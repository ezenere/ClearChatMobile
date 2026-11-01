// Leitura de arquivos do host em pedaços (`fs.read`, SYNC_PROTOCOL.md §8.6): poucos pedaços em
// voo, tamanho/mtime conferidos a cada pedaço (mudou no meio → erro), texto paginado com o corte
// de UTF-8 respeitado. Puro — o envio do comando entra por `readChunk`.
import { REMOTE_FS_LIMITS, type RemoteFsFailure, type RemoteReadResult } from '@shared/remoteFs'

export type ReadChunk = (offset: number, length: number) => Promise<RemoteReadResult>

export class RemoteFileError extends Error {
  readonly failure: RemoteFsFailure
  constructor(failure: RemoteFsFailure) {
    super(failure.message)
    this.failure = failure
  }
}

export const FILE_CHANGED = 'O arquivo mudou no host durante a busca — tente de novo.'

export interface FetchedFile {
  size: number
  mtime: number
  mime?: string
  bytes: Uint8Array
  /** Leu até o fim do arquivo (senão parou em `maxBytes`). */
  complete: boolean
}

/**
 * Busca de `offset` até `offset + maxBytes` (ou o fim). O primeiro pedaço traz tamanho/mtime;
 * os demais vão até `concurrency` em voo.
 */
export async function fetchRange(
  read: ReadChunk,
  opts: {
    offset?: number
    maxBytes: number
    chunkBytes?: number
    concurrency?: number
    expect?: { size: number; mtime: number }
    onProgress?: (done: number, total: number) => void
    signal?: { aborted: boolean }
  }
): Promise<FetchedFile> {
  const chunk = Math.min(
    opts.chunkBytes ?? REMOTE_FS_LIMITS.chunkBytes,
    REMOTE_FS_LIMITS.chunkBytes
  )
  const conc = Math.max(1, opts.concurrency ?? REMOTE_FS_LIMITS.concurrency)
  const start = opts.offset ?? 0
  const first = await read(start, Math.min(chunk, opts.maxBytes))
  if (!first.ok) throw new RemoteFileError(first)
  if (opts.expect && (first.size !== opts.expect.size || first.mtime !== opts.expect.mtime))
    throw new Error(FILE_CHANGED)
  const { size, mtime } = first
  const end = Math.min(size, start + opts.maxBytes)
  const total = Math.max(0, end - start)
  const parts = new Map<number, Uint8Array>([[start, first.data]])
  let done = first.data.length
  opts.onProgress?.(done, total)
  const offsets: number[] = []
  for (let o = start + first.data.length; o < end; o += chunk) offsets.push(o)
  if (first.data.length && first.data.length < Math.min(chunk, total))
    throw new Error('Resposta incompleta do host.')
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < offsets.length) {
      if (opts.signal?.aborted) throw new Error('cancelado')
      const o = offsets[next++]
      const r = await read(o, Math.min(chunk, end - o))
      if (!r.ok) throw new RemoteFileError(r)
      if (r.size !== size || r.mtime !== mtime) throw new Error(FILE_CHANGED)
      parts.set(o, r.data)
      done += r.data.length
      opts.onProgress?.(done, total)
    }
  }
  await Promise.all(Array.from({ length: Math.min(conc, offsets.length) }, worker))
  const bytes = new Uint8Array(done)
  let at = 0
  for (const o of [start, ...offsets]) {
    const p = parts.get(o)
    if (!p) continue
    bytes.set(p, at)
    at += p.length
  }
  return {
    size,
    mtime,
    ...(first.mime ? { mime: first.mime } : {}),
    bytes,
    complete: start + bytes.length >= size
  }
}

/**
 * Separa o fim incompleto de uma sequência UTF-8 (um caractere cortado no limite do pedaço): o
 * resto vai na frente do próximo pedaço.
 */
export function splitUtf8(bytes: Uint8Array): [Uint8Array, Uint8Array] {
  const n = bytes.length
  for (let back = 1; back <= Math.min(3, n); back++) {
    const b = bytes[n - back]
    if ((b & 0xc0) === 0x80) continue // byte de continuação
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1
    return need > back
      ? [bytes.subarray(0, n - back), bytes.subarray(n - back)]
      : [bytes, bytes.subarray(n)]
  }
  return [bytes, bytes.subarray(n)]
}

export function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (!a.length) return b
  if (!b.length) return a
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

/** "1,2 MB" */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0).replace('.', ',')} KB`
  return `${(n / 1048576).toFixed(1).replace('.', ',')} MB`
}
