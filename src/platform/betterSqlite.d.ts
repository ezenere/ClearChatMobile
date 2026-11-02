// Tipos mínimos de `better-sqlite3` para os arquivos vendorados do desktop (memory/store.ts,
// memory/schema.ts, searchIndex.ts) — só `import type`; no celular a conexão é o adaptador
// síncrono de src/memory/sqlite.ts (sobre expo-sqlite no aparelho e node:sqlite nos testes).
declare namespace Database {
  interface RunResult {
    changes: number
    lastInsertRowid: number | bigint
  }
  interface Statement {
    all(...params: unknown[]): unknown[]
    get(...params: unknown[]): unknown
    run(...params: unknown[]): RunResult
  }
  interface Database {
    prepare(sql: string): Statement
    exec(sql: string): unknown
    transaction<F extends (...args: any[]) => any>(fn: F): F
  }
}
// eslint-disable-next-line @typescript-eslint/no-redeclare -- namespace de tipos + valor (como o pacote)
declare const Database: { readonly __types: unique symbol }
export default Database
