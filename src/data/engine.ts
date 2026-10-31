// Motor do sync no celular (SYNC_PROTOCOL.md §7, §10.2–10.3): pull paginado pelo cursor, aplicação
// incremental dos `sync.changes` do WebSocket, resync completo (410), estados de host e o primitivo de
// escrita LWW (§7.4–7.5) com retentativa em conflito e "exclusão vence". Sem React Native: rede,
// chaves e banco entram por dependências (os testes usam um servidor falso e o node:sqlite).
import { SyncApiError, SyncNetworkError } from '@vendor/desktop/sync/http'
import { openRecord, sealRecord, type Subkeys, UnsupportedEnvelopeError } from '@/crypto'
import { UserError } from '@/account/errors'
import { RecordState, type LocalStore, type RecordStateCode } from './store'
import {
  type Change,
  type ChatState,
  isRecordType,
  type Plain,
  type PullPage,
  type PushBody,
  type PushConflict,
  type PushItem,
  type PushResult,
  type RecordsPage
} from './types'

export interface EngineHttp {
  get<T = unknown>(path: string): Promise<T>
  post<T = unknown>(path: string, json?: unknown): Promise<T>
  req<T = unknown>(
    method: string,
    path: string,
    o?: { json?: unknown; binary?: boolean; timeoutMs?: number }
  ): Promise<T>
}

export interface EngineKeys {
  userId: string
  sk: Subkeys
}

export interface EngineDeps {
  store: LocalStore
  http: EngineHttp
  /** Chaves abertas (null = bloqueado). */
  keys: () => EngineKeys | null
  /** Log de diagnóstico — nunca recebe conteúdo nem segredos. */
  log?: (msg: string) => void
  now?: () => number
  /** Cede a thread do JS (a UI respira entre lotes de decifragem). */
  yieldToUi?: () => Promise<void>
  uuid?: () => string
}

export type SyncPhase = 'locked' | 'idle' | 'syncing' | 'offline' | 'error'

export interface SyncStatus {
  phase: SyncPhase
  /** Ainda não terminou o primeiro pull nesta instalação. */
  initial: boolean
  /** Progresso do pull em andamento (0–1) quando dá para estimar. */
  progress: number | null
  lastSyncAt: number | null
  error: string | null
  /** WebSocket conectado (mudanças chegam ao vivo). */
  live: boolean
}

export type DataEvent =
  /** Registros mudaram: `chats` = chats tocados; `list` = a lista precisa recarregar. */
  | { kind: 'data'; chats: string[]; list: boolean; all?: boolean }
  | { kind: 'states'; chats: string[] }
  | { kind: 'status' }

const PAGE = 500
const RESYNC_PAGE = 1000
const FETCH_BATCH = 500
const YIELD_MS = 12

const key = (type: string, id: string): string => `${type}\u0000${id}`

export function conflictOf(e: unknown): PushConflict | null {
  if (!(e instanceof SyncApiError) || e.code !== 'conflict') return null
  const list = e.details.conflicts
  return Array.isArray(list) && list.length ? (list[0] as PushConflict) : null
}

const isNetwork = (e: unknown): boolean => e instanceof SyncNetworkError

export class SyncEngine {
  private readonly d: EngineDeps
  private listeners = new Set<(e: DataEvent) => void>()
  private chain: Promise<unknown> = Promise.resolve()
  private syncing: Promise<void> | null = null
  private again = false
  private running = false
  /** Muda a cada start/stop: trabalho em voo de uma rodada anterior não aplica nada. */
  private gen = 0
  private statesLoaded = false
  private status: SyncStatus

  constructor(deps: EngineDeps) {
    this.d = deps
    const last = Number(deps.store.getMeta('last_sync_at') ?? 0) || null
    this.status = {
      phase: 'locked',
      initial: !last,
      progress: null,
      lastSyncAt: last,
      error: null,
      live: false
    }
  }

  get store(): LocalStore {
    return this.d.store
  }

  // ---------------- observável ----------------

  subscribe(fn: (e: DataEvent) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(e: DataEvent): void {
    for (const fn of this.listeners) fn(e)
  }

  getStatus = (): SyncStatus => this.status

  private setStatus(p: Partial<SyncStatus>): void {
    const next = { ...this.status, ...p }
    if (
      next.phase === this.status.phase &&
      next.progress === this.status.progress &&
      next.error === this.status.error &&
      next.lastSyncAt === this.status.lastSyncAt &&
      next.live === this.status.live &&
      next.initial === this.status.initial
    )
      return
    this.status = next
    this.emit({ kind: 'status' })
  }

  private log(msg: string): void {
    this.d.log?.(msg)
  }

  private now(): number {
    return this.d.now?.() ?? Date.now()
  }

  private uuid(): string {
    return this.d.uuid?.() ?? crypto.randomUUID()
  }

  private async yieldUi(): Promise<void> {
    if (this.d.yieldToUi) await this.d.yieldToUi()
    else await new Promise<void>((r) => setTimeout(r, 0))
  }

  private keys(): EngineKeys {
    const k = this.d.keys()
    if (!k) throw new UserError('Desbloqueie a conta primeiro.')
    return k
  }

  /** Uma operação por vez sobre o banco (pull, mudanças ao vivo, aplicação local de um push). */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn)
    this.chain = run.catch(() => undefined)
    return run
  }

  // ---------------- ciclo de vida ----------------

  /** Cofre aberto: começa a sincronizar. */
  start(): void {
    if (this.running) return
    this.running = true
    this.gen++
    this.statesLoaded = false
    if (this.d.store.refreshDirtyChats().length) this.emit({ kind: 'data', chats: [], list: true })
    this.setStatus({ phase: 'idle', error: null })
    void this.sync()
  }

  /** Bloqueado/saiu: para (o que estiver em voo termina sem chaves e falha em silêncio). */
  stop(): void {
    if (this.running) this.gen++
    this.running = false
    this.again = false
    // `live` é da conexão (o WebSocket da conta segue ligado com o cofre bloqueado)
    this.setStatus({ phase: 'locked', progress: null })
  }

  get isRunning(): boolean {
    return this.running
  }

  /** Apaga o cache (logout, revogação, chaves redefinidas, outra conta). */
  async wipe(): Promise<void> {
    await this.exclusive(async () => this.d.store.wipe())
    this.setStatus({ initial: true, lastSyncAt: null, progress: null, error: null })
    this.emit({ kind: 'data', chats: [], list: true, all: true })
  }

  // ---------------- WebSocket (§10.2–10.3, §10.5) ----------------

  onConnection(online: boolean): void {
    this.setStatus({ live: online })
  }

  onWelcome(w: Record<string, unknown>): void {
    if (Array.isArray(w.chat_states)) {
      const states = w.chat_states as ChatState[]
      this.d.store.replaceChatStates(states)
      this.statesLoaded = true
      this.emit({ kind: 'states', chats: states.map((s) => s.chat_id) })
    }
    // o welcome traz o head: puxa do cursor até ele (mudanças perdidas com o socket fora)
    if (this.running) void this.sync()
  }

  onEvent(f: Record<string, unknown>): void {
    if (f.t === 'sync.changes') {
      void this.onLiveChanges((f.changes as Change[]) ?? [])
      return
    }
    if (f.t === 'chat.state') {
      const s = f as unknown as ChatState
      if (!s.chat_id) return
      this.d.store.upsertChatState(s)
      this.emit({ kind: 'states', chats: [s.chat_id] })
    }
  }

  /**
   * `sync.changes` (§10.5): se continua exatamente do cursor, aplica direto (sem outra ida ao
   * servidor); senão (buraco, pull em andamento) puxa pelo cursor — a fonte de verdade.
   */
  async onLiveChanges(changes: Change[]): Promise<void> {
    if (!this.running || !changes.length) return
    if (this.syncing) {
      this.again = true
      return
    }
    const list = [...changes].sort((a, b) => a.seq - b.seq)
    try {
      await this.exclusive(async () => {
        const cursor = this.d.store.cursor
        const fresh = list.filter((c) => c.seq > cursor)
        if (!fresh.length) return
        const contiguous = fresh.every((c, i) => c.seq === cursor + 1 + i)
        if (!contiguous) throw new Error('gap')
        await this.applyPage(fresh)
        this.d.store.setCursor(fresh[fresh.length - 1].seq)
      })
    } catch {
      void this.sync()
    }
  }

  // ---------------- pull (§7.3) ----------------

  /** Puxa até alcançar o servidor (serializado; chamadas durante um pull o repetem no fim). */
  sync(): Promise<void> {
    if (!this.running) return Promise.resolve()
    if (this.syncing) {
      this.again = true
      return this.syncing
    }
    this.syncing = (async () => {
      this.setStatus({ phase: 'syncing', error: null })
      try {
        do {
          this.again = false
          await this.exclusive(() => this.pullAll())
          if (!this.statesLoaded) await this.loadChatStates().catch(() => undefined)
        } while (this.again && this.running)
        if (!this.running) return
        const at = this.now()
        this.d.store.setMeta('last_sync_at', at)
        this.setStatus({ phase: 'idle', progress: null, lastSyncAt: at, initial: false })
      } catch (e) {
        if (!this.running) return
        if (isNetwork(e)) this.setStatus({ phase: 'offline', progress: null })
        else {
          this.log(`sync falhou: ${(e as Error).message}`)
          this.setStatus({ phase: 'error', progress: null, error: errText(e) })
        }
      }
    })().finally(() => {
      this.syncing = null
    })
    return this.syncing
  }

  private async pullAll(): Promise<void> {
    const start = this.d.store.cursor
    for (let guard = 0; guard < 1_000_000 && this.running; guard++) {
      const since = this.d.store.cursor
      let page: PullPage
      try {
        page = await this.d.http.get<PullPage>(
          `/api/v1/sync/changes?since=${since}&limit=${PAGE}&payload=1`
        )
      } catch (e) {
        if (e instanceof SyncApiError && e.code === 'cursor_expired') {
          await this.fullResync()
          return
        }
        throw e
      }
      if (!this.running) return
      await this.applyPage(page.changes ?? [])
      const next = Math.max(since, page.next ?? page.head ?? since)
      this.d.store.setCursor(next)
      if (page.has_more && page.head > start)
        this.setStatus({ progress: Math.min(0.99, (next - start) / (page.head - start)) })
      if (!page.has_more) break
    }
  }

  /** Resync completo (§7.9): estado atual paginado, apaga o que sumiu, cursor = head. */
  private async fullResync(): Promise<void> {
    this.log('cursor expirado: resync completo')
    const online = new Set<string>()
    let head = 0
    let after = 0
    for (let guard = 0; guard < 1_000_000 && this.running; guard++) {
      const r = await this.d.http.get<RecordsPage>(
        `/api/v1/records?after=${after}&limit=${RESYNC_PAGE}&payload=1`
      )
      const list = r.records ?? []
      if (!head) head = r.head ?? 0
      for (const c of list) online.add(key(c.type, c.id))
      await this.applyPage(list)
      if (!r.has_more || !list.length) break
      after = r.next ?? list[list.length - 1].seq
    }
    if (!this.running) return
    const gone: string[] = []
    this.d.store.sql.tx(() => {
      for (const l of this.d.store.liveRecords()) {
        if (online.has(key(l.type, l.id)) || l.type === 'setting') continue
        this.d.store.removeRecord(l.type, l.id, l.scope)
        if (l.type === 'chat') gone.push(l.id)
      }
    })
    this.d.store.refreshDirtyChats()
    this.d.store.setCursor(head)
    this.statesLoaded = false
    if (gone.length) this.emit({ kind: 'data', chats: gone, list: true })
  }

  async loadChatStates(): Promise<void> {
    const r = await this.d.http.get<{ chat_states: ChatState[] }>('/api/v1/chat-states?since=0')
    this.d.store.replaceChatStates(r.chat_states ?? [])
    this.statesLoaded = true
    this.emit({ kind: 'states', chats: (r.chat_states ?? []).map((s) => s.chat_id) })
  }

  /**
   * Payload dos registros `omitted` (§7.2) por `records/fetch`, repetindo os que voltarem omitidos
   * de novo. Revisão diferente = o registro mudou (a nova vem pelo cursor) → fica sem payload.
   */
  private async fillOmitted(changes: Change[]): Promise<void> {
    let need = changes.filter((c) => !c.deleted && (c.omitted || !c.env) && isRecordType(c.type))
    while (need.length) {
      const again: Change[] = []
      let filled = 0
      for (let i = 0; i < need.length; i += FETCH_BATCH) {
        const part = need.slice(i, i + FETCH_BATCH)
        const r = await this.d.http.post<{ records: Change[] }>('/api/v1/records/fetch', {
          items: part.map((c) => ({ type: c.type, id: c.id }))
        })
        const map = new Map((r.records ?? []).map((x) => [key(x.type, x.id), x]))
        for (const c of part) {
          const full = map.get(key(c.type, c.id))
          if (!full || full.rev !== c.rev || full.deleted) continue
          if (full.env && !full.omitted && (full.scope ?? null) === (c.scope ?? null)) {
            c.env = full.env
            delete c.omitted
            filled++
          } else again.push(c)
        }
      }
      if (!filled) {
        if (again.length) throw new Error('records/fetch sem progresso')
        return
      }
      need = again
    }
  }

  /** Decifra e aplica um lote (uma transação). Devolve os chats tocados. */
  private async applyPage(changes: Change[]): Promise<void> {
    if (!changes.length) return
    const { userId, sk } = this.keys()
    const gen = this.gen
    const list = [...changes].sort((a, b) => a.seq - b.seq)
    await this.fillOmitted(list)
    const store = this.d.store
    const opened = new Map<Change, { plain: Plain | null; state: RecordStateCode }>()
    let t0 = this.now()
    for (const c of list) {
      if (c.deleted || !isRecordType(c.type)) continue
      const local = store.recordMeta(c.type, c.id)
      if (local && (c.rev < local.rev || (c.rev === local.rev && !local.deleted))) continue
      if (!c.env) continue
      try {
        const plain = await openRecord(sk.record, userId, c, c.env)
        opened.set(c, { plain, state: RecordState.Ok })
      } catch (e) {
        const state =
          e instanceof UnsupportedEnvelopeError ? RecordState.Opaque : RecordState.Broken
        this.log(`registro não decifrado: ${c.type}/${c.id} rev ${c.rev}`)
        opened.set(c, { plain: null, state })
      }
      if (this.now() - t0 > YIELD_MS) {
        await this.yieldUi()
        t0 = this.now()
      }
    }
    if (!this.running || gen !== this.gen) throw new Error('sync parado')
    const chats = new Set<string>()
    let list_ = false
    store.sql.tx(() => {
      for (const c of list) {
        const touched = this.applyOne(c, opened.get(c))
        if (!touched) continue
        if (c.type === 'chat') {
          chats.add(c.id)
          list_ = true
        } else if ((c.type === 'message' || c.type === 'session') && c.scope) chats.add(c.scope)
        else if (c.type === 'preset') list_ = true
      }
      for (const id of store.refreshDirtyChats()) {
        chats.add(id)
        list_ = true
      }
    })
    if (chats.size || list_) this.emit({ kind: 'data', chats: [...chats], list: list_ })
  }

  /** Aplica uma mudança (dentro da transação). true = algo mudou no cache. */
  private applyOne(
    c: Change,
    opened: { plain: Plain | null; state: RecordStateCode } | undefined
  ): boolean {
    const store = this.d.store
    const local = store.recordMeta(c.type, c.id)
    if (local && c.rev < local.rev) {
      this.log(`revisão antiga ignorada: ${c.type}/${c.id} ${c.rev} < ${local.rev}`)
      return false
    }
    if (local && c.rev === local.rev && local.deleted === !!c.deleted) {
      store.bumpSeq(c.type, c.id, c.seq)
      return false
    }
    if (c.deleted) {
      store.deleteRecord(c)
      return true
    }
    if (!isRecordType(c.type)) {
      store.putRecord(c, null, RecordState.Opaque)
      return false
    }
    if (!opened) return false
    store.putRecord(c, opened.plain, opened.state)
    return true
  }

  // ---------------- escrita (§7.4–7.6) ----------------

  private async pushRaw(body: PushBody): Promise<PushResult> {
    try {
      return await this.d.http.post<PushResult>('/api/v1/sync/push', body)
    } catch (e) {
      // sem resposta: o lote pode ter sido aplicado — repete com o MESMO push_id (idempotente)
      if (!isNetwork(e)) throw e
      try {
        return await this.d.http.post<PushResult>('/api/v1/sync/push', body)
      } catch (e2) {
        if (isNetwork(e2))
          throw new UserError('Sem conexão com o servidor. Tente de novo quando estiver online.', {
            cause: e2
          })
        throw e2
      }
    }
  }

  private async decryptCurrent(c: Change): Promise<Plain> {
    const { userId, sk } = this.keys()
    const full = c.env ? c : { ...c, omitted: true as const }
    if (!full.env) await this.fillOmitted([full])
    if (!full.env) throw new Error('registro atual sem conteúdo')
    return openRecord(sk.record, userId, full, full.env)
  }

  /** Grava localmente o resultado de um push aceito (o cursor não anda: o eco vem pelo feed). */
  private async applyLocal(
    ref: { type: string; id: string; scope: string | null },
    r: { rev: number; seq: number },
    plain: Plain | null
  ): Promise<void> {
    await this.exclusive(async () => {
      const store = this.d.store
      const cur = store.recordMeta(ref.type, ref.id)
      if (cur && cur.rev >= r.rev) return
      store.sql.tx(() => {
        const base: Change = {
          ...ref,
          rev: r.rev,
          seq: r.seq,
          deleted: !plain,
          size: 0,
          blobs: plain ? store.recordBlobs(ref.type, ref.id) : [],
          device_id: '',
          updated_at: new Date(this.now()).toISOString()
        }
        if (plain) store.putRecord(base, plain, RecordState.Ok)
        else store.deleteRecord(base)
        store.refreshDirtyChats()
      })
    })
    const chatId = ref.type === 'chat' ? ref.id : ref.scope
    this.emit({ kind: 'data', chats: chatId ? [chatId] : [], list: true })
  }

  /**
   * Grava um registro LWW (§7.5). `mutate` recebe o plaintext atual (null = novo) e devolve o novo;
   * em `rev_mismatch` é chamado de novo sobre a versão do servidor — reaplica só o que ele muda
   * (os campos "sujos"), preservando campos desconhecidos. `gone` = apagado em outro lugar: a
   * exclusão vence (apaga aqui e avisa).
   */
  async saveLww(
    ref: { type: string; id: string; scope: string | null },
    mutate: (current: Plain | null) => Plain
  ): Promise<void> {
    const { userId, sk } = this.keys()
    const store = this.d.store
    const meta = store.recordMeta(ref.type, ref.id)
    if (meta?.deleted) throw new UserError('Este item foi apagado.')
    let baseRev = meta?.rev ?? 0
    let current = meta ? store.getPlain(ref.type, ref.id) : null
    const blobs = meta ? store.recordBlobs(ref.type, ref.id) : []
    for (let attempt = 0; attempt < 5; attempt++) {
      const plain = mutate(current)
      const rev = baseRev + 1
      const env = await sealRecord(sk.record, userId, { ...ref, rev }, plain)
      const item: PushItem = { ...ref, base_rev: baseRev, rev, deleted: false, env, blobs }
      let res: PushResult
      try {
        res = await this.pushRaw({ push_id: this.uuid(), items: [item] })
      } catch (e) {
        const c = conflictOf(e)
        if (!c) throw this.friendly(e)
        if (c.reason === 'gone' || c.current?.deleted) {
          const cur = c.current
          await this.applyLocal(ref, { rev: cur?.rev ?? baseRev, seq: cur?.seq ?? 0 }, null)
          throw new UserError('Este item foi apagado em outro dispositivo.', { cause: e })
        }
        if (c.reason !== 'rev_mismatch' || !c.current) throw this.friendly(e)
        if (c.current.type !== ref.type || c.current.id !== ref.id) throw this.friendly(e)
        current = await this.decryptCurrent(c.current)
        baseRev = c.current.rev
        continue
      }
      const r = res.results.find((x) => x.type === ref.type && x.id === ref.id) ?? res.results[0]
      await this.applyLocal(ref, r, plain)
      return
    }
    throw new UserError('O item mudou várias vezes seguidas em outro dispositivo. Tente de novo.')
  }

  /** Apaga (tombstone, §7.7). Já apagado = sucesso; edição concorrente não impede (exclusão vence). */
  async remove(ref: { type: string; id: string; scope: string | null }): Promise<void> {
    this.keys()
    const meta = this.d.store.recordMeta(ref.type, ref.id)
    if (!meta || meta.deleted) return
    let baseRev = meta.rev
    for (let attempt = 0; attempt < 5; attempt++) {
      const item: PushItem = {
        ...ref,
        base_rev: baseRev,
        rev: baseRev + 1,
        deleted: true,
        blobs: []
      }
      try {
        const res = await this.pushRaw({ push_id: this.uuid(), items: [item] })
        const r = res.results.find((x) => x.id === ref.id) ?? res.results[0]
        await this.applyLocal(ref, r, null)
        return
      } catch (e) {
        const c = conflictOf(e)
        if (!c) throw this.friendly(e)
        if (c.reason === 'gone' || c.current?.deleted) {
          await this.applyLocal(
            ref,
            { rev: c.current?.rev ?? baseRev + 1, seq: c.current?.seq ?? 0 },
            null
          )
          return
        }
        if (c.reason !== 'rev_mismatch' || !c.current) throw this.friendly(e)
        baseRev = c.current.rev
      }
    }
    throw new UserError('Não foi possível apagar. Tente de novo.')
  }

  private friendly(e: unknown): unknown {
    if (e instanceof SyncApiError) {
      if (e.code === 'chat_busy')
        return new UserError(
          'Este chat está rodando agora em outro dispositivo. Tente quando o turno terminar.',
          { cause: e }
        )
      if (e.code === 'quota_exceeded')
        return new UserError('A cota da conta foi atingida — nada foi enviado.', { cause: e })
    }
    return e
  }

  // ---------------- ações de chat ----------------

  async renameChat(chatId: string, title: string): Promise<void> {
    const t = title.trim().slice(0, 200)
    if (!t) throw new UserError('Dê um nome ao chat.')
    await this.saveLww({ type: 'chat', id: chatId, scope: chatId }, (cur) => {
      if (!cur) throw new UserError('Este chat não existe mais.')
      return { ...cur, title: t }
    })
  }

  deleteChat(chatId: string): Promise<void> {
    return this.remove({ type: 'chat', id: chatId, scope: chatId })
  }

  // ---------------- blobs (§6.8, §14) ----------------

  /** Ciphertext de um blob (CCB1). */
  fetchBlob(blobId: string): Promise<Uint8Array> {
    return this.d.http.req<Uint8Array>('GET', `/api/v1/blobs/${encodeURIComponent(blobId)}`, {
      binary: true,
      timeoutMs: 10 * 60_000
    })
  }
}

function errText(e: unknown): string {
  if (e instanceof UserError) return e.message
  if (e instanceof SyncApiError) return e.message
  return 'Falha ao sincronizar.'
}
