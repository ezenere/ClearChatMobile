// Aleatoriedade fora do RN (Node/Vitest): o WebCrypto nativo do Node, capturado antes de o shim
// substituir `globalThis.crypto`.
import type { RandomSource } from './randomTypes'

const native = globalThis.crypto

export const randomSource: RandomSource = {
  getRandomValues: <T extends ArrayBufferView | null>(a: T): T =>
    native.getRandomValues(a as never),
  randomUUID: () => native.randomUUID()
}
