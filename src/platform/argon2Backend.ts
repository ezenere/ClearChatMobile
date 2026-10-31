// Backend do Argon2id fora do RN (Node/Vitest): precisa ser injetado (os testes usam o hash-wasm real,
// devDependency) — assim os vetores validam a interface do shim com a implementação de referência.
import type { Argon2Backend } from './argon2Types'

let backend: Argon2Backend | null = null
let name = 'nenhum'

export function setArgon2Backend(b: Argon2Backend | null, label = 'injetado'): void {
  backend = b
  name = b ? label : 'nenhum'
}

/** Quem calcula o Argon2id neste runtime (o self-test mostra). */
export const argon2BackendName = (): string => name

export function getArgon2Backend(): Argon2Backend {
  if (!backend) throw new Error('Argon2id: nenhum backend configurado nesta plataforma')
  return backend
}
