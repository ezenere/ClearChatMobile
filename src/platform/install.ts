// Camada de plataforma: instala o que falta no Hermes antes de qualquer outro módulo do app
// (importado primeiro pelo index.ts da raiz). Ver README.md § "Camada de plataforma".
import { installAbortSignal } from './abort'
import { installCrypto } from './cryptoGlobal'
import { installTextCodec } from './textCodec'
import { installUrl } from './url'

/** Polyfills efetivamente instalados neste runtime (o self-test mostra). */
export const installedPolyfills: string[] = [
  ...installTextCodec(),
  ...installUrl(),
  ...installAbortSignal()
]

const hadSubtle = !!globalThis.crypto?.subtle
installCrypto()
if (!hadSubtle) installedPolyfills.push('crypto.subtle (noble)')
