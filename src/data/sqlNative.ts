// Sql sobre o expo-sqlite (API síncrona via JSI), com cache de statements preparados.
import { openDatabaseSync, type SQLiteDatabase, type SQLiteStatement } from 'expo-sqlite'
import { makeTx, type RunResult, type Sql, type SqlValue } from './sql'

export function openNativeSql(name: string): Sql {
  const db: SQLiteDatabase = openDatabaseSync(name)
  const cache = new Map<string, SQLiteStatement>()
  const stmt = (sql: string): SQLiteStatement => {
    let s = cache.get(sql)
    if (!s) {
      s = db.prepareSync(sql)
      cache.set(sql, s)
    }
    return s
  }
  const exec = (sql: string): void => db.execSync(sql)
  const params = (p?: readonly SqlValue[]): SqlValue[] => (p ? [...p] : [])
  return {
    exec,
    // o cursor é sempre zerado depois do uso: um statement em cache ativo seguraria uma transação
    // de leitura aberta (e o próximo BEGIN/PRAGMA falharia)
    run(sql, p): RunResult {
      const r = stmt(sql).executeSync(params(p))
      try {
        return { changes: r.changes, lastInsertRowId: r.lastInsertRowId }
      } finally {
        r.resetSync()
      }
    },
    all<T>(sql: string, p?: readonly SqlValue[]): T[] {
      const r = stmt(sql).executeSync<T>(params(p))
      try {
        return r.getAllSync()
      } finally {
        r.resetSync()
      }
    },
    get<T>(sql: string, p?: readonly SqlValue[]): T | null {
      const r = stmt(sql).executeSync<T>(params(p))
      try {
        return r.getFirstSync() ?? null
      } finally {
        r.resetSync()
      }
    },
    tx: makeTx(exec),
    close() {
      for (const s of cache.values()) {
        try {
          s.finalizeSync()
        } catch {
          /* */
        }
      }
      cache.clear()
      db.closeSync()
    }
  }
}
