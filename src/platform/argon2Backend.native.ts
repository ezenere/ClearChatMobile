// Backend do Argon2id no aparelho: módulo nativo local (modules/argon2 — argon2kt, a implementação de
// referência em C via JNI). Roda fora da thread do JS.
import { argon2idNative } from '../../modules/argon2'
import type { Argon2Backend } from './argon2Types'

const NATIVE = 'nativo (argon2kt)'
let backend: Argon2Backend = argon2idNative
let name = NATIVE

export function setArgon2Backend(b: Argon2Backend | null, label = 'injetado'): void {
  backend = b ?? argon2idNative
  name = b ? label : NATIVE
}

/** Quem calcula o Argon2id neste runtime (o self-test mostra). */
export const argon2BackendName = (): string => name

export function getArgon2Backend(): Argon2Backend {
  return backend
}
