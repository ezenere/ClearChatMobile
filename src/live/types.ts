// Chats só ao vivo (SYNC_PROTOCOL.md §23, desde 1.8.0): tipos, constantes e leitura defensiva do
// anúncio (`LiveChatInfo`, §23.4) e dos itens do histórico (`LiveItem`, §23.5). Puro.

/** Capacidade do `hello`/`welcome` (§10.3). */
export const LIVE_CAP = 'live_chats'

/** §17.1 */
export const LIVE = {
  hostDropGraceS: 10,
  titleMaxChars: 120,
  historyPageMaxItems: 200,
  historyItemsMax: 200,
  historyChunkBytes: 512 * 1024,
  historyItemMaxBytes: 32 * 1024 * 1024,
  convertWaitS: 5,
  attachChunkBytes: 512 * 1024,
  attachMaxFileBytes: 20 * 1024 * 1024,
  attachMaxFiles: 10,
  attachMaxMessageBytes: 50 * 1024 * 1024,
  /** Comandos `history.*`/`attach.*`/`fs.*` em voo por visualizador (§23.5). */
  maxInFlight: 3
} as const

export type LiveStatus = 'idle' | 'running' | 'waiting'

/** Plaintext do anúncio (§23.4). */
export interface LiveChatInfo {
  sv: number
  chatId: string
  title: string
  persona: { id: string; name: string; icon: string } | null
  model: { providerId: string | null; providerName: string | null; model: string | null }
  status: LiveStatus
  pending: { approvals: number; questions: number; retries: number }
  usesLocalTools: boolean
  hostCwd: string | null
  createdAt: number
  updatedAt: number
  messageCount?: number
}

export interface LiveHost {
  device_id: string
  name: string
  platform: string
  status: 'online' | 'grace'
}

/** Item da lista como o servidor manda (§23.4). */
export interface LiveChatWire {
  chat_id: string
  epoch: number
  arev: number
  running: boolean
  env: unknown
  host: LiveHost
  announced_at?: string
}

export type LiveItemType = 'chat' | 'session' | 'message'

/** Item do histórico / do `rec` (§23.5). */
export interface LiveItem {
  type: LiveItemType
  id: string
  lseq: number
  deleted?: true
  data?: Record<string, unknown>
  omitted?: true
  large?: number
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const count = (v: unknown): number => Math.max(0, Math.trunc(num(v)))
const clip = (s: string, max: number): string => (s.length > max ? s.slice(0, max) : s)

export const isSafeInt = (v: unknown, min = 0): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= min

/** Plaintext decifrado → LiveChatInfo (null = inválido ou de outro chat). Leitores ignoram o resto. */
export function parseLiveInfo(p: Record<string, unknown>, chatId: string): LiveChatInfo | null {
  if (num(p.sv) < 1 || p.chatId !== chatId) return null
  const persona = isObj(p.persona)
    ? {
        id: str(p.persona.id) ?? '',
        name: str(p.persona.name) ?? '',
        icon: str(p.persona.icon) ?? ''
      }
    : null
  const m = isObj(p.model) ? p.model : {}
  const pend = isObj(p.pending) ? p.pending : {}
  const status: LiveStatus = p.status === 'running' || p.status === 'waiting' ? p.status : 'idle'
  const createdAt = num(p.createdAt)
  return {
    sv: num(p.sv),
    chatId,
    title: clip(str(p.title) ?? '', LIVE.titleMaxChars),
    persona,
    model: {
      providerId: str(m.providerId),
      providerName: str(m.providerName),
      model: str(m.model)
    },
    status,
    pending: {
      approvals: count(pend.approvals),
      questions: count(pend.questions),
      retries: count(pend.retries)
    },
    usesLocalTools: p.usesLocalTools === true,
    hostCwd: str(p.hostCwd),
    createdAt,
    updatedAt: num(p.updatedAt, createdAt),
    ...(isSafeInt(p.messageCount) ? { messageCount: p.messageCount } : {})
  }
}

/** Item do histórico vindo do host (null = malformado, ignorado). */
export function parseLiveItem(v: unknown): LiveItem | null {
  if (!isObj(v)) return null
  const type = v.type
  if (type !== 'chat' && type !== 'session' && type !== 'message') return null
  if (typeof v.id !== 'string' || !v.id || !isSafeInt(v.lseq)) return null
  const out: LiveItem = { type, id: v.id, lseq: v.lseq }
  if (v.deleted === true) out.deleted = true
  else if (isObj(v.data)) out.data = v.data
  else if (v.omitted === true) out.omitted = true
  else if (isSafeInt(v.large, 1)) out.large = v.large
  else return null
  return out
}

/** Status exibido de um chat ao vivo (lista). */
export function liveStatusText(info: LiveChatInfo, hostStatus: 'online' | 'grace'): string {
  if (hostStatus === 'grace') return 'reconectando…'
  if (info.status === 'waiting') return 'aguardando você'
  if (info.status === 'running') return 'rodando'
  return 'ocioso'
}
