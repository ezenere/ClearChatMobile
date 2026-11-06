// Merge do primeiro login (SYNC_PROTOCOL.md §12, mesma tela do desktop — `MergeChoice`): o aparelho
// tem dados criados sem conta e a conta também tem dados online → "Priorizar online" ·
// "Priorizar local" com as contagens e o aviso dos chats com histórias diferentes. Também o
// progresso (baixando/unindo) e o erro com "Tentar de novo". Fica no lugar das telas da conta até
// o merge terminar (nada sincroniza antes).
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'
import { useState } from 'react'
import { describeError } from '@/account/errors'
import { account } from '@/account/native'
import { firstLoginMerge } from '@/data/native'
import type { MergeCounts, MergeInfo, MergePriority, MergeState } from '@/data/merge'
import { Button } from '@/ui/Button'
import { Banner, Card, Logo } from '@/ui/Card'
import { Hero, Screen } from '@/ui/Screen'
import { colors, spacing } from '@/ui/theme'

function CountTable({ info }: { info: MergeInfo }) {
  const rows: [string, keyof MergeCounts][] = [
    ['Provedores', 'providers'],
    ['Chats', 'chats'],
    ['Personas', 'presets'],
    ['Memórias', 'memories']
  ]
  return (
    <Card padded={false} testID="merge-counts">
      <View style={[st.row, st.headRow]}>
        <Text style={[st.cell, st.label]} />
        <Text style={[st.cell, st.head]}>Neste celular</Text>
        <Text style={[st.cell, st.head]}>Online</Text>
      </View>
      {rows.map(([label, k]) => (
        <View key={k} style={st.row}>
          <Text style={[st.cell, st.label]}>{label}</Text>
          <Text style={[st.cell, st.num]}>{info.local[k]}</Text>
          <Text style={[st.cell, st.num]}>{info.online[k]}</Text>
        </View>
      ))}
    </Card>
  )
}

export function MergeScreen({ state }: { state: MergeState }) {
  const [busy, setBusy] = useState<MergePriority | null>(null)
  const [error, setError] = useState<string | null>(null)
  const merge = firstLoginMerge()

  const choose = (p: MergePriority) => {
    if (!merge) return
    setBusy(p)
    setError(null)
    merge
      .resolve(p)
      .catch((e: unknown) => setError(describeError(e)))
      .finally(() => setBusy(null))
  }

  if (state.phase === 'checking' || state.phase === 'running')
    return (
      <Screen testID="screen-merge-progress">
        <View style={st.center}>
          <ActivityIndicator color={colors.accentStrong} size="large" />
          <Text style={st.centerTitle}>
            {state.phase === 'checking'
              ? 'Baixando os dados da conta…'
              : 'Unindo os dados deste celular à conta…'}
          </Text>
          <Text style={st.centerText}>Os dados são decifrados aqui, no aparelho.</Text>
        </View>
      </Screen>
    )

  if (state.phase === 'error')
    return (
      <Screen testID="screen-merge-error">
        <View style={st.top}>
          <Logo />
          <Hero
            title="Não deu para unir os dados"
            subtitle="Os dados deste celular continuam aqui, intactos. Nada foi enviado ainda."
          />
        </View>
        <Banner tone="danger">{state.error}</Banner>
        <View style={st.actions}>
          <Button
            title="Tentar de novo"
            icon="refresh"
            onPress={() => void merge?.begin()}
            testID="merge-retry"
          />
          <Button
            title="Sair da conta"
            variant="secondary"
            icon="log-out-outline"
            onPress={() => void account.logout()}
            testID="merge-logout"
          />
        </View>
      </Screen>
    )

  if (state.phase !== 'ask') return null
  const n = state.info.conflictingChats
  return (
    <Screen testID="screen-merge">
      <View style={st.top}>
        <Logo />
        <Hero
          title="Este celular já tem dados"
          subtitle="A conta também tem dados online. Os dois lados serão unidos; a prioridade decide quem vence quando a mesma coisa existe dos dois lados — e a versão perdedora dessas coisas é descartada."
        />
      </View>
      <CountTable info={state.info} />
      {n ? (
        <Banner tone="warning" testID="merge-conflicts">
          {n === 1
            ? '1 chat existe nos dois lados com histórias diferentes; a versão não priorizada será apagada.'
            : `${n} chats existem nos dois lados com histórias diferentes; a versão não priorizada será apagada.`}
        </Banner>
      ) : null}
      {state.info.localOnlyChats ? (
        <Banner tone="info" testID="merge-local-only">
          {state.info.localOnlyChats === 1
            ? '1 chat “Só neste aparelho” continua só neste celular — não entra na união. Depois, dá para salvá-lo online pela lista de chats.'
            : `${state.info.localOnlyChats} chats “Só neste aparelho” continuam só neste celular — não entram na união. Depois, dá para salvá-los online pela lista de chats.`}
        </Banner>
      ) : null}
      {error ? <Banner tone="danger">{error}</Banner> : null}
      <View style={st.choice}>
        <Button
          title="Priorizar online"
          variant="secondary"
          style={{ flex: 1 }}
          loading={busy === 'online'}
          disabled={!!busy}
          onPress={() => choose('online')}
          testID="merge-online"
        />
        <Button
          title="Priorizar local"
          style={{ flex: 1 }}
          loading={busy === 'local'}
          disabled={!!busy}
          onPress={() => choose('local')}
          testID="merge-local"
        />
      </View>
    </Screen>
  )
}

const st = StyleSheet.create({
  top: { gap: spacing.lg, marginTop: spacing.xl },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingHorizontal: 30,
    minHeight: 400
  },
  centerTitle: { color: colors.fg, fontSize: 16.5, fontWeight: '600', textAlign: 'center' },
  centerText: { color: colors.muted, fontSize: 14, textAlign: 'center' },
  actions: { gap: spacing.sm },
  choice: { flexDirection: 'row', gap: spacing.sm },
  row: { flexDirection: 'row', paddingHorizontal: 14, paddingVertical: 9 },
  headRow: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  cell: { flex: 1, fontSize: 14 },
  label: { color: colors.muted },
  head: { color: colors.subtle, fontSize: 12, textAlign: 'right' },
  num: { color: colors.fg, textAlign: 'right', fontVariant: ['tabular-nums'] }
})
