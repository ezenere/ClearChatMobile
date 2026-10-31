// AES-256-GCM nativo: só no aparelho (gcm.native.ts, expo-crypto). No Node/Vitest não existe — as
// primitivas usam o shim noble (subtle.ts).
export interface NativeGcm {
  name: string
  encrypt(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, pt: Uint8Array): Promise<Uint8Array>
  /** Lança em falha de autenticação. */
  decrypt(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, ct: Uint8Array): Promise<Uint8Array>
}

export const nativeGcm: NativeGcm | null = null
