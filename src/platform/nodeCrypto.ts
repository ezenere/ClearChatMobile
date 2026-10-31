// `node:crypto` para os arquivos vendorados do desktop (src/main/sync/stream.ts só usa randomUUID).
// Mapeado no tsconfig (paths) e no resolver do Metro/Vitest.
export function randomUUID(): string {
  return globalThis.crypto.randomUUID()
}
