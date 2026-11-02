// `node:crypto`/`crypto` para os arquivos vendorados do desktop (sync/stream.ts: randomUUID;
// memory/store.ts: randomUUID + randomBytes; voice/voiceCatalog.ts: createHash('sha256') para a
// chave do cache). Mapeado no tsconfig (paths) e no resolver do Metro/Vitest.
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

export function randomUUID(): string {
  return globalThis.crypto.randomUUID()
}

export function randomBytes(n: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(n))
}

/** Subconjunto do `createHash` do Node: só `sha256`, `update(string | bytes)` e `digest('hex')`. */
export function createHash(algorithm: string): {
  update(data: string | Uint8Array): ReturnType<typeof createHash>
  digest(encoding: 'hex'): string
} {
  if (algorithm.toLowerCase() !== 'sha256')
    throw new Error(`createHash: algoritmo não suportado no celular: ${algorithm}`)
  const h = sha256.create()
  const api = {
    update(data: string | Uint8Array) {
      h.update(typeof data === 'string' ? new TextEncoder().encode(data) : data)
      return api
    },
    digest(encoding: 'hex'): string {
      if (encoding !== 'hex') throw new Error(`createHash: digest só em hex no celular`)
      return bytesToHex(h.digest())
    }
  }
  return api
}
