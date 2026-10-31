// Acesso síncrono ao SQLite, com a mesma interface no aparelho (expo-sqlite, ./sqlNative.ts) e nos
// testes (node:sqlite). Síncrono de propósito: as consultas são curtas e as transações de aplicação
// do sync não podem intercalar com outra escrita (o JS é uma thread só).

export type SqlValue = string | number | null | Uint8Array

export interface RunResult {
  changes: number
  lastInsertRowId: number
}

export interface Sql {
  exec(sql: string): void
  run(sql: string, params?: readonly SqlValue[]): RunResult
  all<T>(sql: string, params?: readonly SqlValue[]): T[]
  get<T>(sql: string, params?: readonly SqlValue[]): T | null
  /** Transação (aninhada vira parte da externa). Lançou → ROLLBACK. */
  tx<T>(fn: () => T): T
  close(): void
}

/** Transação com BEGIN/COMMIT explícitos e contagem de aninhamento (para adaptadores simples). */
export function makeTx(exec: (sql: string) => void): <T>(fn: () => T) => T {
  let depth = 0
  return <T>(fn: () => T): T => {
    if (depth > 0) {
      depth++
      try {
        return fn()
      } finally {
        depth--
      }
    }
    exec('BEGIN IMMEDIATE')
    depth = 1
    try {
      const out = fn()
      exec('COMMIT')
      return out
    } catch (e) {
      try {
        exec('ROLLBACK')
      } catch {
        /* já desfeita */
      }
      throw e
    } finally {
      depth = 0
    }
  }
}
