// Digitação da chave de recuperação (§3.5): tolerante (minúsculas, espaços/hífens, O→0, I/L→1) e
// formatada em grupos de 4 enquanto digita. O checksum é conferido em parseRecoveryKey (vendorado).
import { normalizeRecoveryInput } from '@/crypto'

const CROCKFORD_RE = /[^0-9A-HJKMNP-TV-Z]/g

/** "abcd efgh-ijkl…" → "ABCD-EFGH-1JK1-…" (no máx. 36 caracteres úteis). */
export function formatRecoveryTyping(input: string): string {
  const s = normalizeRecoveryInput(input).replace(CROCKFORD_RE, '').slice(0, 36)
  return s.match(/.{1,4}/g)?.join('-') ?? ''
}

/** 36 caracteres válidos digitados (o checksum ainda pode falhar). */
export const recoveryInputComplete = (input: string): boolean =>
  normalizeRecoveryInput(input).replace(CROCKFORD_RE, '').length === 36
