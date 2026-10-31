// Integração contra o servidor de sync REAL (local): `npm run test:integration`. Pulado sem
// CLEARCHAT_SYNC_TEST_URL e CLEARCHAT_SYNC_TEST_MAIL_LOG (ver README.md § "Servidor local").
// Mesma config dos unitários (aliases, camada de plataforma), só troca os arquivos.
import { defineConfig } from 'vitest/config'
import base from './vitest.config'

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['tests/integration/**/*.test.ts'],
    exclude: ['node_modules/**'],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    fileParallelism: false
  }
})
