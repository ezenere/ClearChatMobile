// Adaptador síncrono com a interface do better-sqlite3 (o que os módulos vendorados da memória do
// desktop usam: prepare().all/get/run, exec, transaction) sobre o `Sql` do app — expo-sqlite no
// aparelho, node:sqlite nos testes. Assim memory/store.ts e memory/schema.ts rodam sem alteração.
import type Database from 'better-sqlite3'
import type { Sql, SqlValue } from '@/data/sql'

const val = (v: unknown): SqlValue => {
  if (v === undefined || v === null) return null
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'bigint') return Number(v)
  if (typeof v === 'number' || typeof v === 'string' || v instanceof Uint8Array) return v
  return String(v)
}

export function betterSqlite(sql: Sql): Database.Database {
  return {
    prepare(text: string): Database.Statement {
      return {
        all: (...p: unknown[]) => sql.all(text, p.map(val)),
        get: (...p: unknown[]) => sql.get(text, p.map(val)) ?? undefined,
        run: (...p: unknown[]) => {
          const r = sql.run(text, p.map(val))
          return { changes: r.changes, lastInsertRowid: r.lastInsertRowId }
        }
      }
    },
    exec(text: string) {
      sql.exec(text)
      return this
    },
    transaction<F extends (...args: any[]) => any>(fn: F): F {
      return ((...args: Parameters<F>) => sql.tx(() => fn(...args))) as F
    }
  }
}
