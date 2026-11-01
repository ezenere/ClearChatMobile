// Controle remoto no celular (SYNC_PROTOCOL.md §8, §10, §11): estado do host por chat, inscrição no
// stream do chat aberto com o espelho ao vivo (snapshot + deltas, resync em buraco/reconexão) e o
// cliente de comandos cifrados (§8.6) com resultado, timeout e erros em pt-BR. Porta a metade
// "controle remoto" do HostController do desktop (src/main/sync/host.ts). Sem React Native.
import { WsRequestError } from '@vendor/desktop/sync/ws'
import type { ApprovalItemDecision } from '@shared/approvalPolicy'
import {
  REMOTE_FS_LIMITS,
  type RemoteDirResult,
  type RemoteFsEntry,
  type RemoteFsFailure,
  type RemoteReadResult
} from '@shared/remoteFs'
import type { ApiMessage, AttachmentInfo, QuestionAnswer, StoredMessage } from '@shared/types'
import { fromB64u, type Subkeys } from '@/crypto'
import { UserError } from '@/account/errors'
import type { ChatState } from '@/data/types'
import { openResult, openStream, sealCommand, type Envelope } from './crypto'
import { LiveMirror, type MirrorTimers, type MirrorView } from './mirror'
import {
  COMMAND_KINDS,
  divergedOf,
  type CommandKind,
  type CommandResult,
  type HostMode,
  type RemoteNotice
} from './types'

export interface RemoteWs {
  request(
    t: string,
    fields?: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<Record<string, unknown>>
}

export interface RemoteDeps {
  ws: RemoteWs
  keys: () => { userId: string; sk: Subkeys } | null
  deviceId: () => string | null
  /** Estado do chat no cache (§8.2). */
  chatState: (chatId: string) => ChatState | null
  /** POST REST (resolver divergência). */
  post: (path: string, json: unknown) => Promise<unknown>
  /** Ids das mensagens assistant do chat (para trocar o draft pela mensagem persistida). */
  assistantIds: (chatId: string) => string[]
  loadMessage: (id: string) => StoredMessage | null
  uuid?: () => string
  now?: () => number
  timers?: MirrorTimers
  /** Tempos (testes encurtam). */
  timing?: Partial<typeof DEFAULT_TIMING>
  log?: (msg: string) => void
}

export const DEFAULT_TIMING: { commandMs: number; fsMs: number; resyncGapMs: number } = {
  /** Espera pelo `remote.result` (o servidor desiste em 30 s com `remote.failed`). */
  commandMs: 40_000,
  fsMs: REMOTE_FS_LIMITS.timeoutMs,
  /** Intervalo mínimo entre dois `stream.resync` do mesmo chat. */
  resyncGapMs: 1_500
}

/** Erro de um comando remoto com texto pronto (pt-BR) e o código de origem. */
export class RemoteError extends UserError {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

interface PendingCmd {
  chatId: string
  resolve: (r: Record<string, unknown>) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const KINDS = new Set<string>(COMMAND_KINDS)

/** Resposta do host 0.7+ a um `message.edit` numa mensagem digitada pelo usuário (§8.6). */
const EDIT_NEEDS_UPDATE_RE = /^Editar uma mensagem sua agora cria uma nova versão/

/**
 * Kind enviado (§8.6): controles remotos ≥ 1.2.0 nunca mandam o `regenerate` antigo — um host
 * antigo recusa `branch.regenerate` em vez de apagar as outras versões.
 */
export const wireKind = (kind: CommandKind): CommandKind =>
  kind === 'regenerate' ? 'branch.regenerate' : kind

/** Texto pt-BR de uma recusa do host (`status: 'rejected'`). */
export function rejectText(error: string | undefined, host: string): string {
  if (!error) return `O host (${host}) recusou o comando.`
  if (error === 'attachment_missing')
    return `O host (${host}) não conseguiu baixar um dos anexos — envie de novo.`
  if (error === 'not_host') return `${host} não é mais o host deste chat.`
  if (error === 'chat_busy')
    return `O chat está ocupado em ${host} — tente de novo quando o turno terminar.`
  if (/^comando desconhecido: branch\./.test(error))
    return `O host (${host}) usa uma versão antiga do ClearChat — atualize o app nele para usar versões de mensagens.`
  if (/^comando desconhecido: /.test(error))
    return `O host (${host}) usa uma versão antiga do ClearChat — atualize o app nele.`
  if (EDIT_NEEDS_UPDATE_RE.test(error))
    return 'Mensagens suas não são editadas no lugar: use “Editar como nova versão”.'
  return error
}

/** base64 padrão (com `=`) → bytes. */
export function fromStdB64(s: string): Uint8Array {
  return fromB64u(s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''))
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export class RemoteController {
  private readonly d: RemoteDeps
  private readonly t: typeof DEFAULT_TIMING
  private active: string | null = null
  private mirror: LiveMirror | null = null
  private connected = false
  private pending = new Map<string, PendingCmd>()
  private resyncAt = new Map<string, number>()
  private dropShown = new Set<string>()
  private knownAssistant = new Set<string>()
  private streamChain: Promise<void> = Promise.resolve()
  private listeners = new Set<() => void>()
  private noticeListeners = new Set<(n: RemoteNotice) => void>()
  private version = 0

  constructor(deps: RemoteDeps) {
    this.d = deps
    this.t = { ...DEFAULT_TIMING, ...(deps.timing ?? {}) }
  }

  // ---------------- observável ----------------

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  onNotice(fn: (n: RemoteNotice) => void): () => void {
    this.noticeListeners.add(fn)
    return () => this.noticeListeners.delete(fn)
  }

  /** Muda a cada mudança do espelho/conexão (useSyncExternalStore). */
  getVersion = (): number => this.version

  private changed(): void {
    this.version++
    for (const fn of this.listeners) fn()
  }

  private notice(n: RemoteNotice): void {
    for (const fn of this.noticeListeners) fn(n)
  }

  private log(msg: string): void {
    this.d.log?.(msg)
  }

  private now(): number {
    return this.d.now?.() ?? Date.now()
  }

  /** Espelho ao vivo do chat aberto (null = outro chat / nada recebido ainda). */
  view(chatId: string): MirrorView | null {
    return this.active === chatId && this.mirror ? this.mirror.view : null
  }

  get isConnected(): boolean {
    return this.connected
  }

  get activeChat(): string | null {
    return this.active
  }

  // ---------------- estado / modo (§8.2) ----------------

  mode(chatId: string): HostMode {
    const st = this.d.chatState(chatId)
    if (divergedOf(st)) return 'diverged'
    if (!this.connected) return 'offline'
    if (!st?.host) return 'none'
    if (st.host.device_id === this.d.deviceId()) return 'local'
    return st.host.status === 'online' ? 'remote' : 'host-offline'
  }

  hostName(chatId: string): string {
    return this.d.chatState(chatId)?.host?.name ?? 'outro dispositivo'
  }

  // ---------------- WebSocket ----------------

  /** Inscrições do `hello` (o chat aberto). */
  subscriptions(): string[] {
    return this.active ? [this.active] : []
  }

  onConnection(online: boolean): void {
    if (this.connected === online) return
    this.connected = online
    if (!online) {
      for (const [, p] of this.pending) {
        clearTimeout(p.timer)
        p.reject(
          new RemoteError(
            'disconnected',
            'Conexão com o servidor perdida — o comando pode não ter sido entregue.'
          )
        )
      }
      this.pending.clear()
    }
    this.changed()
  }

  onWelcome(_w: Record<string, unknown>): void {
    this.connected = true
    // o hello já reinscreveu o chat aberto; o snapshot vem pelo resync
    if (this.active && this.mode(this.active) === 'remote') this.resync(this.active, true)
    this.changed()
  }

  onEvent(f: Record<string, unknown>): void {
    switch (f.t) {
      case 'chat.state':
        this.onChatState(f as unknown as ChatState)
        return
      case 'remote.result':
      case 'remote.failed':
        void this.onRemoteResult(f)
        return
      case 'stream.event': {
        const frame = f
        this.streamChain = this.streamChain
          .then(() => this.onStreamEvent(frame))
          .catch((e: unknown) => this.log(`stream: ${errMsg(e)}`))
        return
      }
    }
  }

  private onChatState(s: ChatState): void {
    if (!s?.chat_id) return
    const id = s.chat_id
    const ev = s.event
    const prevStatus = this.prevHostStatus.get(id)
    this.prevHostStatus.set(id, s.host?.status ?? null)
    const remoteHost = !!s.host && s.host.device_id !== this.d.deviceId()
    if (ev?.kind === 'host_dropped' && remoteHost) {
      this.dropShown.add(id)
      this.notice({
        chatId: id,
        tone: 'danger',
        text: `O dispositivo remoto (${s.host!.name}) caiu.`
      })
    } else if (ev?.kind === 'host_back' && remoteHost) {
      // `host_back` também vem depois de uma piscada na tolerância: só avisa se a queda apareceu
      if (this.dropShown.delete(id) || prevStatus === 'offline')
        this.notice({ chatId: id, tone: 'info', text: `${s.host!.name} voltou a ficar online.` })
    } else if (ev?.kind === 'diverged') {
      this.notice({ chatId: id, tone: 'danger', text: 'Este chat ficou divergente.' })
    }
    if (id !== this.active) return
    if (ev?.kind === 'host_changed') {
      this.dropShown.delete(id)
      this.disposeMirror()
    } else if (!s.window) this.mirror?.endTurn()
    if (this.mode(id) === 'remote' && (!this.mirror || !this.mirror.view.complete)) this.resync(id)
    this.changed()
  }

  private prevHostStatus = new Map<string, string | null>()

  // ---------------- stream (§11) ----------------

  /** Chat aberto na tela (inscrição no stream). */
  setActive(chatId: string | null): void {
    if (this.active === chatId) return
    const prev = this.active
    this.active = chatId
    this.disposeMirror()
    if (prev && this.connected)
      void this.d.ws.request('stream.unsubscribe', { chat_ids: [prev] }).catch(() => undefined)
    this.knownAssistant = new Set(chatId ? this.d.assistantIds(chatId) : [])
    if (chatId && this.connected)
      // o servidor pede o snapshot ao host
      void this.d.ws.request('stream.subscribe', { chat_ids: [chatId] }).catch(() => undefined)
    this.changed()
  }

  private disposeMirror(): void {
    this.mirror?.dispose()
    this.mirror = null
  }

  /** Pede um snapshot ao host (throttle por chat; `force` ignora). */
  resync(chatId: string, force = false): void {
    if (!this.connected) return
    const at = this.resyncAt.get(chatId) ?? 0
    if (!force && this.now() - at < this.t.resyncGapMs) return
    this.resyncAt.set(chatId, this.now())
    void this.d.ws.request('stream.resync', { chat_id: chatId }).catch(() => undefined)
  }

  private ensureMirror(chatId: string, epoch: number): LiveMirror {
    if (this.mirror && this.mirror.epoch === epoch) return this.mirror
    this.disposeMirror()
    const m: LiveMirror = new LiveMirror(epoch, {
      resync: () => this.resync(chatId),
      changed: () => {
        if (this.mirror === m) this.changed()
      },
      timers: this.d.timers
    })
    this.mirror = m
    return m
  }

  private async onStreamEvent(f: Record<string, unknown>): Promise<void> {
    const chatId = String(f.chat_id ?? '')
    if (this.active !== chatId || this.mode(chatId) !== 'remote') return
    const keys = this.d.keys()
    if (!keys) return
    const epoch = Number(f.epoch)
    const n = Number(f.n)
    if (!Number.isSafeInteger(epoch) || !Number.isSafeInteger(n)) return
    let p: Record<string, unknown>
    try {
      p = await openStream(keys.sk.stream, keys.userId, chatId, epoch, n, f.env as Envelope)
    } catch (e) {
      this.log(`stream ilegível: ${errMsg(e)}`)
      return
    }
    if (this.active !== chatId) return
    // epoch menor que o do espelho = evento atrasado de um host antigo
    if (this.mirror && epoch < this.mirror.epoch) return
    this.ensureMirror(chatId, epoch).onEvent(n, p)
  }

  /**
   * Registros do chat aberto mudaram: mensagens assistant novas trocam o draft (o stream é mais
   * rápido que o push; sem isso o texto sumiria entre o fim da resposta e a chegada da mensagem).
   */
  onChatData(chatId: string): void {
    if (chatId !== this.active) return
    const fresh: StoredMessage[] = []
    for (const id of this.d.assistantIds(chatId)) {
      if (this.knownAssistant.has(id)) continue
      this.knownAssistant.add(id)
      const m = this.d.loadMessage(id)
      if (m) fresh.push(m)
    }
    if (!this.mirror) return
    fresh.sort((a, b) => a.seq - b.seq)
    for (const m of fresh) this.mirror.onPersistedAssistant(m)
  }

  // ---------------- comandos (§8.6) ----------------

  /**
   * Cifra e envia um comando ao host e espera o `remote.result` decifrado. Erros crus: o
   * `WsRequestError` do `remote.send`, ou `RemoteError` (host caiu / sem resposta).
   */
  private async commandResult(
    chatId: string,
    kind: CommandKind,
    payload: Record<string, unknown>,
    timeoutMs: number,
    timeoutText: string
  ): Promise<Record<string, unknown>> {
    const keys = this.d.keys()
    if (!keys) throw new RemoteError('locked', 'Desbloqueie a conta primeiro.')
    if (!this.connected) throw new RemoteError('disconnected', 'Sem conexão com o servidor.')
    const cmdId = this.d.uuid?.() ?? crypto.randomUUID()
    const env = await sealCommand(keys.sk.stream, keys.userId, chatId, cmdId, { kind, ...payload })
    const result = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(cmdId)
        reject(new RemoteError('command_timeout', timeoutText))
      }, timeoutMs)
      this.pending.set(cmdId, { chatId, resolve, reject, timer })
    })
    result.catch(() => undefined)
    try {
      await this.d.ws.request('remote.send', { chat_id: chatId, cmd_id: cmdId, kind, env })
    } catch (e) {
      const p = this.pending.get(cmdId)
      if (p) clearTimeout(p.timer)
      this.pending.delete(cmdId)
      throw e
    }
    return result
  }

  private async onRemoteResult(f: Record<string, unknown>): Promise<void> {
    const cmdId = String(f.cmd_id ?? '')
    const p = this.pending.get(cmdId)
    if (!p) return
    this.pending.delete(cmdId)
    clearTimeout(p.timer)
    const name = this.hostName(p.chatId)
    if (f.t === 'remote.failed') {
      p.reject(
        f.code === 'command_timeout'
          ? new RemoteError(
              'command_timeout',
              `O host (${name}) não respondeu a tempo — a mensagem pode não ter sido entregue.`
            )
          : new RemoteError(
              'host_offline',
              `O host (${name}) caiu antes de confirmar — a mensagem pode não ter sido entregue.`
            )
      )
      return
    }
    const keys = this.d.keys()
    if (!keys) {
      p.reject(new RemoteError('locked', 'Conta bloqueada.'))
      return
    }
    try {
      p.resolve(await openResult(keys.sk.stream, keys.userId, p.chatId, cmdId, f.env as Envelope))
    } catch (e) {
      p.reject(new RemoteError('invalid_result', `Resposta inválida do host: ${errMsg(e)}`))
    }
  }

  /** Erros do `remote.send` → texto pt-BR. */
  private sendError(chatId: string, e: unknown): Error {
    if (e instanceof RemoteError) return e
    const name = this.hostName(chatId)
    if (e instanceof WsRequestError) {
      switch (e.code) {
        case 'host_offline':
          return new RemoteError(e.code, `O host (${name}) está offline.`)
        case 'no_host':
          return new RemoteError(
            e.code,
            'Este chat não tem host — abra-o num computador para executá-lo.'
          )
        case 'chat_diverged':
          return new RemoteError(e.code, 'Este chat está divergente: resolva a divergência antes.')
        case 'disconnected':
        case 'timeout':
          return new RemoteError(
            e.code,
            'Sem conexão com o servidor — não foi possível enviar ao host.'
          )
        case 'payload_too_large':
          return new RemoteError(e.code, 'O comando é grande demais para o servidor.')
        case 'rate_limited':
          return new RemoteError(e.code, 'Muitos comandos seguidos — espere um pouco.')
        case 'invalid_request':
          return new RemoteError(
            e.code,
            'O servidor do sync recusou o comando (versão antiga do servidor?).'
          )
      }
      return new RemoteError(e.code, e.message || 'Falha ao enviar ao host.')
    }
    return e instanceof Error ? e : new Error(String(e))
  }

  /**
   * Envia um comando ao host do chat e espera o resultado. `rejected` vira `RemoteError` com o
   * texto do host (pt-BR); `duplicate` conta como aceito (reenvio com o mesmo id).
   */
  async command(
    chatId: string,
    kind: CommandKind,
    payload: Record<string, unknown>
  ): Promise<CommandResult> {
    if (!KINDS.has(kind)) throw new RemoteError('invalid_request', `Comando desconhecido: ${kind}`)
    const k = wireKind(kind)
    const name = this.hostName(chatId)
    let r: Record<string, unknown>
    try {
      r = await this.commandResult(
        chatId,
        k,
        payload,
        this.t.commandMs,
        `O host (${name}) não respondeu a tempo — o comando pode não ter sido entregue.`
      )
    } catch (e) {
      throw this.sendError(chatId, e)
    }
    if (r.status === 'rejected')
      throw new RemoteError(
        'rejected',
        rejectText(typeof r.error === 'string' ? r.error : '', name)
      )
    return { ...r, status: r.status === 'duplicate' ? 'duplicate' : 'accepted' } as CommandResult
  }

  // ---- atalhos tipados (uma função por kind do §8.6) ----

  send(
    chatId: string,
    sessionId: string,
    text: string,
    attachments: AttachmentInfo[],
    skills: string[],
    force = false
  ): Promise<CommandResult> {
    return this.command(chatId, force ? 'force' : 'send', {
      sessionId,
      text,
      attachments,
      skills,
      createdAt: this.now()
    })
  }
  queueForce(chatId: string, sessionId: string, queuedId: string): Promise<CommandResult> {
    return this.command(chatId, 'queue.force', { sessionId, queuedId })
  }
  queueRemove(chatId: string, sessionId: string, queuedId: string): Promise<CommandResult> {
    return this.command(chatId, 'queue.remove', { sessionId, queuedId })
  }
  stop(chatId: string, sessionId: string): Promise<CommandResult> {
    return this.command(chatId, 'stop', { sessionId })
  }
  stopSubagents(chatId: string): Promise<CommandResult> {
    return this.command(chatId, 'stop_subagents', {})
  }
  approve(
    chatId: string,
    requestId: string,
    decision: 'allow' | 'deny',
    items?: ApprovalItemDecision[]
  ): Promise<CommandResult> {
    return this.command(chatId, 'approval', {
      requestId,
      decision,
      ...(items?.length ? { items } : {})
    })
  }
  smartOverride(chatId: string, messageId: string): Promise<CommandResult> {
    return this.command(chatId, 'smart_override', { messageId })
  }
  answer(chatId: string, requestId: string, answers: QuestionAnswer[]): Promise<CommandResult> {
    return this.command(chatId, 'question', { requestId, answers })
  }
  cancelQuestion(chatId: string, requestId: string): Promise<CommandResult> {
    return this.command(chatId, 'question', { requestId, cancel: true })
  }
  retry(chatId: string, requestId: string, action: 'retry' | 'cancel'): Promise<CommandResult> {
    return this.command(chatId, 'retry', { requestId, action })
  }
  /** Nova versão da resposta do turno que contém `messageId` (sem ele: o último turno). */
  regenerate(chatId: string, sessionId: string, messageId?: string): Promise<CommandResult> {
    return this.command(chatId, 'branch.regenerate', {
      sessionId,
      ...(messageId ? { messageId } : {})
    })
  }
  /** Edição no lugar (assistente, sintéticas, entre chats…; nunca a mensagem digitada — §8.6). */
  editMessage(chatId: string, messageId: string, message: ApiMessage): Promise<CommandResult> {
    return this.command(chatId, 'message.edit', { messageId, message })
  }
  deleteMessage(chatId: string, messageId: string): Promise<CommandResult> {
    return this.command(chatId, 'message.delete', { messageId })
  }
  compact(chatId: string, sessionId: string, opts?: { retry?: boolean }): Promise<CommandResult> {
    return this.command(chatId, 'compact', { sessionId, ...(opts ? { opts } : {}) })
  }
  extractMemory(chatId: string, sessionId: string): Promise<CommandResult> {
    return this.command(chatId, 'memory.extract', { sessionId })
  }
  /** Nova versão (irmã) de uma mensagem digitada pelo usuário na principal — roda o turno. */
  editBranch(chatId: string, messageId: string, message: ApiMessage): Promise<CommandResult> {
    return this.command(chatId, 'branch.edit', { messageId, message })
  }
  selectBranch(chatId: string, messageId: string): Promise<CommandResult> {
    return this.command(chatId, 'branch.select', { messageId })
  }

  // ---------------- arquivos do host (fs.list / fs.read, §8.6) ----------------

  private fsFail(
    chatId: string,
    reason: RemoteFsFailure['reason'],
    message: string
  ): RemoteFsFailure {
    return { ok: false, reason, message, deviceName: this.hostName(chatId) }
  }

  /** Só com o host online: offline/sem conexão viram falha sem ir à rede. */
  private fsPrecheck(chatId: string): RemoteFsFailure | null {
    const name = this.hostName(chatId)
    switch (this.mode(chatId)) {
      case 'remote':
        return null
      case 'host-offline':
        return this.fsFail(chatId, 'host-offline', `O host (${name}) está offline.`)
      case 'offline':
        return this.fsFail(chatId, 'host-offline', 'Sem conexão com o servidor do sync.')
      case 'diverged':
        return this.fsFail(chatId, 'error', 'Este chat está divergente: resolva antes.')
      case 'none':
        return this.fsFail(chatId, 'host-offline', 'Este chat não tem host.')
      case 'local':
        return this.fsFail(chatId, 'error', 'Este aparelho executa o chat.')
    }
  }

  private fsRejected(chatId: string, r: Record<string, unknown>): RemoteFsFailure {
    const name = this.hostName(chatId)
    const error = typeof r.error === 'string' ? r.error : ''
    if (/^comando desconhecido: fs\./.test(error))
      return this.fsFail(
        chatId,
        'unsupported',
        `O host (${name}) usa uma versão antiga do ClearChat — atualize o app nele para ver os arquivos.`
      )
    if (error === 'not_host')
      return this.fsFail(chatId, 'host-offline', `${name} não é mais o host deste chat.`)
    if (r.code === 'denied') return this.fsFail(chatId, 'denied', error || 'Acesso negado.')
    if (r.code === 'missing')
      return this.fsFail(chatId, 'missing', error || 'Arquivo não encontrado.')
    return this.fsFail(chatId, 'error', error || `O host (${name}) recusou o pedido.`)
  }

  private fsFailure(chatId: string, e: unknown): RemoteFsFailure {
    const name = this.hostName(chatId)
    if (e instanceof RemoteError) {
      if (e.code === 'host_offline')
        return this.fsFail(chatId, 'host-offline', `O host (${name}) caiu antes de responder.`)
      if (e.code === 'command_timeout')
        return this.fsFail(chatId, 'error', `O host (${name}) não respondeu a tempo.`)
      if (e.code === 'disconnected')
        return this.fsFail(chatId, 'host-offline', 'Sem conexão com o servidor.')
      return this.fsFail(chatId, 'error', e.message)
    }
    if (e instanceof WsRequestError) {
      if (e.code === 'host_offline')
        return this.fsFail(chatId, 'host-offline', `O host (${name}) está offline.`)
      if (e.code === 'no_host')
        return this.fsFail(chatId, 'host-offline', 'Este chat não tem host.')
      if (e.code === 'chat_diverged')
        return this.fsFail(chatId, 'error', 'Este chat está divergente: resolva antes.')
      // servidor < 1.3.0 recusa o kind desconhecido
      if (e.code === 'invalid_request')
        return this.fsFail(
          chatId,
          'unsupported',
          'O servidor do sync ainda não permite ver arquivos do host — atualize o servidor.'
        )
      if (e.code === 'disconnected' || e.code === 'timeout')
        return this.fsFail(
          chatId,
          'host-offline',
          'Sem conexão com o servidor — não foi possível falar com o host.'
        )
    }
    return this.fsFail(chatId, 'error', errMsg(e))
  }

  private fsCommand(
    chatId: string,
    kind: 'fs.list' | 'fs.read',
    payload: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return this.commandResult(
      chatId,
      kind,
      payload,
      this.t.fsMs,
      `O host (${this.hostName(chatId)}) não respondeu a tempo.`
    )
  }

  /** Aba Arquivos do host: lista `path` (vazio = raiz do chat no host). Nunca lança. */
  async fsList(chatId: string, path: string): Promise<RemoteDirResult> {
    const pre = this.fsPrecheck(chatId)
    if (pre) return pre
    try {
      const r = await this.fsCommand(chatId, 'fs.list', { chatId, path: String(path ?? '') })
      if (r.status !== 'accepted') return this.fsRejected(chatId, r)
      if (typeof r.dir !== 'string' || !Array.isArray(r.entries))
        throw new Error('Resposta inválida do host.')
      const entries: RemoteFsEntry[] = []
      for (const x of r.entries as Record<string, unknown>[]) {
        const name = x && typeof x.name === 'string' ? x.name : ''
        // nome com separador / NUL / . / .. não vira caminho no controle remoto
        if (!name || /[/\\\0]/.test(name) || name === '.' || name === '..') continue
        const num = (v: unknown): number | undefined =>
          typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined
        const size = num(x.size)
        const mtime = num(x.mtime)
        entries.push({
          name,
          kind: x.kind === 'dir' ? 'dir' : 'file',
          ...(size !== undefined ? { size } : {}),
          ...(mtime !== undefined ? { mtime } : {})
        })
      }
      return {
        ok: true,
        dir: r.dir,
        root: typeof r.root === 'string' && r.root ? r.root : r.dir,
        confine: r.confine !== false,
        truncated: r.truncated === true,
        entries
      }
    } catch (e) {
      return this.fsFailure(chatId, e)
    }
  }

  /** Um pedaço (até `REMOTE_FS_LIMITS.chunkBytes`) de um arquivo do host. Nunca lança. */
  async fsRead(
    chatId: string,
    path: string,
    offset: number,
    length: number
  ): Promise<RemoteReadResult> {
    const pre = this.fsPrecheck(chatId)
    if (pre) return pre
    try {
      const r = await this.fsCommand(chatId, 'fs.read', { chatId, path, offset, length })
      if (r.status !== 'accepted') return this.fsRejected(chatId, r)
      const size = r.size
      const mtime = r.mtime
      if (
        typeof size !== 'number' ||
        typeof mtime !== 'number' ||
        r.offset !== offset ||
        typeof r.data !== 'string'
      )
        throw new Error('Resposta inválida do host.')
      const data = fromStdB64(r.data)
      if (data.length > Math.max(length, 0)) throw new Error('Resposta inválida do host.')
      return {
        ok: true,
        size,
        mtime,
        ...(typeof r.mime === 'string' && r.mime ? { mime: r.mime } : {}),
        offset,
        data
      }
    } catch (e) {
      return this.fsFailure(chatId, e)
    }
  }

  // ---------------- host (§8.9) e divergência (§9.3) ----------------

  /** Fixar/desafixar o host do chat (`host.pin`). */
  async setPinned(chatId: string, pinned: boolean): Promise<void> {
    try {
      await this.d.ws.request('host.pin', { chat_id: chatId, pinned })
    } catch (e) {
      if (e instanceof WsRequestError) {
        if (e.code === 'quota_exceeded')
          throw new RemoteError(e.code, 'O limite de chats com estado foi atingido nesta conta.')
        if (e.code === 'disconnected' || e.code === 'timeout')
          throw new RemoteError(e.code, 'Sem conexão com o servidor.')
        throw new RemoteError(e.code, e.message || 'Não foi possível fixar o host.')
      }
      throw e
    }
  }

  /**
   * "Descartar a versão de <D>" = manter a online (§9.3, `keep: 'online'`, qualquer dispositivo).
   * O celular nunca tem versão local divergente nesta fase (não executa chats).
   */
  async discardDivergentVersion(chatId: string): Promise<void> {
    const d = divergedOf(this.d.chatState(chatId))
    if (!d?.divergence_id) throw new RemoteError('not_diverged', 'Este chat não está divergente.')
    try {
      await this.d.post(`/api/v1/chats/${encodeURIComponent(chatId)}/divergence/resolve`, {
        divergence_id: d.divergence_id,
        keep: 'online'
      })
    } catch (e) {
      const code = (e as { code?: string })?.code
      if (code === 'divergence_mismatch')
        throw new RemoteError(code, 'A divergência mudou enquanto você decidia — confira de novo.')
      throw e
    }
  }
}
