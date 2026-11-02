// Host no celular (SYNC_PROTOCOL.md §8): o celular executa os PRÓPRIOS chats (sem ferramentas
// locais, §8.9) e grava os turnos dentro de janelas de escrita (`host.begin` … `host.end`, fechadas
// quando o chat fica ocioso e a outbox esvazia; revisões com `chat_bases`/`host_epochs`, §8.4).
// Decisão de produto: chats executados no celular NÃO são controlados remotamente — o celular não
// publica o stream (§11) e recusa todo `remote.command` na hora com um texto claro; um computador
// que queira continuar o chat o traz com "Executar neste dispositivo" (§8.8): aqui o turno para, a
// janela fecha e o host é liberado. A tela local usa o mesmo modelo do controle remoto (LiveMirror)
// alimentado pelos eventos do runner. Só em primeiro plano: segundo plano = turno interrompido.
import { WsRequestError } from '@vendor/desktop/sync/ws'
import { diffDraft, toStreamDraft, type DraftState } from '@vendor/desktop/sync/stream'
import type { ApprovalItemDecision } from '@shared/approvalPolicy'
import type {
  AgentEvent,
  ApiMessage,
  AttachmentInfo,
  QuestionAnswer,
  QueuedMessage,
  StreamDraft
} from '@shared/types'
import type { Subkeys } from '@/crypto'
import type { LocalStore } from '@/data/store'
import type { ChatState } from '@/data/types'
import { sealCommand, sealResult, type Envelope } from '@/remote/crypto'
import { LiveMirror, type MirrorView } from '@/remote/mirror'
import type { CommandKind, CommandResult } from '@/remote/types'
import type { Runner } from '@/agent/runner'
import type { ChatRepo } from './repo'
import type { ContentWriter } from './writer'
import type { DivergenceService } from './divergence'
import { LOCAL_TOOLS_REFUSAL, usesLocalTools } from './policy'

export interface HostWs {
  request(
    t: string,
    fields?: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<Record<string, unknown>>
}

export interface HostDeps {
  ws: HostWs
  keys: () => { userId: string; sk: Subkeys } | null
  deviceId: () => string | null
  deviceName: () => string
  store: LocalStore
  repo: ChatRepo
  writer: ContentWriter
  runner: Runner
  /** Puxa até alcançar o servidor (o host DEVE ter cursor ≥ head antes de rodar, §8.3). */
  pull: () => Promise<void>
  /** Avisos para a tela (pt-BR). */
  notice?: (n: { chatId: string; tone: 'info' | 'danger' | 'success'; text: string }) => void
  log?: (msg: string) => void
  uuid?: () => string
  timing?: Partial<typeof HOST_TIMING>
  /** Divergência com versão local (§9); o stack liga depois de criar. */
  divergence?: () => DivergenceService | null
}

export const HOST_TIMING = {
  idleTickMs: 300,
  /** Ocioso por tanto tempo (e outbox vazia) → host.end. */
  idleCloseMs: 700,
  /** Intervalo do draft no espelho local. */
  draftMs: 60
}

/** Resposta a qualquer comando remoto num chat executado neste celular. */
export const REMOTE_REFUSAL =
  'Este chat roda no celular e não aceita controle remoto. Use “Executar neste dispositivo” para trazê-lo para cá.'

export const cmdPurpose = (kind: string): 'run' | 'edit' =>
  kind.startsWith('message.') || kind === 'branch.select' ? 'edit' : 'run'

/** Ações da tela que mudam conteúdo (abrem a janela). */
const CONTENT_ACTIONS = new Set([
  'send',
  'force',
  'queue.force',
  'smart_override',
  'approval',
  'question',
  'retry',
  'message.edit',
  'message.delete',
  'branch.edit',
  'branch.regenerate',
  'branch.select',
  'compact',
  'memory.extract'
])

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export class HostError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

interface ToolRun {
  running: boolean
  output?: string
  judging?: boolean
}

export class HostService {
  private readonly d: HostDeps
  private readonly t: typeof HOST_TIMING
  private windows = new Map<string, { epoch: number; purpose: string }>()
  private beginning = new Map<string, Promise<void>>()
  private ending = new Set<string>()
  private idleSeen = new Map<string, number>()
  /** Troca de host pedida por outro dispositivo (§8.8): parar, fechar a janela e liberar. */
  private handoverOut = new Map<string, { items: QueuedMessage[]; releasing: boolean }>()
  private connected = false
  private foreground = true
  private idleTimer: ReturnType<typeof setInterval> | null = null
  private offBus: (() => void) | null = null
  private listeners = new Set<() => void>()
  private version = 0
  /** Estado otimista do host logo após um ack (o `chat.state` do servidor chega em seguida). */
  private optimistic = new Map<string, ChatState>()
  private reqChat = new Map<string, string>()
  // espelho local (a tela do chat que este aparelho executa)
  private active: string | null = null
  private mirror: LiveMirror | null = null
  private mirrorN = 0
  private drafts = new Map<string, DraftState>()
  private pendingDraft = new Map<string, StreamDraft | null>()
  private draftTimer: ReturnType<typeof setTimeout> | null = null
  private tools = new Map<string, Map<string, ToolRun>>()
  private lastRefetch = 0

  constructor(deps: HostDeps) {
    this.d = deps
    this.t = { ...HOST_TIMING, ...(deps.timing ?? {}) }
  }

  private get me(): string {
    return this.d.deviceId() ?? ''
  }

  get deviceId(): string {
    return this.me
  }

  private log(msg: string): void {
    this.d.log?.(msg)
  }

  // ---------------- ciclo de vida ----------------

  start(): void {
    if (!this.offBus) this.offBus = this.d.runner.bus.on((e) => this.onAgentEvent(e))
    if (!this.idleTimer) this.idleTimer = setInterval(() => void this.idleTick(), this.t.idleTickMs)
    this.d.writer.resume()
    // o app foi fechado no segundo plano com itens guardados na fila
    this.restoreParked()
  }

  stop(): void {
    this.offBus?.()
    this.offBus = null
    if (this.idleTimer) clearInterval(this.idleTimer)
    this.idleTimer = null
    this.d.writer.stop()
  }

  // ---------------- observável (tela) ----------------

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  getVersion = (): number => this.version

  private changed(): void {
    this.version++
    for (const fn of this.listeners) fn()
  }

  // ---------------- estado (§8.2) ----------------

  state(chatId: string): ChatState | null {
    const s = this.d.store.chatState(chatId)
    const l = this.optimistic.get(chatId)
    if (!l) return s
    if (!s || (s.ssq ?? 0) <= (l.ssq ?? 0)) return l
    this.optimistic.delete(chatId)
    return s
  }

  private setOptimistic(chatId: string, patch: Partial<ChatState>): void {
    const st = this.state(chatId) ?? blankState(chatId)
    this.optimistic.set(chatId, { ...st, ...patch })
    this.changed()
  }

  private hostMe(): ChatState['host'] {
    return { device_id: this.me, name: this.d.deviceName(), platform: 'android', status: 'online' }
  }

  isHostHere(chatId: string): boolean {
    return this.state(chatId)?.host?.device_id === this.me || this.windows.has(chatId)
  }

  get isConnected(): boolean {
    return this.connected
  }

  /**
   * Estado novo devolvido pelo servidor fora do WebSocket (ex.: resolve da divergência); null =
   * só limpa a divergência no estado otimista (o `chat.state` chega em seguida).
   */
  applyState(chatId: string, state: ChatState | null): void {
    if (state?.chat_id) {
      this.d.store.upsertChatState(state)
      this.onChatState(state)
    } else this.setOptimistic(chatId, { diverged: null })
  }

  windowOpen(chatId: string): boolean {
    return this.windows.has(chatId)
  }

  activeWindows(): { chat_id: string; epoch: number }[] {
    return [...this.windows].map(([chat_id, w]) => ({ chat_id, epoch: w.epoch }))
  }

  private busy(chatId: string): boolean {
    return this.d.runner.busyChats().has(chatId)
  }

  /** Por que o celular não pode executar este chat (null = pode). */
  refusal(chatId: string): string | null {
    const cfg = this.d.store.getPlain('chat', chatId)?.config
    return usesLocalTools(cfg as Record<string, unknown> | undefined) ? LOCAL_TOOLS_REFUSAL : null
  }

  // ---------------- WebSocket ----------------

  onConnection(online: boolean): void {
    if (this.connected === online) return
    this.connected = online
    // a reconexão reabre as janelas pelo hello.active_windows (tolerância de 10 s)
    this.changed()
  }

  onWelcome(w: Record<string, unknown>): void {
    this.connected = true
    for (const id of (w.lost_windows as string[]) ?? []) this.windows.delete(id)
    // estados de quando estávamos fora (ex.: o PC assumiu um chat deste celular enquanto offline)
    for (const s of (w.chat_states as ChatState[]) ?? []) this.onChatState(s)
    this.d.writer.resume()
    this.changed()
  }

  onEvent(f: Record<string, unknown>): void {
    switch (f.t) {
      case 'chat.state':
        this.onChatState(f as unknown as ChatState)
        return
      case 'host.granted': {
        const chatId = String(f.chat_id)
        this.setOptimistic(chatId, {
          epoch: Number(f.epoch ?? 0),
          host: this.hostMe(),
          window: null,
          handover: null
        })
        void this.d.pull().catch(() => undefined)
        this.d.notice?.({ chatId, tone: 'success', text: 'Este celular agora executa o chat.' })
        return
      }
      case 'host.revoked':
        void this.onLostHost(String(f.chat_id))
        return
      case 'host.handover_request':
        void this.onHandoverRequest(f)
        return
      case 'remote.command':
        void this.rejectRemote(f)
        return
      // stream.resync_request: o celular não publica o stream (chats dele não têm controle remoto)
    }
  }

  private onChatState(s: ChatState): void {
    if (!s?.chat_id) return
    const id = s.chat_id
    const l = this.optimistic.get(id)
    if (l && (s.ssq ?? 0) > (l.ssq ?? 0)) this.optimistic.delete(id)
    const mine = s.host?.device_id === this.me
    if (
      this.windows.has(id) &&
      (!mine || (!s.window && !this.beginning.has(id) && !this.ending.has(id)))
    )
      this.windows.delete(id)
    // outro dispositivo assumiu (takeover com o celular offline/em tolerância): para tudo aqui
    if (!mine && s.host && (this.busy(id) || this.handoverOut.has(id))) void this.onLostHost(id)
    this.changed()
  }

  /** Perdeu o host (troca concluída / revogado): turno interrompido, nada mais é gravado com janela. */
  private async onLostHost(chatId: string): Promise<void> {
    this.windows.delete(chatId)
    this.handoverOut.delete(chatId)
    this.optimistic.delete(chatId)
    if (this.busy(chatId))
      await this.d.runner.stopChat(chatId, true, 'interrupted').catch(() => undefined)
    this.changed()
  }

  /** Comando remoto num chat deste celular: recusado na hora (§8.6 `rejected`), sem executar. */
  private async rejectRemote(f: Record<string, unknown>): Promise<void> {
    const keys = this.d.keys()
    if (!keys) return
    const chatId = String(f.chat_id ?? '')
    const cmdId = String(f.cmd_id ?? '')
    try {
      await this.d.ws.request('remote.result', {
        chat_id: chatId,
        cmd_id: cmdId,
        env: await sealResult(keys.sk.stream, keys.userId, chatId, cmdId, {
          status: 'rejected',
          error: REMOTE_REFUSAL,
          ...(String(f.kind).startsWith('fs.') ? { code: 'denied' } : {})
        })
      })
    } catch (e) {
      this.log(`remote.result falhou: ${errMsg(e)}`)
    }
  }

  // ---------------- janela de escrita (§8.3, §8.5) ----------------

  /** A versão divergente deste chat é deste aparelho (§9)? */
  isDivergedSelf(chatId: string): boolean {
    return !!this.d.divergence?.()?.isSelf(chatId)
  }

  /**
   * Garante a janela antes de rodar/editar. Erros legíveis (pt-BR). Começar um turno exige o
   * servidor; com o turno rodando e a janela aberta, as ações dele (fila, aprovação, parar…)
   * continuam mesmo sem conexão — o conteúdo vai pela outbox quando a conexão voltar.
   */
  async ensureWindow(chatId: string, purpose: 'run' | 'edit' | 'replay' = 'run'): Promise<void> {
    const refused = this.refusal(chatId)
    if (refused) throw new HostError('local_tools', refused)
    if (this.windows.has(chatId) && this.busy(chatId) && this.foreground) return
    if (!this.connected)
      throw new HostError(
        'offline',
        'Sem conexão com o servidor — o celular só executa chats online.'
      )
    if (!this.foreground) throw new HostError('background', 'O app está em segundo plano.')
    if (this.handoverOut.has(chatId))
      throw new HostError('handover_pending', 'Outro dispositivo está assumindo este chat.')
    if (this.windows.has(chatId)) return
    const cur = this.beginning.get(chatId)
    if (cur) return cur
    const p = (async () => {
      const st = this.state(chatId)
      if (st?.host && st.host.device_id !== this.me)
        throw new HostError('not_host', `Este chat é executado em ${st.host.name}.`)
      const epoch = st?.host?.device_id === this.me ? st.epoch : null
      let ack: Record<string, unknown>
      try {
        ack = await this.d.ws.request('host.begin', { chat_id: chatId, epoch, purpose })
      } catch (e) {
        throw this.beginError(e)
      }
      const ep = Number(ack.epoch ?? 0)
      this.windows.set(chatId, { epoch: ep, purpose })
      const became = !!ack.became_host || st?.host?.device_id !== this.me
      this.setOptimistic(chatId, {
        epoch: ep,
        host: this.hostMe(),
        window: { purpose: purpose as 'run', since: new Date().toISOString() }
      })
      if (Number(ack.head ?? 0) > this.d.store.cursor) await this.d.pull().catch(() => undefined)
      if (became) this.d.runner.normalizeStale(chatId)
    })().finally(() => this.beginning.delete(chatId))
    this.beginning.set(chatId, p)
    return p
  }

  private beginError(e: unknown): Error {
    if (!(e instanceof WsRequestError)) return e instanceof Error ? e : new Error(String(e))
    const host = (e.details.state as ChatState | undefined)?.host?.name ?? 'outro dispositivo'
    switch (e.code) {
      case 'not_host':
        return new HostError(e.code, `Este chat é executado em ${host}.`)
      case 'chat_diverged':
        return new HostError(e.code, 'Este chat está divergente: resolva a divergência antes.')
      case 'handover_pending':
        return new HostError(e.code, 'Há uma troca de host em andamento neste chat.')
      case 'cannot_host':
        return new HostError(e.code, 'Este dispositivo não pode executar chats.')
      case 'quota_exceeded':
        return new HostError(e.code, 'O limite de chats com estado foi atingido nesta conta.')
      case 'disconnected':
      case 'timeout':
        return new HostError(e.code, 'Sem conexão com o servidor.')
    }
    return new HostError(e.code, e.message || 'Não foi possível abrir a janela de escrita.')
  }

  /** Modo do próximo lote de conteúdo do chat (ContentWriter). */
  async pushMode(chatId: string): Promise<{ epoch: number | null } | null> {
    const st = this.state(chatId)
    if (st?.diverged) return null
    const w = this.windows.get(chatId)
    if (w) return { epoch: w.epoch }
    if (!this.connected) return null
    if (st?.window && st.host?.device_id !== this.me) return null
    const canHost = !st?.host || st.host.device_id === this.me
    if (canHost && this.busy(chatId)) {
      try {
        await this.ensureWindow(chatId, 'run')
      } catch {
        return null
      }
      const w2 = this.windows.get(chatId)
      return w2 ? { epoch: w2.epoch } : null
    }
    // sem janela e ocioso: replay (§8.4 B) — ex.: o fim de um turno depois que a janela caiu
    return { epoch: null }
  }

  /** Recusas do push que mudam o estado do host. */
  onPushError(chatId: string, code: string): void {
    if (code === 'not_host') this.windows.delete(chatId)
    if (code === 'gone') void this.d.runner.stopChat(chatId, true).catch(() => undefined)
    if (code === 'chat_diverged')
      this.d.notice?.({
        chatId,
        tone: 'danger',
        text: 'Este chat ficou divergente: outra versão foi salva online enquanto este celular estava fora. Escolha qual manter.'
      })
    if (code === 'divergence_discarded') {
      const div = this.d.divergence?.()
      if (div)
        void div
          .replaceContentWithOnline(chatId, true)
          .then(() =>
            this.d.notice?.({
              chatId,
              tone: 'info',
              text: 'A versão deste celular foi descartada em outro dispositivo; o chat agora mostra a versão online.'
            })
          )
          .catch((e) => this.log(`descartar versão local: ${errMsg(e)}`))
    }
    this.changed()
  }

  private async closeWindow(chatId: string): Promise<void> {
    const w = this.windows.get(chatId)
    if (!w || this.ending.has(chatId)) return
    this.ending.add(chatId)
    try {
      const ack = await this.d.ws.request('host.end', { chat_id: chatId, epoch: w.epoch })
      this.windows.delete(chatId)
      this.setOptimistic(chatId, { window: null })
      if (ack.handover_pending && !this.handoverOut.has(chatId))
        this.handoverOut.set(chatId, { items: [], releasing: false })
    } catch (e) {
      if (e instanceof WsRequestError && e.code === 'not_host') this.windows.delete(chatId)
    } finally {
      this.ending.delete(chatId)
    }
  }

  private async idleTick(): Promise<void> {
    if (!this.connected) return
    const now = Date.now()
    // §9.2: chats marcados "precisa rebaixar" que já podem receber a versão online
    if (now - this.lastRefetch > 2000) {
      this.lastRefetch = now
      void this.d.divergence?.()?.refetchPending()
    }
    for (const chatId of [...this.windows.keys()]) {
      if (this.ending.has(chatId) || this.beginning.has(chatId)) continue
      if (this.busy(chatId) || this.d.writer.pendingContent(chatId)) {
        this.idleSeen.delete(chatId)
        if (this.d.writer.pendingContent(chatId)) this.d.writer.schedule(chatId)
        continue
      }
      const seen = this.idleSeen.get(chatId)
      if (!seen) {
        this.idleSeen.set(chatId, now)
        continue
      }
      if (now - seen < this.t.idleCloseMs) continue
      this.idleSeen.delete(chatId)
      await this.closeWindow(chatId)
    }
    for (const [chatId, h] of [...this.handoverOut]) {
      if (h.releasing || this.busy(chatId) || this.d.writer.pendingContent(chatId)) continue
      if (this.windows.has(chatId)) {
        await this.closeWindow(chatId)
        continue
      }
      await this.release(chatId)
    }
  }

  // ---------------- troca de host (§8.8) ----------------

  /** "Executar neste dispositivo" (chats sem ferramentas locais). */
  async takeover(
    chatId: string,
    opts: { mode: 'next_turn' | 'force'; confirmPinned?: boolean }
  ): Promise<'granted' | 'pending'> {
    const refused = this.refusal(chatId)
    if (refused) throw new HostError('local_tools', refused)
    if (!this.connected) throw new HostError('offline', 'Sem conexão com o servidor.')
    let ack: Record<string, unknown>
    try {
      ack = await this.d.ws.request('host.takeover', {
        chat_id: chatId,
        mode: opts.mode,
        confirm_pinned: !!opts.confirmPinned
      })
    } catch (e) {
      if (e instanceof WsRequestError) {
        if (e.code === 'host_pinned')
          throw new HostError(
            e.code,
            'O host deste chat está fixado — confirme para executar aqui mesmo assim.'
          )
        if (e.code === 'chat_diverged')
          throw new HostError(e.code, 'Este chat está divergente: escolha a versão antes.')
        if (e.code === 'handover_pending')
          throw new HostError(e.code, 'Já há uma troca de host em andamento.')
        if (e.code === 'cannot_host')
          throw new HostError(e.code, 'Este dispositivo não pode executar chats.')
        if (e.code === 'quota_exceeded')
          throw new HostError(e.code, 'O limite de chats com estado foi atingido nesta conta.')
        if (e.code === 'disconnected' || e.code === 'timeout')
          throw new HostError(e.code, 'Sem conexão com o servidor.')
        throw new HostError(e.code, e.message || 'Não foi possível assumir o chat.')
      }
      throw e
    }
    if (ack.status === 'granted') {
      this.setOptimistic(chatId, {
        epoch: Number(ack.epoch ?? 0),
        host: this.hostMe(),
        window: null,
        handover: null
      })
      if (Number(ack.head ?? 0) > this.d.store.cursor) await this.d.pull().catch(() => undefined)
      return 'granted'
    }
    this.setOptimistic(chatId, {
      handover: { to_device_id: this.me, to_name: this.d.deviceName(), mode: opts.mode }
    })
    return 'pending'
  }

  async cancelHandover(chatId: string): Promise<void> {
    await this.d.ws.request('host.handover_cancel', { chat_id: chatId })
    const st = this.state(chatId)
    if (st?.handover) this.setOptimistic(chatId, { handover: null })
  }

  /**
   * Outro dispositivo assumindo um chat deste celular: o turno PARA já (qualquer modo — o celular
   * não espera o fim do turno), a fila vai junto no `host.release` e a janela fecha.
   */
  private async onHandoverRequest(f: Record<string, unknown>): Promise<void> {
    const chatId = String(f.chat_id)
    const items = this.d.runner.takeChatQueues(chatId)
    const cur = this.handoverOut.get(chatId)
    this.handoverOut.set(chatId, { items: [...(cur?.items ?? []), ...items], releasing: false })
    const who = String(f.to_name ?? 'Outro dispositivo')
    this.d.notice?.({ chatId, tone: 'info', text: `${who} assumiu este chat — ele continua lá.` })
    await this.d.runner.stopChat(chatId, true, 'interrupted').catch(() => undefined)
    this.changed()
    void this.idleTick()
  }

  private async release(chatId: string): Promise<void> {
    const h = this.handoverOut.get(chatId)
    if (!h) return
    h.releasing = true
    const st = this.state(chatId)
    const keys = this.d.keys()
    const forwarded: { cmd_id: string; env: Envelope }[] = []
    if (keys) {
      for (const it of h.items) {
        const cmdId = this.d.uuid?.() ?? crypto.randomUUID()
        forwarded.push({
          cmd_id: cmdId,
          env: await sealCommand(keys.sk.stream, keys.userId, chatId, cmdId, {
            kind: 'send',
            sessionId: it.sessionId,
            text: it.text,
            attachments: it.attachments ?? [],
            skills: [],
            createdAt: it.createdAt
          })
        })
      }
    }
    try {
      await this.d.ws.request('host.release', { chat_id: chatId, epoch: st?.epoch ?? 0, forwarded })
      this.handoverOut.delete(chatId)
      this.windows.delete(chatId)
      this.optimistic.delete(chatId)
    } catch (e) {
      h.releasing = false
      this.log(`host.release falhou: ${errMsg(e)}`)
      if (e instanceof WsRequestError && (e.code === 'not_host' || e.code === 'invalid_request'))
        this.handoverOut.delete(chatId)
    }
    this.changed()
  }

  // ---------------- primeiro/segundo plano ----------------

  /**
   * Indo para o segundo plano (o SO suspende o app): para os turnos (parcial com `interrupted`,
   * tools sem resposta canceladas, sessão `interrupted`, fila descartada), espera a outbox e fecha
   * as janelas — antes de o WebSocket fechar (AccountService.beforeBackground).
   */
  async onBackground(): Promise<void> {
    this.foreground = false
    const chats = new Set([...this.d.runner.busyChats(), ...this.windows.keys()])
    for (const chatId of chats) {
      // a fila ainda não injetada fica guardada (SQLite) e volta no primeiro plano
      const items = this.d.runner.takeChatQueues(chatId)
      if (items.length)
        this.d.store.parkQueue(
          chatId,
          items.map((q) => ({ id: q.id, sessionId: q.sessionId, json: JSON.stringify(q) }))
        )
      await this.d.runner.stopChat(chatId, true, 'interrupted').catch(() => undefined)
    }
    // sem temporizadores aqui: no segundo plano o Android pausa os timers do JS
    for (const chatId of chats) {
      await this.d.writer.flushNow(chatId).catch(() => false)
      await this.closeWindow(chatId)
    }
    this.changed()
  }

  onForeground(): void {
    this.foreground = true
    this.d.writer.resume()
    this.restoreParked()
    this.changed()
  }

  /** Itens da fila guardados no segundo plano voltam à fila (sem iniciar turno) com um aviso. */
  private restoreParked(): void {
    let rows: { chatId: string; sessionId: string; json: string }[]
    try {
      rows = this.d.store.takeParked()
    } catch {
      return
    }
    const bySession = new Map<string, { chatId: string; items: QueuedMessage[] }>()
    for (const r of rows) {
      try {
        const q = JSON.parse(r.json) as QueuedMessage
        const g = bySession.get(r.sessionId) ?? { chatId: r.chatId, items: [] }
        g.items.push(q)
        bySession.set(r.sessionId, g)
      } catch {
        /* item ilegível */
      }
    }
    const perChat = new Map<string, number>()
    for (const [sid, g] of bySession) {
      this.d.runner.restoreQueue(sid, g.items)
      perChat.set(g.chatId, (perChat.get(g.chatId) ?? 0) + g.items.length)
    }
    for (const [chatId, n] of perChat)
      this.d.notice?.({
        chatId,
        tone: 'info',
        text:
          n === 1
            ? 'O app foi para o segundo plano e o turno parou; a mensagem da fila ficou guardada — toque ⚡ para enviar.'
            : `O app foi para o segundo plano e o turno parou; ${n} mensagens da fila ficaram guardadas — toque ⚡ para enviar.`
      })
  }

  // ---------------- ações da tela ----------------

  private sessionInChat(sessionId: unknown, chatId: string): string {
    const sid = String(sessionId ?? '')
    if (this.d.repo.session(sid)?.chatId !== chatId)
      throw new Error('Sessão não pertence a este chat.')
    return sid
  }

  /**
   * Ação da tela num chat executado aqui (mesmos kinds/payloads do §8.6, para a tela usar o mesmo
   * código do controle remoto): abre a janela nas que mudam conteúdo e chama o runner.
   */
  async local(
    chatId: string,
    kind: CommandKind,
    p: Record<string, unknown>
  ): Promise<CommandResult> {
    const runner = this.d.runner
    const k = kind === 'regenerate' ? 'branch.regenerate' : kind
    if (k === 'fs.list' || k === 'fs.read')
      throw new HostError('unsupported', 'Chats executados no celular não têm arquivos de host.')
    if (CONTENT_ACTIONS.has(k)) await this.ensureWindow(chatId, cmdPurpose(k))
    const ok = (queued?: boolean): CommandResult => ({
      status: 'accepted',
      ...(queued !== undefined ? { queued } : {})
    })
    switch (k) {
      case 'send':
      case 'force': {
        const sid = this.sessionInChat(p.sessionId, chatId)
        const atts = (Array.isArray(p.attachments) ? p.attachments : []) as AttachmentInfo[]
        const r = await runner.send(sid, String(p.text ?? ''), atts)
        if (k === 'force' && r.queued) {
          const q = runner.getQueue(sid)
          const last = q[q.length - 1]
          if (last) runner.forceSend(last.id)
        }
        return ok(r.queued)
      }
      case 'queue.force':
        runner.forceSend(String(p.queuedId))
        return ok()
      case 'queue.remove':
        runner.removeQueued(String(p.queuedId))
        return ok()
      case 'stop':
        await runner.stop(this.sessionInChat(p.sessionId, chatId))
        return ok()
      case 'stop_subagents':
        await runner.stopSubagents(chatId)
        return ok()
      case 'approval':
        runner.approve(
          String(p.requestId),
          p.decision === 'allow' ? 'allow' : 'deny',
          Array.isArray(p.items) ? (p.items as ApprovalItemDecision[]) : undefined
        )
        return ok()
      case 'smart_override':
        await runner.smartOverride(String(p.messageId))
        return ok()
      case 'question':
        if (p.cancel) await runner.cancelQuestion(String(p.requestId))
        else runner.answerQuestion(String(p.requestId), (p.answers ?? []) as QuestionAnswer[])
        return ok()
      case 'retry':
        if (p.action === 'cancel') runner.cancelRetry(String(p.requestId))
        else runner.retry(String(p.requestId))
        return ok()
      case 'branch.regenerate':
        await runner.regenerate(
          this.sessionInChat(p.sessionId, chatId),
          typeof p.messageId === 'string' && p.messageId ? p.messageId : undefined
        )
        return ok()
      case 'branch.edit':
        await runner.editBranch(String(p.messageId), p.message as ApiMessage)
        return ok()
      case 'branch.select':
        runner.selectBranch(String(p.messageId))
        return ok()
      case 'message.edit':
        runner.editMessage(String(p.messageId), p.message as ApiMessage)
        return ok()
      case 'message.delete':
        await runner.deleteMessage(String(p.messageId))
        return ok()
      case 'compact': {
        const opts = (p.opts ?? {}) as { retry?: boolean }
        const r = runner.compact(this.sessionInChat(p.sessionId, chatId), { retry: !!opts.retry })
        return { status: 'accepted', ...(r.scheduled ? { queued: true } : {}) }
      }
      case 'memory.extract': {
        const rec = await runner.extractMemory(this.sessionInChat(p.sessionId, chatId))
        if (rec.error) throw new HostError('extract', rec.error)
        return ok()
      }
    }
    throw new HostError('unsupported', `Ação desconhecida: ${kind}`)
  }

  // ---------------- espelho local (tela) ----------------

  private chatOfEvent(e: AgentEvent): string | null {
    const ofSession = (sid: string): string | null => this.d.repo.session(sid)?.chatId ?? null
    switch (e.type) {
      case 'session-created':
      case 'session-updated':
        return e.session.chatId
      case 'draft':
      case 'tool-running':
      case 'queue-updated':
      case 'compaction':
      case 'error':
        return ofSession(e.sessionId)
      case 'message-added':
        return ofSession(e.message.sessionId)
      case 'approval-requested':
      case 'question-requested':
      case 'retry-requested':
        this.reqChat.set(e.request.id, e.request.chatId)
        return e.request.chatId
      case 'approval-resolved':
      case 'question-resolved':
      case 'retry-resolved':
        return this.reqChat.get(e.id) ?? null
      default:
        return null
    }
  }

  /** Eventos do runner → o espelho local, no formato do stream do desktop (§11). */
  private onAgentEvent(e: AgentEvent): void {
    if (e.type === 'tool-running') {
      const runs = this.tools.get(e.sessionId) ?? new Map<string, ToolRun>()
      if (e.running)
        runs.set(e.toolCallId, { running: !e.judging, output: e.output, judging: e.judging })
      else runs.delete(e.toolCallId)
      this.tools.set(e.sessionId, runs)
    }
    const chatId = this.chatOfEvent(e)
    if (!chatId || chatId !== this.active || !this.mirror) return
    if (e.type === 'message-added') {
      if (e.message.message.role === 'assistant') this.mirror.onPersistedAssistant(e.message)
      return
    }
    if (e.type === 'draft') {
      this.pendingDraft.set(e.sessionId, e.draft)
      if (!e.draft) this.flushDrafts()
      else if (!this.draftTimer)
        this.draftTimer = setTimeout(() => this.flushDrafts(), this.t.draftMs)
      return
    }
    let payload: Record<string, unknown> | null = null
    switch (e.type) {
      case 'session-created':
      case 'session-updated':
        payload = { kind: 'session', session: e.session }
        break
      case 'tool-running':
        payload = {
          kind: 'tool',
          sessionId: e.sessionId,
          toolCallId: e.toolCallId,
          running: e.running,
          ...(e.output !== undefined ? { output: e.output.slice(-32_000) } : {}),
          ...(e.judging ? { judging: true } : {})
        }
        break
      case 'queue-updated':
        payload = { kind: 'queue', sessionId: e.sessionId, queue: e.queue }
        break
      case 'approval-requested':
        payload = { kind: 'approval.requested', request: e.request }
        break
      case 'approval-resolved':
        payload = { kind: 'approval.resolved', id: e.id }
        break
      case 'question-requested':
        payload = { kind: 'question.requested', request: e.request }
        break
      case 'question-resolved':
        payload = { kind: 'question.resolved', id: e.id }
        break
      case 'retry-requested':
        payload = { kind: 'retry.requested', request: e.request }
        break
      case 'retry-resolved':
        payload = { kind: 'retry.resolved', id: e.id }
        break
      case 'error':
        payload = { kind: 'error', sessionId: e.sessionId, error: e.error }
        break
      case 'compaction':
        payload = {
          kind: 'compaction',
          sessionId: e.sessionId,
          state: e.state,
          ...(e.text ? { text: e.text } : {})
        }
        break
    }
    if (payload) this.feed(payload)
  }

  private feed(payload: Record<string, unknown>): void {
    this.mirror?.onEvent(++this.mirrorN, payload)
  }

  private flushDrafts(): void {
    if (this.draftTimer) clearTimeout(this.draftTimer)
    this.draftTimer = null
    for (const [sid, d] of this.pendingDraft) {
      if (!d) {
        const had = this.drafts.get(sid)
        this.drafts.delete(sid)
        if (had) this.feed({ kind: 'draft.end', sessionId: sid, streamId: had.streamId })
        continue
      }
      const { delta, state } = diffDraft(sid, this.drafts.get(sid) ?? null, d)
      this.drafts.set(sid, state)
      if (delta) this.feed({ kind: 'draft.delta', ...delta })
    }
    this.pendingDraft.clear()
  }

  /** Estado completo do runner para o chat (formato do `snapshot` do desktop). */
  snapshotPayload(chatId: string): Record<string, unknown> {
    const runner = this.d.runner
    const sessions: Record<string, unknown> = {}
    const queues: Record<string, QueuedMessage[]> = {}
    for (const s of this.d.repo.sessions(chatId)) {
      const tools: Record<string, ToolRun> = {}
      for (const [id, r] of this.tools.get(s.id) ?? [])
        tools[id] = { ...r, output: r.output?.slice(-16_000) }
      const d = this.drafts.get(s.id)
      sessions[s.id] = {
        status: s.status,
        draft: d ? toStreamDraft(d) : null,
        tools,
        compaction: runner.compaction(s.id)
      }
      const q = runner.getQueue(s.id)
      if (q.length) queues[s.id] = q
    }
    return {
      kind: 'snapshot',
      sessions,
      queues,
      approvals: runner.approvals.list().filter((a) => a.chatId === chatId),
      questions: runner.questions.list().filter((q) => q.chatId === chatId),
      retries: runner.retries.list().filter((r) => r.chatId === chatId),
      processes: [],
      skills: []
    }
  }

  /** Chat aberto na tela: o espelho local acompanha o runner deste aparelho. */
  setActive(chatId: string | null): void {
    if (this.active === chatId) return
    this.mirror?.dispose()
    this.mirror = null
    this.active = chatId
    this.drafts.clear()
    this.pendingDraft.clear()
    if (chatId) {
      this.mirrorN = 0
      const m: LiveMirror = new LiveMirror(0, {
        resync: () => {
          if (this.mirror === m) m.onEvent(++this.mirrorN, this.snapshotPayload(chatId))
        },
        changed: () => {
          if (this.mirror === m) this.changed()
        }
      })
      this.mirror = m
      m.onEvent(++this.mirrorN, this.snapshotPayload(chatId))
    }
    this.changed()
  }

  view(chatId: string): MirrorView | null {
    return this.active === chatId && this.mirror ? this.mirror.view : null
  }
}

function blankState(chatId: string): ChatState {
  return {
    chat_id: chatId,
    ssq: 0,
    epoch: 0,
    head: 0,
    pinned: false,
    host: null,
    window: null,
    handover: null,
    diverged: null
  }
}
