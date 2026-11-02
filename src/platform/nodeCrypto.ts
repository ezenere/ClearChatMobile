// `node:crypto`/`crypto` para os arquivos vendorados do desktop (sync/stream.ts: randomUUID;
// memory/store.ts: randomUUID + randomBytes). Mapeado no tsconfig (paths) e no resolver do Metro/Vitest.
export function randomUUID(): string {
  return globalThis.crypto.randomUUID()
}

export function randomBytes(n: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(n))
}
