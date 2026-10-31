// Motor do sync contra o servidor falso: pull paginado, payload omitido, mudanças ao vivo (contíguas
// e com buraco), LWW por campo com conflito, exclusão vence, cascata do chat, resync (410), revisão
// antiga, registro que não decifra, prévia pelo caminho ativo, busca FTS e cache de mensagens.
import { beforeEach, describe, expect, it } from 'vitest'
import { openRecord } from '../src/crypto'
import { SyncEngine } from '../src/data/engine'
import { LocalStore, ftsQuery } from '../src/data/store'
import { UserError } from '../src/account/errors'
import { DesktopWriter, FakeSync, chatPlain, messagePlain, sessionPlain } from './fakeSync'
import { openNodeSql } from './nodeSql'

let server: FakeSync
let desk: DesktopWriter
let store: LocalStore
let engine: SyncEngine

async function seedChat(
  chatId: string,
  title: string,
  msgs: { role: 'user' | 'assistant'; content: string; parentId?: string | null; id?: string }[],
  extra: { branchSel?: Record<string, string | null>; updatedAt?: number } = {}
) {
  const sid = `${chatId}-s`
  const items = [
    desk.item(
      'chat',
      chatId,
      chatId,
      chatPlain(title, sid, extra.updatedAt ? { updatedAt: extra.updatedAt } : {})
    ),
    desk.item('session', sid, chatId, sessionPlain(chatId, { branchSel: extra.branchSel ?? {} }))
  ]
  msgs.forEach((m, i) =>
    items.push(
      desk.item(
        'message',
        m.id ?? `${chatId}-m${i + 1}`,
        chatId,
        messagePlain({
          id: m.id ?? `${chatId}-m${i + 1}`,
          sessionId: sid,
          seq: i + 1,
          role: m.role,
          content: m.content,
          parentId: m.parentId
        })
      )
    )
  )
  await desk.putMany(items)
}

beforeEach(async () => {
  server = new FakeSync()
  desk = await new DesktopWriter(server).init()
  store = new LocalStore(openNodeSql())
  engine = new SyncEngine({
    store,
    http: server,
    keys: () => ({ userId: server.userId, sk: desk.sk }),
    yieldToUi: async () => undefined
  })
})

describe('pull', () => {
  it('pagina pelo cursor, decifra e indexa (lista, prévia, contagem)', async () => {
    for (let c = 0; c < 6; c++)
      await seedChat(
        `chat${c}`,
        `Chat ${c}`,
        Array.from({ length: 100 }, (_, i) => ({
          role: i % 2 ? ('assistant' as const) : ('user' as const),
          content: `mensagem ${i} do chat ${c}`
        })),
        { updatedAt: 1_700_000_000_000 + c }
      )
    expect(server.seq).toBe(6 * 102)
    engine.start()
    await engine.sync()
    expect(server.calls.filter((c) => c.startsWith('GET /api/v1/sync/changes')).length).toBe(3)
    expect(store.cursor).toBe(server.seq)
    const list = store.listChats()
    expect(list.map((c) => c.title)).toEqual([
      'Chat 5',
      'Chat 4',
      'Chat 3',
      'Chat 2',
      'Chat 1',
      'Chat 0'
    ])
    expect(list[0].preview).toBe('mensagem 99 do chat 5')
    expect(list[0].previewRole).toBe('assistant')
    const chat = store.loadChat('chat3')!
    expect(chat.sessions).toHaveLength(1)
    expect(chat.messages.get('chat3-s')).toHaveLength(100)
    expect(engine.getStatus()).toMatchObject({ phase: 'idle', initial: false })
  })

  it('busca o payload omitido em /records/fetch', async () => {
    server.omitAbove = 200
    await seedChat('big', 'Grande', [{ role: 'user', content: 'x'.repeat(5000) }])
    engine.start()
    await engine.sync()
    expect(server.calls).toContain('POST /api/v1/records/fetch')
    expect(store.loadChat('big')!.messages.get('big-s')![0].message.content).toHaveLength(5000)
  })

  it('ignora revisão antiga e guarda registro que não decifra sem derrubar o lote', async () => {
    await seedChat('c1', 'Um', [{ role: 'user', content: 'oi' }])
    engine.start()
    await engine.sync()
    // envelope de outra chave (outro usuário/servidor malicioso): AAD/tag não confere
    const other = await new DesktopWriter(server).init()
    await other.put(
      'message',
      'evil',
      'c1',
      messagePlain({ id: 'evil', sessionId: 'c1-s', seq: 2, role: 'assistant', content: 'x' })
    )
    await desk.put('chat', 'c2', 'c2', chatPlain('Dois', 'c2-s'))
    await engine.sync()
    expect(
      store
        .listChats()
        .map((c) => c.title)
        .sort()
    ).toEqual(['Dois', 'Um'])
    const c1 = store.loadChat('c1')!
    expect(c1.broken).toBe(1)
    expect(c1.messages.get('c1-s')).toHaveLength(1)
    // revisão menor que a local: ignorada
    const before = store.recordMeta('chat', 'c2')!.rev
    await engine.onLiveChanges([{ ...server.records.get('chat|c2')!, rev: 0, seq: server.seq + 1 }])
    expect(store.recordMeta('chat', 'c2')!.rev).toBe(before)
  })
})

describe('ao vivo (sync.changes)', () => {
  it('contíguo: aplica direto; com buraco: puxa pelo cursor', async () => {
    await seedChat('c1', 'Antes', [{ role: 'user', content: 'oi' }])
    engine.start()
    await engine.sync()
    const live: Parameters<SyncEngine['onLiveChanges']>[0][] = []
    server.onCommit = (ch) => live.push(ch)
    await desk.put('chat', 'c1', 'c1', chatPlain('Depois', 'c1-s'))
    const pulls = server.calls.length
    await engine.onLiveChanges(live[0])
    expect(server.calls.length).toBe(pulls) // nenhuma ida ao servidor
    expect(store.listChats()[0].title).toBe('Depois')
    // buraco: perdeu um commit
    await desk.put('chat', 'c1', 'c1', chatPlain('Perdido', 'c1-s'))
    await desk.put('chat', 'c2', 'c2', chatPlain('Novo', 'c2-s'))
    await engine.onLiveChanges(live[2])
    await engine.sync()
    expect(
      store
        .listChats()
        .map((c) => c.title)
        .sort()
    ).toEqual(['Novo', 'Perdido'])
    expect(store.cursor).toBe(server.seq)
  })

  it('apagar o chat em outro dispositivo cascateia sessões, mensagens e busca', async () => {
    await seedChat('c1', 'Receita', [{ role: 'user', content: 'como fazer pão de queijo' }])
    await seedChat('c2', 'Outro', [{ role: 'user', content: 'nada a ver' }])
    engine.start()
    await engine.sync()
    expect(store.listChats('queijo').map((c) => c.id)).toEqual(['c1'])
    desk.del('chat', 'c1', 'c1')
    await engine.sync()
    expect(store.listChats().map((c) => c.id)).toEqual(['c2'])
    expect(store.listChats('queijo')).toEqual([])
    expect(store.loadChat('c1')).toBeNull()
    expect(store.stats().messages).toBe(1)
  })
})

describe('escrita LWW (§7.4–7.5)', () => {
  it('renomear com conflito reaplica só o título sobre a versão do servidor', async () => {
    await seedChat('c1', 'Título velho', [{ role: 'user', content: 'oi' }])
    engine.start()
    await engine.sync()
    // outro dispositivo muda a config (o celular ainda não viu)
    await desk.put(
      'chat',
      'c1',
      'c1',
      chatPlain('Título velho', 'c1-s', { config: { model: 'novo', futureKey: 1 } })
    )
    await engine.renameChat('c1', 'Título novo')
    const rec = server.records.get('chat|c1')!
    expect(rec.rev).toBe(3)
    const plain = await openRecord(desk.sk.record, server.userId, rec, rec.env!)
    expect(plain.title).toBe('Título novo')
    expect(plain.config).toEqual({ model: 'novo', futureKey: 1 })
    expect(store.listChats()[0].title).toBe('Título novo')
    expect(store.recordMeta('chat', 'c1')!.rev).toBe(3)
    // o eco do próprio push (mesma revisão) não muda nada
    await engine.sync()
    expect(store.listChats()[0].title).toBe('Título novo')
  })

  it('renomear um chat apagado em outro lugar: a exclusão vence', async () => {
    await seedChat('c1', 'Um', [{ role: 'user', content: 'oi' }])
    engine.start()
    await engine.sync()
    desk.del('chat', 'c1', 'c1')
    await expect(engine.renameChat('c1', 'X')).rejects.toBeInstanceOf(UserError)
    expect(store.listChats()).toEqual([])
  })

  it('apagar: cascata local; rev velha e chat_busy', async () => {
    await seedChat('c1', 'Um', [{ role: 'user', content: 'oi' }])
    await seedChat('c2', 'Dois', [{ role: 'user', content: 'oi' }])
    engine.start()
    await engine.sync()
    await desk.put('chat', 'c1', 'c1', chatPlain('Um (editado)', 'c1-s'))
    await engine.deleteChat('c1') // rev_mismatch → repete com a rev atual
    expect(server.records.get('chat|c1')!.deleted).toBe(true)
    expect(store.loadChat('c1')).toBeNull()
    server.busyChats.add('c2')
    await expect(engine.deleteChat('c2')).rejects.toThrow(/rodando/)
    expect(store.loadChat('c2')).not.toBeNull()
  })

  it('offline: avisa sem gravar nada', async () => {
    await seedChat('c1', 'Um', [{ role: 'user', content: 'oi' }])
    engine.start()
    await engine.sync()
    server.offline = true
    await expect(engine.renameChat('c1', 'X')).rejects.toThrow(/Sem conexão/)
    expect(store.listChats()[0].title).toBe('Um')
  })
})

describe('resync (§7.9)', () => {
  it('410 → baixa o estado atual, apaga o que sumiu e posiciona o cursor no head', async () => {
    await seedChat('c1', 'Fica', [{ role: 'user', content: 'a' }])
    await seedChat('c2', 'Some', [{ role: 'user', content: 'b' }])
    engine.start()
    await engine.sync()
    desk.del('chat', 'c2', 'c2')
    await desk.put('chat', 'c1', 'c1', chatPlain('Fica (novo)', 'c1-s'))
    server.gcTombstones()
    store.setCursor(0)
    await engine.sync()
    expect(server.calls.some((c) => c.startsWith('GET /api/v1/records?'))).toBe(true)
    expect(store.listChats().map((c) => c.title)).toEqual(['Fica (novo)'])
    expect(store.loadChat('c2')).toBeNull()
    expect(store.cursor).toBe(server.seq)
  })
})

describe('cache', () => {
  it('prévia segue o caminho ativo (branchSel), não a versão mais nova', async () => {
    await seedChat(
      'b',
      'Ramos',
      [
        { id: 'u1', role: 'user', content: 'pergunta', parentId: null },
        { id: 'a1', role: 'assistant', content: 'resposta escolhida', parentId: 'u1' },
        { id: 'a2', role: 'assistant', content: 'resposta mais nova', parentId: 'u1' }
      ],
      { branchSel: { u1: 'a1' } }
    )
    engine.start()
    await engine.sync()
    expect(store.listChats()[0].preview).toBe('resposta escolhida')
    await desk.put('session', 'b-s', 'b', sessionPlain('b', { branchSel: {} }))
    await engine.sync()
    expect(store.listChats()[0].preview).toBe('resposta mais nova')
  })

  it('busca sem acento acha conteúdo acentuado; título também', async () => {
    await seedChat('c1', 'Configuração do Nginx', [
      { role: 'user', content: 'qual a configuração ideal?' }
    ])
    await seedChat('c2', 'Viagem', [{ role: 'user', content: 'roteiro em Lisboa' }])
    engine.start()
    await engine.sync()
    expect(store.listChats('configuracao').map((c) => c.id)).toEqual(['c1'])
    const hit = store.listChats('lisboa')
    expect(hit.map((c) => c.id)).toEqual(['c2'])
    expect(hit[0].snippet).toContain('[Lisboa]')
    expect(ftsQuery('a"b c')).toBe('"a"* "b"* "c"*')
    expect(ftsQuery('  ')).toBeNull()
  })

  it('reaproveita as mensagens já interpretadas enquanto a revisão não muda', async () => {
    await seedChat('c1', 'Um', [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' }
    ])
    engine.start()
    await engine.sync()
    const a = store.loadChat('c1')!.messages.get('c1-s')!
    await desk.put(
      'message',
      'c1-m2',
      'c1',
      messagePlain({ id: 'c1-m2', sessionId: 'c1-s', seq: 2, role: 'assistant', content: 'b2' })
    )
    await engine.sync()
    const b = store.loadChat('c1')!.messages.get('c1-s')!
    expect(b[0]).toBe(a[0])
    expect(b[1]).not.toBe(a[1])
    expect(b[1].message.content).toBe('b2')
  })

  it('marcador de chamada no registro (memory-extraction + voiceCall) volta a voice-call', async () => {
    await desk.putMany([
      desk.item('chat', 'v', 'v', chatPlain('Voz', 'v-s')),
      desk.item('session', 'v-s', 'v', sessionPlain('v')),
      desk.item(
        'message',
        'mk',
        'v',
        messagePlain({
          id: 'mk',
          sessionId: 'v-s',
          seq: 1,
          role: 'assistant',
          content: 'Chamada de voz iniciada',
          meta: {
            synthetic: true,
            kind: 'memory-extraction',
            voiceCall: { callId: 'x', phase: 'start', startedAt: 1 }
          }
        })
      )
    ])
    engine.start()
    await engine.sync()
    expect(store.loadChat('v')!.messages.get('v-s')![0].meta.kind).toBe('voice-call')
  })

  it('wipe apaga tudo (registros, índices, cursor)', async () => {
    await seedChat('c1', 'Um', [{ role: 'user', content: 'segredo' }])
    engine.start()
    await engine.sync()
    await engine.wipe()
    expect(store.listChats()).toEqual([])
    expect(store.listChats('segredo')).toEqual([])
    expect(store.cursor).toBe(0)
    expect(store.stats()).toEqual({ records: 0, chats: 0, messages: 0 })
  })
})
