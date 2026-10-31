// Aleatoriedade no RN: CSPRNG do SO via expo-crypto (SecureRandom no Android, SecRandom no iOS).
import { getRandomValues, randomUUID } from 'expo-crypto'
import type { RandomSource } from './randomTypes'

export const randomSource: RandomSource = {
  getRandomValues: <T extends ArrayBufferView | null>(a: T): T => {
    if (!a) return a
    // expo-crypto aceita os TypedArrays inteiros; Uint8Array cobre os usos do protocolo
    getRandomValues(a as unknown as Uint8Array)
    return a
  },
  randomUUID: () => randomUUID()
}
