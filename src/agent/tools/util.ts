// Utilitários das tools no celular — adaptação fina de ClearChatDesktop/src/main/tools/util.ts (lá
// depende de fs/os/path). Mesmos nomes e textos; sem caminhos, sem shell e sem "saída em arquivo"
// (spill): no celular não há read_file para o modelo reler o arquivo, então o resultado grande é
// cortado no teto `maxToolOutputChars` (início + fim), como a rede de segurança do desktop.
// Os módulos vendorados (webSearch, pageExtract, models) importam daqui pelo shim gerado.
import { LIMITS } from '@shared/limits'
import type { ContentPart, ModelInfo, StoredMessage } from '@shared/types'
import type { HistoryStore } from '../historyStore'

export const MAX_OUTPUT: number = LIMITS.maxToolOutputChars

export interface ToolContext {
  /** Teto de caracteres do resultado (ChatConfig.maxToolOutputChars). */
  maxOutput?: number
  signal: AbortSignal
  /** Saída parcial — o chamador faz throttle e emite `tool-running`. */
  onOutput?: (partial: string) => void
  /** Chave de cache por sessão (browse_url). */
  cacheKey?: string
  chatId?: string
  sessionId?: string
  /** list_models: provedor da sessão e todos os provedores de chat sincronizados. */
  models?: {
    providerName: string
    current?: string
    list: () => Promise<ModelInfo[]>
    providers?: {
      id: string
      name: string
      isSession?: boolean
      list: () => Promise<ModelInfo[]>
    }[]
  }
  /** get_chat_info / list_chats: dados do chat chamador e dos outros chats (o runner fornece). */
  chats?: { self: () => ChatInfoData; list: () => ChatListEntry[] }
  /** read_history: mensagens persistidas da sessão chamadora (inclui as anteriores às fronteiras). */
  history?: () => StoredMessage[]
  /** read_history com chat_id / scope "all": outros chats + índice FTS do cache local. */
  historyStore?: HistoryStore
}

/** get_chat_info: o chat/sessão que chamou a tool (no celular, `root` = sem diretório raiz). */
export interface ChatInfoData {
  chatId: string
  title: string
  sessionId: string
  mainSessionId: string
  depth: number
  parentSessionId: string | null
  sessionTitle: string
  model: string
  providerName: string
  root: string
  createdAt: number
}

/** list_chats: uma linha por chat. */
export interface ChatListEntry {
  id: string
  title: string
  model: string
  status: 'idle' | 'running' | 'awaiting_approval' | 'awaiting_input' | 'awaiting_retry'
  updatedAt: number
  self: boolean
}

export interface ToolResult {
  content: string
  status: 'ok' | 'error'
  meta?: Record<string, never>
  parts?: ContentPart[]
}

export class ToolError extends Error {}

export const ok = (content: string): ToolResult => ({ content, status: 'ok' })
export const fail = (content: string): ToolResult => ({ content, status: 'error' })

export const maxOutputOf = (ctx: Pick<ToolContext, 'maxOutput'>): number =>
  ctx.maxOutput && ctx.maxOutput > 0 ? ctx.maxOutput : MAX_OUTPUT

/** Número no formato pt-BR (15.234). */
export const fmtNum = (n: number): string => n.toLocaleString('pt-BR')

const countLines = (s: string): number => {
  if (!s) return 0
  let n = 1
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++
  return n
}

/** Trunca no fim: `[… truncado: N caracteres omitidos]`. */
export function truncate(s: string, max = MAX_OUTPUT): string {
  if (s.length <= max) return s
  return `${s.slice(0, max)}\n[… truncado: ${fmtNum(s.length - max)} caracteres omitidos]`
}

/** Mantém início e fim com um marcador no meio (mesmo formato do desktop). */
export function truncateHeadTail(
  s: string,
  max: number,
  headRatio = 0.5,
  hint?: string,
  extra?: { chars: number; lines: number }
): string {
  if (s.length <= max && !extra?.chars) return s
  const budget = Math.max(200, max - 160 - (hint?.length ?? 0))
  const headLen = Math.floor(budget * headRatio)
  const tailLen = budget - headLen
  let head = s.slice(0, Math.min(headLen, s.length))
  let tail = s.length - head.length > tailLen ? s.slice(s.length - tailLen) : s.slice(head.length)
  const hn = head.lastIndexOf('\n')
  if (hn > headLen * 0.7) head = head.slice(0, hn + 1)
  const tn = tail.indexOf('\n')
  if (tn !== -1 && tn < tailLen * 0.3 && tail.length === tailLen) tail = tail.slice(tn + 1)
  const omitted = s.slice(head.length, s.length - tail.length)
  const chars = omitted.length + (extra?.chars ?? 0)
  const lines = countLines(omitted) + (extra?.lines ?? 0)
  if (chars <= 0) return s
  const marker = `[… ${fmtNum(chars)} chars / ${fmtNum(lines)} linhas omitidos …]`
  return `${head.replace(/\n?$/, '\n')}${marker}${hint ? `\n${hint}` : ''}\n${tail}`
}

export function requireString(
  args: Record<string, unknown>,
  key: string,
  allowEmpty = false
): string {
  const v = args[key]
  if (typeof v !== 'string' || (!allowEmpty && v === '')) {
    throw new ToolError(`Argumento obrigatório "${key}" ausente ou inválido (esperado: string).`)
  }
  return v
}

export function optString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key]
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v !== 'string') throw new ToolError(`Argumento "${key}" deve ser uma string.`)
  return v
}

export function optNumber(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key]
  if (v === undefined || v === null || v === '') return undefined
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) throw new ToolError(`Argumento "${key}" deve ser um número.`)
  return n
}

export const optBool = (args: Record<string, unknown>, key: string): boolean =>
  args[key] === true || args[key] === 'true'

export function abortError(): Error {
  const e = new Error('Aborted')
  e.name = 'AbortError'
  return e
}

/** Argumentos da tool (JSON em string ou objeto) — mesmo erro legível do desktop. */
export function parseToolArgs(
  raw: string | Record<string, unknown> | undefined
): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw
  const s = (raw ?? '').trim()
  if (!s) return {}
  let v: unknown
  try {
    v = JSON.parse(s)
  } catch (e) {
    throw new ToolError(
      `Argumentos JSON inválidos: ${(e as Error).message}. Recebido: ${s.slice(0, 300)}`
    )
  }
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw new ToolError('Os argumentos devem ser um objeto JSON.')
  return v as Record<string, unknown>
}

/**
 * Executa a implementação de uma tool: erros viram resultado de texto (status 'error'), abort é
 * relançado (AbortError) e o resultado passa pelo teto `maxToolOutputChars`.
 */
export async function runToolImpl(
  impl: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  try {
    const r = await impl(args, ctx)
    const max = maxOutputOf(ctx)
    return r.content.length > max ? { ...r, content: truncateHeadTail(r.content, max, 0.5) } : r
  } catch (e) {
    if (ctx.signal.aborted || (e as Error).name === 'AbortError') throw abortError()
    if (e instanceof ToolError)
      return fail(e.message.startsWith('Erro') ? e.message : `Erro: ${e.message}`)
    return fail(`Erro: ${(e as Error)?.message ?? String(e)}`)
  }
}
