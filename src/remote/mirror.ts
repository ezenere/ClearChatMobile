// Espelho ao vivo de um chat executado em outro dispositivo (SYNC_PROTOCOL.md §11): aplica o
// `snapshot` e os eventos do stream na ordem de `n`, pede resync em buraco, mantém o draft encerrado
// na tela até a mensagem persistida chegar (como o HostController do desktop). Puro: sem rede nem
// React — a tela lê `view` (imutável, troca a cada mudança).
import { toBranchSel, type BranchSel } from '@shared/branches'
import type {
  ApprovalRequest,
  ProcessInfo,
  QuestionRequest,
  QueuedMessage,
  RetryRequest,
  Session,
  SessionStatus,
  StoredMessage,
  StreamDraft
} from '@shared/types'
import {
  applyDraftDelta,
  draftMatchesMessage,
  toStreamDraft,
  type DraftDelta,
  type DraftState
} from '@vendor/desktop/sync/stream'

export interface ToolRun {
  running: boolean
  output?: string
  judging?: boolean
}

export interface CompactionState {
  state: 'scheduled' | 'running'
  text?: string
}

export interface HostSkill {
  name: string
  description: string
}

/** O que a tela mostra (imutável). */
export interface MirrorView {
  epoch: number
  /** Já recebeu um snapshot (o estado é completo). */
  complete: boolean
  /** Status ao vivo de cada sessão (o do registro pode estar atrasado). */
  status: Record<string, SessionStatus>
  /** Versão ativa ao vivo do host (o registro `session` chega logo depois). */
  branchSel: Record<string, BranchSel>
  /** Draft mostrado por sessão (o 1º encerrado ainda sem mensagem, senão o ao vivo). */
  drafts: Record<string, StreamDraft>
  tools: Record<string, Record<string, ToolRun>>
  compaction: Record<string, CompactionState>
  queues: Record<string, QueuedMessage[]>
  approvals: ApprovalRequest[]
  questions: QuestionRequest[]
  retries: RetryRequest[]
  processes: ProcessInfo[]
  skills: HostSkill[]
  /** Último erro (evento `error`) por sessão — some quando a sessão volta a rodar. */
  errors: Record<string, string>
}

export interface MirrorTimers {
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (t: unknown) => void
}

export interface MirrorDeps {
  /** Pede um snapshot ao host (`stream.resync`) — buraco, delta fora de ordem. */
  resync: () => void
  /** O estado mudou (a tela relê `view`). */
  changed: () => void
  timers?: MirrorTimers
}

/** Teto para um draft encerrado esperar a mensagem persistida (o push leva ~1 s). */
export const ENDED_DRAFT_HOLD_MS = 8_000

export const BUSY_STATUS: ReadonlySet<string> = new Set([
  'running',
  'waiting',
  'awaiting_approval',
  'awaiting_input',
  'awaiting_retry'
])

const defaultTimers: MirrorTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>)
}

type SnapshotSession = {
  status: string
  draft: StreamDraft | null
  tools?: Record<string, ToolRun>
  compaction?: CompactionState | null
}

export class LiveMirror {
  readonly epoch: number
  private lastN = 0
  private complete = false
  private status = new Map<string, SessionStatus>()
  private branchSel = new Map<string, BranchSel>()
  private drafts = new Map<string, DraftState>()
  private ended = new Map<string, StreamDraft[]>()
  private endedTimers = new Map<string, unknown>()
  private tools = new Map<string, Map<string, ToolRun>>()
  private compaction = new Map<string, CompactionState>()
  private queues = new Map<string, QueuedMessage[]>()
  private approvals = new Map<string, ApprovalRequest>()
  private questions = new Map<string, QuestionRequest>()
  private retries = new Map<string, RetryRequest>()
  private processes: ProcessInfo[] = []
  private skills: HostSkill[] = []
  private errors = new Map<string, string>()
  private disposed = false
  private cached: MirrorView | null = null
  private readonly d: MirrorDeps
  private readonly t: MirrorTimers

  constructor(epoch: number, deps: MirrorDeps) {
    this.epoch = epoch
    this.d = deps
    this.t = deps.timers ?? defaultTimers
  }

  get lastSeq(): number {
    return this.lastN
  }

  // ---------------- entrada ----------------

  /**
   * Um `stream.event` já decifrado. `n` contíguo por (chat, epoch); buraco → resync (o snapshot
   * que vem em resposta zera a sequência). Eventos repetidos/antigos são ignorados.
   */
  onEvent(n: number, payload: Record<string, unknown>): void {
    if (this.disposed) return
    const kind = String(payload.kind ?? '')
    if (kind !== 'snapshot' && n !== this.lastN + 1) {
      if (n <= this.lastN) return
      // buraco (ou ainda sem snapshot): aplica o que for idempotente e pede o estado completo
      this.d.resync()
    }
    this.lastN = n
    this.apply(kind, payload)
    this.touch()
  }

  private touch(): void {
    this.cached = null
    if (!this.disposed) this.d.changed()
  }

  private apply(kind: string, p: Record<string, unknown>): void {
    switch (kind) {
      case 'snapshot':
        this.applySnapshot(p)
        return
      case 'draft.delta': {
        const d = p as unknown as DraftDelta
        if (!d?.sessionId) return
        const next = applyDraftDelta(this.drafts.get(d.sessionId) ?? null, d)
        if (next === 'resync') {
          this.d.resync()
          return
        }
        this.drafts.set(d.sessionId, next)
        return
      }
      case 'draft.end':
        this.endLiveDraft(String(p.sessionId))
        return
      case 'session': {
        const s = p.session as Session | undefined
        if (!s?.id) return
        this.status.set(s.id, s.status)
        if (s.status === 'running') this.errors.delete(s.id)
        if (s.branchSel) this.branchSel.set(s.id, toBranchSel(s.branchSel))
        return
      }
      case 'tool': {
        const sid = String(p.sessionId)
        const tcid = String(p.toolCallId)
        const runs = new Map(this.tools.get(sid) ?? [])
        if (p.running)
          runs.set(tcid, {
            running: !p.judging,
            ...(typeof p.output === 'string' ? { output: p.output } : {}),
            ...(p.judging ? { judging: true } : {})
          })
        else runs.delete(tcid)
        this.tools.set(sid, runs)
        return
      }
      case 'queue':
        this.queues.set(String(p.sessionId), asArray<QueuedMessage>(p.queue))
        return
      case 'approval.requested': {
        const r = p.request as ApprovalRequest | undefined
        if (r?.id) this.approvals.set(r.id, r)
        return
      }
      case 'approval.resolved':
        this.approvals.delete(String(p.id))
        return
      case 'question.requested': {
        const r = p.request as QuestionRequest | undefined
        if (r?.id) this.questions.set(r.id, r)
        return
      }
      case 'question.resolved':
        this.questions.delete(String(p.id))
        return
      case 'retry.requested': {
        const r = p.request as RetryRequest | undefined
        if (!r?.id) return
        this.retries.set(r.id, r)
        // falha de rede: o parcial foi descartado no host (nada será persistido)
        this.dropEnded(r.sessionId)
        return
      }
      case 'retry.resolved':
        this.retries.delete(String(p.id))
        return
      case 'compaction': {
        const sid = String(p.sessionId)
        const state = p.state as CompactionState['state'] | null | undefined
        if (state === 'scheduled' || state === 'running')
          this.compaction.set(sid, {
            state,
            ...(typeof p.text === 'string' && p.text ? { text: p.text } : {})
          })
        else this.compaction.delete(sid)
        return
      }
      case 'processes':
        this.processes = asArray<ProcessInfo>(p.processes)
        return
      case 'error':
        if (p.sessionId) this.errors.set(String(p.sessionId), String(p.error ?? 'Erro'))
        return
    }
  }

  private applySnapshot(p: Record<string, unknown>): void {
    this.complete = true
    const sessions = (p.sessions && typeof p.sessions === 'object' ? p.sessions : {}) as Record<
      string,
      SnapshotSession
    >
    const seen = new Set<string>()
    for (const [sid, s] of Object.entries(sessions)) {
      if (!s || typeof s !== 'object') continue
      seen.add(sid)
      this.status.set(sid, s.status as SessionStatus)
      if (s.draft) {
        const cur = this.drafts.get(sid)
        this.drafts.set(sid, {
          streamId: cur?.streamId ?? '',
          content: s.draft.content ?? '',
          reasoning: s.draft.reasoning ?? '',
          toolCalls: (s.draft.toolCalls ?? []).map((t) => ({ ...t }))
        })
      } else if (this.drafts.has(sid)) {
        // o `draft.end` se perdeu: como se tivesse chegado
        this.endLiveDraft(sid)
      }
      this.tools.set(sid, new Map(Object.entries(s.tools ?? {})))
      if (s.compaction) this.compaction.set(sid, s.compaction)
      else this.compaction.delete(sid)
    }
    // sessões que sumiram do snapshot (apagadas no host): nada ao vivo delas
    for (const sid of [...this.drafts.keys()]) if (!seen.has(sid)) this.drafts.delete(sid)
    for (const sid of [...this.tools.keys()]) if (!seen.has(sid)) this.tools.delete(sid)
    const queues = (p.queues && typeof p.queues === 'object' ? p.queues : {}) as Record<
      string,
      QueuedMessage[]
    >
    this.queues = new Map(Object.entries(queues).map(([k, v]) => [k, asArray<QueuedMessage>(v)]))
    this.approvals = byId(asArray<ApprovalRequest>(p.approvals))
    this.questions = byId(asArray<QuestionRequest>(p.questions))
    this.retries = byId(asArray<RetryRequest>(p.retries))
    this.processes = asArray<ProcessInfo>(p.processes)
    this.skills = asArray<HostSkill>(p.skills).filter(
      (s) => s && typeof s.name === 'string' && s.name
    )
  }

  /**
   * Mensagem assistant persistida chegou (sync): some o draft daquela sessão (§11) — o encerrado
   * que ela substitui (e os mais velhos); o ao vivo só se for a resposta dela (`draft.end` perdido).
   */
  onPersistedAssistant(msg: StoredMessage): void {
    if (this.disposed || msg.message.role !== 'assistant') return
    const sid = msg.sessionId
    const synthetic = !!msg.meta.synthetic
    const list = this.ended.get(sid)
    if (list?.length) {
      const i = synthetic
        ? list.length - 1
        : list.findIndex((d) => draftMatchesMessage(d, msg.message))
      if (i < 0) return
      list.splice(0, i + 1)
      if (list.length) this.armEnded(sid)
      else this.dropEnded(sid)
      this.touch()
      return
    }
    const live = this.drafts.get(sid)
    if (live && (synthetic || draftMatchesMessage(toStreamDraft(live), msg.message))) {
      this.drafts.delete(sid)
      this.touch()
    }
  }

  /** Fim do turno no host (janela fechou): some o que é só ao vivo e volta o status gravado. */
  endTurn(): void {
    if (this.disposed) return
    for (const t of this.endedTimers.values()) this.t.clearTimeout(t)
    this.endedTimers.clear()
    this.drafts.clear()
    this.ended.clear()
    this.tools.clear()
    this.status.clear()
    this.touch()
  }

  dispose(): void {
    for (const t of this.endedTimers.values()) this.t.clearTimeout(t)
    this.endedTimers.clear()
    this.disposed = true
  }

  // ---------------- drafts encerrados ----------------

  private endLiveDraft(sid: string): void {
    const had = this.drafts.get(sid)
    this.drafts.delete(sid)
    if (had && (had.content.trim() || had.toolCalls.length)) {
      const list = this.ended.get(sid) ?? []
      list.push(toStreamDraft(had))
      this.ended.set(sid, list)
      this.armEnded(sid)
    }
  }

  private armEnded(sid: string): void {
    const old = this.endedTimers.get(sid)
    if (old !== undefined) this.t.clearTimeout(old)
    const timer = this.t.setTimeout(() => {
      if (this.endedTimers.get(sid) !== timer) return
      this.endedTimers.delete(sid)
      if (this.ended.delete(sid)) this.touch()
    }, ENDED_DRAFT_HOLD_MS)
    this.endedTimers.set(sid, timer)
  }

  private dropEnded(sid: string): boolean {
    const t = this.endedTimers.get(sid)
    if (t !== undefined) this.t.clearTimeout(t)
    this.endedTimers.delete(sid)
    return this.ended.delete(sid)
  }

  // ---------------- leitura ----------------

  get view(): MirrorView {
    if (this.cached) return this.cached
    const drafts: Record<string, StreamDraft> = {}
    for (const sid of new Set([...this.ended.keys(), ...this.drafts.keys()])) {
      const ended = this.ended.get(sid)
      if (ended?.length) drafts[sid] = ended[0]
      else {
        const live = this.drafts.get(sid)
        if (live) drafts[sid] = toStreamDraft(live)
      }
    }
    const tools: Record<string, Record<string, ToolRun>> = {}
    for (const [sid, runs] of this.tools) if (runs.size) tools[sid] = Object.fromEntries(runs)
    const sortByTime = <T extends { createdAt: number }>(xs: T[]): T[] =>
      [...xs].sort((a, b) => a.createdAt - b.createdAt)
    this.cached = {
      epoch: this.epoch,
      complete: this.complete,
      status: Object.fromEntries(this.status),
      branchSel: Object.fromEntries(this.branchSel),
      drafts,
      tools,
      compaction: Object.fromEntries(this.compaction),
      queues: Object.fromEntries([...this.queues].filter(([, q]) => q.length)),
      approvals: sortByTime([...this.approvals.values()]),
      questions: sortByTime([...this.questions.values()]),
      retries: sortByTime([...this.retries.values()]),
      processes: this.processes,
      skills: this.skills,
      errors: Object.fromEntries(this.errors)
    }
    return this.cached
  }
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : []
}

function byId<T extends { id: string }>(list: T[]): Map<string, T> {
  return new Map(list.filter((x) => x && typeof x.id === 'string').map((x) => [x.id, x]))
}

/** Status a EXIBIR de uma sessão de chat remoto: o ao vivo do espelho → transitório com janela. */
export function liveStatus(
  session: Session,
  view: MirrorView | null,
  windowOpen: boolean
): SessionStatus {
  const live = view?.status[session.id]
  if (live) return live
  if (windowOpen && BUSY_STATUS.has(session.status)) return session.status
  return BUSY_STATUS.has(session.status) ? 'interrupted' : session.status
}
