// Estado de execução do runner em memória (porta de ClearChatDesktop/src/main/agent/{queue,
// approvals,questions,retries}.ts): fila por sessão, aprovações, questionários e falhas de conexão
// pendentes. Lá cada módulo é um singleton que emite pelo `events` do main; aqui são instâncias que
// emitem `AgentEvent` num barramento (o host publica no stream e a tela espelha).
import type { ApprovalItemDecision } from '@shared/approvalPolicy'
import { validateAnswers } from '@shared/askUser'
import type {
  AgentEvent,
  ApprovalRequest,
  AttachmentInfo,
  ContentPart,
  MessageMeta,
  QuestionAnswer,
  QuestionRequest,
  QueuedMessage,
  RetryRequest
} from '@shared/types'

export type Emit = (e: AgentEvent) => void

const uuid = (): string => crypto.randomUUID()

/** Barramento de eventos do agente (runner → host/publicador e tela). */
export class AgentBus {
  private listeners = new Set<(e: AgentEvent) => void>()
  on(fn: (e: AgentEvent) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  emit: Emit = (e) => {
    for (const fn of [...this.listeners]) {
      try {
        fn(e)
      } catch {
        /* ouvinte com erro não derruba o runner */
      }
    }
  }
}

// ---------------- fila ----------------

export class QueueRegistry {
  private queues = new Map<string, QueuedMessage[]>()
  constructor(private readonly emit: Emit) {}

  private notify(sessionId: string): void {
    this.emit({ type: 'queue-updated', sessionId, queue: this.get(sessionId) })
  }

  get(sessionId: string): QueuedMessage[] {
    return [...(this.queues.get(sessionId) ?? [])]
  }

  has(sessionId: string): boolean {
    return (this.queues.get(sessionId)?.length ?? 0) > 0
  }

  enqueue(
    sessionId: string,
    text: string,
    attachments?: AttachmentInfo[],
    meta?: MessageMeta,
    skillParts?: ContentPart[]
  ): QueuedMessage {
    const item: QueuedMessage = { id: uuid(), sessionId, text, createdAt: Date.now() }
    if (attachments?.length) item.attachments = attachments
    if (skillParts?.length) item.skillParts = skillParts
    if (meta) item.meta = meta
    this.queues.set(sessionId, [...(this.queues.get(sessionId) ?? []), item])
    this.notify(sessionId)
    return item
  }

  requeueFront(sessionId: string, items: QueuedMessage[]): void {
    if (!items.length) return
    this.queues.set(sessionId, [...items, ...(this.queues.get(sessionId) ?? [])])
    this.notify(sessionId)
  }

  take(id: string): QueuedMessage | null {
    for (const [sid, q] of this.queues) {
      const i = q.findIndex((m) => m.id === id)
      if (i !== -1) {
        const [item] = q.splice(i, 1)
        if (!q.length) this.queues.delete(sid)
        this.notify(sid)
        return item
      }
    }
    return null
  }

  drain(sessionId: string): QueuedMessage[] {
    const q = this.queues.get(sessionId) ?? []
    if (!q.length) return []
    this.queues.delete(sessionId)
    this.notify(sessionId)
    return q
  }

  clear(sessionId: string): void {
    if (this.queues.delete(sessionId)) this.notify(sessionId)
  }

  sessions(): string[] {
    return [...this.queues.keys()]
  }
}

// ---------------- aprovações ----------------

export interface ApprovalOutcome {
  kind: 'allow' | 'deny' | 'cancel' | 'reeval'
  items?: ApprovalItemDecision[]
}

interface Pending<R, O> {
  request: R
  resolve: (o: O) => void
}

export class ApprovalRegistry {
  private pending = new Map<string, Pending<ApprovalRequest, ApprovalOutcome>>()
  constructor(private readonly emit: Emit) {}

  request(
    input: Omit<ApprovalRequest, 'id' | 'createdAt'>,
    signal: AbortSignal
  ): Promise<ApprovalOutcome> {
    const request: ApprovalRequest = { ...input, id: uuid(), createdAt: Date.now() }
    if (signal.aborted) return Promise.resolve({ kind: 'cancel' })
    return new Promise<ApprovalOutcome>((resolve) => {
      const onAbort = (): void => {
        this.resolve(request.id, { kind: 'cancel' })
      }
      this.pending.set(request.id, {
        request,
        resolve: (o) => {
          signal.removeEventListener('abort', onAbort)
          resolve(o)
        }
      })
      signal.addEventListener('abort', onAbort, { once: true })
      this.emit({ type: 'approval-requested', request })
    })
  }

  get(id: string): ApprovalRequest | null {
    return this.pending.get(id)?.request ?? null
  }

  resolve(id: string, outcome: ApprovalOutcome): boolean {
    const p = this.pending.get(id)
    if (!p) return false
    this.pending.delete(id)
    this.emit({ type: 'approval-resolved', id })
    p.resolve(outcome)
    return true
  }

  list(): ApprovalRequest[] {
    return [...this.pending.values()]
      .map((p) => p.request)
      .sort((a, b) => a.createdAt - b.createdAt)
  }
}

// ---------------- questionários (ask_user) ----------------

export type QuestionOutcome = { kind: 'answered'; answers: QuestionAnswer[] } | { kind: 'cancel' }

export class QuestionRegistry {
  private pending = new Map<string, Pending<QuestionRequest, QuestionOutcome>>()
  constructor(private readonly emit: Emit) {}

  request(
    input: Omit<QuestionRequest, 'id' | 'createdAt'>,
    signal: AbortSignal
  ): Promise<QuestionOutcome> {
    const request: QuestionRequest = { ...input, id: uuid(), createdAt: Date.now() }
    if (signal.aborted) return Promise.resolve({ kind: 'cancel' })
    return new Promise<QuestionOutcome>((resolve) => {
      const onAbort = (): void => {
        this.settle(request.id, { kind: 'cancel' })
      }
      this.pending.set(request.id, {
        request,
        resolve: (o) => {
          signal.removeEventListener('abort', onAbort)
          resolve(o)
        }
      })
      signal.addEventListener('abort', onAbort, { once: true })
      this.emit({ type: 'question-requested', request })
    })
  }

  private settle(id: string, outcome: QuestionOutcome): boolean {
    const p = this.pending.get(id)
    if (!p) return false
    this.pending.delete(id)
    this.emit({ type: 'question-resolved', id })
    p.resolve(outcome)
    return true
  }

  get(id: string): QuestionRequest | null {
    return this.pending.get(id)?.request ?? null
  }

  answer(id: string, answers: unknown): void {
    const p = this.pending.get(id)
    if (!p) throw new Error('Este questionário não está mais pendente.')
    const v = validateAnswers(p.request.questions, answers)
    if ('error' in v) throw new Error(v.error)
    this.settle(id, { kind: 'answered', answers: v.answers })
  }

  cancel(id: string): boolean {
    return this.settle(id, { kind: 'cancel' })
  }

  list(): QuestionRequest[] {
    return [...this.pending.values()]
      .map((p) => p.request)
      .sort((a, b) => a.createdAt - b.createdAt)
  }
}

// ---------------- falha de conexão (Tentar de novo / Cancelar) ----------------

export type RetryOutcome = 'retry' | 'cancel'

export class RetryRegistry {
  private pending = new Map<string, Pending<RetryRequest, RetryOutcome>>()
  constructor(private readonly emit: Emit) {}

  request(
    input: Omit<RetryRequest, 'id' | 'createdAt'>,
    signal: AbortSignal
  ): Promise<RetryOutcome> {
    const request: RetryRequest = { ...input, id: uuid(), createdAt: Date.now() }
    if (signal.aborted) return Promise.resolve('cancel')
    return new Promise<RetryOutcome>((resolve) => {
      const onAbort = (): void => {
        this.resolve(request.id, 'cancel')
      }
      this.pending.set(request.id, {
        request,
        resolve: (o) => {
          signal.removeEventListener('abort', onAbort)
          resolve(o)
        }
      })
      signal.addEventListener('abort', onAbort, { once: true })
      this.emit({ type: 'retry-requested', request })
    })
  }

  resolve(id: string, outcome: RetryOutcome): boolean {
    const p = this.pending.get(id)
    if (!p) return false
    this.pending.delete(id)
    this.emit({ type: 'retry-resolved', id })
    p.resolve(outcome)
    return true
  }

  get(id: string): RetryRequest | null {
    return this.pending.get(id)?.request ?? null
  }

  list(): RetryRequest[] {
    return [...this.pending.values()]
      .map((p) => p.request)
      .sort((a, b) => a.createdAt - b.createdAt)
  }
}

/**
 * Chamada ao modelo com o card de falha de conexão (igual ao desktop): erro de REDE → descarta o
 * parcial e espera a decisão; 'retry' refaz do zero; 'cancel' devolve o erro; abort → 'aborted'.
 */
export async function callWithNetworkRetry<T>(p: {
  signal: AbortSignal
  attempt: () => Promise<T>
  isNetwork: (e: unknown) => boolean
  onDiscard?: () => void
  ask: (error: unknown) => Promise<RetryOutcome>
}): Promise<
  | { kind: 'ok'; value: T }
  | { kind: 'error'; error: unknown; network?: boolean; abortedInCard?: boolean }
  | { kind: 'aborted' }
> {
  for (;;) {
    try {
      return { kind: 'ok', value: await p.attempt() }
    } catch (e) {
      if (p.signal.aborted) return { kind: 'aborted' }
      if (!p.isNetwork(e)) return { kind: 'error', error: e }
      p.onDiscard?.()
      const d = await p.ask(e)
      if (p.signal.aborted) return { kind: 'error', error: e, network: true, abortedInCard: true }
      if (d === 'cancel') return { kind: 'error', error: e, network: true }
    }
  }
}
