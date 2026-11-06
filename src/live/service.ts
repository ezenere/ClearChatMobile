// Chats só ao vivo no celular como VISUALIZADOR (SYNC_PROTOCOL.md §23, §23.10): a lista "Ao vivo em
// <host>" (live.list depois de cada welcome com `live_chats` nas caps + live.update/removed/host), o
// histórico em memória do chat aberto (history.* + rec, ./history.ts), os anexos (attach.put /
// attach.get, ./attach.ts) e o stream/comandos pelo RemoteController (roteados pelo vínculo ao vivo
// no servidor). NADA DAQUI É GRAVADO: sem banco, sem arquivo, sem cache de imagem, sem índice de
// busca, sem log de conteúdo. Tudo some quando o chat sai da lista, o epoch muda, a conta bloqueia
// ou sai. Sem React Native.
import type { Subkeys } from '@/crypto'
import type { RemoteController } from '@/remote/controller'
import type { Envelope } from '@/remote/crypto'
import {
  classifyUpload,
  downloadFromHost,
  MemoryAttachments,
  uploadToHost,
  type Downloaded,
  type UploadHandle
} from './attach'
import { openAnnounce } from './crypto'
import { LiveHistory, type HistoryKind } from './history'
import { LiveList, type LiveEntry, type LiveListEvent, type LiveListTimers } from './list'
import { isSafeInt, LIVE_CAP, LIVE } from './types'

export interface LiveWs {
  request(
    t: string,
    fields?: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<Record<string, unknown>>
}

export interface LiveServiceDeps {
  ws: LiveWs
  remote: RemoteController
  keys: () => { userId: string; sk: Subkeys } | null
  deviceId: () => string | null
  /** `features.liveChats` de `/api/info` (§6.2); null = não deu para saber. */
  fetchFeature?: () => Promise<boolean | null>
  /** Último suporte conhecido desta instância (só o booleano; nada de chat). */
  rememberSupport?: (v: boolean) => void
  recallSupport?: () => boolean | null
  timers?: LiveListTimers
  /** Quantos históricos fechados ficam em memória para voltar sem recarregar. */
  keepHistories?: number
  /** Arquivos temporários de visualização (PDF/áudio abertos no app do sistema) a apagar. */
  wipeTemp?: () => void
  log?: (msg: string) => void
}

export type LiveNotice =
  | { kind: 'removed'; chatId: string; reason: string; hostName: string; title: string }
  | { kind: 'restarted'; chatId: string }

export class LiveService {
  readonly list: LiveList
  private readonly d: LiveServiceDeps
  private histories = new Map<string, LiveHistory>()
  private opened: string | null = null
  private capsOk: boolean | null = null
  private featureOk: boolean | null = null
  private files = new MemoryAttachments()
  private fileInflight = new Map<string, Promise<Downloaded>>()
  private uploads = new Set<UploadHandle>()
  private listeners = new Set<() => void>()
  private noticeListeners = new Set<(n: LiveNotice) => void>()
  private version = 0
  /** Nomes dos hosts dos chats que saíram (avisos da tela). */
  private lastHostName = new Map<string, string>()
  private lastTitle = new Map<string, string>()
  private connected = false
  /** Só __DEV__ (clearchat://dev/live): trata o servidor como se devolvesse . */
  devForceCaps = false

  constructor(deps: LiveServiceDeps) {
    this.d = deps
    this.featureOk = deps.recallSupport?.() ?? null
    this.list = new LiveList({
      open: (w) => this.openAnnounce(w.host.device_id, w.chat_id, w.epoch, w.arev, w.env),
      deviceId: deps.deviceId,
      timers: deps.timers,
      log: deps.log
    })
    this.list.on((e) => this.onListEvent(e))
  }

  private log(msg: string): void {
    this.d.log?.(msg)
  }

  // ---------------- observável ----------------

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  onNotice(fn: (n: LiveNotice) => void): () => void {
    this.noticeListeners.add(fn)
    return () => this.noticeListeners.delete(fn)
  }

  getVersion = (): number => this.version

  private changed(): void {
    this.version++
    for (const fn of this.listeners) fn()
  }

  private notice(n: LiveNotice): void {
    for (const fn of this.noticeListeners) fn(n)
  }

  // ---------------- suporte (§23.2) ----------------

  /**
   * A instância suporta chats ao vivo? `features.liveChats` **e** `live_chats` no `welcome.caps`.
   * null = ainda não deu para saber (offline desde a abertura): vale o último conhecido.
   */
  get supported(): boolean | null {
    if (this.capsOk === false || this.featureOk === false) return false
    if (this.capsOk && this.featureOk) return true
    return this.capsOk === null && this.featureOk ? true : null
  }

  private setFeature(v: boolean | null): void {
    if (v === null || v === this.featureOk) return
    this.featureOk = v
    this.d.rememberSupport?.(v && this.capsOk !== false)
    this.changed()
  }

  /** Hook do RemoteController (host/status dos chats ao vivo e o stream deles). */
  readonly hook = {
    entry: (chatId: string): { hostName: string; online: boolean } | null => {
      const e = this.list.get(chatId)
      if (!e) return null
      return { hostName: e.host.name, online: e.host.status === 'online' && !e.stale }
    },
    onStream: (chatId: string, epoch: number, p: Record<string, unknown>): void =>
      this.onStream(chatId, epoch, p)
  }

  // ---------------- WebSocket ----------------

  onConnection(online: boolean): void {
    if (this.connected === online) return
    this.connected = online
    if (!online) this.list.onDisconnected()
    this.changed()
  }

  onWelcome(w: Record<string, unknown>): void {
    this.connected = true
    const caps = Array.isArray(w.caps) ? (w.caps as unknown[]).map(String) : []
    if (this.devForceCaps) caps.push(LIVE_CAP)
    this.capsOk = caps.includes(LIVE_CAP)
    if (this.d.fetchFeature)
      void this.d
        .fetchFeature()
        .then((v) => this.setFeature(v))
        .catch(() => undefined)
    if (!this.capsOk) {
      // servidor < 1.8.0: nenhum chat ao vivo (e nunca live.*)
      this.list.clear('unsupported')
      this.d.rememberSupport?.(false)
      this.changed()
      return
    }
    if (this.featureOk) this.d.rememberSupport?.(true)
    this.relist()
    this.changed()
  }

  /**
   * Pede a lista de novo (`live.list` substitui tudo). Também ao abrir o cofre: o WebSocket conecta
   * com a conta ainda bloqueada e os anúncios não decifram sem a DEK.
   */
  relist(): void {
    if (!this.capsOk || !this.connected || !this.d.keys()) return
    this.list.beginListing()
    void this.d.ws
      .request('live.list', {})
      .then((ack) => this.list.applyList(ack))
      .catch((e: unknown) => {
        this.log(`live.list falhou: ${(e as Error).message}`)
        // sem a lista desta conexão: não aplica eventos soltos por cima de nada
        void this.list.applyList({ chats: [], settling_s: 0 })
      })
  }

  onEvent(f: Record<string, unknown>): void {
    const t = typeof f.t === 'string' ? f.t : ''
    if (t === 'live.update' || t === 'live.removed' || t === 'live.host') this.list.onEvent(f)
    // live.refresh_request: só para hosts (o celular não anuncia, §23.10)
  }

  private async openAnnounce(
    hostId: string,
    chatId: string,
    epoch: number,
    arev: number,
    env: unknown
  ): Promise<Record<string, unknown>> {
    const keys = this.d.keys()
    if (!keys) throw new Error('bloqueado')
    return openAnnounce(keys.sk.stream, keys.userId, hostId, chatId, epoch, arev, env as Envelope)
  }

  private onListEvent(e: LiveListEvent): void {
    switch (e.kind) {
      case 'changed':
        for (const en of this.list.all()) {
          this.lastHostName.set(en.chatId, en.host.name)
          this.lastTitle.set(en.chatId, en.info.title)
        }
        // o chat aberto voltou à lista depois de sair (host reabriu o app): carrega de novo
        if (this.opened && this.list.has(this.opened) && !this.history(this.opened))
          void this.ensureStarted(this.opened)
        this.changed()
        return
      case 'removed':
        for (const id of e.chatIds) {
          this.forget(id)
          this.notice({
            kind: 'removed',
            chatId: id,
            reason: e.reason,
            hostName: this.lastHostName.get(id) ?? 'o host',
            title: this.lastTitle.get(id) ?? ''
          })
        }
        this.changed()
        return
      case 'epoch': {
        const open = this.opened === e.chatId
        this.forget(e.chatId)
        if (open) {
          this.notice({ kind: 'restarted', chatId: e.chatId })
          void this.ensureStarted(e.chatId)
        }
        this.changed()
        return
      }
      case 'back':
        if (this.opened === e.chatId) {
          this.d.remote.resync(e.chatId, true)
          this.histories.get(e.chatId)?.resume()
        }
        return
      case 'running':
        if (!e.running) this.d.remote.endLiveTurn(e.chatId)
        return
    }
  }

  // ---------------- chat aberto ----------------

  entry(chatId: string): LiveEntry | null {
    return this.list.get(chatId)
  }

  history(chatId: string): LiveHistory | null {
    const h = this.histories.get(chatId)
    return h && !h.isDisposed ? h : null
  }

  /** A tela abriu o chat ao vivo: inscrição no stream + histórico (§23.5). */
  open(chatId: string): void {
    this.opened = chatId
    this.d.remote.setActive(chatId)
    const h = this.history(chatId)
    if (h) {
      // voltou à tela: o que mudou desde o conhecido (os `rec` não chegaram com ela fechada)
      void this.d.remote
        .resubscribe(chatId)
        .then(() => h.resume())
        .catch(() => undefined)
    } else void this.ensureStarted(chatId)
    this.changed()
  }

  /** A tela fechou: sai do stream; o espelho fica (em memória) para voltar sem recarregar. */
  close(chatId: string): void {
    if (this.opened !== chatId) return
    this.opened = null
    if (this.d.remote.activeChat === chatId) this.d.remote.setActive(null)
    this.trimHistories()
    this.d.wipeTemp?.()
    this.changed()
  }

  get openChat(): string | null {
    return this.opened
  }

  private trimHistories(): void {
    const keep = this.d.keepHistories ?? 3
    const ids = [...this.histories.keys()].filter((id) => id !== this.opened)
    while (ids.length > keep) {
      const id = ids.shift()!
      this.histories.get(id)?.dispose()
      this.histories.delete(id)
    }
  }

  /** Cria (se preciso) e carrega o histórico do chat aberto. */
  async ensureStarted(chatId: string): Promise<void> {
    const e = this.list.get(chatId)
    if (!e) return
    let h = this.history(chatId)
    if (h && h.epoch !== e.epoch) {
      this.forget(chatId)
      h = null
    }
    if (h) return
    const hist: LiveHistory = new LiveHistory({
      chatId,
      epoch: e.epoch,
      command: (kind, payload) => this.command(chatId, kind, payload),
      changed: () => {
        if (this.histories.get(chatId) === hist) this.changed()
      },
      onAssistant: (m) => this.d.remote.onLiveAssistant(chatId, m),
      onEpoch: () => {
        if (this.histories.get(chatId) !== hist) return
        // o anúncio novo (com o epoch) chega pela lista; pede para garantir
        this.forget(chatId)
        void this.d.ws
          .request('live.refresh', { host_device_id: e.host.device_id })
          .catch(() => undefined)
      },
      log: this.d.log
    })
    this.histories.set(chatId, hist)
    this.changed()
    try {
      // §23.5.1: inscrição confirmada antes de pedir o histórico (os `rec` daqui em diante ficam)
      if (this.opened === chatId) await this.d.remote.resubscribe(chatId)
    } catch {
      /* sem conexão: o start falha com o texto certo */
    }
    if (hist.isDisposed) return
    await hist.start()
  }

  private command(
    chatId: string,
    kind: HistoryKind | 'attach.put' | 'attach.get',
    payload: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return this.d.remote.liveCommand(chatId, kind, payload)
  }

  private onStream(chatId: string, epoch: number, p: Record<string, unknown>): void {
    const h = this.history(chatId)
    if (!h) return
    if (epoch !== h.epoch) {
      if (epoch > h.epoch) void this.d.ws.request('live.refresh', {}).catch(() => undefined)
      return
    }
    if (p.kind === 'rec') h.onRec(Number(p.lseq), Array.isArray(p.items) ? p.items : [])
    else if (p.kind === 'snapshot') {
      const live = p.live as { lseq?: unknown } | undefined
      if (live && isSafeInt(live.lseq)) h.onSnapshotLseq(live.lseq)
    }
  }

  /** Subsessão aberta (subagente): carrega sob demanda. */
  ensureSession(chatId: string, sessionId: string): void {
    void this.history(chatId)?.ensureSession(sessionId)
  }

  /** "Tentar de novo" na tela. */
  retry(chatId: string): void {
    const h = this.history(chatId)
    if (h) void h.retry()
    else void this.ensureStarted(chatId)
  }

  /** Esquece tudo do chat (histórico, anexos). */
  private forget(chatId: string): void {
    this.histories.get(chatId)?.dispose()
    this.histories.delete(chatId)
    this.d.remote.dropLive(chatId)
    this.files.deletePrefix(`${chatId}:`)
    if (this.opened === chatId) this.d.wipeTemp?.()
  }

  // ---------------- anexos (§23.7) ----------------

  /** Anexo já em memória (null = baixar). */
  cachedFile(chatId: string, file: string): Downloaded | null {
    return this.files.get(`${chatId}:${file}`)
  }

  /** Baixa (ou devolve da memória) um anexo do host para exibir. */
  file(chatId: string, file: string): Promise<Downloaded> {
    const key = `${chatId}:${file}`
    const have = this.files.get(key)
    if (have) return Promise.resolve(have)
    const cur = this.fileInflight.get(key)
    if (cur) return cur
    const p = downloadFromHost((kind, payload) => this.command(chatId, kind, payload), chatId, file)
      .then((d) => {
        if (!this.list.has(chatId)) return d
        this.files.put({ ...d, file: key })
        return d
      })
      .finally(() => this.fileInflight.delete(key))
    this.fileInflight.set(key, p)
    return p
  }

  /** Solta da memória um anexo que saiu da tela. */
  releaseFile(chatId: string, file: string): void {
    const key = `${chatId}:${file}`
    this.files.delete(key)
  }

  /**
   * Anexo do composer → host (`attach.put`). A miniatura fica na memória (nada em disco). O
   * resultado é o `AttachmentInfo` que o `send` leva.
   */
  async upload(
    chatId: string,
    data: Uint8Array,
    name: string,
    mime: string | undefined,
    onProgress?: (sent: number, total: number) => void
  ): Promise<{ handle: UploadHandle; file: string; kind: string; size: number; name: string }> {
    const c = await classifyUpload(data, name, mime)
    const key = `${chatId}:${c.file}`
    if (c.kind === 'image') {
      this.files.put({ file: key, mime: c.mime, bytes: data.slice() })
    }
    const handle = uploadToHost(
      (kind, payload) => this.command(chatId, kind, payload),
      { chatId, data, name: c.name, mime: c.mime },
      c,
      { onProgress }
    )
    this.uploads.add(handle)
    void handle.done.finally(() => this.uploads.delete(handle)).catch(() => undefined)
    return { handle, file: c.file, kind: c.kind, size: c.size, name: c.name }
  }

  /** Limites do composer (§17.1: 10 arquivos, 50 MiB por mensagem). */
  static checkLimits(list: { size: number }[]): string | null {
    if (list.length > LIVE.attachMaxFiles)
      return `No máximo ${LIVE.attachMaxFiles} anexos por mensagem.`
    const total = list.reduce((n, a) => n + a.size, 0)
    if (total > LIVE.attachMaxMessageBytes)
      return `Os anexos somam mais de ${Math.round(LIVE.attachMaxMessageBytes / 1048576)} MB.`
    return null
  }

  // ---------------- conta ----------------

  /** Bloqueou / saiu / outra conta: descarta tudo (§23.5 "só em memória"). */
  wipe(): void {
    for (const u of this.uploads) u.cancel()
    this.uploads.clear()
    for (const h of this.histories.values()) h.dispose()
    this.histories.clear()
    this.files.clear()
    this.fileInflight.clear()
    this.lastHostName.clear()
    this.lastTitle.clear()
    this.list.clear('quit')
    this.capsOk = null
    this.connected = false
    if (this.opened) this.d.remote.dropLive(this.opened)
    this.d.wipeTemp?.()
    this.changed()
  }

  /** Para testes/diagnóstico: quanto está em memória (sem conteúdo). */
  stats(): { chats: number; histories: number; files: number; fileBytes: number } {
    return {
      chats: this.list.size,
      histories: this.histories.size,
      files: this.files.size,
      fileBytes: this.files.totalBytes
    }
  }
}
