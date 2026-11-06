// Notificações push no celular (SYNC_PROTOCOL.md §22.7) — parte pura, sem React Native: o que fazer
// com uma mensagem de dados do FCM (mostrar / apagar / descartar), os textos genéricos, os canais do
// Android e as preferências do aparelho (§4.4). A ligação com o expo-notifications fica em
// ./native.ts; os chats executados no próprio celular usam o mesmo `buildNotification`.
import type { KeyValueStore } from '@/account/storage'
import { openPush } from './crypto'

/** Tipos com conteúdo cifrado (§22.3). */
export const CONTENT_KINDS = ['approval', 'question', 'retry', 'reply', 'error'] as const
export type ContentKind = (typeof CONTENT_KINDS)[number]
export type PushKind = ContentKind | 'dismiss' | 'host_offline'

/** §17.1 */
export const PUSH_MAX_AGE_MS = 86_400_000
export const PUSH_TEXT_MAX_CHARS = 200
export const PUSH_TITLE_MAX_CHARS = 120

/** Plaintext do aviso (§22.4). */
export interface PushPayload {
  sv: number
  kind: ContentKind
  chatId: string
  sessionId?: string
  chatTitle: string
  text: string
  requestId?: string
  hostName: string
  /** Desde 1.8.0: device_id do host (escritores ≥ 1.8.0 DEVEM enviar). */
  hostDeviceId?: string
  /** Desde 1.8.0: chat só ao vivo (§23) — tocar abre o visualizador ao vivo. */
  live?: true
  ts: number
}

// ---------------- canais do Android e categorias das preferências ----------------

export type Category = 'pending' | 'reply' | 'error' | 'hostOffline'

export const CATEGORY_OF: Record<ContentKind | 'host_offline', Category> = {
  approval: 'pending',
  question: 'pending',
  retry: 'pending',
  reply: 'reply',
  error: 'error',
  host_offline: 'hostOffline'
}

export interface ChannelSpec {
  id: string
  name: string
  description: string
  /** high = aparece por cima (heads-up) e toca; default = só na bandeja com som. */
  importance: 'high' | 'default'
}

export const CHANNELS: Record<Category, ChannelSpec> = {
  pending: {
    id: 'pending',
    name: 'Pendências',
    description: 'Aprovações, perguntas do agente e novas tentativas esperando por você',
    importance: 'high'
  },
  reply: {
    id: 'replies',
    name: 'Respostas',
    description: 'Resposta pronta num chat',
    importance: 'default'
  },
  error: {
    id: 'errors',
    name: 'Erros',
    description: 'Turno que parou com erro',
    importance: 'default'
  },
  hostOffline: {
    id: 'host-offline',
    name: 'Host offline',
    description: 'O computador que executava um chat ficou offline',
    importance: 'default'
  }
}

// ---------------- preferências do aparelho (§4.4) ----------------

export interface PushPrefs {
  /** Interruptor geral (registra/remove o token). */
  enabled: boolean
  pending: boolean
  reply: boolean
  error: boolean
  hostOffline: boolean
  /** Mostrar o trecho decifrado (padrão: sim). */
  excerpt: boolean
}

export const DEFAULT_PREFS: PushPrefs = {
  enabled: true,
  pending: true,
  reply: true,
  error: true,
  hostOffline: true,
  excerpt: true
}

export const PREF_KEYS: Record<keyof PushPrefs, string> = {
  enabled: 'push.enabled',
  pending: 'push.kind.pending',
  reply: 'push.kind.reply',
  error: 'push.kind.error',
  hostOffline: 'push.kind.host_offline',
  excerpt: 'push.excerpt'
}

export function readPrefs(kv: KeyValueStore): PushPrefs {
  const out = { ...DEFAULT_PREFS }
  for (const k of Object.keys(PREF_KEYS) as (keyof PushPrefs)[]) {
    const v = kv.get(PREF_KEYS[k])
    if (v === '0') out[k] = false
    else if (v === '1') out[k] = true
  }
  return out
}

export function writePref(kv: KeyValueStore, key: keyof PushPrefs, value: boolean): void {
  kv.set(PREF_KEYS[key], value ? '1' : '0')
}

// ---------------- textos ----------------

/** Sem a DEK (biometria, "não lembrar", bloqueado): só o tipo (§22.7). */
export const GENERIC_TEXT: Record<ContentKind, string> = {
  approval: 'Um chat precisa da sua aprovação',
  question: 'O agente fez uma pergunta num chat',
  retry: 'Um chat está esperando para tentar de novo',
  reply: 'Resposta pronta num chat',
  error: 'Um chat parou com erro'
}

/** Com o título do chat e sem trecho ("Mostrar trecho" desligado). */
export const KIND_TEXT: Record<ContentKind, string> = {
  approval: 'Precisa da sua aprovação',
  question: 'O agente fez uma pergunta',
  retry: 'Esperando para tentar de novo',
  reply: 'Resposta pronta',
  error: 'Parou com erro'
}

/** Rótulo antes do trecho. */
const KIND_PREFIX: Record<ContentKind, string> = {
  approval: 'Aprovação',
  question: 'Pergunta',
  retry: 'Nova tentativa',
  reply: '',
  error: 'Erro'
}

const APP_TITLE = 'ClearChat'

export function clip(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length <= max ? one : one.slice(0, max - 1).trimEnd() + '…'
}

/** O que vai para a bandeja (identificador = tag: um aviso novo com a mesma tag substitui). */
export interface ShownNotification {
  id: string
  channel: string
  title: string
  body: string
  /** Android: subtexto (nome do host). */
  subtitle?: string
  data: NotificationData
}

/** Dados guardados junto de cada aviso mostrado (§22.7). */
export interface NotificationData {
  cc: 'push'
  kind: ContentKind | 'host_offline'
  tag: string
  chatId?: string
  /** Host do aviso (desde 1.8.0): `hostDeviceId` decifrado, senão o `from_device_id` de fora. */
  host?: string
  /** Nome do host (só nos decifrados) — casa o `host_offline` de servidores < 1.8.0. */
  hostName?: string
  /** Chat só ao vivo (§22.7): tocar abre o visualizador. */
  live?: true
}

/** Monta a notificação de um aviso decifrado (push do host ou chat executado aqui). */
export function buildNotification(
  tag: string,
  p: Pick<PushPayload, 'kind' | 'chatId' | 'chatTitle' | 'text' | 'hostName'> &
    Partial<Pick<PushPayload, 'hostDeviceId' | 'live'>>,
  prefs: Pick<PushPrefs, 'excerpt'>,
  /** Texto do próprio app (não é conteúdo do chat): sempre mostrado, sem rótulo. */
  appText = false,
  /** `from_device_id` de fora (§22.3): o host quando o payload não diz. */
  fromDeviceId?: string
): ShownNotification {
  const title = clip(p.chatTitle, PUSH_TITLE_MAX_CHARS) || APP_TITLE
  const text = clip(p.text, PUSH_TEXT_MAX_CHARS)
  const prefix = KIND_PREFIX[p.kind]
  const body =
    appText && text
      ? text
      : prefs.excerpt && text
        ? prefix
          ? `${prefix} · ${text}`
          : text
        : KIND_TEXT[p.kind]
  return {
    id: tag,
    channel: CHANNELS[CATEGORY_OF[p.kind]].id,
    title,
    body,
    subtitle: p.hostName ? clip(p.hostName, 64) : undefined,
    data: {
      cc: 'push',
      kind: p.kind,
      tag,
      chatId: p.chatId || undefined,
      ...(p.hostDeviceId || fromDeviceId ? { host: p.hostDeviceId || fromDeviceId } : {}),
      ...(p.hostName ? { hostName: p.hostName } : {}),
      ...(p.live ? { live: true as const } : {})
    }
  }
}

/** Aviso sem a DEK: título do app e o texto genérico do tipo. */
export function genericNotification(
  tag: string,
  kind: ContentKind,
  fromDeviceId?: string
): ShownNotification {
  return {
    id: tag,
    channel: CHANNELS[CATEGORY_OF[kind]].id,
    title: APP_TITLE,
    body: GENERIC_TEXT[kind],
    data: { cc: 'push', kind, tag, ...(fromDeviceId ? { host: fromDeviceId } : {}) }
  }
}

export function hostOfflineNotification(
  tag: string,
  deviceName: string,
  chatId: string | undefined
): ShownNotification {
  const name = clip(deviceName, 64)
  return {
    id: tag,
    channel: CHANNELS.hostOffline.id,
    title: 'Host offline',
    body: name
      ? `${name} ficou offline com um chat em execução.`
      : 'O dispositivo que executava um chat ficou offline.',
    data: { cc: 'push', kind: 'host_offline', tag, chatId: chatId || undefined }
  }
}

// ---------------- decisão (§22.7) ----------------

export type DropReason =
  | 'malformed'
  | 'version'
  | 'unknown-kind'
  | 'signed-out'
  | 'disabled'
  | 'kind-off'
  | 'auth'
  | 'kind-mismatch'
  | 'payload'
  | 'old'
  | 'chat-open'

export type PushDecision =
  | { action: 'show'; notification: ShownNotification; decrypted: boolean }
  | { action: 'dismiss'; id: string }
  | { action: 'drop'; reason: DropReason }

export interface PushContext {
  /** Usuário da conta neste aparelho (null = sem login). */
  userId: string | null
  /** K_push se a DEK estiver disponível SEM interação (memória ou Keystore sem biometria). */
  key: () => Promise<Uint8Array | null>
  prefs: PushPrefs
  now: number
  /** App em primeiro plano com este chat aberto. */
  chatOpen: (chatId: string) => boolean
}

const TAG_RE = /^[0-9a-f]{32}$/

/** Campos (strings) da mensagem de dados do FCM (§22.3). */
export interface FcmData {
  v?: string
  kind?: string
  tag?: string
  env?: string
  sent_at?: string
  chat_id?: string
  device_name?: string
  /** Desde 1.8.0: quem fez o `POST /push` (o host), posto pelo servidor. */
  from_device_id?: string
  /** Desde 1.8.0, no `host_offline`: o host que caiu. */
  device_id?: string
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

function asFcmData(o: Record<string, unknown>): FcmData | null {
  if (typeof o.kind !== 'string' || typeof o.tag !== 'string') return null
  return {
    v: str(o.v),
    kind: o.kind,
    tag: o.tag,
    env: str(o.env),
    sent_at: str(o.sent_at),
    chat_id: str(o.chat_id),
    device_name: str(o.device_name),
    from_device_id: str(o.from_device_id),
    device_id: str(o.device_id)
  }
}

/**
 * Acha os campos do FCM no que a tarefa do expo-notifications entrega: no Android o `data` da
 * tarefa é o RemoteMessage serializado (`{ data: { v, kind, … }, messageId, … }`); em outras
 * versões os campos vêm direto ou num `dataString` JSON.
 */
export function extractFcmData(payload: unknown): FcmData | null {
  const seen = new Set<unknown>()
  const visit = (v: unknown, depth: number): FcmData | null => {
    if (!v || typeof v !== 'object' || depth > 4 || seen.has(v)) return null
    seen.add(v)
    const o = v as Record<string, unknown>
    const direct = asFcmData(o)
    if (direct) return direct
    if (typeof o.dataString === 'string') {
      try {
        const parsed = visit(JSON.parse(o.dataString), depth + 1)
        if (parsed) return parsed
      } catch {
        /* não é JSON */
      }
    }
    for (const k of ['data', 'remoteMessage', 'notification', 'request', 'content', 'trigger']) {
      const r = visit(o[k], depth + 1)
      if (r) return r
    }
    return null
  }
  return visit(payload, 0)
}

function parseIso(s: string | undefined): number | null {
  if (!s) return null
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : null
}

function tooOld(ts: number | null, now: number): boolean {
  return ts !== null && now - ts > PUSH_MAX_AGE_MS
}

function isContentKind(k: string): k is ContentKind {
  return (CONTENT_KINDS as readonly string[]).includes(k)
}

function validPayload(o: Record<string, unknown>): PushPayload | null {
  if (typeof o.sv !== 'number' || o.sv < 1) return null
  if (typeof o.kind !== 'string' || !isContentKind(o.kind)) return null
  if (typeof o.chatId !== 'string' || !o.chatId) return null
  if (typeof o.ts !== 'number' || !Number.isFinite(o.ts)) return null
  return {
    sv: o.sv,
    kind: o.kind,
    chatId: o.chatId,
    sessionId: str(o.sessionId),
    chatTitle: str(o.chatTitle) ?? '',
    text: str(o.text) ?? '',
    requestId: str(o.requestId),
    hostName: str(o.hostName) ?? '',
    ...(typeof o.hostDeviceId === 'string' && o.hostDeviceId
      ? { hostDeviceId: o.hostDeviceId }
      : {}),
    ...(o.live === true ? { live: true as const } : {}),
    ts: o.ts
  }
}

/** O que fazer com uma mensagem de dados recebida (§22.7). Nunca lança. */
export async function decidePush(data: FcmData, ctx: PushContext): Promise<PushDecision> {
  const drop = (reason: DropReason): PushDecision => ({ action: 'drop', reason })
  const kind = data.kind ?? ''
  const tag = data.tag ?? ''
  if (data.v !== undefined && data.v !== '1') return drop('version')
  if (!TAG_RE.test(tag)) return drop('malformed')
  // o dismiss vale sempre (até com as notificações desligadas: apaga o que ficou na bandeja)
  if (kind === 'dismiss') return { action: 'dismiss', id: tag }
  if (kind !== 'host_offline' && !isContentKind(kind)) return drop('unknown-kind')
  if (!ctx.userId) return drop('signed-out')
  if (!ctx.prefs.enabled) return drop('disabled')
  if (!ctx.prefs[CATEGORY_OF[kind]]) return drop('kind-off')

  if (kind === 'host_offline') {
    if (tooOld(parseIso(data.sent_at), ctx.now)) return drop('old')
    const chatId = data.chat_id || undefined
    if (chatId && ctx.chatOpen(chatId)) return drop('chat-open')
    return {
      action: 'show',
      notification: hostOfflineNotification(tag, data.device_name ?? '', chatId),
      decrypted: false
    }
  }

  let env: unknown
  try {
    env = JSON.parse(data.env ?? '')
  } catch {
    return drop('malformed')
  }
  let key: Uint8Array | null = null
  try {
    key = await ctx.key()
  } catch {
    key = null
  }
  if (!key) {
    // DEK indisponível sem interação: texto genérico pelo tipo (sem chat: tocar abre a lista)
    if (tooOld(parseIso(data.sent_at), ctx.now)) return drop('old')
    return {
      action: 'show',
      notification: genericNotification(tag, kind, data.from_device_id || undefined),
      decrypted: false
    }
  }
  let plain: Record<string, unknown>
  try {
    plain = await openPush(key, ctx.userId, kind, tag, env)
  } catch {
    return drop('auth')
  }
  if (plain.kind !== kind) return drop('kind-mismatch')
  const p = validPayload(plain)
  if (!p) return drop('payload')
  if (tooOld(p.ts, ctx.now)) return drop('old')
  if (ctx.chatOpen(p.chatId)) return drop('chat-open')
  return {
    action: 'show',
    notification: buildNotification(tag, p, ctx.prefs, false, data.from_device_id || undefined),
    decrypted: true
  }
}

// ---------------- host caiu → limpar pendências (§22.7, desde 1.8.0) ----------------

/** Qual host o `host_offline` aponta (null = não é um host_offline válido). */
export function hostOfflineTarget(
  data: FcmData
): { deviceId?: string; deviceName?: string } | null {
  if (data.kind !== 'host_offline') return null
  if (data.v !== undefined && data.v !== '1') return null
  const deviceId = data.device_id || undefined
  const deviceName = data.device_name || undefined
  if (!deviceId && !deviceName) return null
  return { ...(deviceId ? { deviceId } : {}), ...(deviceName ? { deviceName } : {}) }
}

const PENDING_KINDS: ReadonlySet<string> = new Set(['approval', 'question', 'retry'])

/**
 * Avisos de pendência (aprovação/pergunta/retry) do host que caiu, a apagar da bandeja: casa pelo
 * host gravado no aviso (`hostDeviceId`, senão `from_device_id`); servidor < 1.8.0 (sem
 * `device_id`): pelo nome — só os decifrados com `hostName` igual ao `device_name` (os genéricos
 * ficam). `reply`/`error` nunca.
 */
export function pendingToClear(
  shown: { id: string; data: unknown }[],
  target: { deviceId?: string; deviceName?: string }
): string[] {
  const out: string[] = []
  for (const n of shown) {
    const d = n.data as Partial<NotificationData> | null
    if (!d || d.cc !== 'push' || !d.kind || !PENDING_KINDS.has(d.kind)) continue
    if (target.deviceId) {
      if (d.host === target.deviceId) out.push(n.id)
    } else if (target.deviceName && d.hostName && d.hostName === target.deviceName) out.push(n.id)
  }
  return out
}

/** 32 hex minúsculos aleatórios (tags dos avisos locais). */
export function randomTag(bytes: Uint8Array): string {
  return Array.from(bytes.subarray(0, 16), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Só para logs de desenvolvimento: nunca o conteúdo. */
export function describeDecision(d: PushDecision): string {
  if (d.action === 'drop') return `descartado (${d.reason})`
  if (d.action === 'dismiss') return `apagar ${d.id.slice(0, 6)}…`
  return `mostrar ${d.notification.data.kind} ${d.notification.id.slice(0, 6)}… ${d.decrypted ? 'decifrado' : 'genérico'}`
}
