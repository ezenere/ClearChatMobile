// Substitui o pacote `hash-wasm` no app (o Hermes não tem WebAssembly): expõe o subconjunto que a
// cripto vendorada chama — `argon2id({...})` — com a MESMA saída do hash-wasm 4.12.0 (Argon2id v1.3),
// calculada pelo backend da plataforma (módulo nativo no aparelho; hash-wasm real nos testes Node).
import type { IArgon2Options } from 'hash-wasm'
import { getArgon2Backend } from './argon2Backend'

const enc = new TextEncoder()
const toBytes = (d: unknown, what: string): Uint8Array => {
  if (typeof d === 'string') return enc.encode(d)
  if (d instanceof Uint8Array) return d
  throw new TypeError(`argon2id: ${what} precisa ser string ou Uint8Array`)
}
const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

type Argon2Result<T> = T extends { outputType: 'binary' } ? Uint8Array : string

/** Mesmas validações do hash-wasm (lança nos mesmos casos inválidos). */
function validate(o: IArgon2Options, password: Uint8Array, salt: Uint8Array): void {
  const int = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n)
  if (password.length < 1) throw new Error('Password must be specified')
  if (salt.length < 8) throw new Error('Salt should be at least 8 bytes long')
  if (!int(o.iterations) || o.iterations < 1)
    throw new Error('Iterations should be a positive number')
  if (!int(o.parallelism) || o.parallelism < 1 || o.parallelism > 0xffffff)
    throw new Error('Parallelism should be a positive number')
  if (!int(o.hashLength) || o.hashLength < 4)
    throw new Error('Hash length should be at least 4 bytes.')
  if (!int(o.memorySize) || o.memorySize < 8 * o.parallelism)
    throw new Error('Memory size should be at least 8 * parallelism.')
  if (o.secret !== undefined) throw new Error('argon2id (mobile): secret não suportado')
  if (o.outputType === 'encoded')
    throw new Error('argon2id (mobile): outputType "encoded" não suportado')
}

export async function argon2id<T extends IArgon2Options>(options: T): Promise<Argon2Result<T>> {
  const password = toBytes(options.password, 'password')
  const salt = toBytes(options.salt, 'salt')
  validate(options, password, salt)
  const out = await getArgon2Backend()({
    password,
    salt,
    iterations: options.iterations,
    memorySize: options.memorySize,
    parallelism: options.parallelism,
    hashLength: options.hashLength
  })
  if (out.length !== options.hashLength) throw new Error('argon2id: tamanho de saída inesperado')
  if (options.outputType === 'binary') return out as Argon2Result<T>
  const h = hex(out)
  out.fill(0)
  return h as Argon2Result<T>
}
