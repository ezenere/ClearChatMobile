// Subconjunto de `crypto.subtle` (WebCrypto) em JS puro sobre @noble/ciphers + @noble/hashes — o Hermes
// não tem WebCrypto. Cobre só o que a cripto do protocolo usa (SYNC_PROTOCOL.md §3.1): SHA-256,
// HMAC-SHA256, HKDF-SHA256 (deriveBits) e AES-GCM (tag de 128 bits), com chaves 'raw'.
// Qualquer outra coisa lança NotSupportedError em vez de fingir.
import { gcm } from '@noble/ciphers/aes.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'

type AlgName = 'AES-GCM' | 'HMAC' | 'HKDF'
type AlgInput = string | { name: string; hash?: string | { name: string }; [k: string]: unknown }

const RAW = Symbol('raw')

/** Chave opaca (equivalente a um CryptoKey não extraível). */
export class ShimCryptoKey {
  readonly type = 'secret'
  readonly extractable = false
  readonly algorithm: { name: AlgName; length?: number; hash?: { name: string } }
  readonly usages: string[];
  [RAW]: Uint8Array
  constructor(raw: Uint8Array, algorithm: ShimCryptoKey['algorithm'], usages: string[]) {
    this[RAW] = raw
    this.algorithm = algorithm
    this.usages = usages
  }
}

function domError(name: string, message: string): Error {
  const e = new Error(message)
  e.name = name
  return e
}
const notSupported = (what: string): Error =>
  domError('NotSupportedError', `crypto.subtle (shim): não suportado: ${what}`)

const algName = (a: AlgInput): string => (typeof a === 'string' ? a : a.name).toUpperCase()
const hashName = (h: unknown): string =>
  (typeof h === 'string' ? h : ((h as { name?: string } | undefined)?.name ?? '')).toUpperCase()

/** BufferSource → Uint8Array (cópia: o chamador pode reutilizar/zerar o buffer dele). */
function bytes(data: unknown, what: string): Uint8Array {
  if (data instanceof Uint8Array) return data.slice()
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength))
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0))
  throw new TypeError(`crypto.subtle (shim): ${what} precisa ser BufferSource`)
}

/** Resultado como ArrayBuffer próprio (o que o WebCrypto devolve). */
const out = (u: Uint8Array): ArrayBuffer =>
  u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer

function keyBytes(key: unknown, name: AlgName, usage: string): Uint8Array {
  if (!(key instanceof ShimCryptoKey)) throw new TypeError('crypto.subtle (shim): chave inválida')
  if (key.algorithm.name !== name)
    throw domError('InvalidAccessError', `chave ${key.algorithm.name} usada como ${name}`)
  if (!key.usages.includes(usage))
    throw domError('InvalidAccessError', `chave sem o uso "${usage}"`)
  return key[RAW]
}

function gcmParams(alg: AlgInput): { iv: Uint8Array; aad?: Uint8Array } {
  if (typeof alg === 'string' || algName(alg) !== 'AES-GCM')
    throw notSupported(`cifra ${algName(alg)}`)
  if (alg.tagLength !== undefined && alg.tagLength !== 128) throw notSupported('tagLength ≠ 128')
  const iv = bytes(alg.iv, 'iv')
  if (iv.length === 0) throw domError('OperationError', 'iv vazio')
  return {
    iv,
    aad: alg.additionalData === undefined ? undefined : bytes(alg.additionalData, 'aad')
  }
}

export const subtle = {
  async digest(alg: AlgInput, data: unknown): Promise<ArrayBuffer> {
    if (algName(alg) !== 'SHA-256') throw notSupported(`digest ${algName(alg)}`)
    return out(sha256(bytes(data, 'data')))
  },

  async importKey(
    format: string,
    keyData: unknown,
    alg: AlgInput,
    _extractable: boolean,
    usages: string[]
  ): Promise<ShimCryptoKey> {
    if (format !== 'raw') throw notSupported(`importKey formato ${format}`)
    const raw = bytes(keyData, 'keyData')
    const name = algName(alg)
    if (name === 'AES-GCM') {
      if (![16, 24, 32].includes(raw.length))
        throw domError('DataError', 'chave AES precisa de 128, 192 ou 256 bits')
      return new ShimCryptoKey(raw, { name, length: raw.length * 8 }, usages)
    }
    if (name === 'HMAC') {
      const h = typeof alg === 'string' ? '' : hashName(alg.hash)
      if (h !== 'SHA-256') throw notSupported(`HMAC com ${h || 'hash ausente'}`)
      return new ShimCryptoKey(raw, { name, hash: { name: 'SHA-256' } }, usages)
    }
    if (name === 'HKDF') return new ShimCryptoKey(raw, { name }, usages)
    throw notSupported(`importKey ${name}`)
  },

  async sign(alg: AlgInput, key: unknown, data: unknown): Promise<ArrayBuffer> {
    if (algName(alg) !== 'HMAC') throw notSupported(`sign ${algName(alg)}`)
    return out(hmac(sha256, keyBytes(key, 'HMAC', 'sign'), bytes(data, 'data')))
  },

  async verify(alg: AlgInput, key: unknown, signature: unknown, data: unknown): Promise<boolean> {
    if (algName(alg) !== 'HMAC') throw notSupported(`verify ${algName(alg)}`)
    const want = hmac(sha256, keyBytes(key, 'HMAC', 'verify'), bytes(data, 'data'))
    const got = bytes(signature, 'signature')
    if (got.length !== want.length) return false
    let d = 0
    for (let i = 0; i < want.length; i++) d |= want[i] ^ got[i]
    return d === 0
  },

  async encrypt(alg: AlgInput, key: unknown, data: unknown): Promise<ArrayBuffer> {
    const { iv, aad } = gcmParams(alg)
    return out(gcm(keyBytes(key, 'AES-GCM', 'encrypt'), iv, aad).encrypt(bytes(data, 'data')))
  },

  async decrypt(alg: AlgInput, key: unknown, data: unknown): Promise<ArrayBuffer> {
    const { iv, aad } = gcmParams(alg)
    const k = keyBytes(key, 'AES-GCM', 'decrypt')
    const ct = bytes(data, 'data')
    if (ct.length < 16) throw domError('OperationError', 'ciphertext curto demais')
    try {
      return out(gcm(k, iv, aad).decrypt(ct))
    } catch {
      // mesma semântica do WebCrypto: falha de autenticação = OperationError sem detalhes
      throw domError('OperationError', 'falha de autenticação AES-GCM')
    }
  },

  async deriveBits(alg: AlgInput, key: unknown, length: number): Promise<ArrayBuffer> {
    if (typeof alg === 'string' || algName(alg) !== 'HKDF')
      throw notSupported(`deriveBits ${algName(alg)}`)
    if (hashName(alg.hash) !== 'SHA-256') throw notSupported(`HKDF com ${hashName(alg.hash)}`)
    if (!Number.isInteger(length) || length <= 0 || length % 8 !== 0)
      throw domError('OperationError', 'length precisa ser múltiplo de 8')
    const ikm = keyBytes(key, 'HKDF', 'deriveBits')
    return out(hkdf(sha256, ikm, bytes(alg.salt, 'salt'), bytes(alg.info, 'info'), length / 8))
  }
}

export type ShimSubtle = typeof subtle
