// Asserções mínimas para os casos do self-test (rodam no Vitest e no aparelho, sem dependências).

export class AssertionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AssertionError'
  }
}

const show = (v: unknown): string => {
  const s = typeof v === 'string' ? JSON.stringify(v) : (JSON.stringify(v) ?? String(v))
  return s.length > 120 ? `${s.slice(0, 117)}...` : s
}

export function eq<T>(actual: T, expected: T, what = 'valor'): void {
  if (actual !== expected)
    throw new AssertionError(`${what}: esperado ${show(expected)}, veio ${show(actual)}`)
}

export function ok(cond: unknown, what: string): void {
  if (!cond) throw new AssertionError(what)
}

/** Igualdade estrutural (ordem das chaves não importa), como o toEqual do Vitest. */
export function deepEq(actual: unknown, expected: unknown, what = 'objeto'): void {
  if (!same(actual, expected))
    throw new AssertionError(`${what}: esperado ${show(expected)}, veio ${show(actual)}`)
}

function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every(
    (k) => k in b && same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
  )
}

export function throws(fn: () => unknown, what: string): void {
  try {
    fn()
  } catch {
    return
  }
  throw new AssertionError(`${what}: deveria lançar`)
}

export async function rejects(
  p: Promise<unknown>,
  what: string,
  errorClass?: abstract new (...args: never[]) => Error
): Promise<void> {
  try {
    await p
  } catch (e) {
    if (errorClass && !(e instanceof errorClass))
      throw new AssertionError(
        `${what}: esperado ${errorClass.name}, veio ${(e as Error)?.name}: ${(e as Error)?.message}`
      )
    return
  }
  throw new AssertionError(`${what}: deveria falhar`)
}
