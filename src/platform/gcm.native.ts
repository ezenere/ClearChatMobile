// AES-256-GCM nativo do expo-crypto (Android: javax.crypto; iOS: CryptoKit), muito mais rápido que o
// JS puro para registros grandes e anexos. Mesma saída por definição (GCM é determinístico dado
// chave/nonce/AAD), e mesmo assim conferido contra o noble antes do primeiro uso (primitives.ts) e
// pelos vetores no self-test do aparelho.
import { AESEncryptionKey, AESSealedData, aesDecryptAsync, aesEncryptAsync } from 'expo-crypto'
import type { NativeGcm } from './gcm'

// chaves importadas por conteúdo (subchaves e chaves de arquivo de blobs); poucas por vez
const cache = new Map<string, Promise<AESEncryptionKey>>()
const MAX_KEYS = 24

function keyId(k: Uint8Array): string {
  let s = ''
  for (let i = 0; i < k.length; i++) s += String.fromCharCode(k[i])
  return s
}

function importKey(k: Uint8Array): Promise<AESEncryptionKey> {
  const id = keyId(k)
  let p = cache.get(id)
  if (p) {
    cache.delete(id)
    cache.set(id, p)
    return p
  }
  p = AESEncryptionKey.import(k.slice()) as Promise<AESEncryptionKey>
  cache.set(id, p)
  while (cache.size > MAX_KEYS) cache.delete(cache.keys().next().value as string)
  return p
}

export const nativeGcm: NativeGcm = {
  name: 'expo-crypto',
  async encrypt(key, nonce, aad, pt) {
    const k = await importKey(key)
    const sealed = await aesEncryptAsync(pt.slice(), k, {
      nonce: { bytes: nonce.slice() },
      additionalData: aad.slice(),
      tagLength: 16
    })
    return (await sealed.ciphertext({ includeTag: true, encoding: 'bytes' })) as Uint8Array
  },
  async decrypt(key, nonce, aad, ct) {
    const k = await importKey(key)
    const sealed = AESSealedData.fromParts(nonce.slice(), ct.slice(), 16)
    return (await aesDecryptAsync(sealed, k, { additionalData: aad.slice() })) as Uint8Array
  }
}
