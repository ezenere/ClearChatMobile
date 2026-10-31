// Self-test da cripto no aparelho (só em builds de desenvolvimento): roda todos os vetores do
// protocolo + checagens da plataforma e mede o Argon2id/AES-GCM. Abrir com
//   adb shell am start -a android.intent.action.VIEW -d clearchat://dev/selftest
// e ler o resumo no logcat (linha "CLEARCHAT_SELFTEST ...").
import { useEffect, useState } from 'react'
import { FlatList, Platform, StyleSheet, Text, View } from 'react-native'
import { argon2BackendName } from '@/platform/argon2Backend'
import { installedPolyfills } from '@/platform/install'
import { allCases, runBenchmarks, runCase, type Bench, type CaseResult } from '@/selftest/runner'
import { colors, font, radius, spacing } from '@/ui/theme'

type Phase = 'running' | 'bench' | 'done'

export default function SelfTest() {
  const [results, setResults] = useState<CaseResult[]>([])
  const [bench, setBench] = useState<Bench[]>([])
  const [phase, setPhase] = useState<Phase>('running')
  const [total] = useState(() => allCases().length)

  useEffect(() => {
    if (!__DEV__) return
    let cancelled = false
    void (async () => {
      const t0 = Date.now()
      const done: CaseResult[] = []
      for (const c of allCases()) {
        const r = await runCase(c)
        if (cancelled) return
        if (!r.ok) console.warn(`[selftest] FALHOU ${r.suite} › ${r.name}: ${r.error}`)
        done.push(r)
        setResults([...done])
      }
      const elapsed = Date.now() - t0
      setPhase('bench')
      let b: Bench[] = []
      try {
        b = await runBenchmarks()
      } catch (e) {
        console.warn(`[selftest] benchmark falhou: ${String(e)}`)
      }
      if (cancelled) return
      setBench(b)
      setPhase('done')
      const pass = done.filter((r) => r.ok).length
      const argon = b.filter((x) => x.name.startsWith('Argon2id')).map((x) => x.ms)
      const aes = b.filter((x) => x.name.startsWith('AES')).map((x) => x.ms)
      console.log(
        `CLEARCHAT_SELFTEST ${pass === done.length ? 'PASS' : 'FAIL'} pass=${pass} fail=${done.length - pass} ` +
          `total=${done.length} elapsed_ms=${elapsed} argon2_prod_ms=${argon.join(',')} ` +
          `aes_gcm_1mib_ms=${aes.join(',')} platform=${Platform.OS}/${Platform.Version} ` +
          `argon2=${argon2BackendName().replace(/ /g, '_')} hermes=${'HermesInternal' in globalThis} ` +
          `wasm=${typeof (globalThis as Record<string, unknown>).WebAssembly !== 'undefined'} ` +
          `polyfills=${installedPolyfills.join('|') || 'nenhum'}`
      )
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (!__DEV__)
    return (
      <View style={styles.root}>
        <Text style={styles.muted}>Disponível só em builds de desenvolvimento.</Text>
      </View>
    )

  const pass = results.filter((r) => r.ok).length
  const fail = results.length - pass
  const failed = results.filter((r) => !r.ok)
  const status =
    phase === 'running'
      ? `Rodando… ${results.length}/${total}`
      : fail
        ? `${fail} FALHA(S)`
        : 'Todos os vetores passaram'

  return (
    <View style={styles.root}>
      <View style={[styles.summary, { borderColor: fail ? colors.danger : colors.borderStrong }]}>
        <Text
          style={[
            styles.status,
            { color: fail ? colors.danger : phase === 'running' ? colors.fg : colors.success }
          ]}
        >
          {status}
        </Text>
        <Text style={styles.counts} testID="selftest-counts">
          {pass} ok · {fail} falha · {total} casos
        </Text>
        <Text style={styles.muted}>Argon2id: {argon2BackendName()}</Text>
        <Text style={styles.muted}>
          Polyfills: {installedPolyfills.length ? installedPolyfills.join(', ') : 'nenhum'}
        </Text>
        {phase === 'bench' && <Text style={styles.muted}>Medindo Argon2id e AES-GCM…</Text>}
        {bench.map((b) => (
          <Text key={b.name} style={styles.bench}>
            {b.name}: {b.ms} ms
          </Text>
        ))}
      </View>
      <FlatList
        data={[...failed, ...results.filter((r) => r.ok)]}
        keyExtractor={(r) => `${r.suite}/${r.name}`}
        renderItem={({ item }) => (
          <View style={styles.row}>
            <Text style={[styles.mark, { color: item.ok ? colors.success : colors.danger }]}>
              {item.ok ? '✓' : '✗'}
            </Text>
            <View style={styles.rowText}>
              <Text style={styles.caseName}>
                <Text style={styles.suite}>{item.suite} › </Text>
                {item.name}
              </Text>
              {item.error && <Text style={styles.error}>{item.error}</Text>}
            </View>
            <Text style={styles.ms}>{item.ms} ms</Text>
          </View>
        )}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, padding: spacing.md, gap: spacing.md },
  summary: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.xs
  },
  status: { fontSize: 20, fontWeight: '600' },
  counts: { color: colors.fg, fontSize: 15 },
  muted: { color: colors.muted, fontSize: 12 },
  bench: { color: colors.accentStrong, fontSize: 12, fontFamily: font.mono },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    paddingVertical: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border
  },
  mark: { width: 16, fontSize: 14, fontWeight: '700' },
  rowText: { flex: 1 },
  caseName: { color: colors.fg, fontSize: 12 },
  suite: { color: colors.subtle },
  error: { color: colors.danger, fontSize: 11, fontFamily: font.mono, marginTop: 2 },
  ms: { color: colors.faint, fontSize: 11, fontFamily: font.mono }
})
