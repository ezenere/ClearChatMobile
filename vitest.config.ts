// Vitest (Node): mesmos aliases do tsconfig e mesmos redirecionamentos do Metro, para os testes
// exercitarem a cripto vendorada pela camada de plataforma (shim de subtle, fflate, shim do hash-wasm).
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vitest/config'

const require = createRequire(import.meta.url)
const { redirect } = require('./scripts/platformAliases.cjs') as {
  redirect: (request: string, importer?: string) => string | null
}
const src = fileURLToPath(new URL('./src', import.meta.url))

const platformAliases: Plugin = {
  name: 'clearchat-platform-aliases',
  enforce: 'pre',
  resolveId(source, importer) {
    return redirect(source, importer?.split('?')[0]) ?? null
  }
}

export default defineConfig({
  plugins: [platformAliases],
  resolve: {
    alias: [
      { find: /^@shared\//, replacement: `${src}/vendor/shared/` },
      { find: /^@vendor\//, replacement: `${src}/vendor/` },
      { find: /^@\//, replacement: `${src}/` }
    ]
  },
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/integration/**', 'node_modules/**'],
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    testTimeout: 60_000
  }
})
