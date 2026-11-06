// Histórico de um chat só ao vivo aberto no celular (SYNC_PROTOCOL.md §23.5–§23.6): vem do host sob
// demanda (`history.list`/`history.changes`/`history.item`) e é atualizado pelos `rec` do stream.
// Ordem ao abrir: (1) a inscrição no stream já foi confirmada — a partir daqui os `rec` ficam
// guardados; (2) `history.list` do chat, das sessões e das mensagens da sessão principal (todas as
// páginas; itens grandes/omitidos por `history.item`); (3) junta por item — o maior `lseq` vence,
// exclusões ficam guardadas com o lseq delas, e os `rec` guardados entram pela mesma regra; (4)
// `conhecido` = maior lseq visto: `rec` com lseq > conhecido + 1 ou `snapshot.live.lseq` > conhecido
// = mudanças perdidas → `history.changes { since }` (+ `history.item`); `reset` → recarrega; (5)
// epoch diferente num resultado → o dono recomeça do zero. Subsessões são carregadas quando abertas.
// SÓ EM MEMÓRIA: nada daqui vai para banco, arquivo, cache de imagens, índice de busca ou log.
// Puro: os comandos entram por `deps.command`.
import type { Session, StoredMessage } from '@shared/types'
import { fromB64u, fromUtf8 } from '@/crypto'
import { chatFromPlain, messageFromPlain, sessionFromPlain } from '@/data/decode'
import type { LoadedChat } from '@/data/store'
import { isSafeInt, LIVE, parseLiveItem, type LiveItem, type LiveItemType } from './types'

export type HistoryKind = 'history.list' | 'history.changes' | 'history.item'

export interface HistoryDeps {
  chatId: string
  epoch: number
  /** Comando ao host (resultado decifrado; `rejected` volta como está). Lança em falha de rede. */
  command: (kind: HistoryKind, payload: Record<string, unknown>) => Promise<Record<string, unknown>>
  /** O espelho mudou (a tela relê `loaded`). */
  changed: () => void
  /** Mensagem do assistente nova/alterada depois de carregado (troca o draft, §11). */
  onAssistant?: (m: StoredMessage) => void
  /** Um resultado veio com outro epoch: o dono descarta este histórico e recomeça (§23.5.5). */
  onEpoch?: (epoch: number) => void
  log?: (msg: string) => void
}

export type HistoryPhase = 'loading' | 'ready' | 'error'

interface Held {
  type: LiveItemType
  id: string
  lseq: number
  deleted: boolean
  data: Record<string, unknown> | null
}

export class HistoryError extends Error {
  readonly code: string | null
  constructor(message: string, code: string | null = null) {
    super(message)
    this.code = code
  }
}

/** Epoch do host mudou no meio (o dono recomeça). */
class EpochChanged extends Error {
  constructor(readonly epoch: number) {
    super('epoch mudou')
  }
}

const k = (type: string, id: string): string => `${type}\u0000${id}`

const cmpMsg = (a: StoredMessage, b: StoredMessage): number =>
  a.seq - b.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

export class LiveHistory {
  readonly chatId: string
  readonly epoch: number
  private readonly d: HistoryDeps
  private items = new Map<string, Held>()
  /** Maior lseq visto (resultados e `rec`). */
  private known = 0
  private phaseV: HistoryPhase = 'loading'
  private errorV: string | null = null
  /** `rec` guardados enquanto o histórico carrega. */
  private buffer: { lseq: number; items: LiveItem[] }[] | null = []
  private loadedSessions = new Set<string>()
  private loadingSessions = new Map<string, Promise<void>>()
  private catching: Promise<void> | null = null
  private catchAgain: number | null = null
  private disposed = false
  /** Muda a cada recarga: respostas antigas não aplicam nada. */
  private gen = 0
  private cached: LoadedChat | null | undefined = undefined
  private loadedCount = 0
  /** Itens grandes demais / que não vieram (não aparecem). */
  private unavailable = 0
  private version = 0

  constructor(deps: HistoryDeps) {
    this.d = deps
    this.chatId = deps.chatId
    this.epoch = deps.epoch
  }

  // ---------------- leitura ----------------

  get phase(): HistoryPhase {
    return this.phaseV
  }

  get error(): string | null {
    return this.errorV
  }

  get knownLseq(): number {
    return this.known
  }

  /** Mensagens já recebidas (progresso do "carregando…"). */
  get progress(): number {
    return this.loadedCount
  }

  getVersion = (): number => this.version

  sessionLoaded(sessionId: string): boolean {
    return this.loadedSessions.has(sessionId)
  }

  /** Item cru (testes). */
  item(type: LiveItemType, id: string): Held | null {
    return this.items.get(k(type, id)) ?? null
  }

  /** O chat no formato que a tela já entende (null = ainda sem o item `chat`). */
  get loaded(): LoadedChat | null {
    if (this.cached !== undefined) return this.cached
    const c = this.items.get(k('chat', this.chatId))
    if (!c?.data || c.deleted) {
      this.cached = null
      return null
    }
    const sessions: Session[] = []
    const messages = new Map<string, StoredMessage[]>()
    for (const it of this.items.values()) {
      if (it.deleted || !it.data) continue
      if (it.type === 'session') sessions.push(sessionFromPlain(it.id, it.data))
      else if (it.type === 'message') {
        const m = messageFromPlain(it.id, it.data)
        const list = messages.get(m.sessionId)
        if (list) list.push(m)
        else messages.set(m.sessionId, [m])
      }
    }
    sessions.sort((a, b) => a.depth - b.depth || a.createdAt - b.createdAt)
    for (const list of messages.values()) list.sort(cmpMsg)
    this.cached = {
      chat: { ...chatFromPlain(this.chatId, c.data), id: this.chatId },
      sessions,
      messages,
      broken: this.unavailable
    }
    return this.cached
  }

  private touch(): void {
    this.cached = undefined
    this.version++
    if (!this.disposed) this.d.changed()
  }

  // ---------------- ciclo de vida ----------------

  /** Passos 2–4 (a inscrição no stream já foi confirmada pelo dono). */
  async start(): Promise<void> {
    const gen = ++this.gen
    this.phaseV = 'loading'
    this.errorV = null
    this.buffer = this.buffer ?? []
    this.touch()
    try {
      await this.loadAll(gen)
      if (gen !== this.gen || this.disposed) return
      const held = this.buffer ?? []
      this.buffer = null
      this.phaseV = 'ready'
      for (const r of held) this.applyRec(r.lseq, r.items)
      this.touch()
    } catch (e) {
      if (gen !== this.gen || this.disposed) return
      if (e instanceof EpochChanged) {
        this.d.onEpoch?.(e.epoch)
        return
      }
      this.buffer = null
      this.phaseV = 'error'
      this.errorV = e instanceof Error && e.message ? e.message : 'Falha ao carregar o histórico.'
      this.touch()
    }
  }

  /** "Tentar de novo" depois de um erro (recarrega tudo). */
  retry(): Promise<void> {
    this.items.clear()
    this.known = 0
    this.loadedSessions.clear()
    this.loadedCount = 0
    this.unavailable = 0
    this.buffer = []
    return this.start()
  }

  dispose(): void {
    this.disposed = true
    this.gen++
    this.items.clear()
    this.buffer = null
    this.cached = null
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  // ---------------- stream ----------------

  /** Evento `rec` (§23.6). */
  onRec(lseq: number, rawItems: unknown[]): void {
    if (this.disposed || !isSafeInt(lseq, 1)) return
    const items = rawItems.map(parseLiveItem).filter((x): x is LiveItem => !!x)
    if (this.buffer) {
      this.buffer.push({ lseq, items })
      return
    }
    if (this.phaseV !== 'ready') return
    this.applyRec(lseq, items)
    this.touch()
  }

  /** `snapshot.live.lseq` (§23.6): maior que o conhecido = `rec` perdidos. */
  onSnapshotLseq(lseq: number): void {
    if (this.disposed || this.phaseV !== 'ready' || !isSafeInt(lseq)) return
    if (lseq > this.known) this.catchUp(this.known)
  }

  /** Voltou a ver o chat (reconexão / reabriu a tela): o que mudou desde o conhecido (§23.5.6). */
  resume(): void {
    if (this.disposed) return
    if (this.phaseV === 'error') {
      void this.retry()
      return
    }
    if (this.phaseV === 'ready') this.catchUp(this.known)
  }

  private applyRec(lseq: number, items: LiveItem[]): void {
    const before = this.known
    const fetch: LiveItem[] = []
    for (const it of items) {
      const fresh = this.put(it, true)
      if (fresh === 'fetch') fetch.push(it)
    }
    if (lseq > this.known) this.known = lseq
    if (fetch.length) void this.fetchItems(fetch, this.gen).catch((e) => this.fail(e))
    if (lseq > before + 1) this.catchUp(before)
  }

  // ---------------- junção (maior lseq vence) ----------------

  /**
   * Junta um item. 'fetch' = sem `data` (omitido/grande) e mais novo que o que temos: pedir por
   * `history.item`. `live` = veio depois de carregado (avisa mensagens do assistente).
   */
  private put(it: LiveItem, live: boolean): 'ok' | 'stale' | 'fetch' {
    const key = k(it.type, it.id)
    const cur = this.items.get(key)
    if (cur && cur.lseq > it.lseq) return 'stale'
    if (it.deleted) {
      if (cur && cur.lseq === it.lseq && cur.deleted) return 'stale'
      this.items.set(key, { type: it.type, id: it.id, lseq: it.lseq, deleted: true, data: null })
      return 'ok'
    }
    if (!it.data) {
      if (cur && cur.lseq === it.lseq && (cur.data || cur.deleted)) return 'stale'
      return 'fetch'
    }
    if (cur && cur.lseq === it.lseq && cur.data && !cur.deleted) return 'stale'
    if (it.type === 'message' && !cur?.data) this.loadedCount++
    this.items.set(key, { type: it.type, id: it.id, lseq: it.lseq, deleted: false, data: it.data })
    if (
      live &&
      it.type === 'message' &&
      (it.data.message as { role?: unknown } | undefined)?.role === 'assistant'
    )
      this.d.onAssistant?.(messageFromPlain(it.id, it.data))
    return 'ok'
  }

  // ---------------- carregamento ----------------

  private check(r: Record<string, unknown>, gen: number): void {
    if (gen !== this.gen || this.disposed) throw new HistoryError('cancelado')
    if (r.status === 'rejected') {
      const msg = typeof r.error === 'string' && r.error ? r.error : 'O host recusou o pedido.'
      const code = typeof r.code === 'string' ? r.code : null
      throw new HistoryError(
        code === 'not_live' ? 'Este chat não é mais só ao vivo no host.' : msg,
        code
      )
    }
    if (r.status !== 'accepted') throw new HistoryError('Resposta inválida do host.')
    if (isSafeInt(r.epoch, 1) && r.epoch !== this.epoch) throw new EpochChanged(r.epoch)
    if (isSafeInt(r.lseq) && r.lseq > this.known) this.known = r.lseq
  }

  private async cmd(
    kind: HistoryKind,
    payload: Record<string, unknown>,
    gen: number
  ): Promise<Record<string, unknown>> {
    const r = await this.d.command(kind, { chatId: this.chatId, ...payload })
    this.check(r, gen)
    return r
  }

  /** Todas as páginas de um `history.list`. Itens sem data voltam para `history.item`. */
  private async listAll(type: LiveItemType, gen: number, sessionId?: string): Promise<LiveItem[]> {
    const out: LiveItem[] = []
    let after: string | null = null
    for (let page = 0; page < 10_000; page++) {
      const r = await this.cmd(
        'history.list',
        { type, ...(sessionId ? { sessionId } : {}), after, limit: LIVE.historyPageMaxItems },
        gen
      )
      const items = (Array.isArray(r.items) ? r.items : [])
        .map(parseLiveItem)
        .filter((x): x is LiveItem => !!x)
      const fetch: LiveItem[] = []
      for (const it of items) if (this.put(it, false) === 'fetch') fetch.push(it)
      out.push(...items)
      if (fetch.length) await this.fetchItems(fetch, gen)
      this.touch()
      const next = typeof r.next === 'string' && r.next ? r.next : null
      if (!next || next === after) break
      after = next
    }
    return out
  }

  private async loadAll(gen: number): Promise<void> {
    await this.listAll('chat', gen)
    const chat = this.items.get(k('chat', this.chatId))
    if (!chat?.data || chat.deleted) throw new HistoryError('O host não tem mais este chat.')
    await this.listAll('session', gen)
    const main = this.mainSessionId()
    if (main) await this.loadSession(main, gen)
  }

  private mainSessionId(): string | null {
    const c = this.items.get(k('chat', this.chatId))?.data
    const id = typeof c?.mainSessionId === 'string' ? c.mainSessionId : ''
    if (id) return id
    for (const it of this.items.values())
      if (it.type === 'session' && it.data && !it.deleted && Number(it.data.depth ?? 0) === 0)
        return it.id
    return null
  }

  private async loadSession(sessionId: string, gen: number): Promise<void> {
    await this.listAll('message', gen, sessionId)
    this.loadedSessions.add(sessionId)
  }

  /** Subsessão (subagente) aberta na tela: carrega as mensagens dela (§23.5.2, sob demanda). */
  ensureSession(sessionId: string): Promise<void> {
    if (this.disposed || this.loadedSessions.has(sessionId)) return Promise.resolve()
    const cur = this.loadingSessions.get(sessionId)
    if (cur) return cur
    const gen = this.gen
    const p = this.loadSession(sessionId, gen)
      .catch((e) => this.fail(e))
      .finally(() => this.loadingSessions.delete(sessionId))
    this.loadingSessions.set(sessionId, p)
    return p
  }

  /** `history.item` por id (lotes ≤ 200; `omitted` volta a ser pedido) e pedaços dos grandes. */
  private async fetchItems(list: LiveItem[], gen: number): Promise<void> {
    const large = list.filter((x) => x.large)
    let want = list.filter((x) => !x.large).map((x) => ({ type: x.type, id: x.id }))
    for (let round = 0; want.length && round < 20; round++) {
      const batch = want.slice(0, LIVE.historyItemsMax)
      const r = await this.cmd('history.item', { items: batch }, gen)
      const got = (Array.isArray(r.items) ? r.items : [])
        .map(parseLiveItem)
        .filter((x): x is LiveItem => !!x)
      const again: { type: LiveItemType; id: string }[] = []
      const seen = new Set<string>()
      for (const it of got) {
        seen.add(k(it.type, it.id))
        if (it.omitted) again.push({ type: it.type, id: it.id })
        else if (it.large) large.push(it)
        else this.put(it, this.phaseV === 'ready')
      }
      // o host DEVE devolver `deleted` para o inexistente: o que não veio fica de fora
      this.unavailable += batch.filter((b) => !seen.has(k(b.type, b.id))).length
      const rest = want.slice(batch.length)
      // sem progresso (o host só devolve omitidos) → desiste desses
      if (again.length === batch.length) {
        this.unavailable += again.length
        want = rest
        continue
      }
      want = [...again, ...rest]
    }
    for (const it of large) await this.fetchPieces(it, gen)
    this.touch()
  }

  /** Item acima de LIVE_ITEM_INLINE_MAX_BYTES: pedaços em base64 do JSON de `data` (§23.5). */
  private async fetchPieces(it: LiveItem, gen: number): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const parts: Uint8Array[] = []
      let offset = 0
      let total = -1
      let lseq = -1
      let restart = false
      for (;;) {
        let r: Record<string, unknown>
        try {
          r = await this.cmd('history.item', { piece: { type: it.type, id: it.id, offset } }, gen)
        } catch (e) {
          if (e instanceof HistoryError && e.code === 'too_large') {
            this.unavailable++
            return
          }
          throw e
        }
        const p = r.piece as Record<string, unknown> | undefined
        if (
          !p ||
          p.id !== it.id ||
          !isSafeInt(p.total) ||
          !isSafeInt(p.offset) ||
          !isSafeInt(p.lseq) ||
          typeof p.data !== 'string' ||
          p.offset !== offset ||
          p.total > LIVE.historyItemMaxBytes
        )
          throw new HistoryError('Resposta inválida do host.')
        if (total < 0) {
          total = p.total
          lseq = p.lseq
        } else if (p.lseq !== lseq || p.total !== total) {
          restart = true
          break
        }
        const bytes = fromStdB64(p.data)
        if (!bytes.length && offset < total) throw new HistoryError('Resposta inválida do host.')
        parts.push(bytes)
        offset += bytes.length
        if (offset >= total) break
      }
      if (restart) continue
      const all = new Uint8Array(offset)
      let at = 0
      for (const b of parts) {
        all.set(b, at)
        at += b.length
      }
      let data: unknown
      try {
        data = JSON.parse(fromUtf8(all))
      } catch {
        throw new HistoryError('Resposta inválida do host.')
      }
      if (!data || typeof data !== 'object' || Array.isArray(data))
        throw new HistoryError('Resposta inválida do host.')
      this.put(
        { type: it.type, id: it.id, lseq, data: data as Record<string, unknown> },
        this.phaseV === 'ready'
      )
      return
    }
    this.unavailable++
  }

  // ---------------- mudanças perdidas (§23.5.4) ----------------

  /** `history.changes { since }` + `history.item` do que veio; `reset` → recarrega. */
  private catchUp(since: number): void {
    if (this.disposed) return
    if (this.catching) {
      this.catchAgain = this.catchAgain === null ? since : Math.min(this.catchAgain, since)
      return
    }
    const gen = this.gen
    this.catching = (async () => {
      const r = await this.cmd('history.changes', { since }, gen)
      if (r.reset === true) {
        await this.reload(gen)
        return
      }
      const list = Array.isArray(r.changes) ? r.changes : []
      const fetch: LiveItem[] = []
      for (const raw of list) {
        const c = raw as Record<string, unknown>
        const type = c.type
        if (type !== 'chat' && type !== 'session' && type !== 'message') continue
        if (typeof c.id !== 'string' || !isSafeInt(c.lseq)) continue
        const cur = this.items.get(k(type, c.id))
        if (cur && cur.lseq >= c.lseq) continue
        if (c.deleted === true) this.put({ type, id: c.id, lseq: c.lseq, deleted: true }, true)
        else {
          // mensagem de subsessão não carregada: fica para quando ela abrir
          fetch.push({ type, id: c.id, lseq: c.lseq, omitted: true })
        }
        if (c.lseq > this.known) this.known = c.lseq
      }
      if (fetch.length) await this.fetchItems(fetch, gen)
      this.touch()
    })()
      .catch((e) => this.fail(e))
      .finally(() => {
        this.catching = null
        const again = this.catchAgain
        this.catchAgain = null
        if (again !== null && gen === this.gen) this.catchUp(again)
      })
  }

  /** `reset`: recarrega a partir do passo 2, mantendo a inscrição. */
  private async reload(gen: number): Promise<void> {
    if (gen !== this.gen) return
    this.items.clear()
    this.loadedSessions.clear()
    this.loadedCount = 0
    this.known = 0
    this.buffer = []
    await this.start()
  }

  private fail(e: unknown): void {
    if (this.disposed) return
    if (e instanceof EpochChanged) {
      this.d.onEpoch?.(e.epoch)
      return
    }
    if (e instanceof HistoryError && e.message === 'cancelado') return
    this.d.log?.(`histórico ao vivo: ${(e as Error).message}`)
    if (this.phaseV === 'ready') {
      // o que já está na tela continua; a próxima mudança tenta de novo
      return
    }
    this.phaseV = 'error'
    this.errorV = e instanceof Error && e.message ? e.message : 'Falha ao carregar o histórico.'
    this.touch()
  }
}

/** base64 padrão (com `=`) → bytes. */
export function fromStdB64(s: string): Uint8Array {
  return fromB64u(s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''))
}
