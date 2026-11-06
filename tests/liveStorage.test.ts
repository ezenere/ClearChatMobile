// Chats "Só neste aparelho" (§23.1, §23.2, §23.8, §23.10, §12.7) e os avisos push do 1.8.0 (§22.7):
// escolha e padrão do aparelho; nada desses chats vai à outbox / ao servidor (nem host.begin);
// resync e pull não apagam a cópia local; o merge do primeiro login os pula (continuam locais) e
// "Salvar online" depois sobe tudo em replay com chat_bases = 0; host_offline apaga as pendências
// do host certo (device_id, from_device_id, nome para servidores antigos).
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryKeyValueStore } from '../src/account/storage'
import {
  deviceDefault,
  initStorageDefault,
  KV_NEW_CHAT_STORAGE,
  rememberChoice,
  storageOffer
} from '../src/host/storageChoice'
import { LocalStore } from '../src/data/store'
import {
  buildNotification,
  decidePush,
  DEFAULT_PREFS,
  genericNotification,
  hostOfflineTarget,
  pendingToClear
} from '../src/push/model'
import { sealPush } from '../src/push/crypto'
import { randomBytes } from '../src/crypto'
import { DEFAULT_CHAT_CONFIG } from '../src/vendor/shared/defaults'
import { LOCAL_OWNER } from '../src/data/binding'
import { until } from './hostHarness'
import { chatPlain, messagePlain, sessionPlain } from './fakeSync'
import { makeLocalPhone, type LocalPhone } from './localHarness'
import { openNodeSql } from './nodeSql'

describe('escolha "Salvar online" · "Só neste aparelho" (§23.1)', () => {
  it('instalação nova: só neste aparelho; já sincronizava: online; depois, a última escolha', () => {
    const fresh = new MemoryKeyValueStore()
    initStorageDefault(fresh, false)
    expect(deviceDefault(fresh)).toBe('live')
    const old = new MemoryKeyValueStore()
    initStorageDefault(old, true)
    expect(deviceDefault(old)).toBe('online')
    // a regra "já sincronizava" só vale na primeira execução da versão nova
    initStorageDefault(fresh, true)
    expect(deviceDefault(fresh)).toBe('live')
    rememberChoice(fresh, 'online')
    expect(fresh.get(KV_NEW_CHAT_STORAGE)).toBe('online')
    expect(deviceDefault(fresh)).toBe('online')
  })

  it('seletor só com conta e servidor com suporte; sem conta grava o padrão; servidor antigo → online', () => {
    const kv = new MemoryKeyValueStore()
    expect(storageOffer(kv, true, true)).toEqual({ show: true, storage: 'live' })
    expect(storageOffer(kv, true, false)).toEqual({ show: false, storage: 'online' })
    expect(storageOffer(kv, true, null)).toEqual({ show: false, storage: 'online' })
    expect(storageOffer(kv, false, null)).toEqual({ show: false, storage: 'live' })
    rememberChoice(kv, 'online')
    expect(storageOffer(kv, false, true)).toEqual({ show: false, storage: 'online' })
    expect(storageOffer(kv, true, true).storage).toBe('online')
  })
})

describe('cache: chat só neste aparelho', () => {
  it('nada vai para a outbox; apagar some de vez (sem tombstone); converter enfileira tudo com base 0', () => {
    const s = new LocalStore(openNodeSql())
    s.setStorage('c1', 'live')
    s.writeLocal({
      type: 'chat',
      id: 'c1',
      scope: 'c1',
      chatId: 'c1',
      plain: chatPlain('Só aqui', 's1')
    })
    s.writeLocal({
      type: 'session',
      id: 's1',
      scope: 'c1',
      chatId: 'c1',
      plain: sessionPlain('c1')
    })
    s.writeLocal({
      type: 'message',
      id: 'm1',
      scope: 'c1',
      chatId: 'c1',
      plain: messagePlain({ id: 'm1', sessionId: 's1', seq: 1, role: 'user', content: 'oi' })
    })
    expect(s.outbox('c1')).toEqual([])
    expect(s.outboxChats()).toEqual([])
    expect(s.isLocalOnly('c1')).toBe(true)
    expect(s.localOnlyChats()).toEqual(['c1'])
    expect(s.loadChat('c1')!.messages.get('s1')!.length).toBe(1)
    expect(s.messageCount('c1')).toBe(1)
    // "Salvar online": vira um chat comum criado offline
    expect(s.convertToOnline('c1')).toBe(3)
    expect(s.isLocalOnly('c1')).toBe(false)
    const rows = s.outbox('c1')
    expect(rows.map((r) => `${r.type}:${r.baseRev}`).sort()).toEqual([
      'chat:0',
      'message:0',
      'session:0'
    ])
    // um chat só daqui apagado não deixa tombstone
    s.setStorage('c2', 'live')
    s.writeLocal({ type: 'chat', id: 'c2', scope: 'c2', chatId: 'c2', plain: chatPlain('x', 's2') })
    s.writeLocal({ type: 'chat', id: 'c2', scope: 'c2', chatId: 'c2', plain: null })
    expect(s.recordMeta('chat', 'c2')).toBeNull()
    expect(s.isLocalOnly('c2')).toBe(false)
    expect(s.outbox('c2')).toEqual([])
    // logout/wipe também esquece os modos
    s.setStorage('c3', 'live')
    s.wipe()
    expect(s.sql.get<{ n: number }>('SELECT COUNT(*) AS n FROM chat_storage')!.n).toBe(0)
  })
})

describe('celular: chat só neste aparelho, merge e "Salvar online"', () => {
  let p: LocalPhone
  afterEach(async () => {
    await p.close()
  })

  const provider = (phone: LocalPhone) =>
    phone.settings.saveProvider({
      name: 'LLM falso',
      kind: 'openai',
      baseUrl: `${phone.llm.url}/v1`,
      apiKey: 'sk-x',
      headers: {}
    })

  const create = (phone: LocalPhone, storage: 'online' | 'live') => {
    const providerId = phone.stack.providers()[0]?.id ?? ''
    const { chat, session } = phone.stack.repo.createChat({
      config: { ...DEFAULT_CHAT_CONFIG(''), providerId, model: 'fake/agent', enabledTools: [] },
      storage
    })
    return { chatId: chat.id, sid: session.id }
  }

  it('sem conta → entrar: o merge pula os "só neste aparelho" (continuam locais); Salvar online sobe depois', async () => {
    p = await makeLocalPhone()
    provider(p)
    const live = create(p, 'live')
    const online = create(p, 'online')
    await p.stack.host.local(live.chatId, 'send', { sessionId: live.sid, text: 'segredo local' })
    await p.idle(live.sid)
    await p.stack.host.local(online.chatId, 'send', { sessionId: online.sid, text: 'pode subir' })
    await p.idle(online.sid)
    p.signIn()
    await until(
      () => p.binding.merge.getState().phase === 'idle' && p.store.getMeta('owner') !== LOCAL_OWNER,
      5000,
      'merge'
    )
    await until(() => !p.stack.writer.pending(online.chatId), 8000, 'chat online subir')
    expect(p.server.records.has(`chat|${online.chatId}`)).toBe(true)
    // o "só neste aparelho" ficou local: nenhum registro, nenhum push com ele
    expect(p.server.records.has(`chat|${live.chatId}`)).toBe(false)
    expect(
      p.server.pushes.some((x) =>
        x.items.some((i) => i.id === live.chatId || i.scope === live.chatId)
      )
    ).toBe(false)
    expect(p.store.isLocalOnly(live.chatId)).toBe(true)
    expect(p.store.getMeta('merge_local_only')).toBe('1')
    expect(JSON.stringify(p.store.loadChat(live.chatId)!.messages.get(live.sid))).toContain(
      'segredo local'
    )
    // um turno nele com conta: sem janela de escrita, nada no servidor
    const begins = p.ws.count('host.begin')
    await p.stack.host.local(live.chatId, 'send', { sessionId: live.sid, text: 'ainda local' })
    await p.idle(live.sid)
    expect(p.ws.count('host.begin')).toBe(begins)
    expect(p.server.records.has(`chat|${live.chatId}`)).toBe(false)
    // pull/resync não apagam a cópia local (o servidor não conhece o chat)
    await p.engine.sync()
    expect(p.store.loadChat(live.chatId)).not.toBeNull()

    // "Salvar online": chat no primeiro lote, conteúdo em replay com chat_bases = 0
    expect(p.stack.saveOnline(live.chatId)).toBeGreaterThan(2)
    await until(
      () => !p.stack.writer.pending(live.chatId) && p.server.records.has(`chat|${live.chatId}`),
      8000,
      'salvar online'
    )
    const content = p.server.pushes.filter((x) =>
      x.items.some((i) => i.scope === live.chatId && i.type === 'message')
    )
    expect(content.length).toBeGreaterThan(0)
    expect(content[0].chat_bases).toEqual({ [live.chatId]: 0 })
    expect(p.store.isLocalOnly(live.chatId)).toBe(false)
    // daí em diante é um chat comum (com janela)
    await p.stack.host.local(live.chatId, 'send', { sessionId: live.sid, text: 'online agora' })
    await p.idle(live.sid)
    expect(p.ws.count('host.begin')).toBeGreaterThan(begins)
  })

  it('sem conta: "Salvar online" pede uma conta', async () => {
    p = await makeLocalPhone()
    provider(p)
    const { chatId } = create(p, 'live')
    expect(() => p.stack.saveOnline(chatId)).toThrow(/Entre numa conta/)
  })
})

describe('push 1.8.0: host de cada aviso e host_offline (§22.7)', () => {
  const tag = 'a'.repeat(32)

  it('o aviso guarda o host: hostDeviceId decifrado, senão from_device_id; genérico com from_device_id', async () => {
    const n = buildNotification(
      tag,
      {
        kind: 'approval',
        chatId: 'c1',
        chatTitle: 'T',
        text: 'x',
        hostName: 'PC',
        hostDeviceId: 'pc-1',
        live: true
      },
      { excerpt: true },
      false,
      'outro'
    )
    expect(n.data).toMatchObject({ host: 'pc-1', hostName: 'PC', live: true })
    expect(
      buildNotification(
        tag,
        { kind: 'reply', chatId: 'c', chatTitle: '', text: '', hostName: '' },
        { excerpt: true },
        false,
        'pc-2'
      ).data.host
    ).toBe('pc-2')
    expect(genericNotification(tag, 'question', 'pc-3').data.host).toBe('pc-3')
    // decidePush: payload com hostDeviceId/live → nos dados
    const key = randomBytes(32)
    const env = await sealPush(key, 'u', 'approval', tag, {
      sv: 1,
      kind: 'approval',
      chatId: 'c1',
      chatTitle: 'T',
      text: 'Executar: ls',
      hostName: 'PC',
      hostDeviceId: 'pc-1',
      live: true,
      ts: 1000
    })
    const d = await decidePush(
      { v: '1', kind: 'approval', tag, env: JSON.stringify(env), from_device_id: 'pc-1' },
      { userId: 'u', key: async () => key, prefs: DEFAULT_PREFS, now: 2000, chatOpen: () => false }
    )
    expect(d.action === 'show' && d.notification.data).toMatchObject({
      host: 'pc-1',
      live: true,
      chatId: 'c1'
    })
    const g = await decidePush(
      { v: '1', kind: 'retry', tag, env: JSON.stringify(env), from_device_id: 'pc-9' },
      { userId: 'u', key: async () => null, prefs: DEFAULT_PREFS, now: 2000, chatOpen: () => false }
    )
    expect(g.action === 'show' && g.notification.data.host).toBe('pc-9')
  })

  it('host_offline apaga só approval/question/retry do host certo; nome só nos decifrados (servidor antigo)', () => {
    const shown = [
      { id: '1', data: { cc: 'push', kind: 'approval', tag: '1', host: 'pc-1', hostName: 'PC' } },
      { id: '2', data: { cc: 'push', kind: 'question', tag: '2', host: 'pc-1' } },
      { id: '3', data: { cc: 'push', kind: 'reply', tag: '3', host: 'pc-1', hostName: 'PC' } },
      {
        id: '4',
        data: { cc: 'push', kind: 'retry', tag: '4', host: 'nb-2', hostName: 'Notebook' }
      },
      { id: '5', data: { cc: 'push', kind: 'approval', tag: '5' } },
      { id: '6', data: { cc: 'outro', kind: 'approval', host: 'pc-1' } }
    ]
    expect(
      hostOfflineTarget({ v: '1', kind: 'host_offline', tag, device_id: 'pc-1', device_name: 'PC' })
    ).toEqual({
      deviceId: 'pc-1',
      deviceName: 'PC'
    })
    expect(hostOfflineTarget({ v: '1', kind: 'approval', tag })).toBeNull()
    expect(pendingToClear(shown, { deviceId: 'pc-1', deviceName: 'PC' })).toEqual(['1', '2'])
    // servidor < 1.8.0: sem device_id → pelo nome, só os decifrados (o genérico #5 fica)
    expect(pendingToClear(shown, { deviceName: 'PC' })).toEqual(['1'])
    expect(pendingToClear(shown, { deviceName: 'Notebook' })).toEqual(['4'])
  })
})
