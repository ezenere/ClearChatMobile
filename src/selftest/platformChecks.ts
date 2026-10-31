// Checagens da camada de plataforma (src/platform) — rodam no Vitest e no aparelho junto dos vetores.
import * as cc from '@/crypto'
import { inflateRaw } from '@/crypto'
import { subtle as shimSubtle } from '@/platform/subtle'
import { argon2id } from '@/platform/hashWasm'
import { normalizeBaseUrl } from '@vendor/desktop/sync/http'
import { deepEq, eq, ok, rejects, throws } from './assert'
import type { VectorCase } from './vectors'

const SUITE = 'plataforma'

export function platformCases(): VectorCase[] {
  const cases: VectorCase[] = []
  const add = (name: string, run: VectorCase['run']): void => {
    cases.push({ suite: SUITE, name, run })
  }

  add('crypto.subtle = shim noble; getRandomValues/randomUUID presentes', () => {
    ok(globalThis.crypto?.subtle === (shimSubtle as unknown), 'crypto.subtle não é o shim')
    const a = globalThis.crypto.getRandomValues(new Uint8Array(32))
    ok(
      a.some((x) => x !== 0),
      'getRandomValues devolveu zeros'
    )
    ok(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        crypto.randomUUID()
      ),
      'randomUUID v4'
    )
  })

  add('primitivas do site redirecionadas para src/platform/primitives (fflate)', () => {
    ok((cc as Record<string, unknown>).PLATFORM_PRIMITIVES === true, 'redirecionamento inativo')
  })

  add('inflateRaw respeita o teto (zip bomb)', async () => {
    const big = await cc.deflateRaw(new Uint8Array(200_000))
    ok(big.length < 2_000, 'deflate de zeros deveria ser pequeno')
    eq((await inflateRaw(big)).length, 200_000, 'tamanho descomprimido')
    await rejects(inflateRaw(big, 100_000), 'acima do teto')
    await rejects(inflateRaw(big.subarray(0, big.length - 2)), 'truncado')
  })

  add('subtle: erros como o WebCrypto (OperationError / NotSupportedError)', async () => {
    const k = await crypto.subtle.importKey('raw', new Uint8Array(32), 'AES-GCM', false, [
      'encrypt'
    ])
    await rejects(
      crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(12) }, k, new Uint8Array(32)),
      'uso não permitido'
    )
    await rejects(crypto.subtle.digest('SHA-1', new Uint8Array(1)), 'SHA-1 não suportado')
  })

  add('TextDecoder fatal recusa UTF-8 inválido', () => {
    throws(
      () => new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array([0xc3, 0x28])),
      'C3 28'
    )
    throws(() => cc.fromUtf8(new Uint8Array([0xed, 0xa0, 0x80])), 'surrogate em UTF-8')
    eq(cc.fromUtf8(cc.utf8('ação ✓ 𝄞')), 'ação ✓ 𝄞', 'roundtrip')
  })

  add('String.normalize (NFC/NFD)', () => {
    eq('a\u0301'.normalize('NFC'), '\u00e1', 'NFC')
    eq('\u00e1'.normalize('NFD'), 'a\u0301', 'NFD')
  })

  add('URL WHATWG + normalizeBaseUrl do sync (desktop vendorado)', () => {
    const u = new URL('http://[::1]:8100/a/../b?x=1#f')
    deepEq([u.host, u.pathname, u.search, u.hash], ['[::1]:8100', '/b', '?x=1', '#f'], 'partes')
    eq(new URL('../c', 'https://h.example/a/b/').href, 'https://h.example/a/c', 'relativa')
    throws(() => new URL('http://exa mple.com'), 'host com espaço')
    eq(
      normalizeBaseUrl(' Sync.Example.com/clear-chat/ '),
      'https://sync.example.com/clear-chat',
      'base'
    )
    eq(normalizeBaseUrl('http://10.0.2.2:8100'), 'http://10.0.2.2:8100', 'base local')
    throws(() => normalizeBaseUrl('ftp://x'), 'ftp')
  })

  add('AbortSignal.timeout / AbortSignal.any', async () => {
    ok(typeof AbortSignal.timeout === 'function', 'timeout')
    ok(typeof AbortSignal.any === 'function', 'any')
    const c = new AbortController()
    const any = AbortSignal.any([c.signal, AbortSignal.timeout(60_000)])
    c.abort(new Error('x'))
    ok(any.aborted, 'any propaga o abort')
    const t = AbortSignal.timeout(10)
    await new Promise((r) => setTimeout(r, 40))
    ok(t.aborted, 'timeout dispara')
  })

  add('shim do hash-wasm: hex = binary e validações', async () => {
    const o = {
      password: 'senha',
      salt: new Uint8Array(16),
      iterations: 2,
      parallelism: 1,
      memorySize: 64,
      hashLength: 32
    }
    const bin = await argon2id({ ...o, outputType: 'binary' })
    const h = await argon2id({ ...o, outputType: 'hex' })
    eq(cc.hex(bin), h, 'hex vs binary')
    await rejects(argon2id({ ...o, salt: new Uint8Array(4) }), 'salt curto')
    await rejects(argon2id({ ...o, memorySize: 4 }), 'memória < 8·p')
  })

  return cases
}
