// Escrita LWW com outbox persistida (SYNC_PROTOCOL.md §7.4–7.5) para registros que o celular grava
// sozinho, sem esperar a rede (hoje: `memory` e `memory_collection` das tools de memória e da
// extração). A revisão vai ao cache na hora (`LocalStore.writeLww`) e sobe um registro por lote
// (um conflito não segura o resto): `rev_mismatch` → os campos mudados aqui sobre a versão do
// servidor (`updatedAt` = o maior), `gone` → a exclusão vence (apaga aqui), sem rede → tenta de
// novo com espera crescente. Sem React Native.
import { SyncApiError, SyncNetworkError } from '@vendor/desktop/sync/http'
import { openRecord, sealRecord, type Subkeys } from '@/crypto'
import type { LocalStore, LwwRow } from './store'
import type { Change, Plain, PushConflict, PushItem, PushResult } from './types'

export interface LwwDeps {
  store: LocalStore
  http: { post<T = unknown>(path: string, json?: unknown): Promise<T> }
  keys: () => { userId: string; sk: Subkeys } | null
  /** Cache mudou por um conflito/exclusão (a tela recarrega). */
  notify?: () => void
  log?: (msg: string) => void
  debounceMs?: number
  retryMs?: number
  uuid?: () => string
}

/** Tipos LWW por campo que passam por aqui, na ordem de envio (coleção antes da memória). */
const ORDER: Record<string, number> = { memory_collection: 0, memory: 1 }

const isNetwork = (e: unknown): boolean => e instanceof SyncNetworkError

function conflictOf(e: unknown): PushConflict | null {
  if (!(e instanceof SyncApiError) || e.code !== 'conflict') return null
  const list = e.details.conflicts
  return Array.isArray(list) && list.length ? (list[0] as PushConflict) : null
}

/** Versão do servidor + os campos mudados aqui (`updatedAt` = o maior dos dois). */
export function mergeLww(server: Plain, patch: Plain): Plain {
  const out: Plain = { ...server, ...patch }
  const a = typeof server.updatedAt === 'number' ? server.updatedAt : 0
  const b = typeof patch.updatedAt === 'number' ? patch.updatedAt : 0
  if (a || b) out.updatedAt = Math.max(a, b)
  return out
}

export class LwwWriter {
  private readonly d: LwwDeps
  private timer: ReturnType<typeof setTimeout> | null = null
  private flushing: Promise<boolean> | null = null
  private again = false
  private stopped = false
  private failures = 0

  constructor(deps: LwwDeps) {
    this.d = deps
  }

  /** Grava a revisão no cache e agenda o envio. `plain` null = apagar. */
  write(w: { type: string; id: string; scope: string | null; plain: Plain | null; patch: Plain }) {
    this.d.store.writeLww(w)
    this.schedule()
  }

  pending(): boolean {
    return this.d.store.lwwOutbox().length > 0 || !!this.flushing
  }

  resume(): void {
    this.stopped = false
    if (this.d.store.lwwOutbox().length) this.schedule(0)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  schedule(delay = this.d.debounceMs ?? 250): void {
    if (this.stopped) return
    if (this.flushing) {
      this.again = true
      return
    }
    if (this.timer) {
      if (delay > 0) return
      clearTimeout(this.timer)
    }
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, delay)
  }

  /** Envia já (sem esperar o debounce). true = outbox vazia. */
  async flushNow(): Promise<boolean> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.flushing) await this.flushing
    return this.flush()
  }

  flush(): Promise<boolean> {
    if (this.flushing) {
      this.again = true
      return this.flushing
    }
    const p = this.doFlush()
      .catch((e: unknown) => {
        this.failures++
        if (!isNetwork(e)) this.d.log?.(`push LWW falhou: ${(e as Error).message}`)
        this.retryLater()
        return false
      })
      .finally(() => {
        this.flushing = null
        if (this.again) {
          this.again = false
          this.schedule(0)
        }
      })
    this.flushing = p
    return p
  }

  private retryLater(): void {
    if (this.stopped) return
    const ms = Math.min(30_000, (this.d.retryMs ?? 1500) * 2 ** Math.max(0, this.failures - 1))
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, ms)
  }

  private async doFlush(): Promise<boolean> {
    const keys = this.d.keys()
    if (!keys) return false
    const store = this.d.store
    const rows = store.lwwOutbox().sort((a, b) => (ORDER[a.type] ?? 9) - (ORDER[b.type] ?? 9))
    let waiting = false
    for (const row of rows) {
      const ok = await this.pushOne(keys, row)
      if (!ok) waiting = true
    }
    if (waiting) {
      this.retryLater()
      return false
    }
    this.failures = 0
    return store.lwwOutbox().length === 0
  }

  /** Um registro por lote. false = ficou para depois (escopo ainda não aceito). */
  private async pushOne(keys: { userId: string; sk: Subkeys }, first: LwwRow): Promise<boolean> {
    const store = this.d.store
    let row: LwwRow | undefined = first
    for (let attempt = 0; attempt < 5 && row; attempt++) {
      const rev = row.baseRev + 1
      const item: PushItem = {
        type: row.type,
        id: row.id,
        scope: row.scope,
        base_rev: row.baseRev,
        rev,
        deleted: row.deleted,
        blobs: []
      }
      if (!row.deleted && row.plain)
        item.env = await sealRecord(
          keys.sk.record,
          keys.userId,
          { type: row.type, id: row.id, scope: row.scope, rev },
          row.plain
        )
      try {
        const res = await this.post({
          push_id: this.d.uuid?.() ?? crypto.randomUUID(),
          items: [item]
        })
        const r =
          res.results.find((x) => x.type === row!.type && x.id === row!.id) ?? res.results[0]
        store.commitLww([{ type: row.type, id: row.id, mark: row.mark, rev, seq: r?.seq ?? 0 }])
        return true
      } catch (e) {
        const c = conflictOf(e)
        if (!c) throw e
        if (c.reason === 'scope_missing') return false
        if (c.reason === 'scope_deleted' || c.reason === 'gone' || c.current?.deleted) {
          // a exclusão vence (§7.5): descarta a edição local e apaga aqui
          store.dropLww(row.type, row.id)
          const cur = c.current
          store.deleteRecord({
            type: row.type,
            id: row.id,
            scope: row.scope,
            rev: cur?.rev ?? rev,
            seq: cur?.seq ?? 0
          })
          this.d.notify?.()
          return true
        }
        if (c.reason !== 'rev_mismatch' || !c.current) throw e
        const server = await this.decrypt(keys, c.current)
        store.rebaseLww(
          row.type,
          row.id,
          c.current.rev,
          row.deleted ? server : mergeLww(server, row.patch)
        )
        row = store.lwwOutbox().find((x) => x.type === first.type && x.id === first.id)
      }
    }
    return !row
  }

  private async post(body: { push_id: string; items: PushItem[] }): Promise<PushResult> {
    try {
      return await this.d.http.post<PushResult>('/api/v1/sync/push', body)
    } catch (e) {
      if (!isNetwork(e)) throw e
      return await this.d.http.post<PushResult>('/api/v1/sync/push', body)
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
