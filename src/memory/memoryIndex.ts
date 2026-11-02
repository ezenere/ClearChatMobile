// Índice local da memória (SYNC_PROTOCOL.md §4.3.4–4.3.5): as tabelas `memory_collections` /
// `memories` / `memories_fts` do desktop num SQLite EM MEMÓRIA, montadas a partir dos registros
// sincronizados do cache (a fonte da verdade) e mantidas pelos avisos do LocalStore. Sobre ele roda
// o MemoryStore VENDORADO do desktop (busca FTS5 com bm25, similares, slugs, validações) — as tools
// de memória têm a mesma semântica do desktop. Mudanças feitas aqui (tools/extração) avisam
// `onLocalChange`, que grava o registro e o põe na outbox LWW (MemorySync). Sem React Native.
import type Database from 'better-sqlite3'
import type { Sql } from '@/data/sql'
import type { LocalStore } from '@/data/store'
import type { Plain } from '@/data/types'
import { ensureMemorySchema } from '@vendor/desktop/memory/schema'
import { MemoryStore } from '@vendor/desktop/memory/store'
import { betterSqlite } from './sqlite'

export interface MemoryIndexDeps {
  cache: LocalStore
  /** Banco em memória (expo-sqlite `:memory:` no aparelho; node:sqlite nos testes). */
  open: () => Sql
  /** Mudança feita por este aparelho (tool/extração): gravar o registro e enviar. */
  onLocalChange: (collectionId: string | null, memoryId: string | null) => void
  log?: (msg: string) => void
  now?: () => number
}

const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d)
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)

/** §4.3.5: a memória de `createdAt` maior (empate: id maior) ganha o sufixo. */
export function slugSuffix(slug: string, id: string): string {
  const tail = id
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(-4)
    .toLowerCase()
  return `${slug}-${tail}`
}

/** Linha de `memory_collections` → plaintext do registro (§4.3.4). */
export function collectionPlain(r: Record<string, unknown>): Plain {
  return {
    sv: 1,
    category: str(r.category, 'topics'),
    name: str(r.name),
    description: str(r.description),
    icon: strOrNull(r.icon),
    createdAt: num(r.created_at, 0),
    updatedAt: num(r.updated_at, 0)
  }
}

/** Linha de `memories` → plaintext do registro (§4.3.5). */
export function memoryPlain(r: Record<string, unknown>): Plain {
  let facts: string[] = []
  try {
    const v = JSON.parse(str(r.facts_json, '[]')) as unknown
    if (Array.isArray(v)) facts = v.filter((x): x is string => typeof x === 'string')
  } catch {
    /* tópicos ilegíveis = nenhum */
  }
  return {
    sv: 1,
    collectionId: str(r.collection_id),
    category: str(r.category, 'topics'),
    title: str(r.title),
    slug: str(r.slug),
    summary: str(r.summary),
    facts,
    pinned: !!r.pinned,
    createdAt: num(r.created_at, 0),
    updatedAt: num(r.updated_at, 0),
    updatedByChatId: strOrNull(r.updated_by_chat_id),
    updatedBy: str(r.updated_by, 'user'),
    supersedesId: strOrNull(r.supersedes_id)
  }
}

export class MemoryIndex {
  private readonly d: MemoryIndexDeps
  private sql: Sql | null = null
  private conn: Database.Database | null = null
  private st: MemoryStore | null = null
  private built = false
  private offs: (() => void)[] = []

  constructor(deps: MemoryIndexDeps) {
    this.d = deps
    this.offs.push(
      deps.cache.onMemoryRecord((type, id, plain) => this.apply(type, id, plain)),
      deps.cache.onWipe(() => this.reset())
    )
  }

  /** MemoryStore do desktop sobre o índice (montado na 1ª leitura). */
  get store(): MemoryStore {
    this.ensure()
    return this.st!
  }

  dispose(): void {
    for (const off of this.offs) off()
    this.offs = []
    this.sql?.close()
    this.sql = null
    this.conn = null
    this.st = null
    this.built = false
  }

  /** Esquece o índice (logout/wipe): a próxima leitura remonta dos registros. */
  reset(): void {
    this.built = false
    if (!this.sql) return
    this.sql.exec('DELETE FROM memories; DELETE FROM memory_collections;')
  }

  ensure(): void {
    if (this.built && this.st) return
    if (!this.sql) {
      this.sql = this.d.open()
      // as cascatas (coleção → memórias) são feitas aqui à mão, como no cache
      this.sql.exec('PRAGMA foreign_keys = OFF')
      this.conn = betterSqlite(this.sql)
      ensureMemorySchema(this.conn)
      this.st = new MemoryStore(this.conn, {
        onChange: (c, m) => this.d.onLocalChange(c, m),
        now: this.d.now
      })
    }
    const sql = this.sql
    sql.tx(() => {
      sql.exec('DELETE FROM memories; DELETE FROM memory_collections;')
      for (const r of this.d.cache.plainsOf('memory_collection'))
        this.upsertCollection(r.id, r.plain)
      const mems = this.d.cache
        .plainsOf('memory')
        .sort(
          (a, b) => num(a.plain.createdAt, 0) - num(b.plain.createdAt, 0) || (a.id < b.id ? -1 : 1)
        )
      for (const r of mems) this.upsertMemory(r.id, r.plain)
    })
    this.built = true
  }

  /** Linha atual (para montar o registro de uma mudança local). */
  row(table: 'memories' | 'memory_collections', id: string): Record<string, unknown> | null {
    this.ensure()
    return this.sql!.get<Record<string, unknown>>(`SELECT * FROM ${table} WHERE id = ?`, [id])
  }

  // ---------------- registros recebidos ----------------

  private apply(type: string, id: string, plain: Plain | null): void {
    if (!this.built || !this.sql) return
    try {
      if (type === 'memory_collection') {
        if (plain) this.upsertCollection(id, plain)
        else {
          this.sql.run('DELETE FROM memories WHERE collection_id = ?', [id])
          this.sql.run('DELETE FROM memory_collections WHERE id = ?', [id])
        }
      } else if (type === 'memory') {
        if (plain) this.upsertMemory(id, plain)
        else this.sql.run('DELETE FROM memories WHERE id = ?', [id])
      }
    } catch (e) {
      this.d.log?.(`índice da memória: ${(e as Error).message}`)
      this.built = false
    }
  }

  private upsertCollection(id: string, raw: Plain): void {
    const p = this.withLocal('memory_collection', id, raw)
    if (!p) return
    this.sql!.run(
      `INSERT INTO memory_collections (id, category, name, description, icon, scope, chat_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'shared', NULL, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, icon = excluded.icon,
         created_at = excluded.created_at, updated_at = excluded.updated_at`,
      [
        id,
        str(p.category, 'topics'),
        str(p.name, 'Coleção'),
        str(p.description),
        strOrNull(p.icon),
        num(p.createdAt, Date.now()),
        num(p.updatedAt, Date.now())
      ]
    )
  }

  private upsertMemory(id: string, raw: Plain): void {
    const p = this.withLocal('memory', id, raw)
    if (!p) return
    const sql = this.sql!
    let slug = str(p.slug, id)
    const createdAt = num(p.createdAt, Date.now())
    // colisão de slug (§4.3.5): a de createdAt maior (empate: id maior) ganha o sufixo e este
    // aparelho envia a nova revisão (regra determinística — todos chegam ao mesmo resultado)
    const other = sql.get<{ id: string; created_at: number; slug: string }>(
      'SELECT id, created_at, slug FROM memories WHERE slug = ? AND id <> ?',
      [slug, id]
    )
    let redirty: string | null = null
    if (other) {
      const incomingLoses =
        createdAt > other.created_at || (createdAt === other.created_at && id > other.id)
      if (incomingLoses) {
        slug = slugSuffix(slug, id)
        redirty = id
      } else {
        sql.run('UPDATE memories SET slug = ? WHERE id = ?', [
          slugSuffix(other.slug, other.id),
          other.id
        ])
        redirty = other.id
      }
    }
    sql.run(
      `INSERT INTO memories (id, collection_id, category, title, slug, summary, facts_json, pinned, created_at, updated_at,
         updated_by_chat_id, updated_by, supersedes_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET collection_id = excluded.collection_id, category = excluded.category,
         title = excluded.title, slug = excluded.slug, summary = excluded.summary, facts_json = excluded.facts_json,
         pinned = excluded.pinned, created_at = excluded.created_at, updated_at = excluded.updated_at,
         updated_by_chat_id = excluded.updated_by_chat_id, updated_by = excluded.updated_by,
         supersedes_id = excluded.supersedes_id`,
      [
        id,
        str(p.collectionId),
        str(p.category, 'topics'),
        str(p.title),
        slug,
        str(p.summary),
        JSON.stringify(Array.isArray(p.facts) ? p.facts : []),
        p.pinned ? 1 : 0,
        createdAt,
        num(p.updatedAt, Date.now()),
        strOrNull(p.updatedByChatId),
        str(p.updatedBy, 'user'),
        strOrNull(p.supersedesId)
      ]
    )
    if (redirty) {
      const target = redirty
      // fora da transação do sync: grava a revisão com o slug novo e envia
      setTimeout(() => this.d.onLocalChange(null, target), 0)
    }
  }

  /** Registro recebido + os campos mudados aqui ainda não aceitos (LWW por campo). */
  private withLocal(type: string, id: string, plain: Plain): Plain | null {
    const patch = this.d.cache.lwwPatch(type, id)
    if (!patch) return plain
    if (patch.__deleted) return null
    return { ...plain, ...patch }
  }
}
