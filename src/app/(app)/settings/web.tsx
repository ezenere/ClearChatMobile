// Configurações → Pesquisa na web (= desktop): buscadores do web_search em ordem de prioridade (o
// primeiro habilitado responde; se falhar, a mesma pesquisa passa ao próximo), liga/desliga, ↑/↓,
// chave de API mascarada (sem chave o buscador com API fica desligado), resultados por pesquisa,
// profundidade do Tavily e o intervalo mínimo entre pesquisas. Settings `webSearchEngines`,
// `webSearchApiKeys` e `webSearchMinIntervalSec` (sincronizados). Tela com FLAG_SECURE (chaves).
import Ionicons from '@expo/vector-icons/Ionicons'
import { useState } from 'react'
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native'
import {
  ENGINE_META,
  isApiEngine,
  moveEngine,
  SEARCH_INTERVAL_DEFAULT_S,
  SEARCH_INTERVAL_MAX_S,
  SEARCH_RESULTS_MAX,
  SEARCH_RESULTS_MIN,
  type EngineConfig,
  type SearchEngineId
} from '@shared/webSearchSettings'
import { describeError } from '@/account/errors'
import type { EngineState } from '@/settings/records'
import { readAt, settings, useSettingsVersion } from '@/settings/react'
import { Note, NumberField, Segmented, SettingsScreen } from '@/settings/ui'
import { Button, TextButton } from '@/ui/Button'
import { Banner, Card } from '@/ui/Card'
import { useSecureScreen } from '@/ui/secure'
import { TextField } from '@/ui/TextField'
import { useToast } from '@/ui/Toast'
import { colors, radius, spacing } from '@/ui/theme'

const toConfig = (e: EngineState): EngineConfig => ({
  id: e.id,
  enabled: e.enabled,
  options: e.options
})

export default function WebSearchSettings() {
  useSecureScreen()
  const toast = useToast()
  const version = useSettingsVersion()
  const { engines, interval } = readAt(version, () => ({
    engines: settings.engines(),
    interval: settings.searchInterval()
  }))
  const [error, setError] = useState<string | null>(null)
  const [keyFor, setKeyFor] = useState<SearchEngineId | null>(null)

  const save = (next: EngineConfig[]) => {
    try {
      settings.setEngines(next)
      setError(null)
    } catch (e) {
      setError(describeError(e))
    }
  }
  const patch = (id: SearchEngineId, p: Partial<EngineConfig>) =>
    save(engines.map((e) => (e.id === id ? { ...toConfig(e), ...p } : toConfig(e))))
  const move = (from: number, to: number) => save(moveEngine(engines.map(toConfig), from, to))
  const firstEnabled = engines.find((e) => e.enabled && !e.desktopOnly)?.id

  return (
    <SettingsScreen title="Pesquisa na web" testID="screen-web">
      <Note>
        O web_search usa o primeiro buscador habilitado da lista. Se ele falhar (sem chave, cota,
        captcha, rede ou resposta vazia), a mesma pesquisa passa para o próximo — os resultados
        nunca se misturam. Vale para todos os seus dispositivos.
      </Note>
      {error ? <Banner tone="danger">{error}</Banner> : null}
      <Card padded={false}>
        {engines.map((e, i) => {
          const meta = ENGINE_META[e.id]
          const canEnable = !meta.needsKey || e.hasKey
          return (
            <View key={e.id} style={[st.engine, i > 0 && st.sep]} testID={`engine-${e.id}`}>
              <View style={st.engineTop}>
                <View style={st.order}>
                  <Pressable
                    onPress={() => move(i, i - 1)}
                    disabled={i === 0}
                    hitSlop={6}
                    accessibilityLabel={`Subir ${meta.label}`}
                    testID={`engine-up-${e.id}`}
                  >
                    <Ionicons
                      name="chevron-up"
                      size={18}
                      color={i === 0 ? colors.faint : colors.muted}
                    />
                  </Pressable>
                  <Pressable
                    onPress={() => move(i, i + 1)}
                    disabled={i === engines.length - 1}
                    hitSlop={6}
                    accessibilityLabel={`Descer ${meta.label}`}
                    testID={`engine-down-${e.id}`}
                  >
                    <Ionicons
                      name="chevron-down"
                      size={18}
                      color={i === engines.length - 1 ? colors.faint : colors.muted}
                    />
                  </Pressable>
                </View>
                <View style={{ flex: 1, gap: 2 }}>
                  <View style={st.titleLine}>
                    <Text style={st.name}>{meta.label}</Text>
                    {e.id === firstEnabled ? <Text style={st.primary}>principal</Text> : null}
                  </View>
                  <Text style={st.desc}>
                    {e.desktopOnly
                      ? `${meta.description} Só no computador (o celular pula este).`
                      : meta.description}
                  </Text>
                </View>
                <Switch
                  value={e.enabled}
                  disabled={!canEnable}
                  onValueChange={(v) => patch(e.id, { enabled: v })}
                  trackColor={{ false: colors.active, true: colors.accent }}
                  thumbColor={e.enabled ? '#ffffff' : colors.muted}
                  accessibilityLabel={`Habilitar ${meta.label}`}
                  testID={`engine-toggle-${e.id}`}
                />
              </View>
              {isApiEngine(e.id) ? (
                <View style={st.extra}>
                  {keyFor === e.id ? (
                    <KeyEditor
                      id={e.id}
                      hasKey={e.hasKey}
                      onClose={() => setKeyFor(null)}
                      onSaved={(msg) => toast(msg)}
                    />
                  ) : (
                    <View style={st.keyLine}>
                      <Ionicons
                        name="key-outline"
                        size={14}
                        color={e.hasKey ? colors.success : colors.subtle}
                      />
                      <Text
                        style={[st.keyText, !e.keyMask && st.keyNone]}
                        testID={`engine-key-${e.id}`}
                      >
                        {e.keyMask ?? 'Sem chave — informe para habilitar'}
                      </Text>
                      <TextButton
                        title={e.hasKey ? 'Trocar' : 'Informar chave'}
                        onPress={() => setKeyFor(e.id)}
                        testID={`engine-setkey-${e.id}`}
                      />
                    </View>
                  )}
                  <NumberField
                    label="Resultados por pesquisa"
                    value={e.options.maxResults}
                    min={SEARCH_RESULTS_MIN}
                    max={SEARCH_RESULTS_MAX}
                    onChange={(v) =>
                      patch(e.id, { options: { ...e.options, maxResults: v ?? undefined } })
                    }
                    testID={`engine-results-${e.id}`}
                  />
                  {e.id === 'tavily' ? (
                    <Segmented
                      options={[
                        { value: 'basic', label: 'Básica' },
                        { value: 'advanced', label: 'Avançada' }
                      ]}
                      value={e.options.depth ?? 'advanced'}
                      onChange={(depth) => patch(e.id, { options: { ...e.options, depth } })}
                      testID="engine-depth"
                    />
                  ) : null}
                </View>
              ) : null}
            </View>
          )
        })}
      </Card>
      {!engines.some((e) => e.enabled && !e.desktopOnly) ? (
        <Banner tone="warning">
          Nenhum buscador habilitado neste celular: o web_search vai retornar erro.
        </Banner>
      ) : null}

      <Card>
        <NumberField
          label="Intervalo mínimo entre pesquisas"
          value={interval}
          min={0}
          max={SEARCH_INTERVAL_MAX_S}
          int={false}
          suffix="s"
          placeholder={String(SEARCH_INTERVAL_DEFAULT_S)}
          onChange={(v) => settings.setSearchInterval(v ?? SEARCH_INTERVAL_DEFAULT_S)}
          testID="web-interval"
        />
        <Note>Espera entre uma pesquisa e a próxima (evita captcha e limite de uso).</Note>
      </Card>
    </SettingsScreen>
  )
}

/**
 * Chave no lugar (não num diálogo: o Modal do Android é outra janela e não herda o FLAG_SECURE).
 */
function KeyEditor({
  id,
  hasKey,
  onClose,
  onSaved
}: {
  id: SearchEngineId
  hasKey: boolean
  onClose: () => void
  onSaved: (msg: string) => void
}) {
  const meta = ENGINE_META[id]
  const [key, setKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  const apply = (value: string | null) => {
    try {
      settings.setEngineKey(id, value)
      onSaved(value ? `Chave do ${meta.label} salva` : `Chave do ${meta.label} removida`)
      onClose()
    } catch (e) {
      setError(describeError(e))
    }
  }
  return (
    <View style={{ gap: spacing.sm }}>
      <TextField
        testID="engine-key-input"
        value={key}
        onChangeText={(v) => {
          setKey(v)
          setError(null)
        }}
        secure
        mono
        icon="key-outline"
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        importantForAutofill="no"
        autoFocus
        placeholder={meta.keyHint}
        error={error}
        hint={hasKey ? 'A chave atual fica até você salvar outra.' : meta.site}
      />
      <View style={{ flexDirection: 'row', gap: spacing.sm }}>
        <Button
          title="Cancelar"
          variant="secondary"
          size="sm"
          full={false}
          style={{ flex: 1 }}
          onPress={onClose}
        />
        <Button
          title="Salvar chave"
          size="sm"
          full={false}
          style={{ flex: 1 }}
          disabled={!key.trim()}
          onPress={() => apply(key)}
          testID="engine-key-save"
        />
      </View>
      {hasKey ? (
        <TextButton
          title="Remover a chave (desliga o buscador)"
          tone="danger"
          onPress={() => apply(null)}
          testID="engine-key-remove"
        />
      ) : null}
    </View>
  )
}

const st = StyleSheet.create({
  engine: { padding: spacing.md, gap: spacing.sm },
  sep: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  engineTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  order: { gap: 2 },
  titleLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  name: { color: colors.fg, fontSize: 15, fontWeight: '500' },
  primary: {
    color: colors.accentStrong,
    fontSize: 11,
    fontWeight: '600',
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: radius.sm,
    backgroundColor: colors.accentSoft,
    overflow: 'hidden'
  },
  desc: { color: colors.subtle, fontSize: 12.5, lineHeight: 17 },
  extra: { paddingLeft: 26, gap: 4 },
  keyLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  keyText: { flex: 1, color: colors.muted, fontSize: 13, fontFamily: 'monospace' },
  keyNone: { fontFamily: undefined, color: colors.subtle }
})
