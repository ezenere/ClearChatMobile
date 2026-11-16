// Configurações → Tempo e mapas (= desktop; protocolo 1.16.0): o provedor da previsão do tempo (tool
// `weather`: Open-Meteo, o padrão sem chave, ou o Google) e a chave do Google Maps Platform
// (mascarada; "Testar" faz UMA chamada). Settings `weatherProvider` e `googleMapsApiKey`
// (sincronizados). Tela com FLAG_SECURE (chave).
import Ionicons from '@expo/vector-icons/Ionicons'
import { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { testGoogleWeatherKey } from '@shared/googleWeather'
import { WEATHER_PROVIDER_META, type WeatherProviderId } from '@shared/mapsSettings'
import { describeError } from '@/account/errors'
import { readAt, settings, useSettingsVersion } from '@/settings/react'
import { Segmented, SettingsScreen } from '@/settings/ui'
import { Button, TextButton } from '@/ui/Button'
import { Banner, Card } from '@/ui/Card'
import { useSecureScreen } from '@/ui/secure'
import { TextField } from '@/ui/TextField'
import { useToast } from '@/ui/Toast'
import { colors, spacing } from '@/ui/theme'

export default function MapsSettings() {
  useSecureScreen()
  const toast = useToast()
  const version = useSettingsVersion()
  const st = readAt(version, () => settings.maps())
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [testing, setTesting] = useState(false)
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null)

  const choose = (id: WeatherProviderId) => {
    try {
      settings.setWeatherProvider(id)
      setError(null)
    } catch (e) {
      setError(describeError(e))
    }
  }
  const runTest = async () => {
    const key = settings.googleMapsKey()
    if (!key) return
    setTesting(true)
    setTest(null)
    try {
      const r = await testGoogleWeatherKey(key, {
        fetch: (url, init) => fetch(url, init),
        signal: new AbortController().signal,
        timeoutMs: 20_000
      })
      setTest(r.ok ? { ok: true, text: r.text } : { ok: false, text: r.error })
    } catch (e) {
      setTest({ ok: false, text: describeError(e) })
    } finally {
      setTesting(false)
    }
  }

  return (
    <SettingsScreen
      title="Tempo e mapas"
      testID="screen-maps"
      help="Fonte da previsão do tempo (tool weather). O Google responde agora, até 10 dias e até 24 horas por vez; dias anteriores, mais de 10 dias e qualquer falha dele vão ao Open-Meteo naquela chamada, com o motivo no resultado. Vale para todos os seus dispositivos."
    >
      {error ? <Banner tone="danger">{error}</Banner> : null}
      <Card>
        <Text style={s.label}>Previsão do tempo</Text>
        <Segmented
          options={[
            { value: 'open-meteo', label: 'Open-Meteo' },
            { value: 'google', label: 'Google', disabled: !st.google.hasKey }
          ]}
          value={st.weatherProvider}
          onChange={choose}
          testID="weather-provider"
        />
        <Text style={s.hint}>{WEATHER_PROVIDER_META[st.weatherProvider].description}</Text>
      </Card>

      <Card>
        <Text style={s.label}>Google Maps Platform</Text>
        {editing ? (
          <KeyEditor
            hasKey={st.google.hasKey}
            onClose={() => setEditing(false)}
            onSaved={(msg) => {
              toast(msg)
              setTest(null)
            }}
          />
        ) : st.google.hasKey ? (
          <View style={s.keyLine}>
            <Ionicons name="key-outline" size={14} color={colors.success} />
            <Text style={s.keyText} testID="maps-key-mask">
              {st.google.keyMask ?? '••••'}
            </Text>
            <TextButton
              title={testing ? 'Testando…' : 'Testar'}
              onPress={() => void runTest()}
              testID="maps-key-test"
            />
            <TextButton title="Trocar" onPress={() => setEditing(true)} testID="maps-key-set" />
          </View>
        ) : (
          <Button
            title="Sem chave · Informar"
            variant="warning"
            size="sm"
            full={false}
            onPress={() => setEditing(true)}
            testID="maps-key-set"
          />
        )}
        {test ? (
          <Banner tone={test.ok ? 'success' : 'danger'} testID="maps-key-result">
            {test.text}
          </Banner>
        ) : null}
        <Text style={s.hint}>
          Chave do Google Cloud com o Maps Experience agent tools ativado. 10 mil chamadas grátis
          por mês; a previsão usa uma por momento (agora + 1 por dia + 1 por hora). Os termos do
          Google pedem citar a fonte (o resultado traz o link).
        </Text>
      </Card>
    </SettingsScreen>
  )
}

/** Chave no lugar (não num diálogo: o Modal do Android não herda o FLAG_SECURE). */
function KeyEditor({
  hasKey,
  onClose,
  onSaved
}: {
  hasKey: boolean
  onClose: () => void
  onSaved: (msg: string) => void
}) {
  const [key, setKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  const apply = (value: string | null) => {
    try {
      settings.setGoogleMapsKey(value)
      onSaved(value ? 'Chave do Google Maps salva' : 'Chave do Google Maps removida')
      onClose()
    } catch (e) {
      setError(describeError(e))
    }
  }
  return (
    <View style={{ gap: spacing.sm }}>
      <TextField
        testID="maps-key-input"
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
        placeholder="AIza…"
        error={error}
        hint={hasKey ? 'A chave atual fica até você salvar outra.' : undefined}
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
          testID="maps-key-save"
        />
      </View>
      {hasKey ? (
        <TextButton
          title="Remover a chave (volta ao Open-Meteo)"
          tone="danger"
          onPress={() => apply(null)}
          testID="maps-key-remove"
        />
      ) : null}
    </View>
  )
}

const s = StyleSheet.create({
  label: { color: colors.fg, fontSize: 15, fontWeight: '500', marginBottom: spacing.sm },
  hint: { color: colors.subtle, fontSize: 12.5, lineHeight: 17, marginTop: spacing.sm },
  keyLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  keyText: { flex: 1, color: colors.muted, fontSize: 13, fontFamily: 'monospace' }
})
