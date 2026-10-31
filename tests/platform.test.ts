// Shims da plataforma contra as implementações de referência do Node (WebCrypto, zlib, TextDecoder,
// hash-wasm) com entradas aleatórias — além dos vetores fixos.
import { webcrypto } from 'node:crypto'
import { deflateRawSync as zlibDeflateRaw, inflateRawSync as zlibInflateRaw } from 'node:zlib'
import { argon2id as referenceArgon2id } from 'hash-wasm'
import { describe, expect, it } from 'vitest'
import { argon2id } from '../src/platform/hashWasm'
import { deflateRawSync, inflateRawSync } from '../src/platform/deflate'
import { subtle } from '../src/platform/subtle'
import { Utf8Decoder, Utf8Encoder } from '../src/platform/textCodec'

const ref = webcrypto.subtle
const rnd = (n: number): Uint8Array<ArrayBuffer> => webcrypto.getRandomValues(new Uint8Array(n))
const buf = (b: ArrayBuffer): string => Buffer.from(b).toString('hex')

describe('subtle (noble) = WebCrypto do Node', () => {
  it('SHA-256, HMAC, HKDF, AES-GCM em entradas aleatórias', async () => {
    for (let i = 0; i < 25; i++) {
      const data = rnd(i * 37)
      expect(buf(await subtle.digest('SHA-256', data))).toBe(buf(await ref.digest('SHA-256', data)))

      const hk = rnd(1 + (i % 64))
      const alg = { name: 'HMAC', hash: 'SHA-256' }
      const mine = await subtle.importKey('raw', hk, alg, false, ['sign'])
      const theirs = await ref.importKey('raw', hk, alg, false, ['sign'])
      expect(buf(await subtle.sign('HMAC', mine, data))).toBe(
        buf(await ref.sign('HMAC', theirs, data))
      )

      const ikm = rnd(32)
      const p = { name: 'HKDF', hash: 'SHA-256', salt: rnd(i % 3 === 0 ? 0 : 16), info: rnd(i) }
      const a = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
      const b = await ref.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
      expect(buf(await subtle.deriveBits(p, a, 256))).toBe(buf(await ref.deriveBits(p, b, 256)))

      const key = rnd(32)
      const g = { name: 'AES-GCM', iv: rnd(12), additionalData: rnd(i), tagLength: 128 }
      const ka = await subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt', 'decrypt'])
      const kb = await ref.importKey('raw', key, 'AES-GCM', false, ['encrypt', 'decrypt'])
      const ct = await subtle.encrypt(g, ka, data)
      expect(buf(ct)).toBe(buf(await ref.encrypt(g, kb, data)))
      expect(buf(await subtle.decrypt(g, ka, ct))).toBe(buf(data.buffer as ArrayBuffer))
      const bad = new Uint8Array(ct)
      bad[bad.length - 1] ^= 1
      await expect(subtle.decrypt(g, ka, bad)).rejects.toMatchObject({ name: 'OperationError' })
    }
  })
})

describe('deflate-raw (fflate) ↔ zlib', () => {
  it('interopera nos dois sentidos', () => {
    for (const n of [0, 1, 100, 5000, 300_000]) {
      const text = new TextEncoder().encode('{"k":"' + 'abc é ✓ '.repeat(n / 8) + '"}')
      const data = n % 2 ? rnd(n) : text
      expect(Buffer.from(zlibInflateRaw(deflateRawSync(data))).equals(Buffer.from(data))).toBe(true)
      expect(
        Buffer.from(inflateRawSync(zlibDeflateRaw(data), Infinity)).equals(Buffer.from(data))
      ).toBe(true)
    }
  })
})

describe('TextEncoder/TextDecoder (polyfill) = Node', () => {
  const nodeFatal = new TextDecoder('utf-8', { fatal: true })
  const nodeLoose = new TextDecoder('utf-8')
  it('bytes aleatórios: mesma saída e mesmos erros', () => {
    const fatal = new Utf8Decoder('utf-8', { fatal: true })
    const loose = new Utf8Decoder('utf-8')
    for (let i = 0; i < 2000; i++) {
      const b = rnd(i % 12)
      expect(loose.decode(b)).toBe(nodeLoose.decode(b))
      let want: string | null
      try {
        want = nodeFatal.decode(b)
      } catch {
        want = null
      }
      if (want === null) expect(() => fatal.decode(b)).toThrow(TypeError)
      else expect(fatal.decode(b)).toBe(want)
    }
  })
  it('encoder = Node (inclui surrogates soltos)', () => {
    const enc = new Utf8Encoder()
    for (const s of ['', 'abc', 'ação ✓ 𝄞', '\ud800x', 'x\udc00', '￿\u0000']) {
      expect(Buffer.from(enc.encode(s)).toString('hex')).toBe(
        Buffer.from(new TextEncoder().encode(s)).toString('hex')
      )
    }
  })
})

describe('shim do hash-wasm', () => {
  it('mesma saída que o hash-wasm chamado direto', async () => {
    for (const [password, t, m] of [
      ['a', 1, 8],
      ['correct horse battery staple — ação ✓', 2, 256],
      ['🔑', 3, 1024]
    ] as const) {
      const o = {
        password,
        salt: rnd(16),
        iterations: t,
        parallelism: 1,
        memorySize: m,
        hashLength: 32
      }
      expect(await argon2id({ ...o, outputType: 'hex' })).toBe(
        await referenceArgon2id({ ...o, outputType: 'hex' })
      )
    }
    // senha vazia: os dois recusam
    const o = {
      password: '',
      salt: rnd(16),
      iterations: 1,
      parallelism: 1,
      memorySize: 8,
      hashLength: 32
    }
    await expect(argon2id(o)).rejects.toThrow()
    await expect(referenceArgon2id(o)).rejects.toThrow()
  })
})
