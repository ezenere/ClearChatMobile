// Loop do agente no celular — versão enxuta de ClearChatDesktop/src/main/agent/runner.ts com a
// mesma semântica de turno: mensagem → request → stream (draft) → mensagem assistant persistida
// (modelo, tokens, custo, duração, raciocínio) → tools (aprovação/Smart-Approve/listas,
// questionário) → resultados → repete; fila e ⚡ forçar; Parar (parcial com `interrupted`, tools
// sem resposta canceladas); card de falha de conexão; erro persistido; regenerar/editar/trocar de
// versão/editar/apagar mensagens. Fase 4b: subagentes, memória, entre chats, compactação e
// título automático (os pontos de extensão estão marcados). Sem React Native.
import {
  approvalRoute,
  blockedText,
  checkItemLabel,
  effectiveMode,
  evaluateLists,
  isListItem,
  normalizeApprovalSettings,
  smartListPlan,
  TOOL_ITEM,
  userDeniedText,
  validateListEntry,
  type ApprovalItemDecision
} from '@shared/approvalPolicy'
import { ASK_USER_NOT_ANSWERED, formatAskUserResult, parseAskUserArgs } from '@shared/askUser'
import { contentText, isAppPart } from '@shared/attachments'
import {
  activePath,
  buildTree,
  isBranchEditable,
  lastTurnAnchor,
  pruneSel,
  selectionToReach,
  turnAnchor,
  turnResponse,
  type BranchSel
} from '@shared/branches'
import { isDisplayOnly } from '@shared/context'
import { clampToolOutput } from '@shared/limits'
import { sessionProviderId } from '@shared/models'
import { connectionErrorText, isConnectionFailure } from '@shared/network'
import { capturedTextFor, effectiveEnvironment } from '@shared/contextCapture'
import {
  argsSummary,
  normalizeSmartApprove,
  overrideMessageText,
  smartRejectText
} from '@shared/smartApprove'
import { buildJudgeExtras } from '@shared/smartApproveContext'
import type {
  AgentEvent,
  ApiMessage,
  ApprovalCheck,
  ApprovalListItem,
  ApprovalRecord,
  AskUserRecord,
  AttachmentInfo,
  Chat,
  ContentPart,
  MessageMeta,
  ModelInfo,
  Provider,
  QuestionAnswer,
  QueuedMessage,
  Session,
  SessionStatus,
  SmartApproveRecord,
  StoredMessage,
  ToolCall,
  ToolName
} from '@shared/types'
import { TOOL_ALIASES } from '@shared/types'
import {
  accToDraft,
  finalizeToolCalls,
  markReasoning,
  newAccumulator,
  reasoningDuration,
  streamChat,
  throttle,
  type StreamAccumulator
} from '@vendor/desktop/agent/llm'
import { addOverride, runJudge, takeOverride } from '@vendor/desktop/agent/smartApprove'
import { formatTextToolResult, parseTextToolCalls } from '@vendor/desktop/agent/textTools'
import { listModelsTool } from '@vendor/desktop/tools/models'
import type { ChatRepo } from '@/host/repo'
import { buildUserContent, referencedFiles, validateAttachments } from './attachments'
import {
  AgentBus,
  ApprovalRegistry,
  callWithNetworkRetry,
  QuestionRegistry,
  QueueRegistry,
  RetryRegistry,
  type RetryOutcome
} from './registries'
import { availableTools, buildRequest, type BuiltRequest } from './request'
import { resolveAskUserQuestions } from './tools/askUser'
import {
  abortError,
  parseToolArgs,
  runToolImpl,
  truncateHeadTail,
  type ToolContext
} from './tools/util'
import { browseUrl, webSearch } from './tools/web'

export const CANCELLED_TEXT = '[Interrompido pelo usuário antes de concluir]'
export const DENIED_TEXT = 'O usuário negou a execução desta ferramenta.'

/** Arquivos do store de anexos no aparelho (baixados sob demanda, §14). */
export interface RunnerFiles {
  /** Garante o arquivo no aparelho (baixa do servidor se preciso). */
  ensure(file: string): Promise<void>
  /** base64 do arquivo (já no aparelho). */
  readBase64(file: string): Promise<string>
  /** Texto UTF-8 (anexos de texto vão inline). */
  readText(file: string): Promise<string>
  size(file: string): number | null
  /** Grava bytes novos no store (imagens do questionário); devolve `<sha256>.<ext>`. */
  save(data: Uint8Array, ext: string): Promise<string>
}

export interface RunnerDeps {
  repo: ChatRepo
  bus?: AgentBus
  provider: (id: string) => Provider | null
  /** Provedores de chat sincronizados (list_models, nomes nas definições). */
  chatProviders: () => Provider[]
  /** `value` de um registro `setting` (aprovações, Smart-Approve, pesquisa na web). */
  setting: (id: string) => unknown
  /** "+ whitelist"/"+ blacklist" no card: grava as listas globais (setting `approvalLists`). */
  addListEntries?: (
    entries: { item: ApprovalListItem; list: 'allow' | 'deny'; entry: string }[]
  ) => void
  files: RunnerFiles
  listModels: (p: Provider) => Promise<ModelInfo[]>
  /** Chamada ao modelo (testes trocam por um provedor falso). Padrão: streamChat vendorado. */
  stream?: typeof streamChat
  log?: (msg: string) => void
  /** Intervalo do draft (ms). */
  draftMs?: number
}

type LoopOutcome =
  | { kind: 'final'; text: string }
  | { kind: 'aborted'; partial: string }
  | { kind: 'error'; error: string }

type StepResult =
  | { kind: 'final'; text: string }
  | { kind: 'continue' }
  | { kind: 'aborted'; partial: string }
  | { kind: 'error'; error: string; networkCancelled?: boolean }

interface RunState {
  sessionId: string
  chatId: string
  depth: number
  controller: AbortController
  stopRequested: boolean
  forced: QueuedMessage[]
  done: Promise<LoopOutcome>
  /** Status final de uma parada (ex.: `interrupted` ao ir para o segundo plano). */
  stopStatus?: SessionStatus
}

interface ToolOutcome {
  content: string
  parts?: ContentPart[]
  status: 'ok' | 'error' | 'denied' | 'cancelled'
  smartApprove?: SmartApproveRecord
  smartOverride?: boolean
  approval?: ApprovalRecord
  askUser?: AskUserRecord
  durationMs: number
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const hasPendingBranch = (sel: BranchSel | undefined): boolean =>
  !!sel && Object.values(sel).includes(null)

const BUSY: readonly SessionStatus[] = [
  'running',
  'awaiting_approval',
  'awaiting_input',
  'awaiting_retry',
  'waiting'
]

/** Troca o texto de uma mensagem do usuário mantendo anexos/skills (= desktop). */
function withUserText(content: ApiMessage['content'], text: string): string | ContentPart[] {
  if (content == null || typeof content === 'string') return text
  const keep = content.filter(isAppPart)
  if (!keep.length) {
    if (!content.length) return text
    const first = content.find((p) => p.type === 'text') ?? { type: 'text' as const, text: '' }
    return [{ ...first, text } as ContentPart]
  }
  return text.trim() ? [...keep, { type: 'text', text }] : keep
}

export class Runner {
  readonly bus: AgentBus
  readonly queue: QueueRegistry
  readonly approvals: ApprovalRegistry
  readonly questions: QuestionRegistry
  readonly retries: RetryRegistry
  private runs = new Map<string, RunState>()
  private readonly d: RunnerDeps
  private readonly repo: ChatRepo
  private textCache = new Map<string, string>()

  constructor(deps: RunnerDeps) {
    this.d = deps
    this.repo = deps.repo
    this.bus = deps.bus ?? new AgentBus()
    const emit = this.bus.emit
    this.queue = new QueueRegistry(emit)
    this.approvals = new ApprovalRegistry(emit)
    this.questions = new QuestionRegistry(emit)
    this.retries = new RetryRegistry(emit)
  }

  private emit(e: AgentEvent): void {
    this.bus.emit(e)
  }

  private log(msg: string): void {
    this.d.log?.(msg)
  }

  // ---------------- estado ----------------

  isRunning(sessionId: string): boolean {
    return this.runs.has(sessionId)
  }

  runningSessions(): string[] {
    return [...this.runs.keys()]
  }

  /** Chats com sessão rodando ou aprovação/questionário/retry pendente (§8.5: janela aberta). */
  busyChats(): Set<string> {
    const out = new Set<string>()
    for (const st of this.runs.values()) out.add(st.chatId)
    for (const a of this.approvals.list()) out.add(a.chatId)
    for (const q of this.questions.list()) out.add(q.chatId)
    for (const r of this.retries.list()) out.add(r.chatId)
    return out
  }

  private setStatus(sessionId: string, status: SessionStatus): void {
    const s = this.repo.setStatus(sessionId, status)
    if (s) this.emit({ type: 'session-updated', session: s })
  }

  private append(sessionId: string, message: ApiMessage, meta: MessageMeta = {}): StoredMessage {
    const before = this.repo.session(sessionId)?.branchSel
    const m = this.repo.append(sessionId, message, meta)
    this.emit({ type: 'message-added', message: m })
    const s = this.repo.session(sessionId)
    if (s) {
      this.repo.touch(s.chatId)
      if (hasPendingBranch(before) && !hasPendingBranch(s.branchSel))
        this.emit({ type: 'session-updated', session: s })
    }
    return m
  }

  private appendError(sessionId: string, error: string): void {
    if (!this.repo.session(sessionId)) return
    try {
      this.append(
        sessionId,
        { role: 'assistant', content: error },
        { synthetic: true, kind: 'error', error }
      )
    } catch (e) {
      this.log(`appendError: ${errMsg(e)}`)
    }
  }

  private clearPendingBranch(sessionId: string): void {
    const s = this.repo.session(sessionId)
    if (!s || !hasPendingBranch(s.branchSel)) return
    const next: BranchSel = {}
    for (const [k, v] of Object.entries(s.branchSel ?? {})) if (v !== null) next[k] = v
    const u = this.repo.setBranchSel(sessionId, next)
    if (u) this.emit({ type: 'session-updated', session: u })
  }

  /** Tools do último assistant sem resposta ganham resultado sintético cancelado (= desktop). */
  repairTail(sessionId: string): void {
    const msgs = this.repo.path(sessionId)
    let idx = -1
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i].message
      if (isDisplayOnly(msgs[i].meta)) continue
      if (m.role === 'assistant') {
        idx = i
        break
      }
      if (m.role === 'user') return
    }
    if (idx === -1) return
    const a = msgs[idx].message
    if (a.role !== 'assistant' || !a.tool_calls?.length) return
    const answered = new Set(
      msgs
        .slice(idx + 1)
        .map((m) => (m.message.role === 'tool' ? m.message.tool_call_id : null))
        .filter(Boolean)
    )
    for (const tc of a.tool_calls) {
      if (answered.has(tc.id)) continue
      this.append(
        sessionId,
        {
          role: 'tool',
          tool_call_id: tc.id,
          content: tc.function.name === 'ask_user' ? ASK_USER_NOT_ANSWERED : CANCELLED_TEXT
        },
        { synthetic: true, kind: 'tool-cancelled', toolStatus: 'cancelled' }
      )
    }
  }

  /** Título provisório (1ª mensagem truncada) de um chat novo — o automático é da fase 4b. */
  private maybeSetTitle(session: Session, text: string): void {
    if (session.depth !== 0) return
    const chat = this.repo.chat(session.chatId)
    if (!chat || (chat.title && chat.title !== 'Novo chat')) return
    if (this.repo.path(session.id).some((m) => m.message.role === 'user')) return
    const line = text.replace(/\s+/g, ' ').trim()
    if (!line) return
    this.repo.updateChat(chat.id, {
      title: line.length > 50 ? line.slice(0, 50).trimEnd() + '…' : line
    })
  }

  private async readTextFile(file: string): Promise<string> {
    const hit = this.textCache.get(file)
    if (hit !== undefined) return hit
    await this.d.files.ensure(file)
    const t = await this.d.files.readText(file)
    this.textCache.set(file, t)
    return t
  }

  private async appendUser(
    session: Session,
    text: string,
    meta: MessageMeta = {},
    attachments: AttachmentInfo[] = [],
    skillParts: ContentPart[] = []
  ): Promise<StoredMessage> {
    const names = attachments.map((a) => a.name)
    this.maybeSetTitle(session, text.trim() ? text : names.join(', '))
    const texts = new Map<string, string>()
    for (const a of attachments)
      if (a.kind === 'text') texts.set(a.file, await this.readTextFile(a.file))
    const content = buildUserContent(text, attachments, skillParts, (f) => texts.get(f) ?? '')
    return this.append(session.id, { role: 'user', content }, meta)
  }

  // ---------------- loop ----------------

  private startLoop(session: Session): RunState {
    const st: RunState = {
      sessionId: session.id,
      chatId: session.chatId,
      depth: session.depth,
      controller: new AbortController(),
      stopRequested: false,
      forced: [],
      done: Promise.resolve({ kind: 'final', text: '' })
    }
    this.runs.set(session.id, st)
    this.setStatus(session.id, 'running')
    st.done = this.runLoop(st).catch((e): LoopOutcome => {
      const error = `Erro interno: ${errMsg(e)}`
      this.log(`runner: ${errMsg(e)}`)
      this.appendError(st.sessionId, error)
      this.finish(st, 'error')
      this.emit({ type: 'error', sessionId: st.sessionId, error })
      return { kind: 'error', error }
    })
    return st
  }

  private finish(st: RunState, status: SessionStatus): void {
    if (this.runs.get(st.sessionId) === st) this.runs.delete(st.sessionId)
    this.clearPendingBranch(st.sessionId)
    this.setStatus(st.sessionId, status)
  }

  private async injectForced(st: RunState): Promise<void> {
    for (const f of st.forced.splice(0)) {
      const s = this.repo.session(st.sessionId)
      if (s)
        await this.appendUser(s, f.text, { kind: 'forced', ...f.meta }, f.attachments, f.skillParts)
    }
  }

  private async onAborted(st: RunState, partial: string): Promise<'continue' | LoopOutcome> {
    this.repairTail(st.sessionId)
    if (!st.stopRequested && st.forced.length && this.repo.session(st.sessionId)) {
      st.controller = new AbortController()
      this.setStatus(st.sessionId, 'running')
      await this.injectForced(st)
      return 'continue'
    }
    this.finish(st, st.stopStatus ?? (st.depth === 0 ? 'idle' : 'interrupted'))
    return { kind: 'aborted', partial }
  }

  private async runLoop(st: RunState): Promise<LoopOutcome> {
    let lastText = ''
    for (;;) {
      // fase 4b: compactação no limite de passo (pedida/automática)
      for (const q of this.queue.drain(st.sessionId)) {
        const s = this.repo.session(st.sessionId)
        if (s)
          await this.appendUser(
            s,
            q.text,
            { kind: 'queued', ...q.meta },
            q.attachments,
            q.skillParts
          )
      }
      const signal = st.controller.signal
      let res: StepResult
      try {
        res = await this.step(st, signal)
      } catch (e) {
        res = signal.aborted
          ? { kind: 'aborted', partial: '' }
          : { kind: 'error', error: errMsg(e) }
      }
      if (res.kind === 'error' && res.networkCancelled) {
        this.repairTail(st.sessionId)
        this.appendError(st.sessionId, res.error)
        this.emit({ type: 'error', sessionId: st.sessionId, error: res.error })
        if (signal.aborted && !st.stopRequested && st.forced.length) {
          const r = await this.onAborted(st, '')
          if (r === 'continue') continue
          return r
        }
        this.finish(st, 'error')
        return { kind: 'error', error: res.error }
      }
      if (signal.aborted || res.kind === 'aborted') {
        const r = await this.onAborted(st, res.kind === 'aborted' ? res.partial : lastText)
        if (r === 'continue') continue
        return r
      }
      if (res.kind === 'error') {
        // fase 4b: contexto estourado → compactar e tentar de novo
        this.repairTail(st.sessionId)
        this.appendError(st.sessionId, res.error)
        this.finish(st, 'error')
        this.emit({ type: 'error', sessionId: st.sessionId, error: res.error })
        return res
      }
      if (res.kind === 'continue') continue
      lastText = res.text
      if (st.forced.length) {
        await this.injectForced(st)
        continue
      }
      if (this.queue.has(st.sessionId)) continue
      this.finish(st, st.depth === 0 ? 'idle' : 'done')
      return { kind: 'final', text: res.text }
    }
  }

  private providerFor(chat: Chat, session: Session): Provider | null {
    return this.d.provider(sessionProviderId(chat.config, session))
  }

  /** Anexos citados no histórico: garante no aparelho e carrega em base64 para a request. */
  private async loadAttachments(history: StoredMessage[]): Promise<Map<string, string>> {
    const files = referencedFiles(history.map((m) => m.message))
    const out = new Map<string, string>()
    for (const f of files) {
      await this.d.files.ensure(f)
      out.set(f, await this.d.files.readBase64(f))
    }
    return out
  }

  private async buildFor(chat: Chat, session: Session, provider: Provider): Promise<BuiltRequest> {
    const history = this.repo.path(session.id)
    const data = await this.loadAttachments(history)
    return buildRequest(chat, session, history, provider, {
      read: (file, name) => {
        const v = data.get(file)
        if (v === undefined) throw new Error(`Anexo não encontrado no aparelho: "${name ?? file}".`)
        return v
      }
    })
  }

  private async step(st: RunState, signal: AbortSignal): Promise<StepResult> {
    const session = this.repo.session(st.sessionId)
    if (!session) return { kind: 'error', error: 'Sessão não encontrada (chat apagado?).' }
    const chat = this.repo.chat(session.chatId)
    if (!chat) return { kind: 'error', error: 'Chat não encontrado.' }
    const provider = this.providerFor(chat, session)
    if (!provider) return { kind: 'error', error: 'Nenhum provider configurado para este chat.' }
    const reqSession =
      session.depth === 0 ? { ...session, model: chat.config.model || session.model } : session
    if (!reqSession.model)
      return { kind: 'error', error: 'Nenhum modelo selecionado para este chat.' }
    let req: BuiltRequest
    try {
      req = await this.buildFor(chat, reqSession, provider)
    } catch (e) {
      return { kind: 'error', error: errMsg(e) }
    }
    let acc: StreamAccumulator = newAccumulator()
    const draft = throttle(
      () => this.emit({ type: 'draft', sessionId: session.id, draft: accToDraft(acc) }),
      this.d.draftMs ?? 40
    )
    const stream = this.d.stream ?? streamChat
    let t0 = Date.now()
    let first = true
    const r = await callWithNetworkRetry({
      signal,
      attempt: async () => {
        if (!first) {
          req = await this.buildFor(this.repo.chat(chat.id) ?? chat, reqSession, provider)
          acc = newAccumulator()
          t0 = Date.now()
        }
        first = false
        await stream(req, signal, acc, () => {
          markReasoning(acc, Date.now())
          draft.call()
        })
      },
      isNetwork: isConnectionFailure,
      onDiscard: () => {
        draft.cancel()
        this.emit({ type: 'draft', sessionId: session.id, draft: null })
        acc = newAccumulator()
      },
      ask: (e) => this.awaitRetryDecision(st, session, chat, provider, e, signal)
    })
    const withReasoningMs = (): Pick<MessageMeta, 'reasoningMs'> => {
      const ms = reasoningDuration(acc, Date.now())
      return ms != null ? { reasoningMs: ms } : {}
    }
    if (r.kind !== 'ok') {
      draft.cancel()
      this.emit({ type: 'draft', sessionId: session.id, draft: null })
      if (r.kind === 'error' && r.network)
        return { kind: 'error', error: errMsg(r.error), networkCancelled: true }
      if (r.kind === 'aborted' || signal.aborted) {
        if (acc.content.trim()) {
          this.append(
            session.id,
            {
              role: 'assistant',
              content: acc.content,
              ...(acc.reasoning.trim() ? { reasoning: acc.reasoning } : {})
            },
            {
              interrupted: true,
              model: acc.model ?? reqSession.model,
              durationMs: Date.now() - t0,
              ...withReasoningMs()
            }
          )
        }
        return { kind: 'aborted', partial: acc.content }
      }
      return { kind: 'error', error: errMsg(r.error) }
    }
    draft.cancel()
    this.emit({ type: 'draft', sessionId: session.id, draft: null })

    const calls: ToolCall[] = finalizeToolCalls(acc).map((t) => ({
      id: t.id,
      type: 'function',
      function: { name: t.name, arguments: t.arguments }
    }))
    const assistant: ApiMessage = {
      role: 'assistant',
      content: acc.content ? acc.content : calls.length ? null : '',
      ...(calls.length ? { tool_calls: calls } : {}),
      ...(acc.reasoning.trim() ? { reasoning: acc.reasoning } : {})
    }
    const meta: MessageMeta = {
      model: acc.model ?? reqSession.model,
      durationMs: Date.now() - t0,
      ...withReasoningMs()
    }
    if (acc.usage) meta.usage = acc.usage
    this.append(session.id, assistant, meta)

    if (calls.length) {
      for (const call of calls) {
        if (signal.aborted) break
        const o = await this.executeTool(
          session,
          call.id,
          call.function.name,
          call.function.arguments,
          signal
        )
        const tmeta: MessageMeta = { toolStatus: o.status, durationMs: o.durationMs }
        if (o.smartApprove) tmeta.smartApprove = o.smartApprove
        if (o.smartOverride) tmeta.smartOverride = true
        if (o.approval) tmeta.approval = o.approval
        if (o.askUser) tmeta.askUser = o.askUser
        if (o.status === 'cancelled') {
          tmeta.synthetic = true
          tmeta.kind = 'tool-cancelled'
        }
        this.append(
          session.id,
          { role: 'tool', tool_call_id: call.id, content: o.parts?.length ? o.parts : o.content },
          tmeta
        )
        if (o.status === 'cancelled' && signal.aborted) break
      }
      if (signal.aborted) return { kind: 'aborted', partial: '' }
      return { kind: 'continue' }
    }

    // modo texto (sem tools nativas)
    const history = this.repo.path(session.id)
    const avail = availableTools(chat, session, history)
    if (!chat.config.nativeTools && avail.length && acc.content) {
      const parsed = parseTextToolCalls(acc.content, avail)
      if (parsed.length) {
        const parts: string[] = []
        for (let i = 0; i < parsed.length; i++) {
          const p = parsed[i]
          if (signal.aborted) {
            parts.push(formatTextToolResult(p.name, CANCELLED_TEXT))
            continue
          }
          if (p.error) {
            parts.push(formatTextToolResult(p.name, `Erro: ${p.error}`))
            continue
          }
          const id = `text_${Date.now().toString(36)}_${i}`
          const o = await this.executeTool(session, id, p.name, p.args, signal)
          parts.push(formatTextToolResult(p.name, o.content))
        }
        this.append(session.id, { role: 'user', content: parts.join('\n\n') }, { synthetic: true })
        if (signal.aborted) return { kind: 'aborted', partial: '' }
        return { kind: 'continue' }
      }
    }
    return { kind: 'final', text: acc.content }
  }

  private async awaitRetryDecision(
    st: RunState,
    session: Session,
    chat: Chat,
    provider: Provider,
    error: unknown,
    signal: AbortSignal
  ): Promise<RetryOutcome> {
    if (signal.aborted) return 'cancel'
    this.setStatus(session.id, 'awaiting_retry')
    const outcome = await this.retries.request(
      {
        chatId: chat.id,
        sessionId: session.id,
        error: connectionErrorText(error),
        model: session.model || chat.config.model,
        providerName: provider.name
      },
      signal
    )
    if (outcome === 'retry' && !signal.aborted && this.runs.get(st.sessionId) === st)
      this.setStatus(session.id, 'running')
    return signal.aborted ? 'cancel' : outcome
  }

  // ---------------- tools ----------------

  private approvalSettings() {
    return normalizeApprovalSettings(
      this.d.setting('approvalModes'),
      this.d.setting('approvalLists'),
      this.d.setting('smartApproveDefaults')
    )
  }

  private toolOutputLimit(chat: Chat): number {
    return clampToolOutput(chat.config.maxToolOutputChars)
  }

  private async listsGate(
    chatId: string,
    sessionId: string,
    toolCallId: string,
    name: ToolName,
    item: ApprovalListItem,
    args: Record<string, unknown>,
    signal: AbortSignal,
    smart?: SmartApproveRecord,
    mode?: 'always' | 'smart' | 'lists'
  ): Promise<{ outcome?: Omit<ToolOutcome, 'durationMs'>; record: ApprovalRecord }> {
    for (let round = 0; ; round++) {
      const ev = evaluateLists(item, args, this.approvalSettings().lists, {})
      const allowed = ev.check.items
        .filter((i) => i.verdict === 'allow' && i.entry)
        .map((i) => ({ text: i.text, entry: i.entry! }))
      const record: ApprovalRecord = {
        item,
        mode: mode ?? (smart ? 'smart' : 'lists'),
        ...(allowed.length ? { allowed } : {})
      }
      if (ev.blocked) {
        const { text, entry, where } = ev.blocked
        return {
          record: { ...record, blocked: { text: where ? `${text} — ${where}` : text, entry } },
          outcome: { content: blockedText(item, ev.blocked), status: 'denied' }
        }
      }
      if (ev.allAllowed) return { record }
      this.setStatus(sessionId, 'awaiting_approval')
      const outcome = await this.approvals.request(
        {
          chatId,
          sessionId,
          toolCallId,
          toolName: name,
          args,
          check: ev.check,
          ...(smart ? { smartApprove: smart } : {})
        },
        signal
      )
      if (!signal.aborted) this.setStatus(sessionId, 'running')
      if (signal.aborted || outcome.kind === 'cancel')
        return { record, outcome: { content: CANCELLED_TEXT, status: 'cancelled' } }
      if (outcome.kind === 'reeval') {
        if (round > 50) return { record, outcome: { content: CANCELLED_TEXT, status: 'cancelled' } }
        continue
      }
      const pending = ev.check.items
        .map((it, index) => ({ it, index }))
        .filter(({ it }) => it.verdict !== 'allow')
      const decisions = new Map((outcome.items ?? []).map((d) => [d.index, d]))
      const entries: { item: ApprovalListItem; list: 'allow' | 'deny'; entry: string }[] = []
      let denied: string | undefined
      const userAllowed: string[] = []
      for (const { it, index } of pending) {
        const d = decisions.get(index)
        const allow = d ? d.allow : outcome.kind === 'allow'
        if (d?.pattern?.trim())
          entries.push({ item, list: allow ? 'allow' : 'deny', entry: d.pattern.trim() })
        if (allow) userAllowed.push(checkItemLabel(it))
        else denied ??= checkItemLabel(it)
      }
      if (entries.length) {
        try {
          this.d.addListEntries?.(entries)
        } catch (e) {
          this.log(`listas de aprovação: ${errMsg(e)}`)
        }
      }
      if (denied !== undefined || outcome.kind === 'deny') {
        const text = denied ?? (pending[0] ? checkItemLabel(pending[0].it) : '')
        return {
          record: { ...record, denied: text, ...(userAllowed.length ? { userAllowed } : {}) },
          outcome: { content: userDeniedText(text), status: 'denied' }
        }
      }
      return { record: { ...record, ...(userAllowed.length ? { userAllowed } : {}) } }
    }
  }

  private async executeTool(
    session: Session,
    toolCallId: string,
    rawName: string,
    rawArgs: string | Record<string, unknown>,
    signal: AbortSignal
  ): Promise<ToolOutcome> {
    const t0 = Date.now()
    let smart: SmartApproveRecord | undefined
    let smartOverride = false
    let approval: ApprovalRecord | undefined
    const done = (o: Omit<ToolOutcome, 'durationMs'>): ToolOutcome => ({
      ...o,
      ...(smart ? { smartApprove: smart } : {}),
      ...(smartOverride ? { smartOverride: true } : {}),
      ...(approval ? { approval } : {}),
      durationMs: Date.now() - t0
    })
    const chat = this.repo.chat(session.chatId)
    if (!chat) return done({ content: 'Erro: chat não encontrado.', status: 'error' })
    const name = (TOOL_ALIASES[rawName] ?? rawName) as ToolName
    if (!availableTools(chat, session).includes(name))
      return done({
        content: `Erro: a ferramenta "${rawName}" não está disponível nesta sessão.`,
        status: 'error'
      })
    let args: Record<string, unknown>
    try {
      args = parseToolArgs(rawArgs)
    } catch (e) {
      return done({ content: `Erro: ${errMsg(e)}`, status: 'error' })
    }
    const settings = this.approvalSettings()
    let route =
      name === 'ask_user'
        ? { kind: 'run' as const }
        : approvalRoute(chat.config, settings.modes, name)
    const item = TOOL_ITEM[name]
    const mode = item ? effectiveMode(chat.config, settings.modes, item) : null
    if (route.kind !== 'run' && takeOverride(session.id, name, args)) {
      smartOverride = true
      route = { kind: 'run' }
    }
    let smartCheck: ApprovalCheck | undefined
    if (route.kind === 'judge') {
      const sa = normalizeSmartApprove(chat.config.smartApprove)
      let judgeIdx: number[] | undefined
      if (isListItem(item)) {
        const plan = smartListPlan(item, args, settings.lists, {
          judgeWhitelisted: sa.judgeWhitelisted,
          safety: {}
        })
        const allowed = plan.ev.check.items
          .filter((i) => i.verdict === 'allow' && i.entry)
          .map((i) => ({ text: i.text, entry: i.entry! }))
        approval = { item, mode: 'smart', ...(allowed.length ? { allowed } : {}) }
        if (plan.kind === 'blocked') {
          const { text, entry, where } = plan.ev.blocked!
          approval.blocked = { text: where ? `${text} — ${where}` : text, entry }
          return done({ content: blockedText(item, plan.ev.blocked!), status: 'denied' })
        }
        if (plan.kind === 'run') route = { kind: 'run' }
        else if (plan.kind === 'protected') route = { kind: 'lists' }
        else {
          smartCheck = plan.ev.check
          judgeIdx = plan.judgeIdx
        }
      }
      if (route.kind === 'judge') {
        this.emit({
          type: 'tool-running',
          sessionId: session.id,
          toolCallId,
          running: true,
          judging: true
        })
        try {
          const history = this.repo.path(session.id)
          smart = await runJudge({
            sa,
            provider: sa.providerId ? this.d.provider(sa.providerId) : null,
            chatConfig: chat.config,
            ctx: {
              tool: name,
              args,
              cwd: '',
              confine: true,
              sandbox: false,
              history,
              ...(smartCheck && judgeIdx ? { check: smartCheck, judgeIdx } : {}),
              extra: buildJudgeExtras({
                history,
                cwd: '',
                ...(item ? { item } : {}),
                check: smartCheck,
                judgeIdx,
                lists: settings.lists
              }),
              environment: {
                user: effectiveEnvironment(chat.config.smartApprove, settings.smart),
                captured: capturedTextFor(chat.config.capturedContext, null, [])
              }
            },
            signal
          })
        } finally {
          this.emit({ type: 'tool-running', sessionId: session.id, toolCallId, running: false })
        }
        if (signal.aborted) return done({ content: CANCELLED_TEXT, status: 'cancelled' })
        if (smart.decision === 'reject')
          return done({ content: smartRejectText(smart.model, smart.reason), status: 'denied' })
        if (smart.decision === 'approve') {
          route = { kind: 'run' }
          if (approval && smart.judged?.length) approval.judgeAllowed = smart.judged
        } else if (smartCheck && smartCheck.items.some((i) => i.verdict !== 'allow')) {
          route = { kind: 'lists' }
        } else route = { kind: 'user' }
      }
    }
    if (route.kind === 'lists' && !isListItem(item)) route = { kind: 'user' }
    if (route.kind === 'lists' && isListItem(item)) {
      const r = await this.listsGate(
        chat.id,
        session.id,
        toolCallId,
        name,
        item,
        args,
        signal,
        mode === 'smart' ? smart : undefined,
        mode ?? undefined
      )
      approval = r.record
      if (r.outcome) return done(r.outcome)
    } else if (route.kind === 'user') {
      this.setStatus(session.id, 'awaiting_approval')
      const outcome = await this.approvals.request(
        {
          chatId: chat.id,
          sessionId: session.id,
          toolCallId,
          toolName: name,
          args,
          ...(smart ? { smartApprove: smart } : {}),
          ...('smartMissing' in route && route.smartMissing ? { smartMissing: true } : {})
        },
        signal
      )
      if (!signal.aborted) this.setStatus(session.id, 'running')
      if (outcome.kind === 'deny') {
        if (item && mode)
          approval = { ...(approval ?? { item, mode }), denied: argsSummary(name, args) }
        return done({ content: DENIED_TEXT, status: 'denied' })
      }
      if (outcome.kind !== 'allow' || signal.aborted)
        return done({ content: CANCELLED_TEXT, status: 'cancelled' })
      if (item && mode)
        approval = { ...(approval ?? { item, mode }), userAllowed: [argsSummary(name, args)] }
    } else if (route.kind === 'run' && item && mode === 'always' && !smartOverride) {
      approval = { item, mode: 'always' }
    }
    if (signal.aborted) return done({ content: CANCELLED_TEXT, status: 'cancelled' })

    if (name === 'ask_user')
      return done(await this.runAskUser(session, chat, toolCallId, args, signal))

    this.emit({ type: 'tool-running', sessionId: session.id, toolCallId, running: true })
    let latest = ''
    const out = throttle(
      () =>
        this.emit({
          type: 'tool-running',
          sessionId: session.id,
          toolCallId,
          running: true,
          output: latest.length > 20_000 ? latest.slice(-20_000) : latest
        }),
      150
    )
    try {
      const provider = this.providerFor(chat, session)
      const ctx: ToolContext = {
        signal,
        maxOutput: this.toolOutputLimit(chat),
        cacheKey: session.id,
        chatId: chat.id,
        sessionId: session.id,
        onOutput: (partial) => {
          latest = partial
          out.call()
        },
        ...(name === 'list_models'
          ? {
              models: {
                providerName: provider?.name ?? '',
                current: chat.config.model,
                list: () =>
                  provider
                    ? this.d.listModels(provider)
                    : Promise.reject(new Error('sem provedor')),
                providers: this.d.chatProviders().map((p) => ({
                  id: p.id,
                  name: p.name,
                  isSession: p.id === provider?.id,
                  list: () => this.d.listModels(p)
                }))
              }
            }
          : {})
      }
      const impl =
        name === 'web_search'
          ? (a: Record<string, unknown>, c: ToolContext) => webSearch(a, c, this.d.setting)
          : name === 'browse_url'
            ? browseUrl
            : name === 'list_models'
              ? listModelsTool
              : null
      if (!impl)
        return done({
          content: `Erro: ferramenta "${name}" indisponível no celular.`,
          status: 'error'
        })
      const r = await runToolImpl(impl, args, ctx)
      return done({ content: r.content, status: r.status })
    } catch (e) {
      if (signal.aborted || (e as Error).name === 'AbortError')
        return done({ content: CANCELLED_TEXT, status: 'cancelled' })
      return done({ content: `Erro: ${errMsg(e)}`, status: 'error' })
    } finally {
      out.cancel()
      this.emit({ type: 'tool-running', sessionId: session.id, toolCallId, running: false })
    }
  }

  private async runAskUser(
    session: Session,
    chat: Chat,
    toolCallId: string,
    args: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<Omit<ToolOutcome, 'durationMs'>> {
    if (session.depth !== 0)
      return {
        content:
          'Erro: subagentes não podem perguntar ao usuário. Decida sozinho ou devolva a dúvida no resultado final.',
        status: 'error'
      }
    const parsed = parseAskUserArgs(args)
    if ('error' in parsed) return { content: parsed.error, status: 'error' }
    let resolved
    try {
      resolved = await resolveAskUserQuestions(parsed.questions, {
        save: (data, ext) => this.d.files.save(data, ext),
        signal
      })
    } catch (e) {
      if (signal.aborted) return { content: ASK_USER_NOT_ANSWERED, status: 'cancelled' }
      return { content: `Erro: ${errMsg(e)}`, status: 'error' }
    }
    const { questions, notes } = resolved
    const tail = notes.length ? `\n\n${notes.join('\n')}` : ''
    const rec = (r: Omit<AskUserRecord, 'questions' | 'notes'>): AskUserRecord => ({
      questions,
      ...r,
      ...(notes.length ? { notes } : {})
    })
    if (signal.aborted)
      return {
        content: ASK_USER_NOT_ANSWERED + tail,
        status: 'cancelled',
        askUser: rec({ outcome: 'cancelled' })
      }
    this.setStatus(session.id, 'awaiting_input')
    const outcome = await this.questions.request(
      {
        chatId: chat.id,
        sessionId: session.id,
        toolCallId,
        questions,
        ...(notes.length ? { notes } : {})
      },
      signal
    )
    if (outcome.kind === 'cancel' || signal.aborted)
      return {
        content: ASK_USER_NOT_ANSWERED + tail,
        status: 'cancelled',
        askUser: rec({ outcome: 'cancelled' })
      }
    this.setStatus(session.id, 'running')
    return {
      content: truncateHeadTail(
        formatAskUserResult(questions, outcome.answers, notes),
        this.toolOutputLimit(chat),
        0.5
      ),
      status: 'ok',
      askUser: rec({ outcome: 'answered', answers: outcome.answers })
    }
  }

  // ---------------- API (agent.* do desktop; comandos §8.6) ----------------

  private async deliverToSession(
    session: Session,
    text: string,
    meta: MessageMeta,
    attachments: AttachmentInfo[] = [],
    skillParts: ContentPart[] = []
  ): Promise<{ queuedId?: string }> {
    if (this.runs.has(session.id)) {
      const q = this.queue.enqueue(session.id, text, attachments, meta, skillParts)
      return { queuedId: q.id }
    }
    this.repairTail(session.id)
    await this.appendUser(session, text, meta, attachments, skillParts)
    this.startLoop(session)
    return {}
  }

  /** Mensagem do usuário: rodando → fila; ociosa → turno. */
  async send(
    sessionId: string,
    text: string,
    attachmentsInput?: AttachmentInfo[],
    meta: MessageMeta = {}
  ): Promise<{ queued: boolean }> {
    const session = this.repo.session(sessionId)
    if (!session) throw new Error('Sessão não encontrada.')
    const attachments = validateAttachments(attachmentsInput, (f) => this.d.files.size(f))
    text = typeof text === 'string' ? text : ''
    if (!text.trim() && !attachments.length) throw new Error('Mensagem vazia.')
    const r = await this.deliverToSession(session, text, meta, attachments)
    return { queued: !!r.queuedId }
  }

  getQueue(sessionId: string): QueuedMessage[] {
    return this.queue.get(sessionId)
  }

  forceSend(queuedId: string): void {
    const item = this.queue.take(queuedId)
    if (!item) return
    const st = this.runs.get(item.sessionId)
    if (st && !st.stopRequested) {
      st.forced.push(item)
      st.controller.abort()
      return
    }
    const session = this.repo.session(item.sessionId)
    if (!session) return
    if (st) {
      this.queue.requeueFront(item.sessionId, [item])
      return
    }
    void this.deliverToSession(
      session,
      item.text,
      item.meta ?? {},
      item.attachments,
      item.skillParts
    )
  }

  removeQueued(queuedId: string): void {
    this.queue.take(queuedId)
  }

  /** Tira os itens da fila de todas as sessões do chat (repasse na troca de host, §8.8). */
  takeChatQueues(chatId: string): QueuedMessage[] {
    const out: QueuedMessage[] = []
    for (const sid of this.queue.sessions()) {
      if (this.repo.session(sid)?.chatId !== chatId) continue
      out.push(...this.queue.drain(sid))
    }
    return out
  }

  private waitDone(st: RunState, ms = 15_000): Promise<void> {
    return Promise.race([
      st.done.then(() => undefined),
      new Promise<void>((r) => setTimeout(r, ms))
    ])
  }

  async stop(sessionId: string): Promise<void> {
    const st = this.runs.get(sessionId)
    if (!st) return
    st.stopRequested = true
    if (st.forced.length) this.queue.requeueFront(sessionId, st.forced.splice(0))
    st.controller.abort()
    await this.waitDone(st)
  }

  /** Para tudo do chat (parciais persistidos como no Parar) — troca forçada/segundo plano. */
  async stopChat(chatId: string, clearQueues = false, status?: SessionStatus): Promise<void> {
    if (clearQueues) for (const s of this.repo.sessions(chatId)) this.queue.clear(s.id)
    const sts = [...this.runs.values()].filter((s) => s.chatId === chatId)
    for (const st of sts) {
      st.stopRequested = true
      if (status) st.stopStatus = status
      if (st.forced.length) this.queue.requeueFront(st.sessionId, st.forced.splice(0))
      st.controller.abort()
    }
    await Promise.all(sts.map((st) => this.waitDone(st, 5000)))
    if (clearQueues) for (const s of this.repo.sessions(chatId)) this.queue.clear(s.id)
  }

  /** Fase 4b (subagentes): nada a parar ainda. */
  async stopSubagents(_chatId: string): Promise<void> {}

  approve(requestId: string, decision: 'allow' | 'deny', items?: ApprovalItemDecision[]): void {
    const req = this.approvals.get(requestId)
    if (!req) throw new Error('Esta aprovação não está mais pendente.')
    if (items?.length && req.check) {
      const list = req.check.item as ApprovalListItem
      for (const d of items) {
        if (!req.check.items[d.index]) throw new Error(`Item ${d.index} inexistente.`)
        if (d.pattern != null) {
          const err = validateListEntry(list, d.pattern)
          if (err) throw new Error(`Padrão inválido "${d.pattern}": ${err}`)
        }
      }
    }
    this.approvals.resolve(requestId, { kind: decision === 'allow' ? 'allow' : 'deny', items })
  }

  /** "Executar mesmo assim" num resultado rejeitado pelo Smart-Approve (= desktop). */
  async smartOverride(messageId: string): Promise<void> {
    const msg = this.repo.get(messageId)
    if (!msg || msg.message.role !== 'tool') throw new Error('Mensagem não encontrada.')
    const rec = msg.meta.smartApprove
    if (!rec || rec.decision !== 'reject')
      throw new Error('Esta chamada não foi rejeitada pelo Smart-Approve.')
    if (rec.overridden) return
    const session = this.repo.session(msg.sessionId)
    if (!session) throw new Error('Sessão não encontrada.')
    const toolCallId = msg.message.tool_call_id
    let call: ToolCall | undefined
    for (const m of this.repo.listAll(session.id)) {
      if (m.message.role === 'assistant')
        call = m.message.tool_calls?.find((t) => t.id === toolCallId) ?? call
      if (call) break
    }
    if (!call) throw new Error('Chamada original não encontrada no histórico.')
    const args = parseToolArgs(call.function.arguments)
    const tool = call.function.name as ToolName
    addOverride(session.id, tool, args)
    const updated = this.repo.update(msg.id, msg.message, {
      ...msg.meta,
      smartApprove: { ...rec, overridden: true }
    })
    this.emit({ type: 'message-updated', message: updated })
    await this.deliverToSession(session, overrideMessageText(tool, args), {})
  }

  answerQuestion(id: string, answers: QuestionAnswer[]): void {
    this.questions.answer(id, answers)
  }

  /** Cancelar o questionário = Parar (o agente não continua). */
  async cancelQuestion(id: string): Promise<void> {
    const q = this.questions.get(id)
    if (!q) return
    if (this.runs.has(q.sessionId)) await this.stop(q.sessionId)
    this.questions.cancel(id)
  }

  retry(id: string): void {
    if (!this.retries.get(id)) throw new Error('Esta falha de conexão não está mais pendente.')
    this.retries.resolve(id, 'retry')
  }

  cancelRetry(id: string): void {
    this.retries.resolve(id, 'cancel')
  }

  private isSessionBusy(s: Session): boolean {
    return this.runs.has(s.id) || BUSY.includes(s.status)
  }

  private async stopForBranch(sessionId: string): Promise<void> {
    if (this.runs.has(sessionId)) await this.stop(sessionId)
    if (this.runs.has(sessionId)) throw new Error('A sessão ainda está parando; tente novamente.')
  }

  /** Nova versão (irmã) de uma mensagem digitada na principal, e roda o turno. */
  async editBranch(messageId: string, message: ApiMessage): Promise<void> {
    const cur = this.repo.get(messageId)
    if (!cur) throw new Error('Mensagem não encontrada.')
    const session = this.repo.session(cur.sessionId)
    if (!session) throw new Error('Sessão não encontrada.')
    if (!isBranchEditable(cur, session.depth))
      throw new Error('Só mensagens digitadas na sessão principal viram uma nova versão.')
    if (!message || typeof message !== 'object' || message.role !== 'user')
      throw new Error('Mensagem inválida.')
    const content = withUserText(cur.message.content, contentText(message.content))
    if (!contentText(content).trim() && !(Array.isArray(content) && content.length))
      throw new Error('Mensagem vazia.')
    await this.stopForBranch(session.id)
    const m = this.repo.addSibling(cur.id, { role: 'user', content })
    this.emit({ type: 'message-added', message: m })
    const s = this.repo.session(session.id) ?? session
    this.emit({ type: 'session-updated', session: s })
    this.repo.touch(session.chatId)
    this.startLoop(s)
  }

  /** Nova versão da resposta do turno que contém `messageId` (padrão: o último). */
  async regenerate(sessionId: string, messageId?: string): Promise<void> {
    const session = this.repo.session(sessionId)
    if (!session) throw new Error('Sessão não encontrada.')
    if (session.depth !== 0) throw new Error('Subsessões são somente leitura.')
    await this.stopForBranch(sessionId)
    const path = this.repo.path(sessionId)
    if (messageId && !path.some((m) => m.id === messageId))
      throw new Error('Esta mensagem não está na versão ativa da conversa.')
    const prompt = messageId ? turnAnchor(path, messageId) : lastTurnAnchor(path)
    if (!prompt) throw new Error('Não há mensagem do usuário para regenerar.')
    const after = path.slice(path.findIndex((m) => m.id === prompt.id) + 1)
    const response = turnResponse(path, prompt.id)
    if (
      after.length &&
      after.length === response.length &&
      response.every((m) => isDisplayOnly(m.meta))
    ) {
      for (const m of response) this.deleteMessage(m.id)
    } else if (after.length) {
      const cur = this.repo.session(sessionId)
      if (!cur) return
      const s = this.repo.setBranchSel(sessionId, { ...cur.branchSel, [prompt.id]: null })
      if (s) this.emit({ type: 'session-updated', session: s })
    }
    if (this.runs.has(sessionId)) return
    this.startLoop(this.repo.session(sessionId) ?? session)
  }

  /** Troca de versão (recusada com a sessão ocupada). */
  selectBranch(messageId: string): Session {
    const cur = this.repo.get(messageId)
    if (!cur) throw new Error('Mensagem não encontrada.')
    const session = this.repo.session(cur.sessionId)
    if (!session) throw new Error('Sessão não encontrada.')
    if (this.isSessionBusy(session))
      throw new Error('Aguarde o agente terminar para trocar de versão.')
    const tree = buildTree(this.repo.listAll(session.id))
    void activePath(tree, pruneSel(tree, selectionToReach(tree, session.branchSel, cur.id)))
    const s = this.repo.select(cur.id)
    this.emit({ type: 'session-updated', session: s })
    return s
  }

  editMessage(id: string, message: ApiMessage): StoredMessage {
    const cur = this.repo.get(id)
    if (!cur) throw new Error('Mensagem não encontrada.')
    const m = this.repo.update(id, message)
    this.emit({ type: 'message-updated', message: m })
    return m
  }

  deleteMessage(id: string): void {
    const r = this.repo.remove(id)
    if (!r) return
    this.emit({ type: 'message-deleted', sessionId: r.message.sessionId, messageId: id })
    for (const x of r.reparented) this.emit({ type: 'message-updated', message: x })
    if (r.selChanged) {
      const s = this.repo.session(r.message.sessionId)
      if (s) this.emit({ type: 'session-updated', session: s })
    }
  }

  /** Fase 4b. */
  compact(_sessionId: string): { scheduled: boolean } {
    throw new Error('Compactar ainda não está disponível em chats executados no celular.')
  }

  /** Fase 4b. */
  async extractMemory(_sessionId: string): Promise<void> {
    throw new Error('Extrair memórias ainda não está disponível em chats executados no celular.')
  }

  /**
   * Ao abrir a janela (virar host, reabrir o app): status transitório gravado sem execução local
   * vira `interrupted` e tools sem resposta são canceladas (= markStaleInterrupted do desktop).
   */
  normalizeStale(chatId: string): void {
    for (const s of this.repo.sessions(chatId)) {
      if (this.runs.has(s.id) || !BUSY.includes(s.status)) continue
      try {
        this.repairTail(s.id)
        this.clearPendingBranch(s.id)
      } catch (e) {
        this.log(`normalizar sessão: ${errMsg(e)}`)
      }
      this.setStatus(s.id, 'interrupted')
    }
  }
}

export { abortError }
