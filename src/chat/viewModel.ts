// Modelo da tela de conversa (puro, testável): sessão escolhida, caminho ativo pelo algoritmo
// normativo (§4.3.8) com a troca de versão só na tela, linhas da lista (separador de dia, fronteira
// de compactação, ‹ i/n › acima das mensagens que não o mostram no rodapé) e os mapas de apoio
// (resultado de cada tool call, subsessão de cada delegate_task). Mesma lógica do MessageList do desktop.
import { selectionToReach, selEquals, type BranchSel, type SiblingInfo } from '@shared/branches'
import { isDisplayOnly, latestBoundaryIndex } from '@shared/context'
import { isSiblingKind } from '@shared/siblings'
import type { Session, StoredMessage } from '@shared/types'
import { branchView } from '@vendor/renderer/branchView'
import { dayStarts } from '@vendor/renderer/dates'
import { isExtractionMessage } from '@vendor/renderer/memory'
import type { LoadedChat } from '@/data/store'

export type RowType =
  'user' | 'assistant' | 'tool' | 'card' | 'marker' | 'error' | 'synthetic' | 'divider'

export type Row =
  | {
      kind: 'message'
      key: string
      type: RowType
      msg: StoredMessage
      /** Antes da última compactação (esmaecida). */
      old: boolean
      /** Abre um dia novo (pílula acima). */
      dayStart: boolean
      /** ‹ i/n › numa linha acima (mensagens que não o mostram no rodapé). */
      switcherAbove: boolean
    }
  | { kind: 'divider'; key: string; type: 'divider'; count: number; showOld: boolean }

export interface SessionView {
  session: Session
  /** Caminho ativo (o que aparece). */
  path: StoredMessage[]
  siblings: Map<string, SiblingInfo>
  rows: Row[]
  /** Resultado (mensagem tool) de cada tool call do caminho. */
  results: Map<string, StoredMessage>
  /** Subsessão criada por cada tool call (delegate_task). */
  childByToolCall: Map<string, Session>
  /** Seleção efetiva (sincronizada ou a escolhida só na tela). */
  sel: BranchSel
  /** A tela está numa versão diferente da sincronizada. */
  localOverride: boolean
}

/** Seleção escolhida só na tela; cai quando a sincronizada muda (§4.3.7, "só na tela"). */
export interface LocalSel {
  sessionId: string
  base: BranchSel
  sel: BranchSel
}

/** Sessão principal do chat (registro `mainSessionId`, senão a de profundidade 0 mais antiga). */
export function mainSession(loaded: LoadedChat): Session | null {
  return (
    loaded.sessions.find((s) => s.id === loaded.chat.mainSessionId) ??
    loaded.sessions.find((s) => s.depth === 0) ??
    loaded.sessions[0] ??
    null
  )
}

export function rowType(m: StoredMessage, depth: number): RowType {
  const role = m.message.role
  if (isExtractionMessage(m.meta) || m.meta.kind === 'compaction') return 'card'
  if (m.meta.kind === 'error') return 'error'
  if (m.meta.kind === 'voice-call') return 'marker'
  if (role === 'user' && m.meta.kind === 'subagent-callback') return 'card'
  if (role === 'assistant') return 'assistant'
  if (m.meta.synthetic && role !== 'user') return 'synthetic'
  if (role === 'user') return m.meta.synthetic && !isUserish(m, depth) ? 'synthetic' : 'user'
  if (role === 'tool') return 'tool'
  return 'synthetic'
}

const isUserish = (m: StoredMessage, _depth: number): boolean =>
  m.meta.kind === 'inter-chat' || m.meta.kind === 'parent-message' || isSiblingKind(m.meta.kind)

/** O componente da mensagem já mostra o ‹ i/n › (balão do usuário, rodapé do assistente)? */
export function nativeSwitcher(m: StoredMessage, depth: number): boolean {
  const role = m.message.role
  if (
    isExtractionMessage(m.meta) ||
    m.meta.kind === 'compaction' ||
    m.meta.kind === 'error' ||
    m.meta.kind === 'voice-call'
  )
    return false
  if (role === 'assistant') return true
  if (role !== 'user' || m.meta.synthetic) return false
  if (m.meta.kind === 'inter-chat') return true
  if (
    m.meta.kind === 'subagent-callback' ||
    m.meta.kind === 'parent-message' ||
    isSiblingKind(m.meta.kind)
  )
    return false
  return depth === 0
}

export function buildSessionView(
  loaded: LoadedChat,
  session: Session,
  local: LocalSel | null,
  showOld: boolean
): SessionView {
  const all = loaded.messages.get(session.id) ?? []
  const base = session.branchSel ?? {}
  const override =
    local && local.sessionId === session.id && selEquals(local.base, base) ? local.sel : null
  const sel = override ?? base
  const { path, siblings } = branchView(all, sel)

  const results = new Map<string, StoredMessage>()
  const known = new Set<string>()
  for (const m of path) {
    if (m.message.role === 'assistant')
      for (const tc of m.message.tool_calls ?? []) known.add(tc.id)
    if (m.message.role === 'tool') results.set(m.message.tool_call_id, m)
  }
  const childByToolCall = new Map<string, Session>()
  for (const s of loaded.sessions)
    if (s.parentSessionId === session.id && s.parentToolCallId)
      childByToolCall.set(s.parentToolCallId, s)

  const hidden = (m: StoredMessage): boolean =>
    m.message.role === 'tool' && known.has(m.message.tool_call_id)

  const boundary = latestBoundaryIndex(path)
  const oldMsgs = boundary > 0 ? path.slice(0, boundary) : []
  const activeMsgs = boundary > 0 ? path.slice(boundary) : path
  const shown = [...(showOld ? oldMsgs : []), ...activeMsgs].filter((m) => !hidden(m))
  const starts = dayStarts(shown)

  const rows: Row[] = []
  const push = (m: StoredMessage, old: boolean) => {
    if (hidden(m)) {
      // resultado mostrado no card da chamada; se tem versões, o ‹ i/n › ainda precisa aparecer
      if (!siblings.has(m.id)) return
    }
    rows.push({
      kind: 'message',
      key: m.id,
      type: hidden(m) ? 'synthetic' : rowType(m, session.depth),
      msg: m,
      old,
      dayStart: starts.has(m.id),
      switcherAbove: siblings.has(m.id) && (hidden(m) || !nativeSwitcher(m, session.depth))
    })
  }
  if (oldMsgs.length && showOld) for (const m of oldMsgs) push(m, true)
  if (oldMsgs.length)
    rows.push({
      kind: 'divider',
      key: 'compaction-divider',
      type: 'divider',
      count: oldMsgs.filter((m) => !isDisplayOnly(m.meta)).length,
      showOld
    })
  for (const m of activeMsgs) push(m, false)

  return {
    session,
    path,
    siblings,
    rows,
    results,
    childByToolCall,
    sel,
    localOverride: !!override && !selEquals(override, base)
  }
}

/** Nova seleção (só na tela) para mostrar a versão `msgId`. */
export function localSelectFor(view: SessionView, loaded: LoadedChat, msgId: string): LocalSel {
  const all = loaded.messages.get(view.session.id) ?? []
  const { tree } = branchView(all, view.sel)
  return {
    sessionId: view.session.id,
    base: view.session.branchSel ?? {},
    sel: selectionToReach(tree, view.sel, msgId)
  }
}

/** Rótulo de uma sessão no seletor (principal / subagente). */
export function sessionLabel(s: Session): string {
  if (s.depth === 0) return 'Principal'
  return s.title || s.task?.slice(0, 40) || 'Subagente'
}
