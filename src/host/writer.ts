// Escrita do conteúdo dos chats que o celular hospeda (SYNC_PROTOCOL.md §7.4, §8.4, §8.5): cada
// revisão é gravada no cache na hora (a tela vê) e entra numa outbox persistida no SQLite; a outbox
// sobe em lotes (~250 ms) — o registro `chat` (LWW, com os campos mudados aqui reaplicados num
// conflito) antes, e o conteúdo (`session`/`message`) com `chat_bases[X]` = o head que o aparelho
// tem e `host_epochs[X]` = epoch da janela aberta (sem janela = replay, §8.4 B). Sem React Native.
import { SyncApiError, SyncNetworkError } from '@vendor/desktop/sync/http'
import { blobIdFromSha256, fromHex, openRecord, sealRecord, type Subkeys } from '@/crypto'
import type { LocalStore, OutboxRow } from '@/data/store'
import type { Change, Plain, PushBody, PushConflict, PushItem, PushResult } from '@/data/types'

export interface WriterDeps {
  store: LocalStore
  http: { post<T = unknown>(path: string, json?: unknown): Promise<T> }
  keys: () => { userId: string; sk: Subkeys } | null
  /**
   * Modo do próximo lote de conteúdo do chat: `{ epoch }` = janela aberta por este aparelho,
   * `{ epoch: null }` = replay, `null` = esperar (janela de outro / divergente / sem conexão).
   */
  pushMode: (chatId: string) => Promise<{ epoch: number | null } | null>
  /** Cache mudou (a tela recarrega). */
  notify: (chats: string[]) => void
  /** Recusa do servidor que o host precisa saber (`not_host`, `chat_diverged`, `gone`, …). */
  onPushError?: (chatId: string, code: string) => void
  /**
   * Garante no servidor os blobs citados (§14: upload ANTES do push do registro) — anexos e imagens
   * do questionário criados neste aparelho; os que vieram de outro dispositivo já estão lá.
   */
  ensureBlobs?: (files: string[]) => Promise<void>
  /** `stale_base`: puxar antes de tentar de novo. */
  pull?: () => Promise<void>
  log?: (msg: string) => void
  debounceMs?: number
  retryMs?: number
  uuid?: () => string
}

const MAX_ITEMS = 100
const MAX_BYTES = 3 * 1024 * 1024
const REF_RE = /clearchat-attachment:\/\/([0-9a-f]{64}(?:\.[a-z0-9]{1,10})?)/g

/** Registro `chat` do servidor + os campos mudados aqui (a `config` mescla por chave). */
export function mergeChat(server: Plain, patch: Plain | null): Plain {
  if (!patch) return server
  const out: Plain = { ...server, ...patch }
  const sc = server.config
  const pc = patch.config
  if (pc && typeof pc === 'object')
    out.config = { ...(sc && typeof sc === 'object' ? sc : {}), ...(pc as Plain) }
  return out
}

const isNetwork = (e: unknown): boolean => e instanceof SyncNetworkError

const contentOrder = (a: OutboxRow, b: OutboxRow): number => {
  const rank = (r: OutboxRow): number =>
    r.deleted ? (r.type === 'message' ? 2 : 3) : r.type === 'session' ? 0 : 1
  const ra = rank(a)
  const rb = rank(b)
  if (ra !== rb) return ra - rb
  if (a.type === 'session')
    return Number(a.plain?.depth ?? 0) - Number(b.plain?.depth ?? 0) || a.id.localeCompare(b.id)
  return Number(a.plain?.seq ?? 0) - Number(b.plain?.seq ?? 0) || a.id.localeCompare(b.id)
}

export class ContentWriter {
  private readonly d: WriterDeps
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private flushing = new Map<string, Promise<boolean>>()
  private again = new Set<string>()
  private waiters = new Map<string, (() => void)[]>()
  private stopped = false
  private failures = new Map<string, number>()
  /** sha256 cujos blobs já foram conferidos no servidor. */
  private blobsOk = new Set<string>()

  constructor(deps: WriterDeps) {
    this.d = deps
  }

  private uuid(): string {
    return this.d.uuid?.() ?? crypto.randomUUID()
  }

  private log(msg: string): void {
    this.d.log?.(msg)
  }

  // ---------------- escrita ----------------

  /** Revisões de conteúdo (`plain` null = apagar). */
  write(chatId: string, items: { type: 'session' | 'message'; id: string; plain: Plain | null }[]) {
    for (const it of items)
      this.d.store.writeLocal({ type: it.type, id: it.id, scope: chatId, chatId, plain: it.plain })
    this.d.notify([chatId])
    this.schedule(chatId)
  }

  /** Registro `chat`: `full` cria (ou substitui) inteiro; senão mescla `patch` no atual. */
  writeChat(chatId: string, patch: Plain, full?: Plain): void {
    const cur = this.d.store.getPlain('chat', chatId)
    const plain = full ?? mergeChat(cur ?? { sv: 1 }, patch)
    this.d.store.writeLocal({
      type: 'chat',
      id: chatId,
      scope: chatId,
      chatId,
      plain,
      patch: full ?? patch
    })
    this.d.notify([chatId])
    this.schedule(chatId)
  }

  pending(chatId: string): boolean {
    return this.d.store.hasOutbox(chatId) || this.flushing.has(chatId)
  }

  /** Conteúdo (sessão/mensagem) ainda não aceito — o host só fecha a janela sem ele (§8.3). */
  pendingContent(chatId: string): boolean {
    return this.d.store.hasOutbox(chatId, ['session', 'message']) || this.flushing.has(chatId)
  }

  /**
   * Envia já, sem temporizadores (no segundo plano o Android pausa os timers do JS): até `tries`
   * ciclos seguidos. true = outbox vazia.
   */
  async flushNow(chatId: string, tries = 3): Promise<boolean> {
    for (let i = 0; i < tries; i++) {
      const t = this.timers.get(chatId)
      if (t) {
        clearTimeout(t)
        this.timers.delete(chatId)
      }
      const cur = this.flushing.get(chatId)
      if (cur) await cur
      if (await this.flush(chatId)) return true
    }
    return !this.pending(chatId)
  }

  /** Resolve quando a outbox do chat esvaziar. */
  whenIdle(chatId: string): Promise<void> {
    if (!this.pending(chatId)) return Promise.resolve()
    return new Promise((resolve) => {
      const list = this.waiters.get(chatId) ?? []
      list.push(resolve)
      this.waiters.set(chatId, list)
      this.schedule(chatId, 0)
    })
  }

  schedule(chatId: string, delay = this.d.debounceMs ?? 250): void {
    if (this.stopped) return
    if (this.flushing.has(chatId)) {
      this.again.add(chatId)
      return
    }
    const cur = this.timers.get(chatId)
    if (cur) {
      if (delay > 0) return
      clearTimeout(cur)
    }
    this.timers.set(
      chatId,
      setTimeout(() => {
        this.timers.delete(chatId)
        void this.flush(chatId)
      }, delay)
    )
  }

  /** Retoma a outbox persistida (início / reconexão). */
  resume(): void {
    this.stopped = false
    for (const id of this.d.store.outboxChats()) this.schedule(id, 0)
  }

  stop(): void {
    this.stopped = true
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
  }

  private settle(chatId: string): void {
    if (this.pending(chatId)) return
    const list = this.waiters.get(chatId)
    this.waiters.delete(chatId)
    for (const fn of list ?? []) fn()
  }

  // ---------------- envio ----------------

  /** Um envio por vez por chat. true = outbox vazia ao fim. */
  flush(chatId: string): Promise<boolean> {
    const cur = this.flushing.get(chatId)
    if (cur) {
      this.again.add(chatId)
      return cur
    }
    const p = this.doFlush(chatId)
      .catch((e: unknown) => {
        const n = (this.failures.get(chatId) ?? 0) + 1
        this.failures.set(chatId, n)
        if (!isNetwork(e)) this.log(`push do chat falhou: ${(e as Error).message}`)
        this.retryLater(chatId, Math.min(30_000, (this.d.retryMs ?? 1500) * 2 ** (n - 1)))
        return false
      })
      .finally(() => {
        this.flushing.delete(chatId)
        if (this.again.delete(chatId)) this.schedule(chatId, 0)
        this.settle(chatId)
      })
    this.flushing.set(chatId, p)
    return p
  }

  private retryLater(chatId: string, ms = this.d.retryMs ?? 1500): void {
    if (this.stopped) return
    const cur = this.timers.get(chatId)
    if (cur) clearTimeout(cur)
    this.timers.set(
      chatId,
      setTimeout(() => {
        this.timers.delete(chatId)
        void this.flush(chatId)
      }, ms)
    )
  }

  private async post(body: PushBody): Promise<PushResult> {
    try {
      return await this.d.http.post<PushResult>('/api/v1/sync/push', body)
    } catch (e) {
      // sem resposta: o lote pode ter sido aplicado — repete com o MESMO push_id (idempotente)
      if (!isNetwork(e)) throw e
      return await this.d.http.post<PushResult>('/api/v1/sync/push', body)
    }
  }

  /** Ids de blob citados por um plaintext (§14). */
  async blobsFor(plain: Plain): Promise<string[]> {
    const keys = this.d.keys()
    return keys ? this.blobsOf(keys.sk, plain) : []
  }

  private async blobsOf(sk: Subkeys, plain: Plain | null): Promise<string[]> {
    if (!plain) return []
    const shas = new Set<string>()
    for (const m of JSON.stringify(plain).matchAll(REF_RE)) shas.add(m[1].slice(0, 64))
    const out: string[] = []
    for (const s of shas) out.push(await blobIdFromSha256(sk, fromHex(s)))
    return out.sort()
  }

  private async item(
    keys: { userId: string; sk: Subkeys },
    r: OutboxRow
  ): Promise<{ item: PushItem; blobs: string[] }> {
    const rev = r.baseRev + 1
    const blobs = r.deleted ? [] : await this.blobsOf(keys.sk, r.plain)
    const item: PushItem = {
      type: r.type,
      id: r.id,
      scope: r.scope,
      base_rev: r.baseRev,
      rev,
      deleted: r.deleted,
      blobs
    }
    if (!r.deleted && r.plain)
      item.env = await sealRecord(
        keys.sk.record,
        keys.userId,
        { type: r.type, id: r.id, scope: r.scope, rev },
        r.plain
      )
    return { item, blobs }
  }

  private async doFlush(chatId: string): Promise<boolean> {
    const keys = this.d.keys()
    if (!keys) return false
    const store = this.d.store
    // 1. registro `chat` (LWW) — o conteúdo precisa do chat no servidor
    for (let attempt = 0; attempt < 5; attempt++) {
      const row = store.outbox(chatId).find((r) => r.type === 'chat')
      if (!row) break
      const { item, blobs } = await this.item(keys, row)
      try {
        const res = await this.post({ push_id: this.uuid(), items: [item] })
        const r = res.results.find((x) => x.type === 'chat' && x.id === chatId) ?? res.results[0]
        store.commitOutbox([
          { type: 'chat', id: chatId, mark: row.mark, rev: item.rev, seq: r?.seq ?? 0, blobs }
        ])
        this.d.notify([chatId])
        break
      } catch (e) {
        const c = conflictOf(e)
        if (!c) throw e
        if (c.reason === 'gone' || c.current?.deleted) {
          store.dropOutbox(chatId)
          this.d.onPushError?.(chatId, 'gone')
          return true
        }
        if (c.reason !== 'rev_mismatch' || !c.current) throw e
        const server = await this.decrypt(keys, c.current)
        store.rebaseOutbox('chat', chatId, c.current.rev, mergeChat(server, row.patch))
      }
    }
    // 2. conteúdo
    const rows = store.outbox(chatId).filter((r) => r.type === 'session' || r.type === 'message')
    if (!rows.length) {
      this.failures.delete(chatId)
      return !store.hasOutbox(chatId)
    }
    const chatMeta = store.recordMeta('chat', chatId)
    if (!chatMeta || chatMeta.seq === 0) {
      // chat ainda não aceito pelo servidor (vai no próximo ciclo)
      this.retryLater(chatId)
      return false
    }
    const mode = await this.d.pushMode(chatId)
    if (!mode) {
      this.retryLater(chatId)
      return false
    }
    rows.sort(contentOrder)
    if (this.d.ensureBlobs) {
      const files = new Set<string>()
      for (const r of rows)
        if (!r.deleted && r.plain)
          for (const m of JSON.stringify(r.plain).matchAll(REF_RE))
            if (!this.blobsOk.has(m[1])) files.add(m[1])
      if (files.size) {
        await this.d.ensureBlobs([...files])
        for (const f of files) this.blobsOk.add(f)
      }
    }
    const built: { row: OutboxRow; item: PushItem; blobs: string[] }[] = []
    for (const row of rows) built.push({ row, ...(await this.item(keys, row)) })
    const chunks: (typeof built)[] = []
    let cur: typeof built = []
    let size = 0
    for (const b of built) {
      const bytes = (b.item.env?.c.length ?? 0) + 200
      if (cur.length && (cur.length >= MAX_ITEMS || size + bytes > MAX_BYTES)) {
        chunks.push(cur)
        cur = []
        size = 0
      }
      cur.push(b)
      size += bytes
    }
    if (cur.length) chunks.push(cur)
    for (const part of chunks) {
      // chat_bases/host_epochs valem no ENVIO (o aceite do lote anterior avança o head)
      const body: PushBody = {
        push_id: this.uuid(),
        items: part.map((b) => b.item),
        chat_bases: { [chatId]: store.contentHead(chatId) }
      }
      if (mode.epoch != null) body.host_epochs = { [chatId]: mode.epoch }
      let res: PushResult
      try {
        res = await this.post(body)
      } catch (e) {
        if (!(e instanceof SyncApiError)) throw e
        return this.onContentError(chatId, e)
      }
      const seqOf = new Map(res.results.map((r) => [`${r.type}\u0000${r.id}`, r.seq]))
      store.commitOutbox(
        part.map((b) => ({
          type: b.row.type,
          id: b.row.id,
          mark: b.row.mark,
          rev: b.item.rev,
          seq: seqOf.get(`${b.row.type}\u0000${b.row.id}`) ?? 0,
          blobs: b.blobs
        }))
      )
    }
    this.failures.delete(chatId)
    this.d.notify([chatId])
    return !store.hasOutbox(chatId)
  }

  private async onContentError(chatId: string, e: SyncApiError): Promise<boolean> {
    switch (e.code) {
      case 'chat_busy':
        this.retryLater(chatId)
        return false
      case 'not_host':
        // janela perdida / epoch velho: o host decide (replay ou esperar) no próximo ciclo
        this.d.onPushError?.(chatId, 'not_host')
        this.retryLater(chatId)
        return false
      case 'stale_base':
        await this.d.pull?.().catch(() => undefined)
        this.retryLater(chatId, 300)
        return false
      case 'chat_diverged':
      case 'divergence_discarded':
        // divergência (§9): a resolução com versão local é da fase 4b — a outbox fica guardada
        this.d.onPushError?.(chatId, e.code)
        return false
      default:
        this.log(`push de conteúdo recusado: ${e.code}`)
        this.d.onPushError?.(chatId, e.code)
        return false
    }
  }

  private async decrypt(keys: { userId: string; sk: Subkeys }, c: Change): Promise<Plain> {
    let full = c
    if (!full.env) {
      const r = await this.d.http.post<{ records: Change[] }>('/api/v1/records/fetch', {
        items: [{ type: c.type, id: c.id }]
      })
      full = r.records?.find((x) => x.type === c.type && x.id === c.id) ?? c
    }
    if (!full.env) throw new Error('registro atual sem conteúdo')
    return openRecord(keys.sk.record, keys.userId, full, full.env)
  }
}

function conflictOf(e: unknown): PushConflict | null {
  if (!(e instanceof SyncApiError) || e.code !== 'conflict') return null
  const list = e.details.conflicts
  return Array.isArray(list) && list.length ? (list[0] as PushConflict) : null
}
