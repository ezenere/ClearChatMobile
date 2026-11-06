// Notificações no aparelho, parte de primeiro plano (SYNC_PROTOCOL.md §22): token do FCM no
// servidor (PushRegistrar), permissão do Android 13+, toque na notificação → abre o chat, avisos
// locais dos chats executados aqui e o handler de apresentação em primeiro plano. O recebimento em
// si (também com o app fechado) fica em ./task.ts.
import * as Notifications from 'expo-notifications'
import { AppState, Linking, Platform } from 'react-native'
import { account, kv } from '@/account/native'
import type { Phase } from '@/account/session'
import { store } from '@/data/native'
import { hostStack } from '@/host/native'
import { systemDialogOpen } from '@/platform/systemDialog'
import { LocalHostNotifier } from './localHost'
import { readPrefs, writePref, type PushPrefs } from './model'
import { type PermissionState, PushRegistrar, pushFeatureOf } from './registration'
import { dismiss, ensureChannels, present } from './task'

const log = (msg: string): void => {
  if (__DEV__) console.log(`[clearchat:push] ${msg}`)
}

// ---------------- instância / permissão / token ----------------

let feature: { base: string; at: number; value: boolean } | null = null
const FEATURE_TTL_MS = 10 * 60_000

/** `features.push` da instância (§6.2), com cache curto. null = não deu para saber. */
export async function serverSupportsPush(force = false): Promise<boolean | null> {
  const base = account.baseUrl()
  if (!force && feature && feature.base === base && Date.now() - feature.at < FEATURE_TTL_MS)
    return feature.value
  try {
    const res = await fetch(`${base}/api/info`, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return null
    const value = pushFeatureOf(await res.json())
    feature = { base, at: Date.now(), value }
    return value
  } catch {
    return null
  }
}

export async function permissionState(): Promise<PermissionState> {
  const p = await Notifications.getPermissionsAsync()
  if (p.granted) return 'granted'
  return p.status === 'denied' ? 'denied' : 'undetermined'
}

/** Pede a permissão (diálogo do sistema no Android 13+; antes disso já vem concedida). */
export async function requestPermission(): Promise<PermissionState> {
  await ensureChannels().catch(() => undefined)
  permissionDialog++
  try {
    const p = await Notifications.requestPermissionsAsync()
    kv.set(KV_ASKED, '1')
    return p.granted ? 'granted' : p.status === 'denied' ? 'denied' : 'undetermined'
  } finally {
    setTimeout(() => permissionDialog--, 1500)
  }
}

/** Configurações do sistema para o app (permissão negada de vez). */
export function openSystemSettings(): void {
  void Linking.openSettings().catch(() => undefined)
}

async function fcmToken(): Promise<string | null> {
  if (Platform.OS !== 'android') return null
  try {
    const t = await Promise.race([
      Notifications.getDevicePushTokenAsync(),
      new Promise<null>((r) => setTimeout(() => r(null), 20_000))
    ])
    return t && typeof t.data === 'string' && t.data ? t.data : null
  } catch (e) {
    // build sem google-services.json (Firebase não inicializado) ou sem Google Play Services
    log(`sem token do FCM: ${e instanceof Error ? e.message.slice(0, 120) : 'erro'}`)
    return null
  }
}

export const registrar = new PushRegistrar({
  http: account.http,
  kv,
  deviceId: () => account.getState().device?.id ?? null,
  serverSupportsPush: () => serverSupportsPush(),
  permission: permissionState,
  token: fcmToken,
  log
})

// ---------------- preferências ----------------

const prefListeners = new Set<() => void>()
let prefsSnapshot: PushPrefs = readPrefs(kv)

export const pushPrefs = {
  get: (): PushPrefs => prefsSnapshot,
  subscribe: (fn: () => void): (() => void) => {
    prefListeners.add(fn)
    return () => prefListeners.delete(fn)
  },
  set(key: keyof PushPrefs, value: boolean): void {
    writePref(kv, key, value)
    prefsSnapshot = readPrefs(kv)
    for (const fn of prefListeners) fn()
    if (key === 'enabled') void registrar.sync(value ? 'ligou' : 'desligou')
  }
}

// ---------------- "pedir na primeira vez" ----------------

const KV_ASKED = 'push.permission_asked'

/** Primeira entrada na conta: vale mostrar o convite antes do diálogo do sistema? */
export async function shouldOfferPermission(): Promise<boolean> {
  if (Platform.OS !== 'android' || kv.get(KV_ASKED) === '1') return false
  if (!readPrefs(kv).enabled) return false
  if ((await permissionState()) === 'granted') return false
  return (await serverSupportsPush()) === true
}

/** "Agora não" no convite: não pergunta de novo (fica nas Configurações → Notificações). */
export function declinePermissionOffer(): void {
  kv.set(KV_ASKED, '1')
}

// ---------------- toque na notificação → abre o chat ----------------

let pendingChat: string | null = null
const navListeners = new Set<() => void>()

export const pushNavigation = {
  /** Chat a abrir (consumido pela pilha da conta quando o cofre está aberto). */
  take(): string | null {
    const c = pendingChat
    pendingChat = null
    return c
  },
  peek: (): string | null => pendingChat,
  subscribe(fn: () => void): () => void {
    navListeners.add(fn)
    return () => navListeners.delete(fn)
  }
}

function onResponse(r: Notifications.NotificationResponse | null): void {
  if (!r) return
  log(`toque: ${r.actionIdentifier}`)
  if (r.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return
  const data = r.notification.request.content.data as { cc?: unknown; chatId?: unknown } | null
  if (data?.cc !== 'push') return
  Notifications.clearLastNotificationResponse()
  if (typeof data.chatId !== 'string' || !data.chatId) return
  pendingChat = data.chatId
  for (const fn of navListeners) fn()
}

// ---------------- chats executados neste celular ----------------

export const localHost = new LocalHostNotifier({
  subscribe: (fn) => hostStack.runner.bus.on(fn),
  isBackground: () => AppState.currentState !== 'active',
  prefs: () => readPrefs(kv),
  show: (n) => void present(n).catch(() => undefined),
  dismiss: (id) => void dismiss(id),
  chatTitle: (chatId) => store.chatSummary(chatId)?.title ?? '',
  hostName: () => account.getState().device?.name ?? ''
})

// ---------------- início ----------------

let started = false
let permissionDialog = 0
let lastSync = 0
const RESYNC_MS = 60 * 60_000

/**
 * Liga as notificações (uma vez, com a tela). Chamar ANTES do `startAccount`: o ouvinte de
 * segundo plano daqui precisa rodar antes do da conta, que para os turnos deste celular.
 */
export function startPush(): void {
  if (started) return
  started = true

  Notifications.setNotificationHandler({
    // primeiro plano: só os avisos montados pelo app (a mensagem de dados do FCM não tem texto e é
    // tratada pela tarefa, que já descarta o chat aberto)
    handleNotification: async (n) => {
      const local = (n.request.content.data as { cc?: unknown } | null)?.cc === 'push'
      return {
        shouldShowBanner: local,
        shouldShowList: local,
        shouldPlaySound: local,
        shouldSetBadge: false
      }
    }
  })
  void ensureChannels().catch(() => undefined)

  Notifications.addNotificationResponseReceivedListener(onResponse)
  onResponse(Notifications.getLastNotificationResponse())
  Notifications.addPushTokenListener((t) => {
    if (typeof t.data === 'string') registrar.onToken(t.data)
  })

  localHost.start()
  AppState.addEventListener('change', (s) => {
    if (s === 'background') {
      if (permissionDialog > 0 || systemDialogOpen()) return
      localHost.onBackground(hostStack.runner.busyChats())
    } else if (s === 'active') {
      localHost.onForeground()
      if (Date.now() - lastSync > RESYNC_MS && signedIn(account.getState().phase)) {
        lastSync = Date.now()
        void registrar.sync('primeiro plano')
      }
    }
  })

  let prev: Phase = account.getState().phase
  account.subscribe(() => {
    const phase = account.getState().phase
    if (phase === prev) return
    const was = prev
    prev = phase
    if (phase === 'signed-out') {
      registrar.forget()
      void Notifications.dismissAllNotificationsAsync().catch(() => undefined)
      return
    }
    // abertura do app (sessão restaurada), login e desbloqueio
    if (signedIn(phase) && (!signedIn(was) || phase === 'unlocked')) {
      lastSync = Date.now()
      void registrar.sync(phase === 'unlocked' ? 'desbloqueio' : 'abertura')
    }
  })
}

const signedIn = (p: Phase): boolean => p === 'locked' || p === 'unlocked' || p === 'needs-setup'
