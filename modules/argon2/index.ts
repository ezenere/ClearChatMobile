// Argon2id nativo (SYNC_PROTOCOL.md §3.4). Android: argon2kt 1.6.0 (implementação de referência
// phc-winner-argon2 em C, via JNI, libs alinhadas a 16 KB). iOS (fase 6, NÃO testado num aparelho
// ainda): a mesma referência em C (ios/vendor/phc-winner-argon2, tag 20190702) chamada pelo Swift —
// conferida contra os vetores compilando os mesmos .c no Linux; no iPhone, pelo self-test.
// Bytes trafegam em base64url sem padding. Nunca cai num Argon2 em JS (lento demais no Hermes).
import { requireNativeModule } from 'expo'
import { b64u, fromB64u } from '@vendor/site/crypto/encoding'
import type { Argon2Params } from '@/platform/argon2Types'

interface NativeArgon2 {
  argon2id(
    passwordB64u: string,
    saltB64u: string,
    iterations: number,
    memoryKiB: number,
    parallelism: number,
    hashLength: number
  ): Promise<string>
}

let native: NativeArgon2 | null = null
const load = (): NativeArgon2 => (native ??= requireNativeModule<NativeArgon2>('ClearChatArgon2'))

/** Argon2id v1.3 → `hashLength` bytes, calculado fora da thread do JS. */
export async function argon2idNative(p: Argon2Params): Promise<Uint8Array> {
  const out = await load().argon2id(
    b64u(p.password),
    b64u(p.salt),
    p.iterations,
    p.memorySize,
    p.parallelism,
    p.hashLength
  )
  return fromB64u(out)
}
