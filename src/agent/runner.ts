// Loop do agente no celular — porta de ClearChatDesktop/src/main/agent/runner.ts com a mesma
// semântica de turno: mensagem → request → stream (draft) → mensagem assistant persistida
// (modelo, tokens, custo, duração, raciocínio) → tools (aprovação/Smart-Approve/listas,
// questionário) → resultados → repete; fila e ⚡ forçar; Parar (parcial com `interrupted`, tools
// sem resposta canceladas); card de falha de conexão; erro persistido; regenerar/editar/trocar de
// versão/editar/apagar mensagens; subagentes (bloqueantes e em segundo plano, callbacks, mensagens
// entre pai/filhos/irmãos com limite); memória (índice congelado por sessão, tools, extração);
// entre chats (list_chats, get_chat_info, send_to_chat — local ou por comando ao host do destino);
// read_history; compactação (pedida, automática pelo contexto e "compactar e tentar de novo") e
// título automático. Sem React Native.
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
import { contentText, isAppPart, messageAttachments, messageSkills } from '@shared/attachments'
import {
  AUTO_TITLE_DEFAULTS,
  AUTO_TITLE_MEMORY_HEADER,
  AUTO_TITLE_SETTING,
  autoTitleEnabled,
  normalizeAutoTitleSettings,
  type AutoTitleRecord,
  type AutoTitleSettings
} from '@shared/autoTitle'
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
import {
  compactThreshold,
  contextUsage,
  hasCompactableHistory,
  isContextLengthError,
  isDisplayOnly,
  resolveContextWindow
} from '@shared/context'
import { DEFAULT_COMPACT_PROMPT } from '@shared/defaults'
import {
  interChatHeader,
  interChatText,
  nextInterChatHops,
  splitInterChatText,
  wouldCreateWaitCycle,
  type WaitEdge
} from '@shared/interChat'
import { clampToolOutput, LIMITS } from '@shared/limits'
import type { MemoryExtractionResult } from '@shared/memory'
import { sessionProviderId } from '@shared/models'
import { connectionErrorText, isConnectionFailure } from '@shared/network'
import { capturedTextFor, effectiveEnvironment } from '@shared/contextCapture'
import {
  isSiblingKind,
  siblingBroadcastText,
  siblingMessageText,
  splitSiblingText
} from '@shared/siblings'
import {
  argsSummary,
  normalizeSmartApprove,
  overrideMessageText,
  smartRejectText
} from '@shared/smartApprove'
import { buildJudgeExtras } from '@shared/smartApproveContext'
import { MEMORY_TOOL_NAMES } from '@shared/tools'
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
import { runAutoTitle, type AutoTitleDeps } from '@vendor/desktop/agent/autoTitle'
import {
  buildCompactionRequest,
  cleanSummary,
  COMPACTION_MODES,
  compactionMeta
} from '@vendor/desktop/agent/compaction'
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
import {
  callbackText,
  formatSiblingExchanges,
  formatSiblingList,
  formatSubagentList,
  fmtDuration,
  parentMessageText,
  ReportRegistry,
  resolveMessageTarget,
  resolveSubagentRef,
  siblingPairKey,
  SlidingWindowLimiter,
  subtreeIds,
  type Report,
  type RunOutcome,
  type SiblingExchange,
  type SubagentRow
} from '@vendor/desktop/agent/subagents'
import { formatTextToolResult, parseTextToolCalls } from '@vendor/desktop/agent/textTools'
import {
  extractionSummaryText,
  runExtraction,
  type ExtractionTrigger
} from '@vendor/desktop/memory/extraction'
import { getChatInfoTool, listChatsTool } from '@vendor/desktop/tools/chats'
import { readHistoryTool } from '@vendor/desktop/tools/history'
import { runMemoryTool } from '@vendor/desktop/tools/memory'
import {
  delegateEmptyText,
  delegateFailureText,
  listModelsTool,
  resolveSubagentTarget
} from '@vendor/desktop/tools/models'
import type { ChatRepo } from '@/host/repo'
import type { MemoryService } from '@/memory/service'
import { buildUserContent, referencedFiles, validateAttachments } from './attachments'
import type { HistoryStore } from './historyStore'
import {
  AgentBus,
  ApprovalRegistry,
  callWithNetworkRetry,
  QuestionRegistry,
  QueueRegistry,
  RetryRegistry,
  type RetryOutcome
} from './registries'
import { availableTools, buildRequest, currentEnv, type BuiltRequest } from './request'
import { resolveAskUserQuestions } from './tools/askUser'
import {
  abortError,
  parseToolArgs,
  runToolImpl,
  truncate,
  truncateHeadTail,
  type ChatListEntry,
  type ToolContext
} from './tools/util'
import { browseUrl, webSearch } from './tools/web'

export const CANCELLED_TEXT = '[Interrompido pelo usuário antes de concluir]'
export const DENIED_TEXT = 'O usuário negou a execução desta ferramenta.'
const MAX_DEPTH = 2

/**
 * Entrega de send_to_chat (o host decide pelo estado do chat de destino, §8): executado/executável
 * aqui → local (janela aberta antes); executado por outro dispositivo online → comando `send` ao
 * host dele (§8.6); senão recusa com texto claro.
 */
export type InterChatRoute =
  { kind: 'local' } | { kind: 'remote'; hostName: string } | { kind: 'refuse'; error: string }

export interface InterChatRouter {
  route(chatId: string): InterChatRoute
  /** Abre a janela de escrita do chat de destino executado aqui. Erro legível (pt-BR). */
  ensureLocal(chatId: string): Promise<void>
  /** Comando `send` ao host do destino. */
  sendRemote(chatId: string, sessionId: string, text: string): Promise<{ queued: boolean }>
  /**
   * Espera o turno do host remoto que trata `text` terminar (estado do chat + registros
   * sincronizados): resposta final, tempo esgotado ou erro.
   */
  waitRemote(
    chatId: string,
    sessionId: string,
    text: string,
    signal: AbortSignal,
    ms: number
  ): Promise<
    { kind: 'final'; text: string } | { kind: 'timeout' } | { kind: 'error'; error: string }
  >
  /** Estado para list_chats de um chat executado em outro dispositivo (null = ocioso/desconhecido). */
  remoteStatus?(chatId: string): ChatListEntry['status'] | null
}

/** Chat para list_chats/send_to_chat (todos os sincronizados). */
export interface ChatSummary {
  id: string
  title: string
  model: string
  updatedAt: number
}

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
  /** Memória (índice local + snapshot por sessão); ausente = sem memória no celular. */
  memory?: MemoryService
  /** read_history em outros chats (cache local). */
  historyStore?: () => HistoryStore
  /** Todos os chats sincronizados (list_chats, send_to_chat). */
  listChats?: () => ChatSummary[]
  /** Entrega de send_to_chat em outro chat (local ou ao host remoto). */
  interChat?: InterChatRouter
  now?: () => number
}

interface CompactRequest {
  reason: 'manual' | 'auto'
  /** Depois de compactar, continua o turno ("Compactar e tentar de novo"). */
  retry?: boolean
}

type CompactionResult =
  { kind: 'ok' } | { kind: 'skipped' } | { kind: 'aborted' } | { kind: 'error'; error: string }

type TurnWait = (LoopOutcome | { kind: 'timeout' } | { kind: 'undelivered' }) & { run?: RunState }

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
  /** Compactação pedida/agendada: roda no próximo limite de passo. */
  compact: CompactRequest | null
  /** Loop iniciado só para compactar (ocioso): termina depois, salvo fila/⚡/retry. */
  compactOnly: boolean
  /** Já houve compactação automática desde a última chamada bem-sucedida (evita laço). */
  autoCompactTried: boolean
  /** Execução de subsessão que reporta ao pai por callback (segundo plano / retomada). */
  report?: Report
}

interface ToolOutcome {
  content: string
  parts?: ContentPart[]
  status: 'ok' | 'error' | 'denied' | 'cancelled'
  smartApprove?: SmartApproveRecord
  smartOverride?: boolean
  approval?: ApprovalRecord
  askUser?: AskUserRecord
  subSessionId?: string
  /** send_to_chat: chat de destino resolvido. */
  targetChatId?: string
  /** delegate_task em segundo plano. */
  background?: boolean
  /** memory_write/rewrite/delete: o que mudou (card da tool). */
  memoryChanges?: MessageMeta['memoryChanges']
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
  /** Execuções de subsessões que reportam ao pai por callback (segundo plano / retomadas). */
  readonly reports = new ReportRegistry()
  /** Resolvida depois que o callback de cada execução foi tratado (por id do Report). */
  private reportSettled = new Map<number, Promise<void>>()
  /** Subagentes dormindo (status 'waiting'): acorda quando chega mensagem/callback. */
  private wakers = new Map<string, () => void>()
  /** Esperas em andamento (send_to_chat com wait_for_reply): chat que espera → chat aguardado. */
  private waitEdges: (WaitEdge & { id: number })[] = []
  private waitSeq = 0
  /** Limite anti pingue-pongue entre irmãos (em memória). */
  readonly siblingLimiter = new SlidingWindowLimiter()
  /** Extrações de memória em andamento (uma por sessão). */
  private extracting = new Map<string, { chatId: string; p: Promise<MemoryExtractionResult> }>()
  private windowCache = new Map<string, { at: number; models: ModelInfo[] | null }>()
  private titleInflight = new Map<string, Promise<string>>()
  /** Compactação ativa por sessão (para o snapshot do espelho local). */
  private compactionState = new Map<string, { state: 'scheduled' | 'running'; text?: string }>()

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
    if (e.type === 'compaction') {
      if (e.state) this.compactionState.set(e.sessionId, { state: e.state, text: e.text })
      else this.compactionState.delete(e.sessionId)
    }
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
    for (const x of this.extracting.values()) out.add(x.chatId)
    return out
  }

  /** Compactação agendada/rodando numa sessão (espelho local). */
  compaction(sessionId: string): { state: 'scheduled' | 'running'; text?: string } | null {
    return this.compactionState.get(sessionId) ?? null
  }

  private now(): number {
    return this.d.now?.() ?? Date.now()
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

  /** Título provisório (1ª mensagem truncada) de um chat novo; devolve o título gravado ou null. */
  private maybeSetTitle(session: Session, text: string): string | null {
    if (session.depth !== 0) return null
    const chat = this.repo.chat(session.chatId)
    if (!chat || (chat.title && chat.title !== 'Novo chat')) return null
    if (this.repo.path(session.id).some((m) => m.message.role === 'user')) return null
    const line = text.replace(/\s+/g, ' ').trim()
    if (!line) return null
    const title = line.length > 50 ? line.slice(0, 50).trimEnd() + '…' : line
    this.repo.updateChat(chat.id, { title })
    return title
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
    // mensagem de outro chat: o título (se ainda não houver) vem do corpo, sem o cabeçalho
    const titleText = meta.kind === 'inter-chat' ? splitInterChatText(text).body : text
    const names = attachments.map((a) => a.name)
    const provisional = this.maybeSetTitle(session, titleText.trim() ? titleText : names.join(', '))
    const texts = new Map<string, string>()
    for (const a of attachments)
      if (a.kind === 'text') texts.set(a.file, await this.readTextFile(a.file))
    const content = buildUserContent(text, attachments, skillParts, (f) => texts.get(f) ?? '')
    const stored = this.append(session.id, { role: 'user', content }, meta)
    // título automático (Configurações → Novos chats): só a 1ª mensagem DIGITADA, em segundo plano
    if (provisional !== null && isTypedFirstMessage(meta))
      this.scheduleAutoTitle(session.chatId, text, names, provisional, stored.id)
    return stored
  }

  // ---------------- loop ----------------

  private startLoop(
    session: Session,
    parentSignal?: AbortSignal,
    init: { compact?: CompactRequest; compactOnly?: boolean } = {}
  ): RunState {
    const st: RunState = {
      sessionId: session.id,
      chatId: session.chatId,
      depth: session.depth,
      controller: new AbortController(),
      stopRequested: false,
      forced: [],
      done: Promise.resolve({ kind: 'final', text: '' }),
      compact: init.compact ?? null,
      compactOnly: !!init.compactOnly,
      autoCompactTried: false
    }
    if (parentSignal) {
      if (parentSignal.aborted) st.controller.abort()
      else parentSignal.addEventListener('abort', () => st.controller.abort(), { once: true })
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
    if (st.compact) {
      st.compact = null
      this.emit({ type: 'compaction', sessionId: st.sessionId, state: null })
    }
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
      st.compactOnly = false
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
      // ---- compactação no limite de passo (pedida, agendada ou automática) ----
      if (!st.compact && !st.autoCompactTried && (await this.shouldAutoCompact(st)))
        st.compact = { reason: 'auto' }
      if (st.compact) {
        const req = st.compact
        st.compact = null
        if (req.reason === 'auto') st.autoCompactTried = true
        const signal = st.controller.signal
        let cr: CompactionResult
        try {
          cr = await this.runCompaction(st, signal)
        } catch (e) {
          cr = signal.aborted ? { kind: 'aborted' } : { kind: 'error', error: errMsg(e) }
        }
        if (signal.aborted || cr.kind === 'aborted') {
          const r = await this.onAborted(st, '')
          if (r === 'continue') continue
          return r
        }
        if (cr.kind === 'error') {
          const error = `Falha ao compactar: ${cr.error}`
          this.appendError(st.sessionId, error)
          this.emit({ type: 'error', sessionId: st.sessionId, error })
          if (st.compactOnly) {
            this.finish(st, 'error')
            return { kind: 'error', error }
          }
        }
        if (st.compactOnly) {
          st.compactOnly = false
          const more =
            (req.retry && cr.kind !== 'error') ||
            st.forced.length > 0 ||
            this.queue.has(st.sessionId)
          if (!more) {
            this.finish(st, st.depth === 0 ? 'idle' : 'done')
            return { kind: 'final', text: lastText }
          }
          await this.injectForced(st)
        }
      }

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
        // contexto estourado: compacta e tenta de novo (subsessões sempre; principal com autoCompact)
        if (isContextLengthError(res.error) && !st.autoCompactTried) {
          const chat = this.repo.chat(st.chatId)
          if (chat && autoCompactAllowed(chat, st.depth)) {
            st.compact = { reason: 'auto' }
            continue
          }
        }
        this.repairTail(st.sessionId)
        this.appendError(st.sessionId, res.error)
        this.finish(st, 'error')
        this.emit({ type: 'error', sessionId: st.sessionId, error: res.error })
        return res
      }
      st.autoCompactTried = false // houve chamada bem-sucedida (usage nova)
      if (res.kind === 'continue') continue
      lastText = res.text
      // compactação agendada durante o último passo: roda agora e encerra o turno (salvo fila/⚡)
      if (st.compact) {
        st.compactOnly = true
        continue
      }
      if (st.forced.length) {
        await this.injectForced(st)
        continue
      }
      if (this.queue.has(st.sessionId)) continue
      // subagente com filhos em segundo plano pendentes: dorme até os callbacks; só reporta ao pai
      // quando encerrar um turno sem filhos pendentes
      if (st.depth > 0 && this.reports.pending(st.sessionId).length) {
        const aborted = await this.sleepWhilePending(st)
        if (aborted) {
          const r = await this.onAborted(st, res.text)
          if (r === 'continue') continue
          return r
        }
        if (this.queue.has(st.sessionId)) continue
      }
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
    // memória: o índice vai congelado por sessão (snapshot no 1º request; registro `session`)
    if (session.depth === 0) this.ensureSnapshot(chat, session)
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
        if (o.subSessionId) tmeta.subSessionId = o.subSessionId
        if (o.targetChatId) tmeta.targetChatId = o.targetChatId
        if (o.background) tmeta.background = true
        if (o.memoryChanges?.length) tmeta.memoryChanges = o.memoryChanges
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
        let subSessionId: string | undefined
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
          if (o.subSessionId) subSessionId = o.subSessionId
          parts.push(formatTextToolResult(p.name, o.content))
        }
        this.append(
          session.id,
          { role: 'user', content: parts.join('\n\n') },
          { synthetic: true, ...(subSessionId ? { subSessionId } : {}) }
        )
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
    if (name === 'delegate_task')
      return done(await this.runDelegate(session, chat, toolCallId, args, signal))
    if (name === 'send_to_chat') return done(await this.runSendToChat(session, chat, args, signal))
    if (name === 'check_subagents') return done(this.runCheckSubagents(session, chat, args))
    if (name === 'wait_subagents')
      return done(await this.runWaitSubagents(session, chat, args, signal))
    if (name === 'cancel_subagent') return done(await this.runCancelSubagent(session, chat, args))
    if (name === 'message_subagent')
      return done(await this.runMessageSubagent(session, chat, args, signal))
    if (MEMORY_TOOL_NAMES.includes(name)) {
      const mem = this.d.memory
      if (!mem)
        return done({ content: 'Erro: a memória não está ativa neste chat.', status: 'error' })
      const r = runMemoryTool(name, args, {
        store: mem.store,
        am: mem.active(chat, session),
        by: { updatedBy: 'model', chatId: chat.id }
      })
      return done({
        content: r.content,
        status: r.status,
        ...(r.changes?.length ? { memoryChanges: r.changes } : {})
      })
    }

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
          : {}),
        ...(name === 'get_chat_info' || name === 'list_chats'
          ? { chats: this.chatToolsCtx(chat, session) }
          : {}),
        ...(name === 'read_history'
          ? {
              history: () => this.repo.path(session.id),
              ...(this.d.historyStore ? { historyStore: this.d.historyStore() } : {})
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
              : name === 'get_chat_info'
                ? getChatInfoTool
                : name === 'list_chats'
                  ? listChatsTool
                  : name === 'read_history'
                    ? readHistoryTool
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

  // ---------------- entrega / fila ----------------

  /**
   * Entrega uma mensagem `role: user` a uma sessão como se o usuário a digitasse (= desktop):
   * rodando (ou dormindo) → fila, injetada no próximo limite de passo; ociosa → inicia um turno.
   * Subsessão retomada → a nova resposta final volta ao pai como callback. `wake=false` só registra
   * a mensagem numa sessão parada (não inicia turno).
   */
  private async deliverToSession(
    session: Session,
    text: string,
    meta: MessageMeta,
    wake = true,
    attachments: AttachmentInfo[] = [],
    skillParts: ContentPart[] = []
  ): Promise<{ queuedId?: string; run?: RunState }> {
    const cur = this.runs.get(session.id)
    if (cur) {
      const q = this.queue.enqueue(session.id, text, attachments, meta, skillParts)
      this.wakeSession(session.id)
      return { queuedId: q.id, run: cur }
    }
    this.repairTail(session.id)
    await this.appendUser(session, text, meta, attachments, skillParts)
    if (!wake) return {}
    // outra entrega iniciou o loop enquanto esta gravava: a mensagem já está no histórico dele
    const raced = this.runs.get(session.id)
    if (raced) return { run: raced }
    const run = this.startLoop(session)
    if (session.depth > 0 && session.parentSessionId) this.attachReport(run, session, true)
    return { run }
  }

  /** Mensagem do usuário: rodando → fila; ociosa → turno; subagente concluído → retoma. */
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
    const r = await this.deliverToSession(session, text, meta, true, attachments)
    return { queued: !!r.queuedId }
  }

  getQueue(sessionId: string): QueuedMessage[] {
    return this.queue.get(sessionId)
  }

  private isQueued(sessionId: string, queuedId: string): boolean {
    return this.queue.get(sessionId).some((q) => q.id === queuedId)
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
      true,
      item.attachments,
      item.skillParts
    )
  }

  removeQueued(queuedId: string): void {
    this.queue.take(queuedId)
  }

  /** Devolve itens guardados à fila (segundo plano → primeiro plano); não inicia turno. */
  restoreQueue(sessionId: string, items: QueuedMessage[]): void {
    if (this.repo.session(sessionId)) this.queue.requeueFront(sessionId, items)
  }

  /**
   * Tira os itens DO USUÁRIO da fila de todas as sessões do chat (repasse na troca de host, §8.8,
   * e fila guardada no segundo plano). Callbacks de subagentes ficam (viram mensagem no `stopChat`).
   */
  takeChatQueues(chatId: string): QueuedMessage[] {
    const out: QueuedMessage[] = []
    for (const sid of this.queue.sessions()) {
      if (this.repo.session(sid)?.chatId !== chatId) continue
      for (const q of this.queue.get(sid)) {
        if (q.meta?.kind === 'subagent-callback') continue
        this.queue.take(q.id)
        out.push(q)
      }
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
    const session = this.repo.session(sessionId)
    // subagente: para ele e todos os descendentes (inclusive os em segundo plano)
    if (session && session.depth > 0) return this.stopSubtree(session)
    const st = this.runs.get(sessionId)
    if (!st) return
    st.stopRequested = true
    if (st.forced.length) this.queue.requeueFront(sessionId, st.forced.splice(0))
    st.controller.abort()
    await this.waitDone(st)
  }

  /**
   * Para tudo do chat (parciais persistidos como no Parar) — troca de host, segundo plano, perda do
   * host. Subagentes em segundo plano não acordam ninguém: os callbacks deles entram como mensagem
   * no pai já parado (sem novo turno). `clearQueues` descarta o que sobrou nas filas.
   */
  async stopChat(chatId: string, clearQueues = false, status?: SessionStatus): Promise<void> {
    const ids = new Set(this.repo.sessions(chatId).map((s) => s.id))
    for (const r of this.reports.all()) if (ids.has(r.sessionId) && !r.outcome) r.silent = true
    const sts = [...this.runs.values()].filter((s) => s.chatId === chatId)
    for (const st of sts) {
      st.stopRequested = true
      if (status) st.stopStatus = status
      if (st.forced.length) this.queue.requeueFront(st.sessionId, st.forced.splice(0))
      st.controller.abort()
    }
    await Promise.all(sts.map((st) => this.waitDone(st, 5000)))
    await Promise.all(
      this.reports
        .all()
        .filter((r) => ids.has(r.sessionId))
        .map((r) => this.reportSettled.get(r.id) ?? Promise.resolve())
    )
    // callbacks que entraram na fila de um pai que estava parando: viram mensagem agora
    for (const sid of ids) {
      if (this.runs.has(sid)) continue
      for (const q of this.queue.get(sid)) {
        if (q.meta?.kind !== 'subagent-callback') continue
        this.queue.take(q.id)
        try {
          this.repairTail(sid)
          this.append(sid, { role: 'user', content: q.text }, q.meta)
        } catch (e) {
          this.log(`callback de subagente: ${errMsg(e)}`)
        }
      }
    }
    if (clearQueues) for (const sid of ids) this.queue.clear(sid)
  }

  /** "Parar subagentes" do chat (a sessão principal continua). */
  async stopSubagents(chatId: string): Promise<void> {
    const tops = this.repo.sessions(chatId).filter((s) => s.depth === 1)
    await Promise.all(tops.map((s) => this.stopSubtree(s)))
  }

  // ---------------- aprovações / questionários / retry ----------------

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

  // ---------------- versões / edição ----------------

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
    // caminho novo = ancestrais da original + a versão nova; o resto do caminho atual sai
    const now = this.repo.session(session.id) ?? session
    const tree = buildTree(this.repo.listAll(session.id))
    const keep = new Set<string>()
    for (let p = tree.parentOf.get(cur.id) ?? null; p; p = tree.parentOf.get(p) ?? null) keep.add(p)
    const abandoned = activePath(tree, now.branchSel ?? {}).filter((m) => !keep.has(m.id))
    await this.stopAbandonedSubagents(session, abandoned)
    if (this.runs.has(session.id)) throw new Error('A sessão voltou a rodar; tente novamente.')
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
      for (const m of response) await this.deleteMessage(m.id)
    } else if (after.length) {
      await this.stopAbandonedSubagents(session, after)
      if (this.runs.has(sessionId)) throw new Error('A sessão voltou a rodar; tente novamente.')
      const cur = this.repo.session(sessionId)
      if (!cur) return
      const s = this.repo.setBranchSel(sessionId, { ...cur.branchSel, [prompt.id]: null })
      if (s) this.emit({ type: 'session-updated', session: s })
    }
    if (this.runs.has(sessionId)) return
    this.startLoop(this.repo.session(sessionId) ?? session)
  }

  /**
   * Troca de versão (recusada com a sessão ocupada ou com subagente em segundo plano rodando na
   * parte que sai ou entra no caminho).
   */
  selectBranch(messageId: string): Session {
    const cur = this.repo.get(messageId)
    if (!cur) throw new Error('Mensagem não encontrada.')
    const session = this.repo.session(cur.sessionId)
    if (!session) throw new Error('Sessão não encontrada.')
    if (this.isSessionBusy(session))
      throw new Error('Aguarde o agente terminar para trocar de versão.')
    const tree = buildTree(this.repo.listAll(session.id))
    const before = activePath(tree, session.branchSel ?? {})
    const next = activePath(
      tree,
      pruneSel(tree, selectionToReach(tree, session.branchSel ?? {}, cur.id))
    )
    const live = this.liveSubSessionsOf(session, [
      ...leftBehind(before, next),
      ...leftBehind(next, before)
    ])
    if (live.length)
      throw new Error(
        `${live.length === 1 ? 'Há um subagente' : `Há ${live.length} subagentes`} em segundo plano rodando nesta versão — aguarde terminar ou pare antes de trocar de versão.`
      )
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

  /** Apaga uma mensagem + as subsessões que ela originou (delegate_task). */
  async deleteMessage(id: string): Promise<void> {
    const r = this.repo.remove(id)
    if (!r) return
    this.emit({ type: 'message-deleted', sessionId: r.message.sessionId, messageId: id })
    for (const x of r.reparented) this.emit({ type: 'message-updated', message: x })
    if (r.selChanged) {
      const s = this.repo.session(r.message.sessionId)
      if (s) this.emit({ type: 'session-updated', session: s })
    }
    await this.deleteSubSessionsOf([r.message])
  }

  // ---------------- compactação (pedida) ----------------

  /**
   * Compactar (só a principal; subsessões compactam sozinhas). Ociosa → roda já (loop só de
   * compactação); rodando → agenda para o próximo limite de passo.
   */
  compact(sessionId: string, opts: { retry?: boolean } = {}): { scheduled: boolean } {
    const session = this.repo.session(sessionId)
    if (!session) throw new Error('Sessão não encontrada.')
    if (session.depth !== 0)
      throw new Error('Subsessões são somente leitura (compactam automaticamente).')
    const req: CompactRequest = { reason: 'manual', retry: !!opts.retry }
    const st = this.runs.get(sessionId)
    if (st) {
      if (st.stopRequested) throw new Error('A sessão está parando; tente novamente.')
      st.compact = req
      this.emit({ type: 'compaction', sessionId, state: 'scheduled' })
      return { scheduled: true }
    }
    this.repairTail(sessionId)
    if (!hasCompactableHistory(this.repo.path(sessionId)))
      throw new Error('Nada para compactar ainda (nenhuma resposta desde a última compactação).')
    this.startLoop(session, undefined, { compact: req, compactOnly: true })
    return { scheduled: false }
  }

  /** Estado do contexto da sessão (medidor do menu de compactação). */
  async contextInfo(
    sessionId: string
  ): Promise<{ used: number | null; window: number | null; threshold: number; auto: boolean }> {
    const session = this.repo.session(sessionId)
    const chat = session && this.repo.chat(session.chatId)
    if (!session || !chat) throw new Error('Sessão não encontrada.')
    const usage = contextUsage(this.repo.path(sessionId))
    return {
      used: usage?.used ?? null,
      window: await this.contextWindowFor(chat, session),
      threshold: compactThreshold(chat.config),
      auto: !!chat.config.autoCompact
    }
  }

  // ---------------- memória (extração) ----------------

  /** "Extrair memórias agora" (só a principal). Uma extração por sessão de cada vez. */
  extractMemory(
    sessionId: string,
    trigger: ExtractionTrigger = 'manual'
  ): Promise<MemoryExtractionResult> {
    const cur = this.extracting.get(sessionId)
    if (cur) return cur.p
    const session = this.repo.session(sessionId)
    if (!session) return Promise.reject(new Error('Sessão não encontrada.'))
    const p = this.extract(sessionId, trigger).finally(() => this.extracting.delete(sessionId))
    this.extracting.set(sessionId, { chatId: session.chatId, p })
    return p
  }

  private async extract(
    sessionId: string,
    trigger: ExtractionTrigger
  ): Promise<MemoryExtractionResult> {
    const session = this.repo.session(sessionId)
    if (!session) throw new Error('Sessão não encontrada.')
    const chat = this.repo.chat(session.chatId)
    if (!chat) throw new Error('Chat não encontrado.')
    if (session.depth !== 0) throw new Error('A extração de memórias só roda na sessão principal.')
    const svc = this.d.memory
    if (!svc) throw new Error('A memória não está disponível neste aparelho.')
    const cfg = svc.active(chat, session).config.extraction
    const providerId = cfg.model
      ? (cfg.providerId ?? sessionProviderId(chat.config, session))
      : sessionProviderId(chat.config, session)
    const provider = providerId ? this.d.provider(providerId) : null
    const model = cfg.model ?? (chat.config.model || session.model)
    const out = await runExtraction({
      service: svc,
      chat,
      sessionId,
      history: this.repo.path(sessionId),
      provider,
      model,
      trigger,
      ...(this.d.stream ? { stream: this.d.stream } : {})
    })
    if (out.empty) return { ...out.record, error: 'Nada novo na conversa desde a última extração.' }
    if (!out.record.error) svc.writeState(sessionId, { lastExtractedSeq: out.maxSeq })
    if (this.repo.session(sessionId)) {
      try {
        this.append(
          sessionId,
          { role: 'assistant', content: extractionSummaryText(out.record) },
          { synthetic: true, kind: 'memory-extraction', memoryExtraction: out.record }
        )
      } catch (e) {
        this.log(`card da extração: ${errMsg(e)}`)
      }
    }
    return out.record
  }

  /** Depois de uma compactação: snapshot renovado no próximo request; extração automática (se ligada). */
  private afterCompaction(sessionId: string): void {
    const svc = this.d.memory
    if (!svc) return
    try {
      const session = this.repo.session(sessionId)
      const chat = session && this.repo.chat(session.chatId)
      if (!session || !chat) return
      svc.clearSnapshot(sessionId)
      const am = svc.active(chat, session)
      if (session.depth !== 0 || !am.active || !am.canWrite || !am.config.extraction.auto) return
      void this.extractMemory(sessionId, 'compaction').catch((e) =>
        this.log(`extração automática: ${errMsg(e)}`)
      )
    } catch (e) {
      this.log(`memória (pós-compactação): ${errMsg(e)}`)
    }
  }

  private ensureSnapshot(chat: Chat, session: Session): void {
    try {
      this.d.memory?.ensureSnapshot(chat, session)
    } catch (e) {
      this.log(`memória (snapshot): ${errMsg(e)}`)
    }
  }

  // ---------------- título automático ----------------

  private autoTitleSettings(): AutoTitleSettings {
    return normalizeAutoTitleSettings(this.d.setting(AUTO_TITLE_SETTING))
  }

  private autoTitleDeps(): AutoTitleDeps {
    return {
      settings: () => this.autoTitleSettings(),
      chat: (id) => this.repo.chat(id),
      provider: (id) => this.d.provider(id),
      memory: (chat) => {
        const svc = this.d.memory
        if (!svc) return null
        const am = svc.active(chat, { depth: 0 })
        if (!am.active) return null
        return svc.renderIndex(am, {
          maxChars: AUTO_TITLE_DEFAULTS.memoryChars,
          header: AUTO_TITLE_MEMORY_HEADER
        })
      },
      setTitle: (chatId, title) => this.repo.updateChat(chatId, { title }),
      record: (messageId, rec: AutoTitleRecord) => {
        const m = this.repo.get(messageId)
        if (!m) return
        const updated = this.repo.update(m.id, m.message, { ...m.meta, autoTitle: rec })
        this.emit({ type: 'message-updated', message: updated })
      },
      ...(this.d.stream ? { stream: this.d.stream } : {}),
      log: (msg) => this.log(msg)
    }
  }

  /** 1ª mensagem digitada de um chat novo virou o título provisório: gera o título em segundo plano. */
  private scheduleAutoTitle(
    chatId: string,
    text: string,
    attachments: string[],
    expectTitle: string,
    messageId: string
  ): void {
    if (!autoTitleEnabled(this.autoTitleSettings())) return
    setTimeout(() => {
      runAutoTitle(
        { chatId, text, attachments, expectTitle, messageId, trigger: 'auto' },
        this.autoTitleDeps()
      ).catch((e) => this.log(`título automático: ${errMsg(e)}`))
    }, 0)
  }

  /** "Gerar título" (menu do chat): de novo a partir da 1ª mensagem; erros legíveis. */
  generateTitle(chatId: string): Promise<string> {
    const cur = this.titleInflight.get(chatId)
    if (cur) return cur
    const p = (async (): Promise<string> => {
      if (!autoTitleEnabled(this.autoTitleSettings()))
        throw new Error('Escolha o “Modelo para o título” em Configurações → Novos chats.')
      const chat = this.repo.chat(chatId)
      if (!chat) throw new Error('Chat não encontrado.')
      const path = chat.mainSessionId ? this.repo.path(chat.mainSessionId) : []
      const users = path.filter((m) => m.message.role === 'user' && m.meta.kind !== 'compaction')
      const first =
        users.find((m) => isTypedFirstMessage(m.meta)) ??
        users.find((m) => !m.meta.synthetic || m.meta.kind === 'inter-chat')
      if (!first) throw new Error('O chat ainda não tem mensagem para dar nome.')
      const raw = first.message.role === 'user' ? contentText(first.message.content) : ''
      const out = await runAutoTitle(
        {
          chatId,
          text: first.meta.kind === 'inter-chat' ? splitInterChatText(raw).body : raw,
          attachments: [
            ...messageAttachments(first.message).map((a) => a.name),
            ...messageSkills(first.message).map((s) => `Skill ${s.name}`)
          ],
          expectTitle: chat.title,
          messageId: first.id,
          trigger: 'manual'
        },
        this.autoTitleDeps()
      )
      if (out.status === 'error') throw new Error(`Não foi possível gerar o título: ${out.error}`)
      if (out.status === 'skipped')
        throw new Error('Escolha o “Modelo para o título” em Configurações → Novos chats.')
      if (out.status === 'kept' && out.reason === 'renamed')
        throw new Error('O chat foi renomeado enquanto o título era gerado — mantido o seu.')
      return out.title
    })().finally(() => this.titleInflight.delete(chatId))
    this.titleInflight.set(chatId, p)
    return p
  }

  // ---------------- compactação (execução) ----------------

  /** Janela de contexto da sessão (override do chat / contextLength do modelo via /models, em cache). */
  private async contextWindowFor(chat: Chat, session: Session): Promise<number | null> {
    const provider = this.providerFor(chat, session)
    let models: ModelInfo[] | null = null
    if (provider) {
      const c = this.windowCache.get(provider.id)
      if (c && this.now() - c.at < 5 * 60_000) models = c.models
      else {
        try {
          models = await this.d.listModels(provider)
        } catch {
          models = null
        }
        this.windowCache.set(provider.id, { at: this.now(), models })
      }
    }
    const s =
      session.depth === 0 ? { ...session, model: chat.config.model || session.model } : session
    return resolveContextWindow(chat.config, s, models)
  }

  private async shouldAutoCompact(st: RunState): Promise<boolean> {
    const session = this.repo.session(st.sessionId)
    const chat = session && this.repo.chat(session.chatId)
    if (!session || !chat || !autoCompactAllowed(chat, session.depth)) return false
    const history = this.repo.path(session.id)
    if (!hasCompactableHistory(history)) return false
    const usage = contextUsage(history)
    if (!usage) return false
    const window = await this.contextWindowFor(chat, session)
    return !!window && usage.used >= compactThreshold(chat.config) * window
  }

  /**
   * Resume o histórico ativo com o mesmo modelo (request normal + prompt de compactação no fim),
   * transmitindo o resumo (evento `compaction`), e persiste a fronteira `role: user` (= desktop).
   * Abortar (Parar/⚡) cancela sem salvar nada.
   */
  private async runCompaction(st: RunState, signal: AbortSignal): Promise<CompactionResult> {
    const session = this.repo.session(st.sessionId)
    if (!session) return { kind: 'error', error: 'Sessão não encontrada.' }
    const chat = this.repo.chat(session.chatId)
    if (!chat) return { kind: 'error', error: 'Chat não encontrado.' }
    const provider = this.providerFor(chat, session)
    if (!provider) return { kind: 'error', error: 'Nenhum provider configurado para este chat.' }
    this.repairTail(session.id)
    const history = this.repo.path(session.id)
    if (!hasCompactableHistory(history)) return { kind: 'skipped' }
    const reqSession =
      session.depth === 0 ? { ...session, model: chat.config.model || session.model } : session
    const window = await this.contextWindowFor(chat, session)
    const prompt = chat.config.compactPrompt?.trim()
      ? chat.config.compactPrompt
      : DEFAULT_COMPACT_PROMPT
    let data: Map<string, string>
    try {
      data = await this.loadAttachments(history)
    } catch (e) {
      return { kind: 'error', error: errMsg(e) }
    }
    const env = {
      ...currentEnv(),
      read: (file: string, name?: string) => {
        const v = data.get(file)
        if (v === undefined) throw new Error(`Anexo não encontrado no aparelho: "${name ?? file}".`)
        return v
      }
    }
    const stream = this.d.stream ?? streamChat
    this.emit({ type: 'compaction', sessionId: session.id, state: 'running', text: '' })
    const t0 = this.now()
    try {
      let acc = newAccumulator()
      let toolChoiceNone = false
      let emptyRetries = 0
      for (let i = 0; i < COMPACTION_MODES.length;) {
        let req: BuiltRequest
        try {
          req = buildCompactionRequest(
            chat,
            reqSession,
            history,
            provider,
            prompt,
            { mode: COMPACTION_MODES[i], window, toolChoiceNone },
            env
          )
        } catch (e) {
          return { kind: 'error', error: errMsg(e) }
        }
        acc = newAccumulator()
        const cur = acc
        const tick = throttle(
          () =>
            this.emit({
              type: 'compaction',
              sessionId: session.id,
              state: 'running',
              text: cur.content
            }),
          60
        )
        try {
          await stream(req, signal, acc, tick.call)
        } catch (e) {
          tick.cancel()
          if (signal.aborted) return { kind: 'aborted' }
          const error = errMsg(e)
          if (isContextLengthError(error) && i < COMPACTION_MODES.length - 1) {
            i++
            continue
          }
          return { kind: 'error', error }
        }
        tick.cancel()
        if (!acc.content.trim()) {
          // 1ª: tool_choice 'none' (o modelo tentou chamar tool); 2ª: só repete; depois desiste
          if (!toolChoiceNone) {
            toolChoiceNone = true
            continue
          }
          if (emptyRetries < 1) {
            emptyRetries++
            continue
          }
          const why = [
            acc.finishReason ? `finish_reason=${acc.finishReason}` : '',
            acc.reasoning.trim() ? `só raciocínio (${acc.reasoning.length} caracteres)` : '',
            acc.toolCalls.length ? `tentou chamar ${acc.toolCalls.length} tool(s)` : ''
          ]
            .filter(Boolean)
            .join(', ')
          return {
            kind: 'error',
            error: `o modelo não retornou um resumo${why ? ` (${why})` : ''}.`
          }
        }
        break
      }
      if (signal.aborted) return { kind: 'aborted' }
      const summary = cleanSummary(acc.content)
      const m = compactionMeta(chat, reqSession, history, summary, acc.usage?.completionTokens, env)
      const meta: MessageMeta = {
        synthetic: true,
        kind: 'compaction',
        summaryOf: m.summaryOf,
        compactedCount: m.compactedCount,
        contextEstimate: m.contextEstimate,
        model: acc.model ?? reqSession.model,
        durationMs: this.now() - t0
      }
      const before = contextUsage(history)
      if (before) meta.usageBefore = before.used
      if (acc.usage) meta.compactUsage = acc.usage
      if (m.insertBeforeSeq != null) {
        // mensagens do usuário ainda sem resposta ficam depois da fronteira (intactas)
        const r = this.repo.insertAt(
          session.id,
          m.insertBeforeSeq,
          { role: 'user', content: m.text },
          meta
        )
        for (const x of r.shifted) this.emit({ type: 'message-updated', message: x })
        this.emit({ type: 'message-added', message: r.message })
        if (r.selChanged) {
          const s = this.repo.session(session.id)
          if (s) this.emit({ type: 'session-updated', session: s })
        }
        this.repo.touch(session.chatId)
      } else this.append(session.id, { role: 'user', content: m.text }, meta)
      // memória: o índice congelado é renovado no próximo request; extração automática (se ligada)
      this.afterCompaction(session.id)
      return { kind: 'ok' }
    } finally {
      this.emit({ type: 'compaction', sessionId: session.id, state: null })
    }
  }

  // ---------------- subagentes ----------------

  /** Provedores de chat + o da sessão (resolução do delegate_task). */
  private resolveSubagent(
    chat: Chat,
    session: Session,
    args: Record<string, unknown>
  ): ReturnType<typeof resolveSubagentTarget> {
    return resolveSubagentTarget({
      providers: this.d.chatProviders().map((p) => ({ id: p.id, name: p.name })),
      callerProviderId: sessionProviderId(chat.config, session),
      callerModel: session.depth === 0 ? chat.config.model || session.model : session.model,
      provider: args.provider,
      model: args.model,
      listModels: (pid) => {
        const p = this.d.provider(pid)
        return p ? this.d.listModels(p) : Promise.reject(new Error('provedor não encontrado'))
      }
    })
  }

  private async runDelegate(
    session: Session,
    chat: Chat,
    toolCallId: string,
    args: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<Omit<ToolOutcome, 'durationMs'>> {
    if (session.depth >= MAX_DEPTH)
      return { content: 'Erro: profundidade máxima de subagentes atingida.', status: 'error' }
    const task = typeof args.task === 'string' ? args.task.trim() : ''
    if (!task) return { content: 'Erro: argumento obrigatório "task" ausente.', status: 'error' }
    const background = args.background === true || args.background === 'true'
    const target = await this.resolveSubagent(chat, session, args)
    if ('error' in target) return { content: target.error, status: 'error' }
    const { model, providerId } = target
    const providerName = this.d.provider(providerId)?.name ?? providerId
    const note = target.note ? `[nota: ${target.note}]\n\n` : ''
    const rawTitle =
      (typeof args.title === 'string' && args.title.trim()) || task.replace(/\s+/g, ' ')
    const title = rawTitle.length > 60 ? rawTitle.slice(0, 60).trimEnd() + '…' : rawTitle
    const child = this.repo.createSession({
      chatId: chat.id,
      parentSessionId: session.id,
      parentToolCallId: toolCallId,
      depth: (session.depth + 1) as 1 | 2,
      model,
      providerId,
      title,
      task,
      status: 'running'
    })
    this.emit({ type: 'session-created', session: child })
    this.append(child.id, { role: 'user', content: task }, { synthetic: true })

    if (background) {
      // sem o signal do pai: Parar/⚡ na sessão pai não derrubam subagentes em segundo plano
      const bst = this.startLoop(child)
      this.attachReport(bst, child, false)
      return {
        content: `${note}Subagente iniciado em segundo plano (id ${child.id}, ${providerName} · ${model}). Você receberá o resultado automaticamente quando ele terminar.`,
        status: 'ok',
        subSessionId: child.id,
        background: true
      }
    }

    const cst = this.startLoop(child, signal)
    const outcome = await cst.done
    const max = this.toolOutputLimit(chat)
    if (outcome.kind === 'final')
      return {
        content: note + truncateHeadTail(outcome.text.trim() || delegateEmptyText(model), max, 0.5),
        status: 'ok',
        subSessionId: child.id
      }
    if (signal.aborted)
      return { content: CANCELLED_TEXT, status: 'cancelled', subSessionId: child.id }
    if (outcome.kind === 'aborted') {
      const partial = outcome.partial.trim()
      return {
        content: `[Subagente interrompido pelo usuário]${partial ? `\n\nResposta parcial:\n${truncate(partial)}` : ''}`,
        status: 'cancelled',
        subSessionId: child.id
      }
    }
    return {
      content: note + delegateFailureText(model, outcome.error),
      status: 'error',
      subSessionId: child.id
    }
  }

  private wakeSession(sessionId: string): void {
    this.wakers.get(sessionId)?.()
  }

  /**
   * Subagente que encerrou o turno com filhos em segundo plano pendentes: status 'waiting' até
   * chegar mensagem/callback na fila (ou não haver mais pendentes). true = abortado.
   */
  private async sleepWhilePending(st: RunState): Promise<boolean> {
    this.setStatus(st.sessionId, 'waiting')
    while (
      this.reports.pending(st.sessionId).length &&
      !this.queue.has(st.sessionId) &&
      !st.controller.signal.aborted
    ) {
      const sig = st.controller.signal
      await new Promise<void>((resolve) => {
        const done = (): void => {
          if (this.wakers.get(st.sessionId) === done) this.wakers.delete(st.sessionId)
          sig.removeEventListener('abort', done)
          resolve()
        }
        this.wakers.set(st.sessionId, done)
        sig.addEventListener('abort', done, { once: true })
      })
    }
    const aborted = st.controller.signal.aborted
    if (!aborted) this.setStatus(st.sessionId, 'running')
    return aborted
  }

  /** A execução `run` da subsessão reporta ao pai por callback quando terminar. */
  private attachReport(run: RunState, session: Session, update: boolean): Report {
    const r = this.reports.add({
      sessionId: session.id,
      parentSessionId: session.parentSessionId ?? '',
      title: session.title,
      model: session.model,
      update
    })
    run.report = r
    this.reportSettled.set(
      r.id,
      run.done.then((o) => this.onReportDone(r, o))
    )
    return r
  }

  /**
   * Fim de uma execução que reporta ao pai: entrega o callback (fila se o pai estiver rodando;
   * acorda o pai se estiver ocioso), salvo se reivindicado/apagado. Parada em cascata (`silent`):
   * registra sem acordar o pai.
   */
  private async onReportDone(r: Report, o: LoopOutcome): Promise<void> {
    try {
      if (this.reports.complete(r, o as RunOutcome)) {
        const parent = this.repo.session(r.parentSessionId)
        const chat = parent && this.repo.chat(parent.chatId)
        if (parent && chat) {
          const text = callbackText(r, o as RunOutcome, this.toolOutputLimit(chat))
          const d = await this.deliverToSession(parent, text, callbackMeta(r), !r.silent)
          this.reports.sent(r, d.queuedId)
        }
      }
    } catch (e) {
      this.log(`callback de subagente: ${errMsg(e)}`)
    } finally {
      this.reportSettled.delete(r.id)
      this.wakeSession(r.parentSessionId)
      this.reports.prune()
    }
  }

  /** Para uma subsessão e todos os descendentes; os callbacks dos descendentes não acordam ninguém. */
  private async stopSubtree(session: Session): Promise<void> {
    const ids = subtreeIds(this.repo.sessions(session.chatId), [session.id])
    const set = new Set(ids)
    for (const r of this.reports.all())
      if (set.has(r.sessionId) && r.sessionId !== session.id && !r.outcome) r.silent = true
    const sts = ids.map((id) => this.runs.get(id)).filter((x): x is RunState => !!x)
    for (const st of sts) {
      st.stopRequested = true
      if (st.forced.length) this.queue.requeueFront(st.sessionId, st.forced.splice(0))
      st.controller.abort()
    }
    await Promise.all(sts.map((st) => this.waitDone(st)))
  }

  /** Subsessões (raízes) criadas pelos delegate_task destas mensagens da sessão `parent`. */
  private subSessionRoots(parent: Session, msgs: StoredMessage[]): string[] {
    const callIds = new Set<string>()
    const subIds = new Set<string>()
    for (const m of msgs) {
      if (m.meta.subSessionId) subIds.add(m.meta.subSessionId)
      if (m.message.role === 'assistant')
        for (const tc of m.message.tool_calls ?? []) callIds.add(tc.id)
    }
    if (!subIds.size && !callIds.size) return []
    return this.repo
      .sessions(parent.chatId)
      .filter(
        (s) =>
          s.parentSessionId === parent.id &&
          (subIds.has(s.id) || (s.parentToolCallId != null && callIds.has(s.parentToolCallId)))
      )
      .map((s) => s.id)
  }

  private liveSubSessionsOf(parent: Session, msgs: StoredMessage[]): string[] {
    const roots = this.subSessionRoots(parent, msgs)
    return roots.length
      ? subtreeIds(this.repo.sessions(parent.chatId), roots).filter((id) => this.runs.has(id))
      : []
  }

  /**
   * Parte abandonada da conversa (versão nova): subagentes nascidos nela que ainda rodam param SEM
   * callback; callbacks deles já na fila da principal saem. As subsessões continuam salvas.
   */
  private async stopAbandonedSubagents(parent: Session, abandoned: StoredMessage[]): Promise<void> {
    const roots = this.subSessionRoots(parent, abandoned)
    if (!roots.length) return
    const ids = subtreeIds(this.repo.sessions(parent.chatId), roots)
    const set = new Set(ids)
    this.reports.drop(ids)
    for (const q of this.queue.get(parent.id))
      if (q.meta?.kind === 'subagent-callback' && set.has(q.meta.subSessionId ?? ''))
        this.queue.take(q.id)
    const live = ids.map((id) => this.runs.get(id)).filter((x): x is RunState => !!x)
    for (const st of live) {
      st.stopRequested = true
      if (st.forced.length) this.queue.requeueFront(st.sessionId, st.forced.splice(0))
      st.controller.abort()
    }
    await Promise.all(live.map((st) => this.waitDone(st, 5000)))
  }

  /** Apaga as subsessões criadas pelos delegate_task destas mensagens (evita órfãs). */
  private async deleteSubSessionsOf(removed: StoredMessage[]): Promise<void> {
    if (!removed.length) return
    const parent = this.repo.session(removed[0].sessionId)
    if (!parent) return
    const roots = this.subSessionRoots(parent, removed)
    if (!roots.length) return
    const ids = subtreeIds(this.repo.sessions(parent.chatId), roots)
    this.reports.drop(ids)
    const live = ids.map((id) => this.runs.get(id)).filter((x): x is RunState => !!x)
    for (const st of live) {
      st.stopRequested = true
      st.forced = []
      st.controller.abort()
    }
    await Promise.all(live.map((st) => this.waitDone(st, 5000)))
    for (const id of ids) {
      for (const a of this.approvals.list())
        if (a.sessionId === id) this.approvals.resolve(a.id, { kind: 'cancel' })
      this.queue.clear(id)
    }
    // filhos antes dos pais
    this.repo.deleteSessions(parent.chatId, [...ids].reverse())
    for (const id of ids)
      this.emit({ type: 'session-deleted', sessionId: id, chatId: parent.chatId })
  }

  /** Última atividade de uma subsessão (texto curto para check_subagents). */
  private sessionTail(sessionId: string): string {
    const msgs = this.repo.path(sessionId)
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i].message
      if (msgs[i].meta.kind === 'error') return `erro: ${msgs[i].meta.error ?? ''}`
      if (m.role === 'assistant') {
        if (m.content?.trim()) return m.content
        if (m.tool_calls?.length)
          return `chamando ${m.tool_calls.map((t) => t.function.name).join(', ')}`
      }
      if (m.role === 'tool')
        return `resultado de tool (${contentText(m.content).length} caracteres)`
    }
    return ''
  }

  private children(parentSessionId: string | null): Session[] {
    if (!parentSessionId) return []
    const parent = this.repo.session(parentSessionId)
    return parent
      ? this.repo.sessions(parent.chatId).filter((s) => s.parentSessionId === parentSessionId)
      : []
  }

  private runCheckSubagents(
    session: Session,
    chat: Chat,
    args: Record<string, unknown> = {}
  ): Omit<ToolOutcome, 'durationMs'> {
    if (args.messages === true || args.messages === 'true')
      return this.runSiblingExchanges(session, chat, args)
    const kids = this.children(session.id)
    const pm = this.repo.path(session.id)
    const rows: SubagentRow[] = kids.map((k) => {
      const rep = this.reports.latest(k.id)
      const toolMsg = pm.find((m) => m.message.role === 'tool' && m.meta.subSessionId === k.id)
      const background = !!toolMsg?.meta.background
      const running = this.runs.has(k.id)
      const hasCallback = pm.some(
        (m) => m.meta.kind === 'subagent-callback' && m.meta.subSessionId === k.id
      )
      const msgs = this.repo.path(k.id)
      let result: SubagentRow['result']
      if (running) result = rep ? 'pending' : 'none'
      else if (rep) result = rep.claimed || rep.callbackSent ? 'delivered' : 'pending'
      else if (background || hasCallback) result = hasCallback ? 'delivered' : 'none'
      else result = toolMsg ? 'tool' : 'none'
      return {
        id: k.id,
        title: k.title,
        model: k.model,
        status: k.status,
        background,
        startedAt: k.createdAt,
        finishedAt: running
          ? undefined
          : (rep?.finishedAt ?? msgs.at(-1)?.createdAt ?? k.createdAt),
        result,
        tail: this.sessionTail(k.id)
      }
    })
    let content = formatSubagentList(rows)
    if (session.depth > 0 && session.parentSessionId) {
      const sibs = this.children(session.parentSessionId).filter((s) => s.id !== session.id)
      content += `\n\n${formatSiblingList(sibs.map((s) => ({ id: s.id, title: s.title, status: s.status })))}`
    }
    return { content: truncateHeadTail(content, this.toolOutputLimit(chat), 0.5), status: 'ok' }
  }

  private runSiblingExchanges(
    session: Session,
    chat: Chat,
    args: Record<string, unknown>
  ): Omit<ToolOutcome, 'durationMs'> {
    const kids = this.children(session.id)
    let only: string | null = null
    const ref = typeof args.id === 'string' ? args.id.trim() : ''
    if (ref) {
      const res = this.resolveOwnSubagent(session, chat, ref)
      if ('error' in res) return { content: res.error, status: 'error' }
      only = res.ok.id
    }
    const byId = new Map(kids.map((k) => [k.id, k]))
    const refOf = (id: string): { id: string; title: string } => ({
      id,
      title: byId.get(id)?.title ?? this.repo.session(id)?.title ?? '(apagado)'
    })
    const direct: SiblingExchange[] = []
    const broadcasts = new Map<string, SiblingExchange>()
    const add = (
      to: string,
      meta: MessageMeta,
      text: string,
      at: number,
      queued: boolean
    ): void => {
      if (!isSiblingKind(meta.kind) || !meta.fromSessionId) return
      const body = splitSiblingText(text).body
      if (meta.kind === 'sibling-broadcast' && meta.broadcastId) {
        const b = broadcasts.get(meta.broadcastId)
        if (b) {
          b.to.push(refOf(to))
          b.at = Math.min(b.at, at)
          b.queued = b.queued && queued
        } else
          broadcasts.set(meta.broadcastId, {
            at,
            from: refOf(meta.fromSessionId),
            to: [refOf(to)],
            broadcast: true,
            text: body,
            queued
          })
        return
      }
      direct.push({
        at,
        from: refOf(meta.fromSessionId),
        to: [refOf(to)],
        broadcast: false,
        text: body,
        queued
      })
    }
    for (const k of kids) {
      for (const m of this.repo.path(k.id))
        if (m.message.role === 'user')
          add(k.id, m.meta, contentText(m.message.content), m.createdAt, false)
      for (const q of this.queue.get(k.id)) if (q.meta) add(k.id, q.meta, q.text, q.createdAt, true)
    }
    let items = [...direct, ...broadcasts.values()]
    if (only) items = items.filter((it) => it.from.id === only || it.to.some((t) => t.id === only))
    return {
      content: formatSiblingExchanges(items, chat.id, this.toolOutputLimit(chat)),
      status: 'ok'
    }
  }

  private resolveOwnSubagent(
    session: Session,
    chat: Chat,
    ref: string
  ): { ok: Session } | { error: string } {
    const r = resolveSubagentRef(this.repo.sessions(chat.id), session.id, ref)
    if (r === null)
      return {
        error: `Erro: subagente não encontrado: "${ref}". Use check_subagents para ver os ids.`
      }
    if (r === 'ambiguous')
      return { error: `Erro: "${ref}" corresponde a mais de um subagente. Use o id completo.` }
    if (r === 'not-owned')
      return {
        error: `Erro: "${ref}" não é um subagente desta sessão — só é possível falar com os próprios subagentes (diretos ou descendentes). Use check_subagents.`
      }
    return { ok: r }
  }

  /** Reivindica o resultado de uma execução: sem callback (retira da fila do pai, se já estava lá). */
  private claimReport(r: Report): string {
    const c = this.reports.claim(r)
    if (c.queuedId && this.queue.take(c.queuedId)) return ''
    return c.sent ? ' (já tinha chegado antes como mensagem)' : ''
  }

  private async runWaitSubagents(
    session: Session,
    chat: Chat,
    args: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<Omit<ToolOutcome, 'durationMs'>> {
    const rawIds = Array.isArray(args.ids)
      ? args.ids.filter((x): x is string => typeof x === 'string' && !!x.trim())
      : typeof args.ids === 'string' && args.ids.trim()
        ? [args.ids]
        : []
    const mode = args.mode === 'any' ? 'any' : 'all'
    const timeoutS = clampWaitS(args.timeout_s)
    const max = this.toolOutputLimit(chat)
    let targets: Report[]
    if (rawIds.length) {
      targets = []
      for (const id of rawIds) {
        const res = this.resolveOwnSubagent(session, chat, id)
        if ('error' in res) return { content: res.error, status: 'error' }
        const rep = this.reports.latest(res.ok.id)
        if (!rep || rep.parentSessionId !== session.id)
          return {
            content: `Erro: o subagente ${subTitle(res.ok)} não está em segundo plano nesta sessão (estado: ${res.ok.status}). Use check_subagents.`,
            status: 'error'
          }
        if (!targets.includes(rep)) targets.push(rep)
      }
    } else {
      targets = this.reports
        .forParent(session.id)
        .filter(
          (r) =>
            !r.claimed &&
            (!r.outcome ||
              !r.callbackSent ||
              (!!r.callbackQueuedId && this.isQueued(session.id, r.callbackQueuedId)))
        )
    }
    if (!targets.length)
      return { content: '[nenhum subagente em segundo plano pendente nesta sessão]', status: 'ok' }
    const running = targets.filter((r) => !r.outcome)
    let timedOut = false
    if (running.length) {
      const settled = running.map((r) => this.reportSettled.get(r.id) ?? Promise.resolve())
      const all: Promise<unknown> = mode === 'all' ? Promise.all(settled) : Promise.race(settled)
      try {
        timedOut = (await raceDone(all, timeoutS * 1000, signal)) === 'timeout'
      } catch (e) {
        if (signal.aborted || (e as Error).name === 'AbortError')
          return {
            content: `${CANCELLED_TEXT} Os subagentes continuam rodando; os resultados chegarão como mensagem.`,
            status: 'cancelled'
          }
        throw e
      }
    }
    const finished = targets.filter((r) => r.outcome)
    const parts: string[] = []
    const per = Math.max(1000, Math.floor((max - 400) / Math.max(1, targets.length)))
    for (const r of targets) {
      if (r.outcome) parts.push(callbackText(r, r.outcome, per) + this.claimReport(r))
      else
        parts.push(
          `[Subagente "${r.title}" (id ${r.sessionId}) ainda rodando · ${fmtDuration(this.now() - r.startedAt)} — o resultado chegará como mensagem]`
        )
    }
    const head = timedOut
      ? `[tempo esgotado após ${timeoutS}s: ${finished.length} de ${targets.length} subagentes terminaram]`
      : `[${finished.length} de ${targets.length} subagentes terminaram]`
    return { content: truncateHeadTail(`${head}\n\n${parts.join('\n\n')}`, max, 0.5), status: 'ok' }
  }

  private async runCancelSubagent(
    session: Session,
    chat: Chat,
    args: Record<string, unknown>
  ): Promise<Omit<ToolOutcome, 'durationMs'>> {
    const ref = typeof args.id === 'string' ? args.id.trim() : ''
    if (!ref) return { content: 'Erro: argumento obrigatório "id" ausente.', status: 'error' }
    const res = this.resolveOwnSubagent(session, chat, ref)
    if ('error' in res) return { content: res.error, status: 'error' }
    const target = res.ok
    if (!this.runs.has(target.id))
      return {
        content: `O subagente ${subTitle(target)} não está em execução (estado: ${target.status}).`,
        status: 'ok',
        subSessionId: target.id
      }
    const rep = this.runs.get(target.id)?.report
    await this.stopSubtree(target)
    return {
      content: `Subagente ${subTitle(target)} cancelado (com os subagentes dele).${rep ? ' O cancelamento chegará como mensagem de resultado.' : ''}`,
      status: 'ok',
      subSessionId: target.id
    }
  }

  /**
   * Espera o turno da sessão que vai tratar a mensagem entregue terminar. Ficou na fila e o loop
   * acabou sem entregá-la (Parar) → 'undelivered'.
   */
  private async waitForTurn(
    sessionId: string,
    queuedId: string | undefined,
    signal: AbortSignal,
    ms: number
  ): Promise<TurnWait> {
    const deadline = this.now() + ms
    for (;;) {
      if (signal.aborted) throw abortError()
      const st = this.runs.get(sessionId)
      if (!st) {
        if (queuedId && this.isQueued(sessionId, queuedId)) return { kind: 'undelivered' }
        return { kind: 'final', text: this.lastAssistantText(sessionId) }
      }
      const r = await raceDone(st.done, deadline - this.now(), signal)
      if (r === 'timeout') return { kind: 'timeout', run: st }
      if (queuedId && this.isQueued(sessionId, queuedId)) {
        const again = this.runs.get(sessionId)
        if (again && again !== st) continue
        return { kind: 'undelivered' }
      }
      return { ...r, run: st }
    }
  }

  private lastAssistantText(sessionId: string): string {
    const msgs = this.repo.path(sessionId)
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m.message.role === 'assistant' && !isDisplayOnly(m.meta)) return m.message.content ?? ''
    }
    return ''
  }

  private async runMessageSubagent(
    session: Session,
    chat: Chat,
    args: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<Omit<ToolOutcome, 'durationMs'>> {
    const ref = typeof args.id === 'string' ? args.id.trim() : ''
    const message = typeof args.message === 'string' ? args.message.trim() : ''
    const wait = args.wait_for_reply === true || args.wait_for_reply === 'true'
    if (args.broadcast === true || args.broadcast === 'true') {
      if (!message)
        return {
          content: 'Erro: argumento obrigatório "message" ausente ou vazio.',
          status: 'error'
        }
      return this.runSiblingBroadcast(session, message, wait, isTrue(args.include_finished))
    }
    if (!ref)
      return {
        content:
          'Erro: argumento obrigatório "id" ausente (ou use broadcast=true para todos os irmãos).',
        status: 'error'
      }
    if (!message)
      return { content: 'Erro: argumento obrigatório "message" ausente ou vazio.', status: 'error' }
    const res = resolveMessageTarget(this.repo.sessions(chat.id), session.id, ref)
    if (res === null)
      return {
        content: `Erro: subagente não encontrado: "${ref}". Use check_subagents para ver os ids.`,
        status: 'error'
      }
    if (res === 'ambiguous')
      return {
        content: `Erro: "${ref}" corresponde a mais de um subagente. Use o id completo.`,
        status: 'error'
      }
    if (res === 'not-owned')
      return {
        content: `Erro: "${ref}" não é um subagente desta sessão nem um irmão — message_subagent só alcança os próprios subagentes (diretos ou descendentes) e, num subagente, os irmãos (criados pelo mesmo agente pai). Use check_subagents.`,
        status: 'error'
      }
    if (res.relation === 'sibling')
      return this.runSiblingMessage(session, res.target, message, wait)
    const target = res.target
    const timeoutS = clampWaitS(args.timeout_s)
    const d = await this.deliverToSession(target, parentMessageText(message), {
      kind: 'parent-message',
      fromSessionId: session.id
    })
    const out = (
      content: string,
      status: ToolOutcome['status'] = 'ok'
    ): Omit<ToolOutcome, 'durationMs'> => ({ content, status, subSessionId: target.id })
    const name = subTitle(target)
    if (!wait)
      return out(
        d.queuedId
          ? `Mensagem enfileirada para o subagente ${name}: ele está rodando e a recebe no próximo passo.`
          : `Mensagem entregue ao subagente ${name}: ele retomou o trabalho; a nova resposta final chegará como mensagem.`
      )
    let r: TurnWait
    try {
      r = await this.waitForTurn(target.id, d.queuedId, signal, timeoutS * 1000)
    } catch (e) {
      if (signal.aborted || (e as Error).name === 'AbortError')
        return out(
          `${CANCELLED_TEXT} A mensagem já tinha sido entregue ao subagente ${name}; a resposta chegará como mensagem.`,
          'cancelled'
        )
      throw e
    }
    // a resposta volta aqui: o callback dessa execução não é injetado de novo
    const rep = r.run?.report
    if (rep && rep.parentSessionId === session.id && r.kind !== 'timeout') this.claimReport(rep)
    const max = this.toolOutputLimit(chat)
    switch (r.kind) {
      case 'final':
        return out(
          truncateHeadTail(
            `Resposta do subagente ${name}:\n\n${r.text.trim() || delegateEmptyText(target.model)}`,
            max,
            0.5
          )
        )
      case 'timeout':
        return out(
          `[O subagente ${name} ainda está rodando após ${timeoutS}s; a resposta chegará como mensagem.]`
        )
      case 'undelivered':
        return out(
          `[A mensagem ficou na fila do subagente ${name}: ele foi parado antes de recebê-la.]`,
          'error'
        )
      case 'aborted':
        return out(`[O subagente ${name} foi interrompido antes de responder.]`, 'error')
      default:
        return out(delegateFailureText(target.model, r.error), 'error')
    }
  }

  private async runSiblingMessage(
    session: Session,
    target: Session,
    message: string,
    wait: boolean
  ): Promise<Omit<ToolOutcome, 'durationMs'>> {
    if (wait) return { content: NO_SIBLING_WAIT, status: 'error' }
    const name = subTitle(target)
    const retryS = this.siblingLimiter.take(
      siblingPairKey(session.id, target.id),
      LIMITS.siblingMaxPerWindow,
      LIMITS.siblingWindowS * 1000
    )
    if (retryS)
      return {
        content: `Erro: você e o irmão ${name} já trocaram ${LIMITS.siblingMaxPerWindow} mensagens no último minuto (limite anti pingue-pongue). Você poderá enviar outra em ${retryS} s. Melhor: termine a sua tarefa e devolva o resultado — o agente pai coordena o resto.`,
        status: 'error'
      }
    const d = await this.deliverToSession(
      target,
      siblingMessageText(session.title, session.id, message),
      { kind: 'sibling-message', fromSessionId: session.id }
    )
    return {
      content: d.queuedId
        ? `Mensagem enfileirada para o irmão ${name}: ele está rodando e a recebe no próximo passo. Se precisar responder, ele usa message_subagent e a resposta chega como mensagem nova — não espere por ela se puder seguir.`
        : `Mensagem entregue ao irmão ${name}: ele estava parado e retomou o trabalho (a nova resposta final dele vai ao agente pai). Se precisar responder, ele usa message_subagent e a resposta chega como mensagem nova.`,
      status: 'ok',
      subSessionId: target.id
    }
  }

  private async runSiblingBroadcast(
    session: Session,
    message: string,
    wait: boolean,
    includeFinished: boolean
  ): Promise<Omit<ToolOutcome, 'durationMs'>> {
    if (wait)
      return {
        content: NO_SIBLING_WAIT.replace(
          'entre subagentes irmãos',
          'com broadcast (nem entre irmãos)'
        ),
        status: 'error'
      }
    const sibs =
      session.depth > 0 && session.parentSessionId
        ? this.children(session.parentSessionId).filter((s) => s.id !== session.id)
        : []
    if (!sibs.length)
      return {
        content:
          'Erro: você não tem subagentes irmãos (outras subsessões criadas pelo mesmo agente pai) — não há para quem enviar o broadcast.',
        status: 'error'
      }
    const active = sibs.filter((s) => this.runs.has(s.id))
    const stopped = sibs.filter((s) => !this.runs.has(s.id))
    const targets = includeFinished ? sibs : active
    const list = (xs: Session[]): string => xs.map((s) => subTitle(s)).join(', ')
    if (!targets.length)
      return {
        content: `Nenhum irmão ativo agora: o broadcast não foi enviado. Parados (ociosos/concluídos): ${list(stopped)}. Use include_finished=true para retomá-los (cada um roda de novo e gasta tokens) ou envie a um só com id.`,
        status: 'ok'
      }
    const retryS = this.siblingLimiter.take(
      `broadcast|${session.id}`,
      LIMITS.siblingBroadcastMaxPerWindow,
      LIMITS.siblingWindowS * 1000
    )
    if (retryS)
      return {
        content: `Erro: você já enviou ${LIMITS.siblingBroadcastMaxPerWindow} broadcasts no último minuto. Poderá enviar outro em ${retryS} s — ou mande direto a um irmão (message_subagent com id), ou termine a sua tarefa e deixe o agente pai coordenar.`,
        status: 'error'
      }
    const broadcastId = crypto.randomUUID()
    const text = siblingBroadcastText(session.title, session.id, message)
    const queued: Session[] = []
    const resumed: Session[] = []
    for (const t of targets) {
      const d = await this.deliverToSession(t, text, {
        kind: 'sibling-broadcast',
        fromSessionId: session.id,
        broadcastId
      })
      ;(d.queuedId ? queued : resumed).push(t)
    }
    const lines = [
      `Broadcast entregue a ${targets.length} ${targets.length === 1 ? 'irmão' : 'irmãos'}.`,
      queued.length ? `Na fila (rodando; recebem no próximo passo): ${list(queued)}.` : '',
      resumed.length
        ? `Retomados (estavam parados; a nova resposta final de cada um vai ao agente pai): ${list(resumed)}.`
        : '',
      !includeFinished && stopped.length
        ? `Pulados por estarem parados (ociosos/concluídos): ${list(stopped)} — include_finished=true os retomaria.`
        : '',
      'Só quem for o destinatário responde, com message_subagent direto a você; a resposta chega como mensagem nova. Siga a sua tarefa enquanto isso.'
    ]
    return { content: lines.filter(Boolean).join('\n'), status: 'ok' }
  }

  // ---------------- entre chats ----------------

  /** Estado de um chat para list_chats: pendências locais > rodando aqui > host remoto > ocioso. */
  private chatStatus(chatId: string): ChatListEntry['status'] {
    if (this.approvals.list().some((a) => a.chatId === chatId)) return 'awaiting_approval'
    if (this.questions.list().some((q) => q.chatId === chatId)) return 'awaiting_input'
    if (this.retries.list().some((q) => q.chatId === chatId)) return 'awaiting_retry'
    for (const st of this.runs.values()) if (st.chatId === chatId) return 'running'
    return this.d.interChat?.remoteStatus?.(chatId) ?? 'idle'
  }

  private chatToolsCtx(chat: Chat, session: Session): ToolContext['chats'] {
    return {
      self: () => ({
        chatId: chat.id,
        title: chat.title,
        sessionId: session.id,
        mainSessionId: chat.mainSessionId,
        depth: session.depth,
        parentSessionId: session.parentSessionId,
        sessionTitle: session.title,
        model: session.depth === 0 ? chat.config.model || session.model : session.model,
        providerName: this.providerFor(chat, session)?.name ?? '',
        root: '(nenhum — chat executado no celular)',
        createdAt: chat.createdAt
      }),
      list: () =>
        (this.d.listChats?.() ?? []).map((c) => ({
          id: c.id,
          title: c.title,
          model: c.model,
          status: this.chatStatus(c.id),
          updatedAt: c.updatedAt,
          self: c.id === chat.id
        }))
    }
  }

  /** Id exato ou prefixo único (≥ 4 caracteres). */
  private resolveChatRef(ref: string): Chat | 'ambiguous' | null {
    const exact = this.repo.chat(ref)
    if (exact) return exact
    const r = ref.toLowerCase()
    if (r.length < 4) return null
    const m = (this.d.listChats?.() ?? []).filter((c) => c.id.startsWith(r))
    if (m.length > 1) return 'ambiguous'
    return m.length === 1 ? this.repo.chat(m[0].id) : null
  }

  private async runSendToChat(
    session: Session,
    chat: Chat,
    args: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<Omit<ToolOutcome, 'durationMs'>> {
    const fail = (content: string, targetChatId?: string): Omit<ToolOutcome, 'durationMs'> => ({
      content,
      status: 'error',
      ...(targetChatId ? { targetChatId } : {})
    })
    const ref = typeof args.chat_id === 'string' ? args.chat_id.trim() : ''
    const message = typeof args.message === 'string' ? args.message.trim() : ''
    if (!ref)
      return fail('Erro: argumento obrigatório "chat_id" ausente. Use list_chats para ver os ids.')
    if (!message) return fail('Erro: argumento obrigatório "message" ausente ou vazio.')
    const target = this.resolveChatRef(ref)
    if (target === 'ambiguous')
      return fail(
        `Erro: "${ref}" corresponde a mais de um chat. Use o id completo (veja list_chats).`
      )
    if (!target) return fail(`Erro: chat não encontrado: "${ref}". Use list_chats para ver os ids.`)
    if (target.id === chat.id)
      return fail(
        'Erro: não é possível enviar uma mensagem para o próprio chat. Para falar com o usuário, responda normalmente.',
        target.id
      )
    const tname = `"${target.title || 'Novo chat'}" (id ${target.id})`
    const targetSession = this.repo.session(target.mainSessionId)
    if (!targetSession) return fail(`Erro: o chat ${tname} não tem sessão principal.`, target.id)

    const { hops, allowed } = nextInterChatHops(this.repo.path(chat.mainSessionId))
    if (!allowed)
      return fail(
        `Erro: limite de ${LIMITS.interChatMaxHops} saltos entre chats atingido — este turno já faz parte de uma cadeia de ${hops - 1} mensagens entre chats. A mensagem NÃO foi enviada; responda normalmente em vez de reenviar.`,
        target.id
      )
    const wait = args.wait_for_reply === true || args.wait_for_reply === 'true'
    const rawT = typeof args.timeout_s === 'number' ? args.timeout_s : Number(args.timeout_s)
    const timeoutS =
      Number.isFinite(rawT) && rawT > 0
        ? Math.min(LIMITS.interChatMaxTimeoutS, Math.max(1, Math.round(rawT)))
        : LIMITS.interChatDefaultTimeoutS
    if (wait && wouldCreateWaitCycle(this.waitEdges, chat.id, target.id))
      return fail(
        `Erro: ciclo de espera — o chat ${tname} já está aguardando (direta ou indiretamente) uma resposta deste chat; aguardá-lo travaria os dois. A mensagem NÃO foi enviada. Responda normalmente (sua resposta final volta para ele) ou envie sem wait_for_reply.`,
        target.id
      )
    const route: InterChatRoute = this.d.interChat?.route(target.id) ?? { kind: 'local' }
    if (route.kind === 'refuse')
      return fail(`Erro: ${route.error} A mensagem NÃO foi enviada.`, target.id)
    const remote = route.kind === 'remote'
    // o chat de destino só responde por send_to_chat se puder alcançar este chat: um chat executado
    // no celular não aceita comandos remotos, então o host remoto nunca consegue responder por aí
    const header = interChatHeader(chat.title, chat.id, {
      waitForReply: wait,
      canReply: !remote && availableTools(target, targetSession).includes('send_to_chat')
    })
    const meta: MessageMeta = {
      kind: 'inter-chat',
      fromChatId: chat.id,
      fromSessionId: session.id,
      fromChatTitle: chat.title,
      interChatHops: hops
    }
    const edge = wait ? { id: ++this.waitSeq, from: chat.id, to: target.id } : null
    if (edge) this.waitEdges.push(edge)
    const done = (
      content: string,
      status: ToolOutcome['status'] = 'ok'
    ): Omit<ToolOutcome, 'durationMs'> => ({ content, status, targetChatId: target.id })
    const text = interChatText(header, message)
    try {
      const max = this.toolOutputLimit(chat)
      if (remote) {
        // outro dispositivo executa o destino: comando `send` ao host dele (§8.6). O protocolo não
        // leva `meta` no comando — lá a mensagem chega como texto com o cabeçalho de origem.
        let q: { queued: boolean }
        try {
          q = await this.d.interChat!.sendRemote(target.id, targetSession.id, text)
        } catch (e) {
          return fail(
            `Erro: não foi possível entregar ao chat ${tname} no ${route.hostName}: ${errMsg(e)}`,
            target.id
          )
        }
        if (!wait)
          return done(
            q.queued
              ? `Mensagem enfileirada no chat ${tname} (executado no ${route.hostName}): ele está ocupado; será entregue no próximo passo dele. A resposta não volta automaticamente.`
              : `Mensagem entregue ao chat ${tname} (executado no ${route.hostName}): iniciou um turno lá. A resposta não volta automaticamente (use wait_for_reply=true para aguardar).`
          )
        let r: Awaited<ReturnType<InterChatRouter['waitRemote']>>
        try {
          r = await this.d.interChat!.waitRemote(
            target.id,
            targetSession.id,
            text,
            signal,
            timeoutS * 1000
          )
        } catch (e) {
          if (signal.aborted || (e as Error).name === 'AbortError')
            return done(
              `${CANCELLED_TEXT} A mensagem já tinha sido entregue ao chat ${tname}; a resposta ficará lá.`,
              'cancelled'
            )
          throw e
        }
        if (r.kind === 'final')
          return done(
            truncateHeadTail(
              `Resposta do chat ${tname}:\n\n${r.text.trim() || '(o chat terminou o turno sem texto)'}`,
              max,
              0.5
            )
          )
        if (r.kind === 'timeout')
          return done(
            `[O chat ${tname} ainda está rodando após ${timeoutS}s; a resposta ficará no chat ${target.id}. A mensagem foi entregue — não reenvie; verifique depois com list_chats.]`
          )
        return done(`Erro no chat ${tname}: ${r.error}`, 'error')
      }
      try {
        await this.d.interChat?.ensureLocal(target.id)
      } catch (e) {
        return fail(`Erro: ${errMsg(e)} A mensagem NÃO foi enviada ao chat ${tname}.`, target.id)
      }
      const d = await this.deliverToSession(targetSession, text, meta)
      if (!wait)
        return done(
          d.queuedId
            ? `Mensagem enfileirada no chat ${tname}: ele está ocupado; será entregue no próximo passo dele. A resposta não volta automaticamente.`
            : `Mensagem entregue ao chat ${tname}: iniciou um turno lá. A resposta não volta automaticamente (use wait_for_reply=true para aguardar).`
        )
      let r: TurnWait
      try {
        r = await this.waitForTurn(targetSession.id, d.queuedId, signal, timeoutS * 1000)
      } catch (e) {
        if (signal.aborted || (e as Error).name === 'AbortError')
          return done(
            `${CANCELLED_TEXT} A mensagem já tinha sido entregue ao chat ${tname}; a resposta ficará lá.`,
            'cancelled'
          )
        throw e
      }
      switch (r.kind) {
        case 'final':
          return done(
            truncateHeadTail(
              `Resposta do chat ${tname}:\n\n${r.text.trim() || '(o chat terminou o turno sem texto)'}`,
              max,
              0.5
            )
          )
        case 'timeout':
          return done(
            `[O chat ${tname} ainda está rodando após ${timeoutS}s; a resposta ficará no chat ${target.id}. A mensagem foi entregue — não reenvie; verifique depois com list_chats.]`
          )
        case 'undelivered':
          return done(
            `[A mensagem ficou na fila do chat ${tname}: o turno dele foi interrompido antes de entregá-la.]`,
            'error'
          )
        case 'aborted': {
          const partial = r.partial.trim()
          return done(
            `[O turno do chat ${tname} foi interrompido antes de terminar.]${partial ? `\n\nResposta parcial:\n${truncate(partial, max)}` : ''}`,
            'error'
          )
        }
        default:
          return done(`Erro no chat ${tname}: ${r.error}`, 'error')
      }
    } finally {
      if (edge) {
        const i = this.waitEdges.findIndex((e) => e.id === edge.id)
        if (i !== -1) this.waitEdges.splice(i, 1)
      }
    }
  }

  // ---------------- janela aberta ----------------

  /**
   * Ao abrir a janela (virar host, reabrir o app): status transitório gravado sem execução local
   * vira `interrupted` e tools sem resposta são canceladas (= markStaleInterrupted do desktop);
   * subagente em segundo plano que ficou rodando num fechamento abrupto: o pai recebe
   * "(interrompido: o app foi fechado)", sem ser acordado (= initRunner do desktop).
   */
  normalizeStale(chatId: string): void {
    const stale: Session[] = []
    for (const s of this.repo.sessions(chatId)) {
      if (this.runs.has(s.id) || !BUSY.includes(s.status)) continue
      try {
        this.repairTail(s.id)
        this.clearPendingBranch(s.id)
      } catch (e) {
        this.log(`normalizar sessão: ${errMsg(e)}`)
      }
      this.setStatus(s.id, 'interrupted')
      stale.push(s)
    }
    for (const s of stale) {
      try {
        if (s.depth === 0 || !s.parentSessionId) continue
        const pm = this.repo.path(s.parentSessionId)
        const tool = pm.find((m) => m.message.role === 'tool' && m.meta.subSessionId === s.id)
        if (!tool?.meta.background) continue
        const idx = pm.indexOf(tool)
        if (
          pm
            .slice(idx + 1)
            .some((m) => m.meta.kind === 'subagent-callback' && m.meta.subSessionId === s.id)
        )
          continue
        this.append(
          s.parentSessionId,
          {
            role: 'user',
            content: callbackText(
              { title: s.title, sessionId: s.id, model: s.model, update: false },
              { kind: 'app-closed' }
            )
          },
          callbackMeta({ sessionId: s.id, update: false })
        )
      } catch (e) {
        this.log(`callback de subagente interrompido: ${errMsg(e)}`)
      }
    }
  }
}

/** Subsessões compactam sempre ao atingir o limite; a principal só com autoCompact. */
function autoCompactAllowed(chat: Chat, depth: number): boolean {
  return depth > 0 || !!chat.config.autoCompact
}

/**
 * Mensagem digitada pelo usuário (não de outro chat, callback, sintética…) — a mesma regra do
 * desktop (isTypedFirstMessage) para o título automático.
 */
export const isTypedFirstMessage = (meta: MessageMeta): boolean =>
  !meta.synthetic && (!meta.kind || meta.kind === 'queued' || meta.kind === 'forced')

const callbackMeta = (r: Pick<Report, 'sessionId' | 'update'>): MessageMeta => ({
  kind: 'subagent-callback',
  synthetic: true,
  subSessionId: r.sessionId,
  ...(r.update ? { callbackUpdate: true } : {})
})

const subTitle = (s: Pick<Session, 'title' | 'id'>): string =>
  `"${s.title || 'Subagente'}" (id ${s.id})`

const clampWaitS = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) && n > 0
    ? Math.min(LIMITS.subagentWaitMaxS, Math.max(1, Math.round(n)))
    : LIMITS.subagentWaitDefaultS
}

const isTrue = (v: unknown): boolean => v === true || v === 'true'

const NO_SIBLING_WAIT =
  'Erro: wait_for_reply não vale entre subagentes irmãos (dois irmãos esperando um pelo outro travariam). Envie sem wait_for_reply: o irmão responde com message_subagent e a resposta chega como mensagem nova.'

/** O que está em `from` e sai do caminho ao passar para `to`. */
const leftBehind = (from: StoredMessage[], to: StoredMessage[]): StoredMessage[] => {
  const keep = new Set(to.map((m) => m.id))
  return from.filter((m) => !keep.has(m.id))
}

/** Fim de `done`, timeout (ms) ou abort do chamador (rejeita com AbortError). */
function raceDone<T>(done: Promise<T>, ms: number, signal: AbortSignal): Promise<T | 'timeout'> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError())
    if (ms <= 0) return resolve('timeout')
    const cleanup = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
    const onAbort = (): void => {
      cleanup()
      reject(abortError())
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve('timeout')
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
    void done.then((o) => {
      cleanup()
      resolve(o)
    })
  })
}

export { abortError }
