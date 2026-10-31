// Substitui `./primitives` para os módulos de src/vendor/site/crypto (redirecionado pelo resolver do
// Metro e do Vitest — scripts/platformAliases.cjs). Reexporta as primitivas vendoradas (WebCrypto,
// atendido pelo shim de subtle.ts) e troca deflateRaw/inflateRaw, que no site usam
// CompressionStream + Blob.stream() — inexistentes no Hermes — por fflate. No aparelho, o AES-GCM
// vai para o nativo (expo-crypto) depois de conferido contra o noble (resposta conhecida).
/* eslint-disable import/export -- de propósito: as exportações locais abaixo sombreiam as do `export *` (regra do ES) */
import * as vendored from '@vendor/site/crypto/primitives'
import { MAX_INFLATED_BYTES } from '@vendor/site/crypto/constants'
import type { Bytes } from '@vendor/site/crypto/encoding'
import { deflateRawSync, inflateRawSync } from './deflate'
import { nativeGcm } from './gcm'

export * from '@vendor/site/crypto/primitives'

/** DEFLATE cru (RFC 1951). */
export const deflateRaw: typeof vendored.deflateRaw = async (data) => deflateRawSync(data) as Bytes

export const inflateRaw: typeof vendored.inflateRaw = async (data, cap = MAX_INFLATED_BYTES) =>
  inflateRawSync(data, cap) as Bytes

// ---------------- AES-256-GCM: nativo no aparelho, conferido antes do primeiro uso ----------------

let nativeReady: Promise<boolean> | null = null
let nativeDisabled = false

/** O GCM nativo dá exatamente a saída do noble (cifra e decifra, com AAD e tag)? */
async function checkNative(): Promise<boolean> {
  if (!nativeGcm) return false
  try {
    const key = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 255)
    const nonce = new Uint8Array(12).map((_, i) => (i * 13 + 1) & 255)
    const aad = new TextEncoder().encode('clearchat|kat')
    const pt = new Uint8Array(1000).map((_, i) => (i * 31) & 255)
    const ref = await vendored.gcmEncrypt(key, nonce, aad, pt)
    const got = await nativeGcm.encrypt(key, nonce, aad, pt)
    if (got.length !== ref.length || got.some((b, i) => b !== ref[i])) return false
    const back = await nativeGcm.decrypt(key, nonce, aad, ref)
    if (back.length !== pt.length || back.some((b, i) => b !== pt[i])) return false
    const bad = ref.slice()
    bad[5] ^= 1
    try {
      await nativeGcm.decrypt(key, nonce, aad, bad)
      return false // aceitou dado adulterado
    } catch {
      return true
    }
  } catch {
    return false
  }
}

const nativeEnabled = (): Promise<boolean> => {
  if (!nativeGcm || nativeDisabled) return Promise.resolve(false)
  if (!nativeReady) nativeReady = checkNative()
  return nativeReady
}

/** Qual AES-GCM está em uso (self-test/diagnóstico). */
export async function gcmBackend(): Promise<string> {
  return (await nativeEnabled()) ? (nativeGcm?.name ?? 'nativo') : 'noble (JS)'
}

/** Testes/self-test: força o caminho JS. */
export function setNativeGcmEnabled(on: boolean): void {
  nativeDisabled = !on
}

export const gcmEncrypt: typeof vendored.gcmEncrypt = async (key, nonce, aad, plaintext) => {
  if (!(await nativeEnabled())) return vendored.gcmEncrypt(key, nonce, aad, plaintext)
  if (key.length !== 32) throw new Error('chave AES-256 precisa de 32 bytes')
  if (nonce.length !== 12) throw new Error('nonce GCM precisa de 12 bytes')
  return (await nativeGcm!.encrypt(key, nonce, aad, plaintext)) as Bytes
}

export const gcmDecrypt: typeof vendored.gcmDecrypt = async (key, nonce, aad, ctAndTag) => {
  if (!(await nativeEnabled())) return vendored.gcmDecrypt(key, nonce, aad, ctAndTag)
  if (key.length !== 32) throw new Error('chave AES-256 precisa de 32 bytes')
  if (nonce.length !== 12) throw new Error('nonce GCM precisa de 12 bytes')
  if (ctAndTag.length < 16) throw new Error('ciphertext curto demais')
  try {
    return (await nativeGcm!.decrypt(key, nonce, aad, ctAndTag)) as Bytes
  } catch {
    throw new vendored.AuthError()
  }
}

/** Marca usada pelos testes/self-test para confirmar que o redirecionamento está ativo. */
export const PLATFORM_PRIMITIVES = true
