// Recebimento dos avisos push (SYNC_PROTOCOL.md §22.7) e exibição — também com o app fechado: a
// tarefa do expo-notifications/expo-task-manager roda para TODA mensagem de dados do FCM (primeiro
// plano, segundo plano e app morto, num JS sem tela). Por isso este módulo é importado pelo
// `index.ts` (escopo do módulo, antes do expo-router) e é leve: só a conta (kv + Keystore), a
// cripto e o expo-notifications — nada do sync, do host nem das telas.
import * as Notifications from 'expo-notifications'
import { AndroidImportance, AndroidNotificationVisibility } from 'expo-notifications'
import * as TaskManager from 'expo-task-manager'
import { AppState, Platform } from 'react-native'
import { kv, account, readDekWithoutPrompt } from '@/account/native'
import { KV } from '@/account/storage'
import { fromB64u } from '@/crypto'
import { pushKey } from './crypto'
import {
  CHANNELS,
  decidePush,
  describeDecision,
  extractFcmData,
  readPrefs,
  type PushDecision,
  type ShownNotification
} from './model'

export const PUSH_TASK = 'clearchat-push'

const log = (msg: string): void => {
  if (__DEV__) console.log(`[clearchat:push] ${msg}`)
}

// ---------------- chat aberto na tela (§22.7: primeiro plano com o chat aberto → não mostra) ----

let openChat: string | null = null

/** A tela da conversa avisa qual chat está aberto (null ao sair). */
export function setOpenChat(chatId: string | null): void {
  openChat = chatId
  if (chatId) void dismissChat(chatId)
}

export const isChatOpen = (chatId: string): boolean =>
  openChat === chatId && AppState.currentState === 'active'

// ---------------- canais e exibição ----------------

let channels: Promise<void> | null = null

/** Cria os canais do Android (idempotente; o usuário ajusta som/importância nas configurações do sistema). */
export function ensureChannels(): Promise<void> {
  if (Platform.OS !== 'android') return Promise.resolve()
  channels ??= (async () => {
    for (const c of Object.values(CHANNELS))
      await Notifications.setNotificationChannelAsync(c.id, {
        name: c.name,
        description: c.description,
        importance: c.importance === 'high' ? AndroidImportance.HIGH : AndroidImportance.DEFAULT,
        // tela bloqueada: o Android esconde o conteúdo (só "ClearChat" e "Conteúdo oculto")
        lockscreenVisibility: AndroidNotificationVisibility.PRIVATE,
        showBadge: true,
        enableVibrate: true
      })
  })().catch((e: unknown) => {
    channels = null
    throw e
  })
  return channels
}

export async function present(n: ShownNotification): Promise<void> {
  await ensureChannels().catch(() => undefined)
  await Notifications.scheduleNotificationAsync({
    identifier: n.id,
    content: {
      title: n.title,
      body: n.body,
      subtitle: n.subtitle ?? null,
      data: n.data,
      color: '#6a4be0',
      autoDismiss: true,
      priority:
        n.channel === CHANNELS.pending.id
          ? Notifications.AndroidNotificationPriority.HIGH
          : Notifications.AndroidNotificationPriority.DEFAULT
    },
    trigger: Platform.OS === 'android' ? { channelId: n.channel } : null
  })
}

export async function dismiss(id: string): Promise<void> {
  await Notifications.dismissNotificationAsync(id).catch(() => undefined)
}

/** Apaga os avisos de um chat que o usuário abriu. */
export async function dismissChat(chatId: string): Promise<void> {
  try {
    const shown = await Notifications.getPresentedNotificationsAsync()
    for (const n of shown) {
      const data = n.request.content.data as { cc?: unknown; chatId?: unknown } | null
      if (data?.cc === 'push' && data.chatId === chatId)
        await Notifications.dismissNotificationAsync(n.request.identifier)
    }
  } catch {
    /* sem permissão / sem notificações */
  }
}

// ---------------- recebimento ----------------

/** K_push sem interação: o cofre aberto (memória) ou a DEK lembrada sem biometria no Keystore. */
let devNoKey = false
/** Desenvolvimento (rota /dev/push): finge a DEK indisponível para ver o texto genérico. */
export function setDevNoKey(v: boolean): void {
  if (__DEV__) devNoKey = v
}

async function keyWithoutPrompt(): Promise<Uint8Array | null> {
  if (__DEV__ && devNoKey) return null
  const mem = account.pushKey
  if (mem) return mem
  const raw = await readDekWithoutPrompt(kv)
  if (!raw) return null
  const dek = fromB64u(raw)
  try {
    return await pushKey(dek)
  } finally {
    dek.fill(0)
  }
}

/** Trata uma mensagem de dados do FCM (a tarefa e a rota de desenvolvimento passam por aqui). */
export async function handlePushData(payload: unknown): Promise<PushDecision | null> {
  const data = extractFcmData(payload)
  if (!data) {
    log('mensagem sem os campos do ClearChat')
    return null
  }
  const d = await decidePush(data, {
    userId: kv.get(KV.userId),
    key: keyWithoutPrompt,
    prefs: readPrefs(kv),
    now: Date.now(),
    chatOpen: isChatOpen
  })
  log(describeDecision(d))
  try {
    if (d.action === 'show') await present(d.notification)
    else if (d.action === 'dismiss') await dismiss(d.id)
  } catch (e) {
    log(`falha ao exibir: ${e instanceof Error ? e.message : 'erro'}`)
  }
  return d
}

const isResponse = (data: unknown): boolean =>
  !!data && typeof data === 'object' && 'actionIdentifier' in data

TaskManager.defineTask<Notifications.NotificationTaskPayload>(
  PUSH_TASK,
  async ({ data, error }) => {
    if (error || isResponse(data)) return Notifications.BackgroundNotificationTaskResult.NoData
    try {
      const d = await handlePushData(data)
      return d?.action === 'show'
        ? Notifications.BackgroundNotificationTaskResult.NewData
        : Notifications.BackgroundNotificationTaskResult.NoData
    } catch {
      return Notifications.BackgroundNotificationTaskResult.Failed
    }
  }
)

// registrar no escopo do módulo (docs do expo-notifications); persiste entre aberturas
Notifications.registerTaskAsync(PUSH_TASK).catch((e: unknown) =>
  log(`registerTaskAsync falhou: ${e instanceof Error ? e.message : 'erro'}`)
)
