// Memória no celular: índice local (MemoryIndex) + outbox LWW (LwwWriter) + MemoryService. Uma
// mudança feita aqui (tool de memória ou extração) vira revisão do registro `memory` /
// `memory_collection` com só os campos que mudaram como "sujos" (§7.5) — o desktop vê pelo sync
// normal. Sem React Native: o aparelho (native.ts) e os testes montam com o seu `Sql`.
import type { Subkeys } from '@/crypto'
import { LwwWriter } from '@/data/lww'
import type { Sql } from '@/data/sql'
import type { LocalStore } from '@/data/store'
import type { Plain } from '@/data/types'
import { collectionPlain, MemoryIndex, memoryPlain } from './memoryIndex'
import { MemoryService, type SessionMemoryIO } from './service'

export interface MemorySystemDeps {
  cache: LocalStore
  open: () => Sql
  http: { post<T = unknown>(path: string, json?: unknown): Promise<T> }
  keys: () => { userId: string; sk: Subkeys } | null
  sessions: SessionMemoryIO
  notify?: () => void
  log?: (msg: string) => void
  now?: () => number
  writerTiming?: { debounceMs?: number; retryMs?: number }
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/** Campos de `next` diferentes em `prev` (os "sujos" da revisão). */
export function changedFields(prev: Plain | null, next: Plain): Plain {
  const out: Plain = {}
  for (const [k, v] of Object.entries(next)) if (!prev || !same(prev[k], v)) out[k] = v
  return out
}

export interface MemorySystem {
  index: MemoryIndex
  writer: LwwWriter
  service: MemoryService
  /** Grava agora a revisão de uma memória/coleção mudada aqui (também usado após colisão de slug). */
  sync(collectionId: string | null, memoryId: string | null): void
  dispose(): void
}

export function createMemorySystem(d: MemorySystemDeps): MemorySystem {
  const writer = new LwwWriter({
    store: d.cache,
    http: d.http,
    keys: d.keys,
    notify: d.notify,
    log: d.log,
    ...d.writerTiming
  })
  const sync = (collectionId: string | null, memoryId: string | null): void => {
    try {
      if (memoryId) {
        const row = index.row('memories', memoryId)
        const prev = d.cache.getPlain('memory', memoryId)
        if (row) {
          const plain = memoryPlain(row)
          const patch = changedFields(prev, plain)
          if (Object.keys(patch).length)
            writer.write({
              type: 'memory',
              id: memoryId,
              scope: String(plain.collectionId),
              plain: { ...(prev ?? {}), ...plain },
              patch
            })
        } else if (prev) {
          writer.write({
            type: 'memory',
            id: memoryId,
            scope: typeof prev.collectionId === 'string' ? prev.collectionId : null,
            plain: null,
            patch: {}
          })
        }
      }
      if (collectionId) {
        const row = index.row('memory_collections', collectionId)
        const prev = d.cache.getPlain('memory_collection', collectionId)
        if (row) {
          const plain = collectionPlain(row)
          const patch = changedFields(prev, plain)
          if (Object.keys(patch).length)
            writer.write({
              type: 'memory_collection',
              id: collectionId,
              scope: null,
              plain: { ...(prev ?? {}), ...plain },
              patch
            })
        }
      }
      d.notify?.()
    } catch (e) {
      d.log?.(`memória: revisão não gravada (${(e as Error).message})`)
    }
  }
  const index = new MemoryIndex({
    cache: d.cache,
    open: d.open,
    onLocalChange: sync,
    log: d.log,
    now: d.now
  })
  const service = new MemoryService(() => index.store, d.sessions, d.now)
  return {
    index,
    writer,
    service,
    sync,
    dispose: () => {
      writer.stop()
      index.dispose()
    }
  }
}
