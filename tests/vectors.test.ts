// Vetores do contrato + checagens da plataforma, os mesmos casos da tela /dev/selftest.
import { describe, it } from 'vitest'
import { allCases } from '../src/selftest/runner'

const bySuite = new Map<string, ReturnType<typeof allCases>>()
for (const c of allCases()) bySuite.set(c.suite, [...(bySuite.get(c.suite) ?? []), c])

for (const [suite, cases] of bySuite)
  describe(suite, () => {
    for (const c of cases) it(c.name, () => c.run())
  })
