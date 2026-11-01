// Conta neste aparelho: servidor, login por código, registro do dispositivo, chaves (setup,
// desbloqueio, recuperação), ciclo de vida da sessão e o WebSocket só para os eventos de sessão
// (SYNC_PROTOCOL.md §5, §6.2–6.6, §10, §15, §20). Sem React Native: as dependências do aparelho
// (Keystore, SQLite, biometria, captcha) entram por `AccountDeps` — os testes usam versões em memória.
import { OFFICIAL_SYNC_URL, type SyncServerInfo, type SyncServerKind } from '@shared/sync'
import {
  fetchServerInfo,
  normalizeBaseUrl,
  protocolMismatch,
  SyncApiError,
  SyncHttp,
  SyncNetworkError,
  type Tokens
} from '@vendor/desktop/sync/http'
import { RealtimeClient, type RealtimeOptions, type WsState } from '@vendor/desktop/sync/ws'
import { passwordStrength } from '@vendor/site/lib/password'
import {
  ARGON2_DEFAULT,
  b64u,
  type Bytes,
  createKeyMaterial,
  deriveSubkeys,
  fromB64u,
  type KeysResponse,
  passwordChangeBody,
  type PasswordKekFn,
  recoveryChangeBody,
  type Subkeys,
  unlockWithPassword,
  unlockWithRecovery
} from '@/crypto'
import { UserError, retryAfterSeconds } from './errors'
import {
  type AccountInfo,
  type Connection,
  type DeviceInfo,
  initialSession,
  NEW_RECOVERY_KEY_NOTICE,
  reasonForCode,
  reduceSession,
  type ServerChoice,
  type SessionEvent,
  type SessionState,
  type SignOutReason
} from './session'
import { KV, type KeyValueStore, type SecretStore, SESSION_KEYS } from './storage'

export interface RealtimeLike {
  start(): void
  stop(): void
  getState(): WsState
  /** Requisição com `id` → ack (campos) ou erro `WsRequestError` (§10.1). */
  request(
    t: string,
    fields?: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<Record<string, unknown>>
}

/** Quem mais ouve o WebSocket da conta (o sync de dados: `sync.changes`, `chat.state`, welcome). */
export interface RealtimeListener {
  onWelcome?: (w: Record<string, unknown>) => void
  onEvent?: (f: Record<string, unknown>) => void
  onState?: (online: boolean) => void
}

export interface DeviceProfile {
  /** Nome padrão do aparelho (modelo), editável antes de entrar. */
  defaultName: string
  platform: 'android' | 'ios'
  appVersion: string
}

export interface AccountDeps {
  secrets: SecretStore
  kv: KeyValueStore
  device: DeviceProfile
  /** CLEARCHAT_SYNC_URL: sobrepõe o servidor escolhido (desenvolvimento/testes). */
  envUrl?: string | null
  /** Abre o captcha da instância (§15) e devolve o token do Turnstile. */
  captcha?: (base: string, action: 'login') => Promise<string>
  fetchInfo?: (base: string) => Promise<SyncServerInfo>
  realtime?: (opts: RealtimeOptions) => RealtimeLike
  /** KEK da senha (padrão: Argon2id da camada de plataforma — nativo no aparelho). */
  kekFn?: PasswordKekFn
  /** Tempos do WebSocket (testes encurtam). */
  wsTiming?: RealtimeOptions['timing']
  now?: () => number
}

/** Opções de "Lembrar neste dispositivo". */
export interface RememberOptions {
  remember: boolean
  biometric?: boolean
}

/** Material de chaves gerado e ainda não enviado (a chave de recuperação aparece antes). */
export interface PendingKeys {
  recoveryKey: string
  commit: (opts: RememberOptions) => Promise<void>
}

export interface PendingRecoveryKey {
  recoveryKey: string
  commit: () => Promise<void>
}

interface AuthResult {
  access_token: string
  access_expires_in: number
  refresh_token?: string
  user: { id: string; email: string; name: string }
  device_id: string
  keys_ready: boolean
  keys: KeysResponse | null
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
/** Fechamento 4403 até 30 s depois de `keys.reset` não é revogação (§10.2). */
const KEYS_RESET_GRACE_MS = 30_000
export const RESEND_COOLDOWN_MS = 60_000

export const normalizeEmail = (s: string): string =>
  String(s ?? '')
    .trim()
    .toLowerCase()

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

export class AccountService {
  readonly http: SyncHttp
  private readonly ws: RealtimeLike
  private readonly deps: AccountDeps
  private state: SessionState
  private listeners = new Set<() => void>()
  private tokens: Tokens | null = null
  private dek: Bytes | null = null
  private sk: Subkeys | null = null
  private recoveryDek: Bytes | null = null
  private info: SyncServerInfo | null = null
  private foreground = true
  private keysResetAt = 0
  private signingOut = false
  private loggingOut = false
  private rtListeners = new Set<RealtimeListener>()
  /** Cursor informado no `hello` (§10.3, informativo) — o sync de dados fornece. */
  helloCursor: () => number = () => 0
  /** Chats inscritos no stream no `hello` (o chat aberto — controle remoto). */
  helloSubscriptions: () => string[] = () => []

  constructor(deps: AccountDeps) {
    this.deps = deps
    this.state = initialSession(this.serverChoice())
    this.http = new SyncHttp({
      base: () => this.baseUrl(),
      tokens: {
        get: () => this.tokens,
        set: (t) => this.saveTokens(t)
      },
      appVersion: deps.device.appVersion,
      client: 'mobile',
      onSignedOut: (code) => void this.endSession(reasonForCode(code))
    })
    const opts: RealtimeOptions = {
      url: () => this.baseUrl().replace(/^http/, 'ws') + '/ws',
      hello: async () => {
        await this.http.ensureFresh()
        return {
          access_token: this.tokens?.access_token ?? '',
          cursor: this.helloCursor(),
          state_cursor: 0,
          active_windows: [],
          subscriptions: this.helloSubscriptions()
        }
      },
      onWelcome: (w) => this.onWelcome(w),
      onEvent: (f) => this.onEvent(f),
      onState: (s) => this.onWsState(s),
      onUnauthorized: async () => {
        try {
          return await this.http.refresh()
        } catch {
          return false
        }
      },
      onFatal: (code, reason) => this.onWsFatal(code, reason),
      timing: deps.wsTiming
    }
    this.ws = deps.realtime ? deps.realtime(opts) : new RealtimeClient(opts)
  }

  // ---------------- estado observável ----------------

  /** Requisição no WebSocket da conta (controle remoto: `remote.send`, `stream.*`, `host.pin`). */
  wsRequest(
    t: string,
    fields?: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<Record<string, unknown>> {
    return this.ws.request(t, fields, timeoutMs)
  }

  addRealtimeListener(l: RealtimeListener): () => void {
    this.rtListeners.add(l)
    return () => this.rtListeners.delete(l)
  }

  /** Usuário da conta (null sem login). */
  get accountUserId(): string | null {
    return this.state.account?.userId ?? null
  }

  getState = (): SessionState => this.state

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private dispatch(e: SessionEvent): void {
    const next = reduceSession(this.state, e)
    if (next === this.state) return
    this.state = next
    for (const fn of this.listeners) fn()
  }

  /** Subchaves em memória (null quando bloqueado). */
  get subkeys(): Subkeys | null {
    return this.sk
  }

  get canUseBiometrics(): boolean {
    return this.deps.secrets.canUseBiometrics()
  }

  get defaultDeviceName(): string {
    return this.deps.device.defaultName
  }

  get serverInfo(): SyncServerInfo | null {
    return this.info
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  // ---------------- servidor (§20.1) ----------------

  private serverChoice(): ServerChoice {
    const { kv, envUrl } = this.deps
    if (envUrl)
      return {
        kind: 'self',
        url: normalizeBaseUrl(envUrl),
        name: kv.get(KV.serverName),
        envOverride: true
      }
    const url = kv.get(KV.serverUrl)
    if (kv.get(KV.serverKind) === 'self' && url)
      return { kind: 'self', url, name: kv.get(KV.serverName) }
    return { kind: 'official', url: OFFICIAL_SYNC_URL, name: kv.get(KV.serverName) }
  }

  baseUrl(): string {
    return this.state.server.url
  }

  /** Valida um servidor (`GET /api/info` + protocolo compatível). Não muda nada. */
  async probeServer(input?: string): Promise<SyncServerInfo> {
    const base = input === undefined ? this.baseUrl() : normalizeBaseUrl(input)
    const info = await (this.deps.fetchInfo ?? fetchServerInfo)(base)
    const mismatch = protocolMismatch(info)
    if (mismatch) throw new UserError(mismatch)
    if (base === this.baseUrl()) this.rememberInfo(info)
    return info
  }

  private rememberInfo(info: SyncServerInfo): void {
    this.info = info
    if (this.deps.kv.get(KV.serverName) !== info.name) this.deps.kv.set(KV.serverName, info.name)
    if (this.state.server.name !== info.name)
      this.dispatch({ type: 'server', server: { ...this.state.server, name: info.name } })
  }

  /** Troca de servidor — só sem conta (§20.1: um app fala com uma instância por vez). */
  async setServer(kind: SyncServerKind, input?: string): Promise<SyncServerInfo | null> {
    if (this.state.phase !== 'signed-out')
      throw new UserError('Saia da conta antes de trocar de servidor.')
    if (this.deps.envUrl) throw new UserError('O servidor está fixado por CLEARCHAT_SYNC_URL.')
    const { kv } = this.deps
    if (kind === 'self') {
      const base = normalizeBaseUrl(input ?? '')
      const info = await this.probeServer(base)
      kv.set(KV.serverKind, 'self')
      kv.set(KV.serverUrl, base)
      kv.set(KV.serverName, info.name)
      this.info = info
      this.dispatch({ type: 'server', server: { kind: 'self', url: base, name: info.name } })
      return info
    }
    kv.set(KV.serverKind, 'official')
    kv.set(KV.serverUrl, null)
    kv.set(KV.serverName, null)
    this.info = null
    this.dispatch({
      type: 'server',
      server: { kind: 'official', url: OFFICIAL_SYNC_URL, name: null }
    })
    return null
  }

  // ---------------- inicialização ----------------

  /** Abertura do app: tokens + DEK lembrada → direto; só tokens → desbloqueio. */
  async init(): Promise<void> {
    const { kv, secrets } = this.deps
    this.tokens = parseJson<Tokens>(secrets.getTokens())
    const account = this.storedAccount()
    const device = this.storedDevice()
    const signedIn = !!this.tokens && !!account && !!device
    if (!signedIn && (this.tokens || account)) this.wipeSessionStorage()
    const hasKeys = signedIn && !!kv.get(KV.keys)
    const remember = kv.get(KV.remember) !== '0'
    const biometric = kv.get(KV.biometric) === '1'
    let unlocked = false
    if (hasKeys && remember) {
      let raw: string | null = null
      try {
        raw = await secrets.getDek()
      } catch {
        raw = null
      }
      if (raw) {
        try {
          await this.openVault(fromB64u(raw))
          unlocked = true
        } catch {
          await secrets.setDek(null).catch(() => undefined)
        }
      }
    }
    this.dispatch({
      type: 'restored',
      server: this.serverChoice(),
      account: signedIn ? account : null,
      device: signedIn ? device : null,
      hasKeys,
      unlocked,
      remember,
      biometric
    })
    this.updateRealtime()
  }

  private storedAccount(): AccountInfo | null {
    const { kv } = this.deps
    const userId = kv.get(KV.userId)
    if (!userId) return null
    return { userId, email: kv.get(KV.email) ?? '', name: kv.get(KV.accountName) ?? '' }
  }

  private storedDevice(): DeviceInfo | null {
    const { kv } = this.deps
    const id = kv.get(KV.deviceId)
    if (!id) return null
    return { id, name: kv.get(KV.deviceName) ?? this.deps.device.defaultName }
  }

  private storedKeys(): KeysResponse | null {
    return parseJson<KeysResponse>(this.deps.kv.get(KV.keys))
  }

  private saveTokens(t: Tokens | null): void {
    this.tokens = t
    this.deps.secrets.setTokens(t ? JSON.stringify(t) : null)
  }

  private saveKeys(k: KeysResponse | null): void {
    this.deps.kv.set(KV.keys, k ? JSON.stringify(k) : null)
    this.deps.kv.set(KV.keysRev, k ? String(k.keys_rev) : null)
  }

  // ---------------- login por código (§5.2, §5.3, §6.3) ----------------

  /** Último e-mail usado no login (preenche o campo ao voltar; só em memória). */
  lastEmail = ''

  async requestCode(email: string): Promise<void> {
    const e = normalizeEmail(email)
    if (!EMAIL_RE.test(e)) throw new UserError('Digite um e-mail válido.')
    this.lastEmail = e
    const info = await this.probeServer()
    let token: string | undefined
    if (info.captcha) {
      if (!this.deps.captcha) throw new UserError('Este servidor exige captcha.')
      token = await this.deps.captcha(this.baseUrl(), 'login')
    }
    try {
      await this.http.post(
        '/api/v1/auth/code/request',
        { email: e, ...(token ? { turnstile_token: token } : {}) },
        false
      )
    } catch (err) {
      const ra = retryAfterSeconds(err)
      if (ra) this.dispatch({ type: 'rate-limited', until: this.now() + ra * 1000 })
      throw err
    }
    this.dispatch({ type: 'code-sent', email: e, at: this.now() })
  }

  cancelLogin(): void {
    this.dispatch({ type: 'login-cancelled' })
  }

  async verifyCode(code: string, deviceName?: string): Promise<void> {
    const login = this.state.login
    if (!login) throw new UserError('Peça o código de novo.')
    const c = String(code ?? '').replace(/\D/g, '')
    if (c.length !== 6) throw new UserError('O código tem 6 dígitos.')
    const name = (deviceName?.trim() || this.deps.device.defaultName).slice(0, 64)
    let r: AuthResult
    try {
      r = await this.http.post<AuthResult>(
        '/api/v1/auth/code/verify',
        {
          email: login.email,
          code: c,
          device: {
            name,
            platform: this.deps.device.platform,
            client: 'mobile',
            app_version: this.deps.device.appVersion,
            can_host: true
          }
        },
        false
      )
    } catch (err) {
      const ra = retryAfterSeconds(err)
      if (ra) this.dispatch({ type: 'rate-limited', until: this.now() + ra * 1000 })
      throw err
    }
    if (!r.refresh_token) throw new Error('O servidor não devolveu o refresh token.')
    const { kv } = this.deps
    this.saveTokens({
      access_token: r.access_token,
      access_expires_at: this.now() + (r.access_expires_in ?? 3600) * 1000,
      refresh_token: r.refresh_token
    })
    kv.set(KV.userId, r.user.id)
    kv.set(KV.email, r.user.email)
    kv.set(KV.accountName, r.user.name ?? '')
    kv.set(KV.deviceId, r.device_id)
    kv.set(KV.deviceName, name)
    const hasKeys = r.keys_ready && !!r.keys
    this.saveKeys(hasKeys ? r.keys : null)
    this.dispatch({
      type: 'signed-in',
      account: { userId: r.user.id, email: r.user.email, name: r.user.name ?? '' },
      device: { id: r.device_id, name },
      hasKeys
    })
    this.updateRealtime()
  }

  // ---------------- chaves (§3.4–3.8, §5.5, §6.5) ----------------

  private get userId(): string {
    const id = this.state.account?.userId
    if (!id) throw new UserError('Entre na conta primeiro.')
    return id
  }

  /**
   * Relê `GET /keys`. `silent` = chamada interna (evento/welcome): não lança. Conta sem chaves
   * (`409 keys_not_ready`) com chaves em cache = as chaves foram redefinidas (§5.5).
   */
  async refreshKeys(silent = false): Promise<boolean> {
    try {
      const k = await this.http.get<KeysResponse>('/api/v1/keys')
      this.saveKeys(k)
      if (this.state.phase === 'needs-setup') {
        this.dispatch({ type: 'keys-ready' })
        this.updateRealtime()
      }
      return true
    } catch (e) {
      if (e instanceof SyncApiError && e.code === 'keys_not_ready') {
        if (this.storedKeys() || this.state.phase === 'unlocked' || this.state.phase === 'locked')
          await this.onKeysReset()
        if (silent) return false
        throw new UserError(
          'A conta ainda não tem senha de criptografia. Defina-a e tente de novo.',
          { cause: e }
        )
      }
      if (silent) return false
      throw e
    }
  }

  /** Chaves frescas do servidor; sem rede, as do cache. */
  private async currentKeys(): Promise<KeysResponse> {
    const cached = this.storedKeys()
    try {
      const k = await this.http.get<KeysResponse>('/api/v1/keys')
      this.saveKeys(k)
      return k
    } catch (e) {
      if (e instanceof SyncApiError && e.code === 'keys_not_ready') {
        await this.onKeysReset()
        throw new UserError('As chaves da conta foram redefinidas. Defina a nova senha.', {
          cause: e
        })
      }
      if (e instanceof SyncNetworkError && cached) return cached
      throw e
    }
  }

  private checkNewPassword(pw: string): void {
    const s = passwordStrength(pw, this.state.account?.email ?? '')
    if (!s.ok) throw new UserError(s.errors[0] ?? 'Senha fraca demais.')
  }

  /** DEK → subchaves em memória e, se pedido, no Keystore. */
  private async openVault(dek: Bytes, opts?: RememberOptions): Promise<void> {
    const sk = await deriveSubkeys(dek)
    this.dek = dek
    this.sk = sk
    if (!opts) return
    const { kv, secrets } = this.deps
    let biometric = !!opts.biometric && opts.remember && secrets.canUseBiometrics()
    if (opts.remember) {
      try {
        await secrets.setDek(b64u(dek), { biometric })
      } catch {
        // biometria indisponível na hora de gravar: não guarda (pede a senha na próxima abertura)
        biometric = false
        await secrets.setDek(null).catch(() => undefined)
        kv.set(KV.remember, '0')
        kv.set(KV.biometric, '0')
        this.dispatch({ type: 'unlocked', remember: false, biometric: false })
        return
      }
    } else {
      await secrets.setDek(null)
    }
    kv.set(KV.remember, opts.remember ? '1' : '0')
    kv.set(KV.biometric, biometric ? '1' : '0')
    this.dispatch({ type: 'unlocked', remember: opts.remember, biometric })
  }

  private forgetKeysInMemory(): void {
    this.dek?.fill(0)
    this.recoveryDek?.fill(0)
    this.dek = this.sk = this.recoveryDek = null
  }

  /** Senha de criptografia → DEK (Argon2id fora da thread do JS). Senha errada → AuthError. */
  async unlock(password: string, opts: RememberOptions): Promise<void> {
    if (this.state.phase !== 'locked') throw new UserError('Nada para desbloquear.')
    if (!password) throw new UserError('Digite a senha de criptografia.')
    const keys = await this.currentKeys()
    const dek = await unlockWithPassword(this.userId, keys, password, this.deps.kekFn)
    await this.openVault(dek, opts)
    // parâmetros abaixo do padrão atual: regrava a wrap (§3.4) — em segundo plano
    const k = keys.password.kdf
    if (k.m < ARGON2_DEFAULT.m || k.t < ARGON2_DEFAULT.t)
      void this.changePassword(password, true).catch(() => undefined)
  }

  /** DEK lembrada com biometria (o prompt foi cancelado na abertura): tenta de novo. */
  async unlockWithBiometrics(): Promise<boolean> {
    if (this.state.phase !== 'locked' || !this.state.biometric) return false
    const raw = await this.deps.secrets.getDek().catch(() => null)
    if (!raw) return false
    await this.openVault(fromB64u(raw))
    this.dispatch({ type: 'unlocked', remember: true, biometric: true })
    return true
  }

  /** Há DEK guardada com biometria (oferecer "Desbloquear com biometria")? */
  get hasBiometricDek(): boolean {
    return this.state.biometric && this.state.remember && this.deps.kv.get(KV.biometric) === '1'
  }

  /** 1º passo da recuperação: chave → DEK (fica pendente até definir a senha nova, §5.2/§5.5). */
  async beginRecovery(input: string): Promise<void> {
    if (this.state.phase !== 'locked') throw new UserError('Nada para desbloquear.')
    const keys = await this.currentKeys()
    this.recoveryDek?.fill(0)
    this.recoveryDek = await unlockWithRecovery(this.userId, keys, input)
  }

  get recoveryPending(): boolean {
    return !!this.recoveryDek
  }

  /** 2º passo: senha nova obrigatória (`PUT /keys/password` com key_proof) e abre o cofre. */
  async finishRecovery(newPassword: string, opts: RememberOptions): Promise<void> {
    const dek = this.recoveryDek
    if (!dek) throw new UserError('Digite a chave de recuperação primeiro.')
    this.checkNewPassword(newPassword)
    const body = await passwordChangeBody(
      this.userId,
      dek,
      newPassword,
      ARGON2_DEFAULT,
      this.deps.kekFn
    )
    await this.http.put('/api/v1/keys/password', body)
    await this.refreshKeys(true)
    this.recoveryDek = null
    await this.openVault(dek, opts)
    this.dispatch({ type: 'notice', notice: NEW_RECOVERY_KEY_NOTICE })
  }

  /** Troca a senha de criptografia (exige o cofre aberto). */
  async changePassword(newPassword: string, skipPolicy = false): Promise<void> {
    if (!this.dek) throw new UserError('Desbloqueie a conta primeiro.')
    if (!skipPolicy) this.checkNewPassword(newPassword)
    const body = await passwordChangeBody(
      this.userId,
      this.dek,
      newPassword,
      ARGON2_DEFAULT,
      this.deps.kekFn
    )
    await this.http.put('/api/v1/keys/password', body)
    await this.refreshKeys(true)
  }

  /** Nova chave de recuperação: gera e mostra; só vale depois do `commit` (PUT /keys/recovery). */
  async newRecoveryKey(): Promise<PendingRecoveryKey> {
    const dek = this.dek
    if (!dek) throw new UserError('Desbloqueie a conta primeiro.')
    const r = await recoveryChangeBody(this.userId, dek)
    return {
      recoveryKey: r.recoveryKey,
      commit: async () => {
        await this.http.put('/api/v1/keys/recovery', r.body)
        await this.refreshKeys(true)
      }
    }
  }

  /**
   * Conta sem chaves (§5.1): gera DEK, wraps e a chave de recuperação no aparelho. A chave aparece
   * antes; `commit` envia `POST /keys/setup` (só depois da confirmação do usuário) e abre o cofre.
   */
  async setupKeys(password: string): Promise<PendingKeys> {
    if (this.state.phase !== 'needs-setup') throw new UserError('A conta já tem chaves.')
    this.checkNewPassword(password)
    const userId = this.userId
    const m = await createKeyMaterial(userId, password, ARGON2_DEFAULT, this.deps.kekFn)
    return {
      recoveryKey: m.recoveryKey,
      commit: async (opts) => {
        let keys: KeysResponse
        try {
          keys = await this.http.post<KeysResponse>('/api/v1/keys/setup', m.body)
        } catch (e) {
          if (e instanceof SyncApiError && e.code === 'keys_already_set') {
            await this.refreshKeys(true)
            throw new UserError(
              'As chaves desta conta já foram definidas em outro lugar. Desbloqueie com a senha de criptografia.',
              { cause: e }
            )
          }
          throw e
        }
        this.saveKeys(keys)
        this.keysResetAt = 0
        this.dispatch({ type: 'keys-ready' })
        await this.openVault(m.dek, opts)
        this.updateRealtime()
      }
    }
  }

  // ---------------- dispositivo (§6.6) ----------------

  async renameDevice(name: string): Promise<void> {
    const dev = this.state.device
    if (!dev) throw new UserError('Entre na conta primeiro.')
    const n = name.trim().slice(0, 64)
    if (!n) throw new UserError('Dê um nome ao aparelho.')
    await this.http.patch(`/api/v1/devices/${encodeURIComponent(dev.id)}`, { name: n })
    this.deps.kv.set(KV.deviceName, n)
    this.dispatch({ type: 'device-renamed', name: n })
  }

  // ---------------- bloquear / sair ----------------

  /** Tira a DEK da memória e do Keystore; continua logado (pede a senha de novo). */
  async lock(): Promise<void> {
    if (this.state.phase !== 'unlocked') return
    this.forgetKeysInMemory()
    await this.deps.secrets.setDek(null).catch(() => undefined)
    this.dispatch({ type: 'locked' })
  }

  /** Sair: revoga o dispositivo no servidor (`POST /auth/logout`) e apaga tokens e DEK. */
  async logout(): Promise<void> {
    // o servidor fecha o socket com 4403 device_revoked ao revogar: fecha antes, senão a saída
    // voluntária vira "dispositivo desconectado"
    this.loggingOut = true
    this.ws.stop()
    try {
      if (this.tokens) {
        try {
          await this.http.req('POST', '/api/v1/auth/logout', { json: {}, timeoutMs: 8_000 })
        } catch {
          /* offline / já revogado: sai só localmente */
        }
      }
      await this.endSession('logout')
    } finally {
      this.loggingOut = false
    }
  }

  private wipeSessionStorage(): void {
    this.tokens = null
    this.deps.secrets.setTokens(null)
    for (const k of SESSION_KEYS) this.deps.kv.set(k, null)
  }

  /** Fim da sessão (logout, revogação, conta apagada…): apaga credenciais e DEK (§3.13, §5.4). */
  private async endSession(reason: SignOutReason): Promise<void> {
    if (this.signingOut || this.state.phase === 'signed-out') return
    if (this.loggingOut && reason !== 'logout') return
    this.signingOut = true
    try {
      this.ws.stop()
      this.forgetKeysInMemory()
      this.wipeSessionStorage()
      await this.deps.secrets.setDek(null).catch(() => undefined)
      this.dispatch({ type: 'signed-out', reason })
    } finally {
      this.signingOut = false
    }
  }

  private async onKeysReset(): Promise<void> {
    this.keysResetAt = this.now()
    this.forgetKeysInMemory()
    this.saveKeys(null)
    await this.deps.secrets.setDek(null).catch(() => undefined)
    this.dispatch({ type: 'keys-reset' })
  }

  dismissNotice(): void {
    this.dispatch({ type: 'notice', notice: null })
  }

  // ---------------- WebSocket (só eventos de sessão nesta fase) ----------------

  /** App em primeiro/segundo plano: o SO derruba o socket em segundo plano — fecha antes. */
  setForeground(fg: boolean): void {
    if (this.foreground === fg) return
    this.foreground = fg
    this.updateRealtime()
  }

  private updateRealtime(): void {
    const p = this.state.phase
    const want =
      this.foreground &&
      !!this.tokens &&
      (p === 'locked' || p === 'unlocked' || p === 'needs-setup')
    if (want) this.ws.start()
    else this.ws.stop()
  }

  private onWsState(s: WsState): void {
    const map: Record<WsState, Connection> = {
      idle: 'offline',
      connecting: 'connecting',
      online: 'online',
      offline: 'connecting',
      stopped: 'offline'
    }
    for (const l of this.rtListeners) l.onState?.(s === 'online')
    if (this.state.connection === 'error' && s === 'stopped') return
    this.dispatch({ type: 'connection', connection: map[s] })
  }

  private onWelcome(w: Record<string, unknown>): void {
    const rev = typeof w.keys_rev === 'number' ? w.keys_rev : null
    const known = Number(this.deps.kv.get(KV.keysRev) ?? 0)
    if (rev !== null && rev !== known) void this.refreshKeys(true)
    else if (rev === null && this.state.phase !== 'needs-setup') void this.refreshKeys(true)
    for (const l of this.rtListeners) l.onWelcome?.(w)
  }

  private onEvent(f: Record<string, unknown>): void {
    switch (f.t) {
      case 'keys.changed':
        void this.refreshKeys(true)
        return
      case 'keys.reset':
        void this.onKeysReset()
        return
      case 'account.deleted':
        void this.endSession('account-deleted')
        return
      default:
        // sync.changes, chat.state → sync de dados (src/data); stream.*/remote.* → src/remote
        for (const l of this.rtListeners) l.onEvent?.(f)
    }
  }

  private onWsFatal(code: number, reason: string): void {
    if (code === 4403) {
      if (reason === 'keys_reset' || this.now() - this.keysResetAt < KEYS_RESET_GRACE_MS) {
        // não é revogação: reconecta quando houver chaves novas (setup/refreshKeys)
        if (reason === 'keys_reset' && this.state.phase !== 'needs-setup') void this.onKeysReset()
        return
      }
      void this.endSession(reasonForCode(reason || 'forbidden'))
      return
    }
    if (code === 4001) {
      this.dispatch({ type: 'connection', connection: 'error' })
      this.dispatch({
        type: 'notice',
        notice: {
          tone: 'danger',
          title: 'Protocolo incompatível',
          text: 'Este servidor usa uma versão incompatível do protocolo — atualize o app.'
        }
      })
      return
    }
    if (code === 4409) this.dispatch({ type: 'connection', connection: 'error' })
  }
}
