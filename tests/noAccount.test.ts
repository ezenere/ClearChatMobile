// "Usar sem conta": a fase `local` da conta (persistida, entrar depois, voltar), o celular inteiro
// funcionando sem servidor (provedor, persona, memória, chat com turno pelo provedor falso, anexo,
// renomear/apagar) e nada indo a servidor nenhum, o cache sobrevivendo a reabrir o app, os recursos
// só com conta recusados com texto claro, e o merge do primeiro login (§12) contra o servidor falso:
// online vazio → sobe tudo (um segundo cliente vê), os dois com dados → pergunta, dedupe/remapeamento,
// prioridade online × local, idênticos sem envio.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { reduceSession, initialSession, type SessionState } from '../src/account/session'
import { AccountService } from '../src/account/service'
import { KV, MemoryKeyValueStore, MemorySecretStore } from '../src/account/storage'
import { LOCAL_OWNER, syncAllowed } from '../src/data/binding'
import { SyncEngine } from '../src/data/engine'
import {
  applyMerge,
  dedupe,
  downloadOnline,
  normBase,
  normName,
  remapPlain,
  type MergeState
} from '../src/data/merge'
import { LocalStore } from '../src/data/store'
import { prepareAttachment, uploadAttachments } from '../src/remote/upload'
import { openRecord } from '../src/crypto'
import type { Change } from '../src/data/types'
import { until } from './hostHarness'
import { chatPlain, DesktopWriter, FakeSync, messagePlain, sessionPlain } from './fakeSync'
import { makeLocalPhone, type LocalPhone } from './localHarness'
import { openNodeSql } from './nodeSql'

const server0 = { kind: 'official' as const, url: 'https://x', name: null }

describe('fase da conta: sem conta', () => {
  it('signed-out → local → sign-in → signed-out; restored local; troca de servidor permitida', () => {
    let s: SessionState = { ...initialSession(server0), phase: 'signed-out' }
    s = reduceSession(s, { type: 'local' })
    expect(s.phase).toBe('local')
    // só do signed-out
    expect(reduceSession({ ...s, phase: 'locked' }, { type: 'local' }).phase).toBe('locked')
    const other = { kind: 'self' as const, url: 'http://y', name: 'Y' }
    expect(reduceSession(s, { type: 'server', server: other }).server).toEqual(other)
    s = reduceSession(s, { type: 'sign-in' })
    expect(s.phase).toBe('signed-out')
    expect(reduceSession(s, { type: 'sign-in' })).toBe(s)
    const restored = reduceSession(initialSession(server0), {
      type: 'restored',
      server: server0,
      account: null,
      device: null,
      hasKeys: false,
      unlocked: false,
      remember: true,
      biometric: false,
      local: true
    })
    expect(restored.phase).toBe('local')
  })

  it('AccountService: "Usar sem conta" persiste, reabre sem conta, entrar volta ao login; WebSocket nunca liga', async () => {
    const kv = new MemoryKeyValueStore()
    const secrets = new MemorySecretStore()
    let starts = 0
    const make = () =>
      new AccountService({
        secrets,
        kv,
        device: { defaultName: 'Pixel', platform: 'android', appVersion: '0.1.0' },
        realtime: () => ({
          start: () => void starts++,
          stop: () => undefined,
          getState: () => 'idle',
          request: () => Promise.reject(new Error('sem ws'))
        })
      })
    const a = make()
    await a.init()
    expect(a.getState().phase).toBe('signed-out')
    expect(a.localModeChosen).toBe(false)
    a.useWithoutAccount()
    expect(a.getState().phase).toBe('local')
    expect(kv.get(KV.localMode)).toBe('1')
    expect(() => a.useWithoutAccount()).toThrow()
    // reabrir o app: direto nos dados locais
    const b = make()
    await b.init()
    expect(b.getState().phase).toBe('local')
    expect(b.localModeChosen).toBe(true)
    await b.setServer('official')
    b.beginSignIn()
    expect(b.getState().phase).toBe('signed-out')
    // o modo sem conta continua sendo o padrão até o merge
    const c = make()
    await c.init()
    expect(c.getState().phase).toBe('local')
    c.clearLocalMode()
    const d = make()
    await d.init()
    expect(d.getState().phase).toBe('signed-out')
    expect(starts).toBe(0)
  })
})

describe('celular sem conta', () => {
  let p: LocalPhone
  let dir: string
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-local-'))
    p = await makeLocalPhone({ dbPath: join(dir, 'cache.db') })
  })
  afterEach(async () => {
    await p.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('provedor, persona, memória e chat com turno — tudo só aqui, nada ao servidor; reabre com os dados', async () => {
    expect(p.store.getMeta('owner')).toBe(LOCAL_OWNER)
    expect(syncAllowed(p.store)).toBe(false)
    const pid = p.settings.saveProvider({
      name: 'LLM falso',
      kind: 'openai',
      baseUrl: `${p.llm.url}/v1`,
      apiKey: 'sk-local-123',
      headers: {}
    })
    const preset = p.settings.savePreset({
      name: 'Revisor',
      description: '',
      icon: 'code',
      config: { providerId: pid, model: 'fake/a', systemPrompt: 'seja breve' }
    })
    p.settings.setSetting('defaultPresetId', preset.id)
    const col = p.settings.createCollection({ category: 'people', name: 'Família' })
    p.settings.createMemory({ collectionId: col.id, title: 'Rex', summary: 'o cachorro' })
    const { chatId, sid } = p.newChat()
    const r = await p.stack.host.local(chatId, 'send', { sessionId: sid, text: 'olá local' })
    expect(r.status).toBe('accepted')
    await p.idle(sid)
    const loaded = p.store.loadChat(chatId)!
    const texts = [...loaded.messages.values()].flat().map((m) => m.message.content)
    expect(texts).toContain('olá local')
    expect(texts.some((t) => typeof t === 'string' && t.startsWith('ok: olá local'))).toBe(true)
    expect(p.llm.requests.some((x) => x.path.endsWith('/chat/completions'))).toBe(true)
    // renomear e apagar sem servidor
    p.stack.renameChatLocal(chatId, 'Meu chat')
    expect(p.store.getPlain('chat', chatId)!.title).toBe('Meu chat')
    const other = p.newChat()
    await p.stack.deleteChatLocal(other.chatId)
    expect(p.store.getPlain('chat', other.chatId)).toBeNull()
    // os writers tentam subir (debounce) — sem chaves, nada sai
    await new Promise((res) => setTimeout(res, 120))
    // nada saiu do aparelho além do provedor de IA
    expect(p.server.calls).toEqual([])
    expect(p.ws.requests).toEqual([])
    expect(p.store.lwwOutbox().length).toBeGreaterThan(0)
    // reabrir o app: mesmo arquivo de cache
    await p.close()
    const again = new LocalStore(openNodeSql(join(dir, 'cache.db')))
    expect(again.getMeta('owner')).toBe(LOCAL_OWNER)
    expect(again.listChats().map((c) => c.title)).toEqual(['Meu chat'])
    expect(again.plainsOf('provider')[0].plain.apiKey).toBe('sk-local-123')
    expect(again.plainsOf('memory').map((m) => m.plain.title)).toEqual(['Rex'])
    expect(again.setting('defaultPresetId')).toBe(preset.id)
    expect(again.loadChat(chatId)!.messages.get(sid)!.length).toBe(2)
    again.sql.close()
    p = await makeLocalPhone({ dbPath: join(dir, 'cache.db') })
    expect(p.store.listChats().length).toBe(1)
  })

  it('recursos só com conta recusam com texto claro; anexo fica no aparelho sem upload', async () => {
    const { chatId } = p.newChat()
    await expect(p.stack.host.takeover(chatId, { mode: 'next_turn' })).rejects.toThrow(
      'Entre numa conta'
    )
    expect(p.stack.host.isHostHere(chatId)).toBe(true)
    expect(await p.stack.host.pushMode(chatId)).toBeNull()
    const put = new Map<string, Uint8Array>()
    const deps = {
      keys: () => null,
      localOnly: () => true,
      put: (f: string, d: Uint8Array) => void put.set(f, d),
      post: () => Promise.reject(new Error('sem servidor')),
      putBlob: () => Promise.reject(new Error('sem servidor'))
    }
    const prep = await prepareAttachment(
      deps,
      new TextEncoder().encode('oi'),
      'a.txt',
      'text/plain'
    )
    expect(prep.info.file).toMatch(/^[0-9a-f]{64}\.txt$/)
    expect(put.has(prep.info.file)).toBe(true)
    await uploadAttachments(deps, [prep])
    // com conta continua exigindo as chaves
    await expect(
      prepareAttachment(
        { ...deps, localOnly: () => false },
        new Uint8Array([1]),
        'x.txt',
        'text/plain'
      )
    ).rejects.toThrow('Desbloqueie')
  })
})

/** Plaintext no servidor, decifrado com a DEK da conta (o "segundo cliente"). */
async function serverPlain(server: FakeSync, desk: DesktopWriter, type: string, id: string) {
  const r = server.records.get(`${type}|${id}`)
  if (!r || r.deleted || !r.env) return null
  return openRecord(desk.sk.record, server.userId, r as Change, r.env)
}

const mergeIdle = (p: LocalPhone) =>
  until(
    () => p.binding.merge.getState().phase === 'idle' && p.store.getMeta('owner') !== LOCAL_OWNER,
    5000,
    'merge terminar'
  )

describe('entrar depois: merge do primeiro login (§12)', () => {
  let p: LocalPhone
  afterEach(async () => {
    await p.close()
  })

  it('conta vazia: sobe tudo sem perguntar (chat em replay com chat_bases = 0); outro cliente vê', async () => {
    p = await makeLocalPhone()
    const pid = p.settings.saveProvider({
      name: 'LLM falso',
      kind: 'openai',
      baseUrl: `${p.llm.url}/v1`,
      apiKey: 'sk-local-123',
      headers: {}
    })
    const col = p.settings.createCollection({ category: 'people', name: 'Família' })
    const mem = p.settings.createMemory({ collectionId: col.id, title: 'Rex', summary: 'cão' })
    p.settings.setSetting('defaultModel', { providerId: pid, model: 'fake/agent' })
    const { chatId, sid } = p.newChat()
    const prep = await prepareAttachment(
      {
        keys: () => null,
        localOnly: () => true,
        put: (f, d) => void p.files.set(f, d),
        post: () => Promise.reject(new Error('sem servidor')),
        putBlob: () => Promise.reject(new Error('sem servidor'))
      },
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]),
      'foto.png',
      'image/png'
    )
    expect(prep.info.kind).toBe('image')
    await p.stack.host.local(chatId, 'send', {
      sessionId: sid,
      text: 'antes da conta',
      attachments: [prep.info]
    })
    await p.idle(sid)
    expect(p.server.calls).toEqual([])
    const states: MergeState['phase'][] = []
    p.binding.merge.subscribe(() => states.push(p.binding.merge.getState().phase))
    p.signIn()
    await mergeIdle(p)
    expect(states).toContain('checking')
    expect(states).not.toContain('ask')
    expect(p.account.localModeCleared).toBe(1)
    expect(p.store.getMeta('owner')).toBe('http://fake|user-fake-1')
    await until(
      () =>
        !p.stack.writer.pending(chatId) &&
        !p.stack.memory.writer.pending() &&
        !!p.server.records.get(`chat|${chatId}`),
      8000,
      'outboxes subirem'
    )
    expect((await serverPlain(p.server, p.desk, 'provider', pid))!.apiKey).toBe('sk-local-123')
    expect((await serverPlain(p.server, p.desk, 'memory', mem.id))!.title).toBe('Rex')
    expect((await serverPlain(p.server, p.desk, 'setting', 'defaultModel'))!.value).toEqual({
      providerId: pid,
      model: 'fake/agent'
    })
    const content = p.server.pushes.filter((x) => x.items.some((i) => i.type === 'message'))
    expect(content.length).toBeGreaterThan(0)
    expect(content[0].chat_bases).toEqual({ [chatId]: 0 })
    expect(content[0].host_epochs).toBeUndefined()
    // segundo cliente (outro aparelho com a mesma conta) puxa e vê o chat
    const store2 = new LocalStore(openNodeSql())
    const e2 = new SyncEngine({
      store: store2,
      http: p.server,
      keys: () => ({ userId: p.server.userId, sk: p.desk.sk }),
      yieldToUi: async () => undefined
    })
    e2.start()
    await e2.sync()
    const msgs = [...store2.loadChat(chatId)!.messages.values()].flat()
    expect(JSON.stringify(msgs.map((m) => m.message.content))).toContain('antes da conta')
    // o anexo criado sem conta subiu como blob (CCB1) antes do registro (§14)
    expect(p.server.blobs.size).toBe(1)
    expect(store2.plainsOf('provider').map((x) => x.plain.name)).toEqual(['LLM falso'])
    e2.stop()
    // daqui em diante sincroniza normalmente (com janela)
    await p.stack.host.local(chatId, 'send', { sessionId: sid, text: 'depois da conta' })
    expect(p.ws.count('host.begin')).toBe(1)
    await p.idle(sid)
  })

  it('os dois com dados: pergunta com contagens; dedupe do provedor remapeia o chat; prioridade online', async () => {
    const server = new FakeSync()
    const desk = await new DesktopWriter(server).init()
    // online: o "PC" já tem o mesmo provedor (outro id), uma persona e um setting
    await desk.put('provider', 'prov-pc', null, {
      sv: 1,
      name: 'llm FALSO',
      kind: 'openai',
      baseUrl: 'HTTP://127.0.0.1:9/v1/',
      apiKey: 'sk-pc',
      headers: {},
      createdAt: 1
    })
    await desk.put('setting', 'defaultSystemPrompt', null, { sv: 1, value: 'do PC' })
    await desk.put('setting', 'ttsSettings', null, {
      sv: 1,
      value: { backend: 'api', api: { providerId: 'prov-pc', model: 'do-pc', voice: null } }
    })
    await desk.put('chat', 'chat-pc', 'chat-pc', chatPlain('Do PC', 's-pc'))
    await desk.put('session', 's-pc', 'chat-pc', sessionPlain('chat-pc'))
    await desk.put(
      'message',
      'm-pc',
      'chat-pc',
      messagePlain({ id: 'm-pc', sessionId: 's-pc', seq: 1, role: 'user', content: 'oi do PC' })
    )
    p = await makeLocalPhone({ server, desk })
    const pid = p.settings.saveProvider({
      name: 'LLM falso',
      kind: 'openai',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'sk-local',
      headers: {}
    })
    p.settings.setSetting('defaultSystemPrompt', 'do celular')
    p.settings.setSetting('defaultModel', { providerId: pid, model: 'm1' })
    // settings de voz: locais do aparelho (1.9.0) — remapeadas, nunca enviadas; a do PC é ignorada
    p.settings.setSetting('sttSettings', { mode: 'api', api: { providerId: pid, model: 'w' } })
    const { chatId } = p.newChat()
    expect(p.store.getPlain('chat', chatId)!.config).toMatchObject({ providerId: pid })
    p.signIn()
    await until(() => p.binding.merge.getState().phase === 'ask', 5000, 'pergunta')
    const st = p.binding.merge.getState()
    if (st.phase !== 'ask') throw new Error('sem pergunta')
    expect(st.info.local).toEqual({ providers: 1, chats: 1, presets: 0, memories: 0 })
    expect(st.info.online).toEqual({ providers: 1, chats: 1, presets: 0, memories: 0 })
    expect(st.info.conflictingChats).toBe(0)
    // nada sobe nem desce enquanto a pergunta está na tela
    expect(p.server.pushes).toEqual([])
    expect(p.engine.isRunning).toBe(false)
    await p.binding.merge.resolve('online')
    await mergeIdle(p)
    // o provedor local virou o online (id canônico) e as referências seguiram
    expect(p.store.getPlain('provider', pid)).toBeNull()
    expect(p.store.getPlain('provider', 'prov-pc')!.apiKey).toBe('sk-pc')
    expect(p.store.getPlain('chat', chatId)!.config).toMatchObject({ providerId: 'prov-pc' })
    expect(p.store.setting('defaultModel')).toEqual({ providerId: 'prov-pc', model: 'm1' })
    expect(p.store.setting('defaultSystemPrompt')).toBe('do PC')
    expect(p.store.deviceSetting('sttSettings')).toEqual({
      mode: 'api',
      api: { providerId: 'prov-pc', model: 'w' }
    })
    expect(p.store.deviceSetting('ttsSettings')).toBeUndefined()
    expect(
      p.store
        .listChats()
        .map((c) => c.id)
        .sort()
    ).toEqual([chatId, 'chat-pc'].sort())
    await until(() => !!p.server.records.get(`chat|${chatId}`), 8000, 'chat local subir')
    await until(() => !p.stack.memory.writer.pending(), 8000, 'LWW subir')
    // o provedor (online venceu e era o mesmo) não gerou envio; o setting online ficou
    expect(p.server.records.get('provider|prov-pc')!.rev).toBe(1)
    expect(p.server.records.get(`provider|${pid}`)).toBeUndefined()
    expect(p.server.records.get('setting|defaultSystemPrompt')!.rev).toBe(1)
    expect(p.server.records.get('setting|sttSettings')).toBeUndefined()
    expect(p.server.records.get('setting|ttsSettings')!.rev).toBe(1)
    expect((await serverPlain(server, desk, 'setting', 'defaultModel'))!.value).toEqual({
      providerId: 'prov-pc',
      model: 'm1'
    })
  })

  it('prioridade local: o conteúdo local vai por cima (base = rev online)', async () => {
    const server = new FakeSync()
    const desk = await new DesktopWriter(server).init()
    await desk.put('setting', 'defaultSystemPrompt', null, { sv: 1, value: 'do PC' })
    await desk.put('preset', 'pre-pc', null, {
      sv: 1,
      name: 'Revisor',
      description: '',
      icon: 'code',
      config: { model: 'x' },
      createdAt: 1,
      updatedAt: 1
    })
    p = await makeLocalPhone({ server, desk })
    p.settings.setSetting('defaultSystemPrompt', 'do celular')
    // mesma persona (nome sem caixa/acento + config igual) → dedupe, nada a enviar
    const local = p.settings.savePreset({
      name: 'revisor',
      description: '',
      icon: 'code',
      config: { model: 'x' }
    })
    p.signIn()
    await until(() => p.binding.merge.getState().phase === 'ask', 5000, 'pergunta')
    await p.binding.merge.resolve('local')
    await mergeIdle(p)
    expect(p.store.getPlain('preset', local.id)).toBeNull()
    expect(p.store.getPlain('preset', 'pre-pc')).not.toBeNull()
    await until(() => !p.stack.memory.writer.pending(), 8000, 'LWW subir')
    const rec = server.records.get('setting|defaultSystemPrompt')!
    expect(rec.rev).toBe(2)
    expect((await serverPlain(server, desk, 'setting', 'defaultSystemPrompt'))!.value).toBe(
      'do celular'
    )
  })

  it('sem rede no merge: erro, dados locais intactos, tentar de novo funciona', async () => {
    p = await makeLocalPhone()
    p.settings.saveProvider({
      name: 'X',
      kind: 'openai',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'k',
      headers: {}
    })
    p.server.offline = true
    p.signIn()
    await until(() => p.binding.merge.getState().phase === 'error', 5000, 'erro')
    expect(p.store.getMeta('owner')).toBe(LOCAL_OWNER)
    expect(p.store.plainsOf('provider').length).toBe(1)
    p.server.offline = false
    await p.binding.merge.begin()
    await mergeIdle(p)
    expect(p.store.getMeta('owner')).not.toBe(LOCAL_OWNER)
    await until(() => p.server.records.size === 1, 5000, 'provedor subir')
  })

  it('sair da conta antes do merge não apaga os dados sem conta', async () => {
    p = await makeLocalPhone()
    p.settings.saveProvider({
      name: 'X',
      kind: 'openai',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'k',
      headers: {}
    })
    p.account.setPhase('signed-out')
    p.account.setPhase('locked')
    p.account.setPhase('signed-out')
    await new Promise((r) => setTimeout(r, 50))
    expect(p.store.getMeta('owner')).toBe(LOCAL_OWNER)
    expect(p.store.plainsOf('provider').length).toBe(1)
  })
})

describe('depois do merge: comportamento de hoje', () => {
  it('sair de uma conta (dados já unidos) apaga o cache; "Usar sem conta" depois começa do zero', async () => {
    const p = await makeLocalPhone()
    try {
      p.settings.saveProvider({
        name: 'X',
        kind: 'openai',
        baseUrl: 'http://127.0.0.1:9/v1',
        apiKey: 'k',
        headers: {}
      })
      p.signIn()
      await mergeIdle(p)
      expect(syncAllowed(p.store)).toBe(true)
      p.account.setPhase('signed-out')
      await until(() => !p.store.getMeta('owner'), 3000, 'cache apagado')
      expect(p.store.plainsOf('provider')).toEqual([])
      p.account.setPhase('local')
      await until(() => p.store.getMeta('owner') === LOCAL_OWNER, 3000, 'dono local')
      expect(syncAllowed(p.store)).toBe(false)
    } finally {
      await p.close()
    }
  })
})

describe('merge: peças puras', () => {
  it('normalizações e remapeamento das referências (§12.5)', () => {
    expect(normBase('HTTPS://API.Example.com/v1/')).toBe('https://api.example.com/v1')
    expect(normName('  Família ')).toBe('familia')
    const map: Record<string, string> = {
      'provider|p1': 'P',
      'preset|x': 'X',
      'memory_collection|c1': 'C',
      'memory|m1': 'M'
    }
    const get = (t: string, id: unknown): string | undefined => map[`${t}|${String(id)}`]
    expect(
      remapPlain(
        'chat',
        'c',
        {
          config: {
            providerId: 'p1',
            presetId: 'x',
            smartApprove: { providerId: 'p1', capture: { providerId: 'p1' } },
            voice: {
              model: { providerId: 'p1' },
              tts: { backend: 'api', api: { providerId: 'p1', model: 't', voice: null } },
              stt: { mode: 'api', api: { providerId: 'p1', model: 'w' } }
            },
            memory: {
              collections: ['c1', 'c9'],
              writeTo: { people: 'c1' },
              extraction: { providerId: 'p1' }
            }
          }
        },
        get
      )
    ).toEqual({
      config: {
        providerId: 'P',
        presetId: 'X',
        smartApprove: { providerId: 'P', capture: { providerId: 'P' } },
        voice: {
          model: { providerId: 'P' },
          tts: { backend: 'api', api: { providerId: 'P', model: 't', voice: null } },
          stt: { mode: 'api', api: { providerId: 'P', model: 'w' } }
        },
        memory: {
          collections: ['C', 'c9'],
          writeTo: { people: 'C' },
          extraction: { providerId: 'P' }
        }
      }
    })
    expect(remapPlain('memory', 'm', { collectionId: 'c1', supersedesId: 'm1' }, get)).toEqual({
      collectionId: 'C',
      supersedesId: 'M'
    })
    expect(
      remapPlain('setting', 'sttSettings', { value: { api: { providerId: 'p1' } } }, get)
    ).toEqual({
      value: { api: { providerId: 'P' } }
    })
    expect(remapPlain('setting', 'defaultPresetId', { value: 'x' }, get)).toEqual({ value: 'X' })
    expect(remapPlain('session', 's', { providerId: 'zz' }, get)).toBeNull()
  })

  it('dedupe: coleção e memória por nome; chat com mesmo id e história diferente = conflito', async () => {
    const server = new FakeSync()
    const desk = await new DesktopWriter(server).init()
    await desk.put('memory_collection', 'col-pc', null, {
      sv: 1,
      category: 'people',
      name: 'FAMILIA',
      description: ''
    })
    await desk.put('memory', 'mem-pc', 'col-pc', { sv: 1, collectionId: 'col-pc', title: 'rex' })
    await desk.put('chat', 'same', 'same', chatPlain('X', 's1'))
    await desk.put('session', 's1', 'same', sessionPlain('same'))
    await desk.put(
      'message',
      'm1',
      'same',
      messagePlain({ id: 'm1', sessionId: 's1', seq: 1, role: 'user', content: 'online' })
    )
    const store = new LocalStore(openNodeSql())
    const put = (type: string, id: string, scope: string | null, plain: Record<string, unknown>) =>
      store.writeLww({ type, id, scope, plain, patch: plain })
    put('memory_collection', 'col-l', null, { sv: 1, category: 'people', name: 'Família' })
    put('memory', 'mem-l', 'col-l', { sv: 1, collectionId: 'col-l', title: 'Rex' })
    store.writeLocal({
      type: 'chat',
      id: 'same',
      scope: 'same',
      chatId: 'same',
      plain: chatPlain('X', 's1')
    })
    store.writeLocal({
      type: 'session',
      id: 's1',
      scope: 'same',
      chatId: 'same',
      plain: sessionPlain('same')
    })
    store.writeLocal({
      type: 'message',
      id: 'm2',
      scope: 'same',
      chatId: 'same',
      plain: messagePlain({ id: 'm2', sessionId: 's1', seq: 1, role: 'user', content: 'local' })
    })
    const snap = await downloadOnline(server, { userId: server.userId, sk: desk.sk })
    const remap = dedupe(store, snap)
    expect([...remap.values()].sort()).toEqual(['col-pc', 'mem-pc'])
    const r = applyMerge(store, snap, 'online', 'owner')
    expect(r.remapped).toBe(2)
    expect(store.getPlain('memory', 'mem-pc')!.collectionId).toBe('col-pc')
    // prioridade online num chat conflitante: a versão local sai
    expect(store.getPlain('message', 'm2')).toBeNull()
    expect(store.getPlain('message', 'm1')).not.toBeNull()
    expect(store.lwwOutbox()).toEqual([])
    expect(store.outbox('same')).toEqual([])
    expect(store.cursor).toBe(server.seq)
  })
})
