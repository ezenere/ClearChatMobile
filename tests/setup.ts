// Ambiente dos testes = o do aparelho: WebCrypto do Node trocado pelo shim noble, sem
// CompressionStream/DecompressionStream (o Hermes não tem) e Argon2id pelo shim do hash-wasm com o
// hash-wasm real como backend (o módulo nativo não roda no Node; os vetores validam a interface).
import { argon2id as referenceArgon2id } from 'hash-wasm'
import { setArgon2Backend } from '../src/platform/argon2Backend'
import { installCrypto } from '../src/platform/cryptoGlobal'

installCrypto(true)

const g = globalThis as Record<string, unknown>
delete g.CompressionStream
delete g.DecompressionStream

setArgon2Backend(
  ({ password, salt, iterations, memorySize, parallelism, hashLength }) =>
    referenceArgon2id({
      password,
      salt,
      iterations,
      memorySize,
      parallelism,
      hashLength,
      outputType: 'binary'
    }),
  'hash-wasm (testes)'
)
