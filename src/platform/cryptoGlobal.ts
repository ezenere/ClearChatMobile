// Instala `globalThis.crypto` (getRandomValues, randomUUID, subtle) para a cripto vendorada do site
// rodar sem alterações. No RN nada disso existe; nos testes (`force`) troca o WebCrypto do Node pelo
// shim, para os vetores exercitarem exatamente o código que roda no aparelho.
import { randomSource } from './random'
import { subtle } from './subtle'

export function installCrypto(force = false): void {
  const current = globalThis.crypto as Partial<Crypto> | undefined
  if (!force && current?.subtle && current.getRandomValues && current.randomUUID) return
  const c = {
    getRandomValues:
      (!force && current?.getRandomValues?.bind(current)) || randomSource.getRandomValues,
    randomUUID: (!force && current?.randomUUID?.bind(current)) || randomSource.randomUUID,
    subtle: (!force && current?.subtle) || subtle
  }
  Object.defineProperty(globalThis, 'crypto', {
    value: c,
    configurable: true,
    enumerable: true,
    writable: true
  })
}
