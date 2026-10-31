// Sql sobre o node:sqlite (testes): mesma interface do adaptador do expo-sqlite (src/data/sqlNative.ts).
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { makeTx, type Sql, type SqlValue } from '../src/data/sql'

export function openNodeSql(path = ':memory:'): Sql {
  const db = new DatabaseSync(path)
  const cache = new Map<string, StatementSync>()
  const stmt = (sql: string): StatementSync => {
    let s = cache.get(sql)
    if (!s) {
      s = db.prepare(sql)
      cache.set(sql, s)
    }
    return s
  }
  const exec = (sql: string): void => db.exec(sql)
  const p = (params?: readonly SqlValue[]) => (params ?? []) as SqlValue[]
  return {
    exec,
    run(sql, params) {
      const r = stmt(sql).run(...p(params))
      return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) }
    },
    all<T>(sql: string, params?: readonly SqlValue[]): T[] {
      return stmt(sql).all(...p(params)) as T[]
    },
    get<T>(sql: string, params?: readonly SqlValue[]): T | null {
      return (stmt(sql).get(...p(params)) as T | undefined) ?? null
    },
    tx: makeTx(exec),
    close() {
      cache.clear()
      db.close()
    }
  }
}
