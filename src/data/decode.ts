// Plaintext dos registros → tipos do app (src/shared vendorado). Leitura defensiva: campo malformado
// vira o padrão, nunca exceção (o registro veio de outro cliente, possivelmente de outra versão).
import { toBranchSel } from '@shared/branches'
import { isDisplayOnly } from '@shared/context'
import { contentText } from '@shared/attachments'
import type { ApiMessage, MessageMeta, Session, StoredMessage } from '@shared/types'
import { isVoiceCallMarker } from '@vendor/site/data/voice'
import type { ChatPlain, Plain } from './types'

const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d)
const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const isObj = (v: unknown): v is Plain => !!v && typeof v === 'object' && !Array.isArray(v)

export function chatFromPlain(id: string, p: Plain): ChatPlain {
  return {
    ...p,
    sv: 1,
    title: str(p.title),
    config: isObj(p.config) ? p.config : {},
    mainSessionId: str(p.mainSessionId),
    createdAt: num(p.createdAt),
    updatedAt: num(p.updatedAt, num(p.createdAt))
  }
}

/** Título exibido de um chat. */
export const chatTitle = (title: string | null | undefined): string =>
  (title ?? '').trim() || 'Novo chat'

/** Session a partir do registro `session` (§4.3.7); status como gravado. */
export function sessionFromPlain(id: string, p: Plain): Session {
  const depth = Math.min(2, Math.max(0, Math.trunc(num(p.depth)))) as 0 | 1 | 2
  return {
    id,
    chatId: str(p.chatId),
    parentSessionId: strOrNull(p.parentSessionId),
    parentToolCallId: strOrNull(p.parentToolCallId),
    depth,
    model: str(p.model),
    providerId: strOrNull(p.providerId),
    title: str(p.title),
    task: strOrNull(p.task),
    status: str(p.status, 'idle') as Session['status'],
    createdAt: num(p.createdAt),
    branchSel: toBranchSel(p.branchSel)
  }
}

/**
 * `meta` do registro → local (§4.3.8): o marcador de chamada vai como `kind: 'memory-extraction'` +
 * `voiceCall` (sem `memoryExtraction`) e volta a `voice-call`; `voice-call` explícito também vale.
 */
export function metaFromWire(meta: unknown): MessageMeta {
  if (!isObj(meta)) return {}
  if (isVoiceCallMarker(meta)) return { ...(meta as MessageMeta), kind: 'voice-call' }
  return meta as MessageMeta
}

function apiMessage(v: unknown): ApiMessage {
  if (!isObj(v)) return { role: 'user', content: '' }
  const role = v.role
  if (role === 'user' || role === 'system' || role === 'assistant' || role === 'tool')
    return v as unknown as ApiMessage
  return { role: 'user', content: '' }
}

/** StoredMessage a partir do registro `message` (parentId ausente = legado → mãe derivada). */
export function messageFromPlain(id: string, p: Plain): StoredMessage {
  const m: StoredMessage = {
    id,
    sessionId: str(p.sessionId),
    seq: num(p.seq),
    message: apiMessage(p.message),
    meta: metaFromWire(p.meta),
    createdAt: num(p.createdAt)
  }
  if (p.parentId === null || (typeof p.parentId === 'string' && p.parentId)) m.parentId = p.parentId
  return m
}

/** Texto legível de uma mensagem (sem anexos), para prévia e busca. */
export function messagePlainText(m: StoredMessage): string {
  const msg = m.message
  if (msg.role === 'assistant') return msg.content ?? ''
  return contentText(msg.content)
}

/** A mensagem entra na prévia da lista (conversa de verdade, não marcador/erro/resultado de tool)? */
export function isPreviewable(m: StoredMessage): boolean {
  const role = m.message.role
  if (role !== 'user' && role !== 'assistant') return false
  if (isDisplayOnly(m.meta) && m.meta.kind !== 'voice-call') return false
  if (m.meta.kind === 'compaction') return false
  if (role === 'user' && m.meta.synthetic) return false
  return true
}

/** Prévia em uma linha (markdown simplificado, sem quebras, cortada). */
export function previewText(text: string, max = 160): string {
  const s = text
    .replace(/```[\s\S]*?```/g, ' [código] ')
    // linhas separadoras de tabela e marcadores de lista/título/citação no começo da linha
    .replace(/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/gm, ' ')
    .replace(/^\s*(?:[-*+]|\d+[.)]|#{1,6}|>)\s+/gm, '')
    .replace(/^\s*\||\|\s*$/gm, '')
    .replace(/\s*\|\s*/g, ' · ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' [imagem] ')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/[*_~#>|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}
