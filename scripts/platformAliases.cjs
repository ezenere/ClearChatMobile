// Redirecionamentos de import que fazem os arquivos vendorados (src/vendor/, nunca editados) rodarem
// no RN. Usado pelo metro.config.js (app) e pelo vitest.config.ts (testes), para os dois resolverem
// igual. Devolve o caminho absoluto do substituto, ou null para seguir a resolução normal.
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const SITE_CRYPTO = path.join(ROOT, 'src/vendor/site/crypto')
const PLATFORM = path.join(ROOT, 'src/platform')

/** Imports externos dos vendorados → módulo da plataforma. */
const MODULES = {
  // Argon2id: hash-wasm precisa de WebAssembly (o Hermes não tem) → módulo nativo
  'hash-wasm': path.join(PLATFORM, 'hashWasm.ts'),
  // src/main/sync/stream.ts (desktop) só usa randomUUID
  'node:crypto': path.join(PLATFORM, 'nodeCrypto.ts')
}

/**
 * @param {string} request especificador do import
 * @param {string | undefined} importer caminho absoluto de quem importa
 */
function redirect(request, importer) {
  if (Object.prototype.hasOwnProperty.call(MODULES, request)) {
    // nos testes, o backend Node do Argon2 importa o hash-wasm REAL (fora de src/vendor)
    if (request === 'hash-wasm' && importer && !importer.startsWith(path.join(ROOT, 'src/vendor')))
      return null
    return MODULES[request]
  }
  // deflate-raw: as primitivas do site usam CompressionStream → src/platform/primitives.ts (fflate)
  if (request === './primitives' && importer && path.dirname(importer) === SITE_CRYPTO)
    return path.join(PLATFORM, 'primitives.ts')
  return null
}

module.exports = { redirect, ROOT }
