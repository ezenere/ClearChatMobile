// Token de push deste aparelho no servidor (SYNC_PROTOCOL.md §22.2): `PUT /devices/current/push`
// depois do login/desbloqueio, a cada abertura (idempotente) e quando o FCM troca o token;
// `DELETE` quando o usuário desliga as notificações (ou nega a permissão). Sem `features.push` na
// instância, nada é registrado. Sem React Native: o token, a permissão e a sonda da instância entram
// por `RegistrarDeps` (os testes usam o servidor falso).
import { SyncApiError, SyncNetworkError } from '@vendor/desktop/sync/http'
import type { KeyValueStore } from '@/account/storage'
import { readPrefs } from './model'

export const PUSH_PATH = '/api/v1/devices/current/push'

export type PushStatus =
  /** Ainda não conferiu. */
  | 'idle'
  | 'signed-out'
  /** Desligado pelo usuário neste aparelho. */
  | 'off'
  /** A instância não tem push (`features.push` nulo) ou não conhece a rota. */
  | 'unavailable'
  /** Build sem o Firebase (sem google-services.json) ou sem Google Play Services: sem token. */
  | 'no-token'
  /** Permissão de notificações negada (ou ainda não pedida). */
  | 'no-permission'
  | 'registered'
  /** Falha de rede/servidor (tenta de novo na próxima abertura/conexão). */
  | 'error'

export type PermissionState = 'granted' | 'denied' | 'undetermined'

export interface RegistrarHttp {
  req(method: string, path: string, o?: { json?: unknown; timeoutMs?: number }): Promise<unknown>
}

export interface RegistrarDeps {
  http: RegistrarHttp
  kv: KeyValueStore
  /** Dispositivo logado (null = sem login). */
  deviceId: () => string | null
  /** `features.push` da instância inclui `fcm`? null = não deu para saber (offline). */
  serverSupportsPush: () => Promise<boolean | null>
  permission: () => Promise<PermissionState>
  /** Token nativo do FCM (null = indisponível neste build/aparelho). */
  token: () => Promise<string | null>
  log?: (msg: string) => void
}

const KV_DEVICE = 'push.registered_device'
const KV_TOKEN = 'push.registered_token'

/** `features.push` (§6.2) → a instância aceita tokens FCM? */
export function pushFeatureOf(info: unknown): boolean {
  if (!info || typeof info !== 'object') return false
  const features = (info as { features?: unknown }).features
  if (!features || typeof features !== 'object') return false
  const push = (features as { push?: unknown }).push
  if (!push || typeof push !== 'object') return false
  const providers = (push as { providers?: unknown }).providers
  return Array.isArray(providers) && providers.includes('fcm')
}

export class PushRegistrar {
  private status: PushStatus = 'idle'
  private listeners = new Set<() => void>()
  private running: Promise<PushStatus> | null = null
  private again = false

  constructor(private readonly d: RegistrarDeps) {}

  getStatus = (): PushStatus => this.status

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private set(s: PushStatus): PushStatus {
    if (s !== this.status) {
      this.status = s
      for (const fn of this.listeners) fn()
    }
    return s
  }

  /** O servidor tem um token deste aparelho (registrado por esta instalação)? */
  registeredFor(deviceId: string): boolean {
    return this.d.kv.get(KV_DEVICE) === deviceId && !!this.d.kv.get(KV_TOKEN)
  }

  /**
   * O FCM avisou um token (o expo-notifications também avisa a cada `getDevicePushTokenAsync`):
   * só registra de novo se mudou — senão o próprio registro geraria outro aviso, em laço.
   */
  onToken(token: string): void {
    if (token && token !== this.d.kv.get(KV_TOKEN)) void this.sync('token novo')
  }

  /** Esquece o registro local (logout/revogação: o servidor já apagou o token, §22.2). */
  forget(): void {
    this.d.kv.set(KV_DEVICE, null)
    this.d.kv.set(KV_TOKEN, null)
    this.set('signed-out')
  }

  /**
   * Confere e registra/remove o token conforme as preferências, a permissão e a instância.
   * Chamadas simultâneas se juntam (uma roda de novo no fim se outra chegou no meio).
   */
  sync(reason = ''): Promise<PushStatus> {
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = (async () => {
      let s: PushStatus
      do {
        this.again = false
        s = await this.once(reason)
      } while (this.again)
      return s
    })().finally(() => {
      this.running = null
    })
    return this.running
  }

  private async remove(deviceId: string): Promise<void> {
    if (!this.registeredFor(deviceId)) return
    await this.d.http.req('DELETE', PUSH_PATH, { timeoutMs: 15_000 })
    this.d.kv.set(KV_DEVICE, null)
    this.d.kv.set(KV_TOKEN, null)
  }

  private async once(reason: string): Promise<PushStatus> {
    const { kv, log } = this.d
    const deviceId = this.d.deviceId()
    if (!deviceId) {
      kv.set(KV_DEVICE, null)
      kv.set(KV_TOKEN, null)
      return this.set('signed-out')
    }
    try {
      if (!readPrefs(kv).enabled) {
        await this.remove(deviceId)
        return this.set('off')
      }
      const supported = await this.d.serverSupportsPush().catch(() => null)
      if (supported === false) return this.set('unavailable')
      const perm = await this.d.permission().catch((): PermissionState => 'undetermined')
      if (perm !== 'granted') {
        // sem permissão o aviso não aparece: o host não deve contar com este aparelho (§22.5)
        await this.remove(deviceId)
        return this.set('no-permission')
      }
      const token = await this.d.token().catch(() => null)
      if (!token) return this.set('no-token')
      await this.d.http.req('PUT', PUSH_PATH, {
        json: { provider: 'fcm', token },
        timeoutMs: 15_000
      })
      kv.set(KV_DEVICE, deviceId)
      kv.set(KV_TOKEN, token)
      log?.(`token registrado (${reason || 'sync'})`)
      return this.set('registered')
    } catch (e) {
      if (e instanceof SyncApiError && (e.status === 404 || e.code === 'push_unavailable'))
        return this.set('unavailable')
      log?.(
        `registro do token falhou: ${e instanceof SyncNetworkError ? 'sem rede' : e instanceof SyncApiError ? e.code : 'erro'}`
      )
      return this.set('error')
    }
  }
}
