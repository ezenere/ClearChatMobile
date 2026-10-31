// DEFLATE cru (RFC 1951) sobre fflate — o Hermes não tem CompressionStream/DecompressionStream.
// A descompressão é incremental e aborta ao passar do teto (proteção contra "zip bomb").
import { Inflate, deflateSync } from 'fflate'

export function deflateRawSync(data: Uint8Array): Uint8Array {
  return deflateSync(data)
}

export class InflateLimitError extends Error {
  constructor() {
    super('conteúdo descomprimido grande demais')
    this.name = 'InflateLimitError'
  }
}

const SLICE = 64 * 1024

export function inflateRawSync(data: Uint8Array, cap: number): Uint8Array {
  const parts: Uint8Array[] = []
  let total = 0
  let ended = false
  const inf = new Inflate((chunk, final) => {
    total += chunk.length
    if (total > cap) throw new InflateLimitError()
    parts.push(chunk)
    if (final) ended = true
  })
  // entrada em fatias: o teto é conferido ao longo do caminho, não só no fim
  for (let off = 0; off < data.length; off += SLICE) {
    const end = Math.min(data.length, off + SLICE)
    inf.push(data.subarray(off, end), end === data.length)
  }
  if (data.length === 0) inf.push(new Uint8Array(0), true)
  if (!ended) throw new Error('deflate-raw truncado')
  const outBuf = new Uint8Array(total)
  let o = 0
  for (const p of parts) {
    outBuf.set(p, o)
    o += p.length
  }
  return outBuf
}
