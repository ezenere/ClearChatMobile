// A URL do RN é uma aproximação por regex (não valida, resolve caminhos relativos de forma ingênua);
// o cliente do sync normaliza/valida URLs de servidor (§20.1), então troca pela implementação WHATWG.
import { setupURLPolyfill } from 'react-native-url-polyfill'

export function installUrl(): string[] {
  setupURLPolyfill()
  return ['URL', 'URLSearchParams']
}
