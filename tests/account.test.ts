// AccountService contra o servidor falso (fetch) e um WebSocket falso: login por código, registro do
// dispositivo, chaves (setup, desbloqueio, recuperação), refresh rotativo e fim de sessão.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RealtimeOptions, WsState } from '../src/vendor/desktop/sync/ws'
import { describeError, UserError } from '../src/account/errors'
import { AccountService, type RealtimeLike } from '../src/account/service'
import { KV, MemoryKeyValueStore, MemorySecretStore } from '../src/account/storage'
import { createKeyMaterial, fromB64u, type KeysResponse, type Tokens } from './helpers'
import { FakeServer } from './fakeServer'

const PASSWORD = 'uma senha de teste bem comprida'

class FakeRealtime implements RealtimeLike {
  starts = 0
  stops = 0
  state: WsState = 'idle'
  constructor(readonly opts: RealtimeOptions) {}
  start(): void {
    this.starts++
    this.state = 'online'
  }
  stop(): void {
    this.stops++
    this.state = 'stopped'
  }
  getState(): WsState {
    return this.state
  }
  get running(): boolean {
    return this.state !== 'stopped' && this.state !== 'idle'
  }
}

let server: FakeServer
let kv: MemoryKeyValueStore
let secrets: MemorySecretStore
let rt: FakeRealtime | null
let realFetch: typeof fetch

function make(opts: { captcha?: (b: string, a: 'login') => Promise<string> } = {}) {
  return new AccountService({
    secrets,
    kv,
    device: { defaultName: 'Pixel 9 Pro', platform: 'android', appVersion: '0.1.0' },
    captcha: opts.captcha,
    realtime: (o) => (rt = new FakeRealtime(o))
  })
}

async function signedIn(a: AccountService): Promise<void> {
  await a.init()
  await a.setServer('self', server.base)
  await a.requestCode(server.email)
  await a.verifyCode(server.code, 'Meu celular')
}

/** Conta com chaves já definidas (como o site faria no cadastro). */
async function withKeys(): Promise<string> {
  const m = await createKeyMaterial(server.userId, PASSWORD)
  server.keys = {
    key_version: 1,
    keys_rev: 1,
    password: m.body.password,
    recovery: m.body.recovery
  } as KeysResponse
  server.verifier = m.body.verifier
  return m.recoveryKey
}

beforeEach(() => {
  server = new FakeServer()
  kv = new MemoryKeyValueStore()
  secrets = new MemorySecretStore()
  rt = null
  realFetch = globalThis.fetch
  globalThis.fetch = server.fetch as typeof fetch
})
afterEach(() => {
  globalThis.fetch = realFetch
  vi.useRealTimers()
})

describe('servidor (§20.1)', () => {
  it('começa no oficial e troca para self-host validado e normalizado', async () => {
    const a = make()
    await a.init()
    expect(a.getState().phase).toBe('signed-out')
    expect(a.getState().server).toMatchObject({
      kind: 'official',
      url: 'https://clear.ezenere.com'
    })
    const info = await a.setServer('self', 'sync.fake.test/')
    expect(info?.name).toBe('Instância de Teste')
    expect(a.getState().server).toEqual({
      kind: 'self',
      url: 'https://sync.fake.test',
      name: 'Instância de Teste'
    })
    expect(kv.get(KV.serverUrl)).toBe('https://sync.fake.test')
    // persistido: um serviço novo (app reaberto) já começa no self-host
    const b = make()
    expect(b.getState().server.url).toBe('https://sync.fake.test')
  })

  it('recusa protocolo incompatível e servidor inacessível', async () => {
    const a = make()
    await a.init()
    server.protocol = { min: 2, max: 3, version: '2.0.0' }
    await expect(a.setServer('self', server.base)).rejects.toThrow(/incompatível/)
    await expect(a.setServer('self', 'https://outro.test')).rejects.toThrow(/conectar/)
    expect(a.getState().server.kind).toBe('official')
  })
})

describe('login por código (§5.2, §5.3)', () => {
  it('pede o código, registra o dispositivo como mobile e guarda tokens só no SecretStore', async () => {
    const a = make()
    await a.init()
    await a.setServer('self', server.base)
    await expect(a.requestCode('não é e-mail')).rejects.toBeInstanceOf(UserError)
    await a.requestCode('  Ana@Example.TEST ')
    expect(server.callsTo('/api/v1/auth/code/request')[0].body).toEqual({ email: server.email })
    expect(a.getState().login?.email).toBe(server.email)
    await a.verifyCode('123 456', 'Meu celular')
    const verify = server.callsTo('/api/v1/auth/code/verify')[0]
    expect(verify.body?.device).toEqual({
      name: 'Meu celular',
      platform: 'android',
      client: 'mobile',
      app_version: '0.1.0',
      can_host: true
    })
    const s = a.getState()
    expect(s.phase).toBe('needs-setup')
    expect(s.account).toEqual({ userId: server.userId, email: server.email, name: 'Ana' })
    expect(s.device).toEqual({ id: 'dev-1', name: 'Meu celular' })
    const tokens = JSON.parse(secrets.tokens!) as Tokens
    expect(tokens.refresh_token).toMatch(/^ccr_/)
    for (const v of kv.map.values()) expect(v).not.toMatch(/cc[ar]_/)
    expect(rt?.running).toBe(true)
  })

  it('código errado e limite de taxa viram mensagens pt-BR', async () => {
    const a = make()
    await a.init()
    await a.setServer('self', server.base)
    await a.requestCode(server.email)
    const e = await a.verifyCode('000000').catch((x: unknown) => x)
    expect(describeError(e)).toMatch(/Código incorreto ou expirado/)
    server.override.set('POST /api/v1/auth/code/request', {
      status: 429,
      json: { error: { code: 'rate_limited', message: 'x', details: { retry_after: 120 } } },
      headers: { 'Retry-After': '120' }
    })
    const e2 = await a.requestCode(server.email).catch((x: unknown) => x)
    expect(describeError(e2)).toBe('Muitas tentativas. Tente de novo em 2 min.')
    expect(a.getState().login?.retryAt).toBeGreaterThan(Date.now() + 100_000)
  })

  it('com captcha na instância, pede o token antes e o envia (§15)', async () => {
    server.captcha = true
    const captcha = vi.fn(async () => 'tok-123')
    const a = make({ captcha })
    await a.init()
    await a.setServer('self', server.base)
    await a.requestCode(server.email)
    expect(captcha).toHaveBeenCalledWith('https://sync.fake.test', 'login')
    expect(server.callsTo('/api/v1/auth/code/request')[0].body).toEqual({
      email: server.email,
      turnstile_token: 'tok-123'
    })
  })
})

describe('chaves (§3.4–3.8, §5.5)', () => {
  it('senha errada não abre; certa abre e lembra a DEK', async () => {
    await withKeys()
    const a = make()
    await signedIn(a)
    expect(a.getState().phase).toBe('locked')
    const e = await a.unlock('senha errada qualquer', { remember: true }).catch((x: unknown) => x)
    expect(describeError(e)).toBe('Senha de criptografia incorreta.')
    expect(a.getState().phase).toBe('locked')
    await a.unlock(PASSWORD, { remember: true })
    expect(a.getState().phase).toBe('unlocked')
    expect(a.subkeys?.record).toHaveLength(32)
    expect(fromB64u(secrets.dek!)).toHaveLength(32)
    expect(kv.get(KV.remember)).toBe('1')
  })

  it('sem "lembrar", a DEK fica só em memória', async () => {
    await withKeys()
    const a = make()
    await signedIn(a)
    await a.unlock(PASSWORD, { remember: false })
    expect(a.getState().phase).toBe('unlocked')
    expect(secrets.dek).toBeNull()
    const b = make()
    await b.init()
    expect(b.getState().phase).toBe('locked')
  })

  it('reabrir: tokens + DEK lembrada → direto; biometria cancelada → desbloqueio', async () => {
    await withKeys()
    const a = make()
    await signedIn(a)
    await a.unlock(PASSWORD, { remember: true })
    const b = make()
    await b.init()
    expect(b.getState().phase).toBe('unlocked')
    expect(b.getState().account?.email).toBe(server.email)
    secrets.dekBiometric = true
    secrets.denyBiometric = true
    const c = make()
    await c.init()
    expect(c.getState().phase).toBe('locked')
  })

  it('bloquear apaga a DEK (memória e Keystore) e mantém a sessão', async () => {
    await withKeys()
    const a = make()
    await signedIn(a)
    await a.unlock(PASSWORD, { remember: true })
    await a.lock()
    expect(a.getState().phase).toBe('locked')
    expect(a.subkeys).toBeNull()
    expect(secrets.dek).toBeNull()
    expect(secrets.tokens).not.toBeNull()
  })

  it('recuperação: checksum antes da rede, senha nova obrigatória com key_proof', async () => {
    const recoveryKey = await withKeys()
    const a = make()
    await signedIn(a)
    const typo = recoveryKey.slice(0, -1) + (recoveryKey.endsWith('0') ? '1' : '0')
    const e = await a.beginRecovery(typo).catch((x: unknown) => x)
    expect(describeError(e)).toMatch(/Chave de recuperação incorreta/)
    // digitação tolerante: minúsculas, sem hífens
    await a.beginRecovery(recoveryKey.toLowerCase().replace(/-/g, ' '))
    expect(a.recoveryPending).toBe(true)
    await expect(a.finishRecovery('curta', { remember: true })).rejects.toBeInstanceOf(UserError)
    await a.finishRecovery('outra senha nova e longa', { remember: true })
    expect(a.getState().phase).toBe('unlocked')
    expect(a.getState().notice?.action).toBe('new-recovery-key')
    expect(server.keys?.keys_rev).toBe(2)
    // a senha nova vale; a antiga não
    await a.lock()
    await expect(a.unlock(PASSWORD, { remember: false })).rejects.toThrow()
    await a.unlock('outra senha nova e longa', { remember: false })
    // nova chave de recuperação só vale depois do commit
    const p = await a.newRecoveryKey()
    expect(p.recoveryKey).toMatch(/^([0-9A-Z]{4}-){8}[0-9A-Z]{4}$/)
    expect(server.keys?.keys_rev).toBe(2)
    await p.commit()
    expect(server.keys?.keys_rev).toBe(3)
  })

  it('conta sem chaves: setup no aparelho (chave de recuperação antes do envio)', async () => {
    const a = make()
    await signedIn(a)
    expect(a.getState().phase).toBe('needs-setup')
    await expect(a.setupKeys('fraca')).rejects.toBeInstanceOf(UserError)
    const p = await a.setupKeys(PASSWORD)
    expect(server.callsTo('/api/v1/keys/setup')).toHaveLength(0)
    expect(p.recoveryKey).toMatch(/^([0-9A-Z]{4}-){8}[0-9A-Z]{4}$/)
    await p.commit({ remember: true })
    expect(a.getState().phase).toBe('unlocked')
    expect(server.keys?.keys_rev).toBe(1)
    // outro aparelho desbloqueia com a mesma senha
    const b = make()
    kv.set(KV.remember, '0')
    await b.init()
    expect(b.getState().phase).toBe('locked')
    await b.unlock(PASSWORD, { remember: false })
    expect(b.getState().phase).toBe('unlocked')
  })
})

describe('sessão (§5.4, §10.2)', () => {
  it('refresh rotativo no corpo: access expirado → refresh → repete; tokens novos gravados', async () => {
    await withKeys()
    const a = make()
    await signedIn(a)
    const before = JSON.parse(secrets.tokens!) as Tokens
    server.expireAccess()
    await a.renameDevice('Celular novo')
    const r = server.callsTo('/api/v1/auth/refresh')
    expect(r).toHaveLength(1)
    expect(r[0].body).toEqual({ refresh_token: before.refresh_token })
    expect(r[0].headers.authorization).toBeUndefined()
    const after = JSON.parse(secrets.tokens!) as Tokens
    expect(after.refresh_token).not.toBe(before.refresh_token)
    expect(after.access_token).not.toBe(before.access_token)
    expect(a.getState().device?.name).toBe('Celular novo')
  })

  it('refresh recusado (dispositivo revogado) → apaga tudo e explica', async () => {
    await withKeys()
    const a = make()
    await signedIn(a)
    await a.unlock(PASSWORD, { remember: true })
    server.revoke('dev-1')
    await expect(a.renameDevice('x')).rejects.toThrow()
    const s = a.getState()
    expect(s.phase).toBe('signed-out')
    expect(s.notice?.title).toBe('Sessão encerrada')
    expect(secrets.tokens).toBeNull()
    expect(secrets.dek).toBeNull()
    expect(kv.get(KV.userId)).toBeNull()
    expect(kv.get(KV.serverUrl)).toBe(server.base) // o servidor escolhido fica
    expect(rt?.running).toBe(false)
  })

  it('sair revoga no servidor e apaga tokens e DEK, sem aviso', async () => {
    await withKeys()
    const a = make()
    await signedIn(a)
    await a.unlock(PASSWORD, { remember: true })
    await a.logout()
    expect(server.callsTo('/api/v1/auth/logout')).toHaveLength(1)
    expect(server.devices.get('dev-1')?.revoked).toBe(true)
    expect(a.getState()).toMatchObject({ phase: 'signed-out', notice: null, account: null })
    expect(secrets.tokens).toBeNull()
    expect(secrets.dek).toBeNull()
  })

  it('sair: o 4403 device_revoked que o servidor manda no meio não vira "desconectado"', async () => {
    await withKeys()
    const a = make()
    await signedIn(a)
    const real = server.fetch
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const r = await real(input, init)
      if (String(input).endsWith('/api/v1/auth/logout')) rt!.opts.onFatal(4403, 'device_revoked')
      return r
    }) as typeof fetch
    await a.logout()
    expect(rt?.stops).toBeGreaterThan(0)
    expect(a.getState()).toMatchObject({ phase: 'signed-out', notice: null })
  })

  it('sair offline ainda apaga tudo localmente', async () => {
    await withKeys()
    const a = make()
    await signedIn(a)
    globalThis.fetch = (async () => {
      throw new TypeError('offline')
    }) as typeof fetch
    await a.logout()
    expect(a.getState().phase).toBe('signed-out')
    expect(secrets.tokens).toBeNull()
  })

  it('WebSocket: 4403 device_revoked → login com explicação', async () => {
    await withKeys()
    const a = make()
    await signedIn(a)
    await a.unlock(PASSWORD, { remember: true })
    rt!.opts.onFatal(4403, 'device_revoked')
    await vi.waitFor(() => expect(a.getState().phase).toBe('signed-out'))
    expect(a.getState().notice?.title).toBe('Dispositivo desconectado')
    expect(secrets.dek).toBeNull()
  })

  it('WebSocket: keys.reset → definir senha de novo; o 4403 seguinte não é revogação', async () => {
    await withKeys()
    const a = make()
    await signedIn(a)
    await a.unlock(PASSWORD, { remember: true })
    rt!.opts.onEvent({ t: 'keys.reset' })
    await vi.waitFor(() => expect(a.getState().phase).toBe('needs-setup'))
    rt!.opts.onFatal(4403, 'keys_reset')
    await new Promise((r) => setTimeout(r, 10))
    expect(a.getState().phase).toBe('needs-setup')
    expect(a.getState().notice?.title).toBe('Chaves redefinidas')
    expect(secrets.dek).toBeNull()
    expect(secrets.tokens).not.toBeNull()
  })

  it('WebSocket: account.deleted → apaga tudo; keys.changed → relê as chaves', async () => {
    await withKeys()
    const a = make()
    await signedIn(a)
    const n = server.callsTo('/api/v1/keys').length
    rt!.opts.onEvent({ t: 'keys.changed', keys_rev: 2 })
    await vi.waitFor(() => expect(server.callsTo('/api/v1/keys').length).toBe(n + 1))
    rt!.opts.onEvent({ t: 'account.deleted' })
    await vi.waitFor(() => expect(a.getState().phase).toBe('signed-out'))
    expect(a.getState().notice?.title).toBe('Conta apagada')
  })

  it('segundo plano fecha o socket; primeiro plano reconecta', async () => {
    await withKeys()
    const a = make()
    await signedIn(a)
    expect(rt?.running).toBe(true)
    a.setForeground(false)
    expect(rt?.running).toBe(false)
    a.setForeground(true)
    expect(rt?.running).toBe(true)
  })

  it('hello do WebSocket leva um access token fresco (refresh antes, se vencido)', async () => {
    await withKeys()
    const a = make()
    await signedIn(a)
    const t = JSON.parse(secrets.tokens!) as Tokens
    secrets.tokens = JSON.stringify({ ...t, access_expires_at: Date.now() - 1 })
    const b = make()
    await b.init()
    const hello = await rt!.opts.hello()
    expect(server.callsTo('/api/v1/auth/refresh')).toHaveLength(1)
    expect(hello.access_token).toBe((JSON.parse(secrets.tokens!) as Tokens).access_token)
    expect(hello.access_token).not.toBe(t.access_token)
  })
})
