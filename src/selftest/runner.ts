// Executa os casos do self-test (vetores + plataforma) e mede o Argon2id/AES-GCM no aparelho.
import { ARGON2_DEFAULT, encryptBlob, decryptBlob, passwordKek, type Subkeys } from '@/crypto'
import { platformCases } from './platformChecks'
import { vectorCases, type VectorCase } from './vectors'

export interface CaseResult {
  suite: string
  name: string
  ok: boolean
  ms: number
  error?: string
}

export interface Bench {
  name: string
  ms: number
}

export const allCases = (): VectorCase[] => [...vectorCases(), ...platformCases()]

export async function runCase(c: VectorCase): Promise<CaseResult> {
  const t0 = Date.now()
  try {
    await c.run()
    return { suite: c.suite, name: c.name, ok: true, ms: Date.now() - t0 }
  } catch (e) {
    const err = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
    return { suite: c.suite, name: c.name, ok: false, ms: Date.now() - t0, error: err }
  }
}

/** Tempos de referência: Argon2id de produção (64 MiB, t=3, p=1) e AES-GCM de 1 MiB (blob). */
export async function runBenchmarks(): Promise<Bench[]> {
  const out: Bench[] = []
  const salt = new Uint8Array(16).fill(7)
  for (let i = 1; i <= 2; i++) {
    const t0 = Date.now()
    await passwordKek('benchmark-password', salt, ARGON2_DEFAULT)
    out.push({ name: `Argon2id produção #${i} (m=64 MiB, t=3, p=1)`, ms: Date.now() - t0 })
  }
  const sk = { blob: new Uint8Array(32).fill(1), blobId: new Uint8Array(32) } as Subkeys
  const pt = new Uint8Array(1 << 20).fill(42)
  let t0 = Date.now()
  const ct = await encryptBlob(sk, 'u', 'b', pt, salt)
  out.push({ name: 'AES-256-GCM cifrar 1 MiB (blob CCB1)', ms: Date.now() - t0 })
  t0 = Date.now()
  await decryptBlob(sk, 'u', 'b', ct)
  out.push({ name: 'AES-256-GCM decifrar 1 MiB (blob CCB1)', ms: Date.now() - t0 })
  return out
}
