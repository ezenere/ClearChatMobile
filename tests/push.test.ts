// Notificações push (SYNC_PROTOCOL.md §22): decisão de exibição (decifrado, genérico sem a DEK,
// descartes, dismiss, preferências, chat aberto), registro do token contra o servidor falso e os
// avisos locais dos chats executados no celular. Os vetores de push.json rodam em vectors.test.ts.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentEvent, Session } from '../src/vendor/shared/types'
import type { RealtimeLike } from '../src/account/service'
import { AccountService } from '../src/account/service'
import { MemoryKeyValueStore, MemorySecretStore } from '../src/account/storage'
import { fromHex, randomBytes } from '../src/crypto'
import pushJson from '../src/vendor/protocol/test-vectors/push.json'
import { pushKey, sealPush } from '../src/push/crypto'
import { LocalHostNotifier } from '../src/push/localHost'
import {
  DEFAULT_PREFS,
  decidePush,
  extractFcmData,
  type FcmData,
  type PushContext,
  type PushPrefs,
  readPrefs,
  type ShownNotification,
  writePref
} from '../src/push/model'
import { PUSH_PATH, PushRegistrar, pushFeatureOf } from '../src/push/registration'
import { createKeyMaterial, type KeysResponse } from './helpers'
import { FakeServer } from './fakeServer'

const V = pushJson as unknown as {
  user_id: string
  push_key_hex: string
  cases: { name: string; kind: string; tag: string; json: string; envelope: unknown }[]
}
const KEY = fromHex(V.push_key_hex)
const approval = V.cases.find((c) => c.kind === 'approval')!
const reply = V.cases.find((c) => c.kind === 'reply')!
const APPROVAL_TS = 1760000300000

const fcm = (
  c: { kind: string; tag: string; envelope: unknown },
  extra: FcmData = {}
): FcmData => ({
  v: '1',
  kind: c.kind,
  tag: c.tag,
  env: JSON.stringify(c.envelope),
  sent_at: new Date(APPROVAL_TS).toISOString(),
  ...extra
})

function ctx(over: Partial<PushContext> = {}): PushContext {
  return {
    userId: V.user_id,
    key: async () => KEY,
    prefs: { ...DEFAULT_PREFS },
    now: APPROVAL_TS + 60_000,
    chatOpen: () => false,
    ...over
  }
}

describe('decidePush (§22.7)', () => {
  it('decifra o vetor e monta título = chatTitle, corpo = trecho, subtexto = host', async () => {
    const d = await decidePush(fcm(approval), ctx())
    expect(d.action).toBe('show')
    if (d.action !== 'show') return
    expect(d.decrypted).toBe(true)
    expect(d.notification).toEqual({
      id: approval.tag,
      channel: 'pending',
      title: 'Refatorar login',
      body: 'Aprovação · Executar: npm test',
      subtitle: 'Desktop de casa',
      data: {
        cc: 'push',
        kind: 'approval',
        tag: approval.tag,
        chatId: '3d6f0a52-7c1e-4b8a-9f2d-0e4c5b6a7d8e',
        // desde 1.8.0 o aviso guarda o host (o nome casa o host_offline de servidores antigos)
        hostName: 'Desktop de casa'
      }
    })
    const r = await decidePush(fcm(reply), ctx({ now: 1760000400000 }))
    expect(r.action === 'show' && r.notification.channel).toBe('replies')
    expect(r.action === 'show' && r.notification.body).toBe(
      'Pronto, alterei os 3 arquivos e os testes passaram.'
    )
  })

  it('"Mostrar trecho" desligado: título do chat e texto pelo tipo', async () => {
    const d = await decidePush(fcm(approval), ctx({ prefs: { ...DEFAULT_PREFS, excerpt: false } }))
    expect(d.action === 'show' && d.notification.body).toBe('Precisa da sua aprovação')
    expect(d.action === 'show' && d.notification.title).toBe('Refatorar login')
  })

  it('DEK indisponível (biometria/não lembrar/bloqueado): texto genérico, sem chat', async () => {
    const d = await decidePush(fcm(approval), ctx({ key: async () => null }))
    expect(d).toEqual({
      action: 'show',
      decrypted: false,
      notification: {
        id: approval.tag,
        channel: 'pending',
        title: 'ClearChat',
        body: 'Um chat precisa da sua aprovação',
        data: { cc: 'push', kind: 'approval', tag: approval.tag }
      }
    })
    const r = await decidePush(fcm(reply), ctx({ key: async () => null }))
    expect(r.action === 'show' && r.notification.body).toBe('Resposta pronta num chat')
    // leitura da DEK que lança = indisponível
    const t = await decidePush(
      fcm(approval),
      ctx({
        key: async () => {
          throw new Error('keystore')
        }
      })
    )
    expect(t.action === 'show' && t.decrypted).toBe(false)
  })

  it('sem DEK, aviso velho pelo sent_at do servidor é descartado', async () => {
    const d = await decidePush(
      fcm(approval),
      ctx({ key: async () => null, now: APPROVAL_TS + 86_400_000 + 1 })
    )
    expect(d).toEqual({ action: 'drop', reason: 'old' })
  })

  it('descarta: falha de autenticação com a DEK disponível, kind trocado, ts velho', async () => {
    const wrong = await decidePush(fcm(approval), ctx({ key: async () => randomBytes(32) }))
    expect(wrong).toEqual({ action: 'drop', reason: 'auth' })
    // envelope de approval entregue como reply: a AAD não bate
    const swapped = await decidePush(fcm({ ...approval, kind: 'reply' }), ctx())
    expect(swapped).toEqual({ action: 'drop', reason: 'auth' })
    // kind interno diferente do externo (cifrado com a AAD certa, payload mentindo)
    const tag = 'ab'.repeat(16)
    const env = await sealPush(KEY, V.user_id, 'approval', tag, {
      ...(JSON.parse(reply.json) as object),
      kind: 'reply'
    })
    const mismatch = await decidePush(fcm({ kind: 'approval', tag, envelope: env }), ctx())
    expect(mismatch).toEqual({ action: 'drop', reason: 'kind-mismatch' })
    const old = await decidePush(fcm(approval), ctx({ now: APPROVAL_TS + 86_400_000 + 1 }))
    expect(old).toEqual({ action: 'drop', reason: 'old' })
    const fresh = await decidePush(fcm(approval), ctx({ now: APPROVAL_TS + 86_400_000 }))
    expect(fresh.action).toBe('show')
  })

  it('descarta mensagem malformada, versão/kind desconhecidos e sem login', async () => {
    expect(await decidePush(fcm(approval, { tag: 'XYZ' }), ctx())).toEqual({
      action: 'drop',
      reason: 'malformed'
    })
    expect(await decidePush(fcm(approval, { v: '2' }), ctx())).toEqual({
      action: 'drop',
      reason: 'version'
    })
    expect(await decidePush(fcm(approval, { kind: 'promo' }), ctx())).toEqual({
      action: 'drop',
      reason: 'unknown-kind'
    })
    expect(await decidePush(fcm(approval, { env: '{' }), ctx())).toEqual({
      action: 'drop',
      reason: 'malformed'
    })
    expect(await decidePush(fcm(approval), ctx({ userId: null }))).toEqual({
      action: 'drop',
      reason: 'signed-out'
    })
  })

  it('dismiss apaga a tag — mesmo com as notificações desligadas', async () => {
    const off = { ...DEFAULT_PREFS, enabled: false }
    const d = await decidePush(
      { v: '1', kind: 'dismiss', tag: approval.tag, env: '' },
      ctx({ prefs: off, userId: null })
    )
    expect(d).toEqual({ action: 'dismiss', id: approval.tag })
  })

  it('preferências do aparelho filtram por tipo', async () => {
    const p = (over: Partial<PushPrefs>) => ({ ...DEFAULT_PREFS, ...over })
    expect(await decidePush(fcm(approval), ctx({ prefs: p({ enabled: false }) }))).toEqual({
      action: 'drop',
      reason: 'disabled'
    })
    expect(await decidePush(fcm(approval), ctx({ prefs: p({ pending: false }) }))).toEqual({
      action: 'drop',
      reason: 'kind-off'
    })
    // respostas desligadas não afetam pendências
    expect((await decidePush(fcm(approval), ctx({ prefs: p({ reply: false }) }))).action).toBe(
      'show'
    )
    expect(
      await decidePush(fcm(reply), ctx({ prefs: p({ reply: false }), now: 1760000400000 }))
    ).toEqual({ action: 'drop', reason: 'kind-off' })
    const host = { v: '1', kind: 'host_offline', tag: 'cd'.repeat(16), env: '' }
    expect(await decidePush(host, ctx({ prefs: p({ hostOffline: false }) }))).toEqual({
      action: 'drop',
      reason: 'kind-off'
    })
  })

  it('primeiro plano com o chat aberto: não mostra', async () => {
    const d = await decidePush(
      fcm(approval),
      ctx({ chatOpen: (id) => id === '3d6f0a52-7c1e-4b8a-9f2d-0e4c5b6a7d8e' })
    )
    expect(d).toEqual({ action: 'drop', reason: 'chat-open' })
    const other = await decidePush(fcm(approval), ctx({ chatOpen: (id) => id === 'outro' }))
    expect(other.action).toBe('show')
  })

  it('host_offline: campos em claro, sem DEK', async () => {
    const tag = 'ef'.repeat(16)
    const d = await decidePush(
      {
        v: '1',
        kind: 'host_offline',
        tag,
        env: '',
        chat_id: 'chat-9',
        device_name: 'Desktop de casa',
        sent_at: new Date(APPROVAL_TS).toISOString()
      },
      ctx({ key: async () => null })
    )
    expect(d).toEqual({
      action: 'show',
      decrypted: false,
      notification: {
        id: tag,
        channel: 'host-offline',
        title: 'Host offline',
        body: 'Desktop de casa ficou offline com um chat em execução.',
        data: { cc: 'push', kind: 'host_offline', tag, chatId: 'chat-9' }
      }
    })
  })

  it('acha os campos no payload da tarefa (RemoteMessage serializado, dataString)', () => {
    const fields = { v: '1', kind: 'reply', tag: reply.tag, env: '{}', sent_at: 'x' }
    expect(
      extractFcmData({ data: { collapseKey: reply.tag, data: { ...fields, dataString: null } } })
    ).toMatchObject(fields)
    expect(extractFcmData({ data: { dataString: JSON.stringify(fields) } })).toMatchObject(fields)
    expect(extractFcmData({ data: { foo: 'bar' } })).toBeNull()
    expect(extractFcmData(null)).toBeNull()
  })

  it('trecho é encurtado e sem quebras', async () => {
    const tag = '12'.repeat(16)
    const long = 'linha\n'.repeat(80)
    const env = await sealPush(KEY, V.user_id, 'reply', tag, {
      sv: 1,
      kind: 'reply',
      chatId: 'c',
      chatTitle: 'T'.repeat(300),
      text: long,
      hostName: 'PC',
      ts: APPROVAL_TS
    })
    const d = await decidePush(fcm({ kind: 'reply', tag, envelope: env }), ctx())
    if (d.action !== 'show') throw new Error('esperava mostrar')
    expect(d.notification.body.length).toBeLessThanOrEqual(200)
    expect(d.notification.body).not.toContain('\n')
    expect(d.notification.title.length).toBeLessThanOrEqual(120)
  })
})

describe('preferências (§4.4)', () => {
  it('padrão tudo ligado; grava "0"/"1" no kv do aparelho', () => {
    const kv = new MemoryKeyValueStore()
    expect(readPrefs(kv)).toEqual(DEFAULT_PREFS)
    writePref(kv, 'excerpt', false)
    writePref(kv, 'reply', false)
    expect(readPrefs(kv)).toEqual({ ...DEFAULT_PREFS, excerpt: false, reply: false })
    expect(kv.get('push.excerpt')).toBe('0')
  })
})

// ---------------- registro do token contra o servidor falso ----------------

class NoRealtime implements RealtimeLike {
  start(): void {}
  stop(): void {}
  getState() {
    return 'idle' as const
  }
  request(): Promise<Record<string, unknown>> {
    return Promise.reject(new Error('sem WebSocket'))
  }
}

describe('PushRegistrar (§22.2)', () => {
  let server: FakeServer
  let realFetch: typeof fetch
  let kv: MemoryKeyValueStore
  let account: AccountService
  let perm: 'granted' | 'denied' | 'undetermined'
  let token: string | null
  let reg: PushRegistrar

  beforeEach(async () => {
    server = new FakeServer()
    realFetch = globalThis.fetch
    globalThis.fetch = server.fetch as typeof fetch
    const m = await createKeyMaterial(server.userId, 'uma senha de teste bem comprida')
    server.keys = {
      key_version: 1,
      keys_rev: 1,
      password: m.body.password,
      recovery: m.body.recovery
    } as KeysResponse
    server.verifier = m.body.verifier
    kv = new MemoryKeyValueStore()
    account = new AccountService({
      secrets: new MemorySecretStore(),
      kv,
      device: { defaultName: 'Pixel', platform: 'android', appVersion: '0.1.0' },
      realtime: () => new NoRealtime()
    })
    await account.init()
    await account.setServer('self', server.base)
    perm = 'granted'
    token = 'fcm-token-1'
    reg = new PushRegistrar({
      http: account.http,
      kv,
      deviceId: () => account.getState().device?.id ?? null,
      serverSupportsPush: async () =>
        pushFeatureOf(await (await fetch(`${server.base}/api/info`)).json()),
      permission: async () => perm,
      token: async () => token
    })
  })
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  const login = async () => {
    await account.requestCode(server.email)
    await account.verifyCode(server.code, 'Meu celular')
  }
  const puts = () => server.callsTo(PUSH_PATH).filter((c) => c.method === 'PUT')
  const dels = () => server.callsTo(PUSH_PATH).filter((c) => c.method === 'DELETE')
  const myPush = async () => (await account.devices()).find((d) => d.current)?.push

  it('sem login não chama nada; depois do login registra (e a cada abertura, idempotente)', async () => {
    expect(await reg.sync()).toBe('signed-out')
    expect(server.callsTo(PUSH_PATH)).toHaveLength(0)
    await login()
    expect(await reg.sync('login')).toBe('registered')
    expect(puts()[0].body).toEqual({ provider: 'fcm', token: 'fcm-token-1' })
    expect(await myPush()).toBe(true)
    expect(await reg.sync('abertura')).toBe('registered')
    expect(puts()).toHaveLength(2)
    expect(reg.getStatus()).toBe('registered')
  })

  it('token novo do FCM substitui o anterior', async () => {
    await login()
    await reg.sync()
    token = 'fcm-token-2'
    await reg.sync('token novo')
    expect(puts().at(-1)?.body).toEqual({ provider: 'fcm', token: 'fcm-token-2' })
    expect([...server.devices.values()][0].pushToken).toBe('fcm-token-2')
  })

  it('aviso de token do FCM: só registra de novo se mudou (sem laço)', async () => {
    await login()
    await reg.sync()
    reg.onToken('fcm-token-1')
    await reg.sync()
    expect(puts()).toHaveLength(2)
    token = 'fcm-token-3'
    reg.onToken('fcm-token-3')
    await new Promise((r) => setTimeout(r, 20))
    expect(puts().at(-1)?.body).toEqual({ provider: 'fcm', token: 'fcm-token-3' })
    const n = puts().length
    reg.onToken('fcm-token-3')
    await new Promise((r) => setTimeout(r, 20))
    expect(puts()).toHaveLength(n)
  })

  it('desligar no aparelho → DELETE; religar → PUT', async () => {
    await login()
    await reg.sync()
    writePref(kv, 'enabled', false)
    expect(await reg.sync('desligou')).toBe('off')
    expect(dels()).toHaveLength(1)
    expect(await myPush()).toBe(false)
    // desligado e já removido: não repete o DELETE
    await reg.sync()
    expect(dels()).toHaveLength(1)
    writePref(kv, 'enabled', true)
    expect(await reg.sync('ligou')).toBe('registered')
    expect(await myPush()).toBe(true)
  })

  it('instância sem push (features.push null): não registra', async () => {
    server.push = false
    await login()
    expect(await reg.sync()).toBe('unavailable')
    expect(server.callsTo(PUSH_PATH)).toHaveLength(0)
  })

  it('servidor antigo sem a rota (404): indisponível', async () => {
    await login()
    const r = new PushRegistrar({
      http: account.http,
      kv,
      deviceId: () => account.getState().device?.id ?? null,
      serverSupportsPush: async () => null,
      permission: async () => 'granted',
      token: async () => 't'
    })
    server.push = false
    expect(await r.sync()).toBe('unavailable')
  })

  it('permissão negada: remove o token (o host não deve contar com este aparelho)', async () => {
    await login()
    await reg.sync()
    perm = 'denied'
    expect(await reg.sync()).toBe('no-permission')
    expect(dels()).toHaveLength(1)
    expect(await myPush()).toBe(false)
  })

  it('sem Firebase (sem token): não registra, sem erro', async () => {
    token = null
    await login()
    expect(await reg.sync()).toBe('no-token')
    expect(server.callsTo(PUSH_PATH)).toHaveLength(0)
  })

  it('chamadas simultâneas se juntam', async () => {
    await login()
    const all = await Promise.all([reg.sync(), reg.sync(), reg.sync()])
    expect(all).toEqual(['registered', 'registered', 'registered'])
    expect(puts().length).toBeLessThanOrEqual(2)
  })

  it('sair: o servidor apaga o token e o registro local é esquecido', async () => {
    await login()
    await reg.sync()
    const id = account.getState().device!.id
    expect(reg.registeredFor(id)).toBe(true)
    await account.logout()
    reg.forget()
    expect(reg.registeredFor(id)).toBe(false)
    expect(server.devices.get(id)?.pushToken).toBeNull()
    expect(await reg.sync()).toBe('signed-out')
  })

  it('K_push em memória com o cofre aberto (e some ao bloquear)', async () => {
    await login()
    expect(account.pushKey).toBeNull()
    await account.unlock('uma senha de teste bem comprida', { remember: false })
    const k = account.pushKey
    expect(k).not.toBeNull()
    expect(k!.length).toBe(32)
    await account.lock()
    expect(account.pushKey).toBeNull()
  })
})

// ---------------- chats executados neste celular ----------------

describe('LocalHostNotifier (avisos locais)', () => {
  let bg: boolean
  let prefs: PushPrefs
  let shown: ShownNotification[]
  let dismissed: string[]
  let emit: (e: AgentEvent) => void
  let n: LocalHostNotifier

  const session = (status: Session['status'], parent: string | null = null): Session =>
    ({
      id: parent ? 'sub-1' : 'ses-1',
      chatId: 'chat-1',
      parentSessionId: parent,
      status
    }) as Session

  beforeEach(() => {
    bg = false
    prefs = { ...DEFAULT_PREFS }
    shown = []
    dismissed = []
    n = new LocalHostNotifier({
      subscribe: (fn) => {
        emit = fn
        return () => undefined
      },
      isBackground: () => bg,
      prefs: () => prefs,
      show: (x) => shown.push(x),
      dismiss: (id) => dismissed.push(id),
      chatTitle: () => 'Viagem',
      hostName: () => 'Pixel'
    })
    n.start()
  })

  const approvalEv = (id = 'apr-1'): AgentEvent => ({
    type: 'approval-requested',
    request: {
      id,
      chatId: 'chat-1',
      sessionId: 'ses-1',
      toolCallId: 't1',
      toolName: 'web_search',
      args: { query: 'voos baratos' },
      createdAt: 1
    }
  })

  it('em primeiro plano não avisa', () => {
    emit(approvalEv())
    emit({ type: 'session-updated', session: session('running') })
    emit({ type: 'session-updated', session: session('idle') })
    expect(shown).toHaveLength(0)
  })

  it('em segundo plano: aprovação com o mesmo código de exibição; resolvida → some', () => {
    bg = true
    emit(approvalEv())
    expect(shown).toHaveLength(1)
    expect(shown[0]).toMatchObject({
      channel: 'pending',
      title: 'Viagem',
      subtitle: 'Pixel',
      data: { cc: 'push', kind: 'approval', chatId: 'chat-1' }
    })
    expect(shown[0].body).toContain('voos baratos')
    emit({ type: 'approval-resolved', id: 'apr-1' })
    expect(dismissed).toEqual([shown[0].id])
  })

  it('resposta e erro do turno principal em segundo plano (subagente não conta)', () => {
    emit({ type: 'session-updated', session: session('running') })
    emit({
      type: 'message-added',
      message: {
        id: 'm1',
        sessionId: 'ses-1',
        seq: 1,
        message: { role: 'assistant', content: '**Pronto!** Achei `3` voos.' },
        meta: {},
        createdAt: 1
      }
    })
    bg = true
    emit({ type: 'session-updated', session: session('running', 'ses-1') })
    emit({ type: 'session-updated', session: session('done', 'ses-1') })
    expect(shown).toHaveLength(0)
    emit({ type: 'session-updated', session: session('idle') })
    expect(shown).toHaveLength(1)
    expect(shown[0]).toMatchObject({ channel: 'replies', body: 'Pronto! Achei 3 voos.' })
    emit({ type: 'session-updated', session: session('running') })
    emit({ type: 'error', sessionId: 'ses-1', error: 'HTTP 500' })
    emit({ type: 'session-updated', session: session('error') })
    expect(shown[1]).toMatchObject({ channel: 'errors', body: 'Erro · HTTP 500' })
    // interrompido (ida para o segundo plano) não é resposta nem erro
    emit({ type: 'session-updated', session: session('running') })
    emit({ type: 'session-updated', session: session('interrupted') })
    expect(shown).toHaveLength(2)
  })

  it('preferências valem para os avisos locais', () => {
    bg = true
    prefs = { ...DEFAULT_PREFS, pending: false }
    emit(approvalEv())
    expect(shown).toHaveLength(0)
    prefs = { ...DEFAULT_PREFS, enabled: false }
    n.onBackground(['chat-1'])
    expect(shown).toHaveLength(0)
  })

  it('turno interrompido ao ir para o segundo plano; voltar apaga os avisos locais', () => {
    emit(approvalEv())
    n.onBackground(['chat-1'])
    expect(shown).toHaveLength(1)
    expect(shown[0].channel).toBe('errors')
    expect(shown[0].body).toBe(
      'O turno parou porque o app saiu da tela. Havia uma aprovação esperando por você. Toque para voltar ao chat.'
    )
    // texto do app: aparece mesmo com "Mostrar trecho" desligado
    prefs = { ...DEFAULT_PREFS, excerpt: false }
    n.onBackground(['chat-1'])
    expect(shown[1].body).toContain('O turno parou')
    n.onForeground()
    expect(dismissed).toContain(shown[0].id)
  })
})

it('K_push do vetor bate com a DEK de keys.json', async () => {
  const keys = (await import('../src/vendor/protocol/test-vectors/keys.json')) as unknown as {
    dek_hex: string
  }
  expect(Buffer.from(await pushKey(fromHex(keys.dek_hex))).toString('hex')).toBe(V.push_key_hex)
})
