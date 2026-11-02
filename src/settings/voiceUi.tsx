// Peças das telas de voz: provedor de voz (só os que servem a capacidade — STT: OpenAI-compatível/
// OpenRouter; TTS: + ElevenLabs), modelo/voz pela listagem do provedor (catálogo vendorado do
// desktop: `/models` do OpenRouter, `/v1/models`/`/v1/voices` da ElevenLabs, lista embutida quando
// o provedor não lista) com id digitado, e um "Testar voz".
import Ionicons from '@expo/vector-icons/Ionicons'
import { useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import type { Provider } from '@shared/types'
import type { VoiceCatalogView } from '@shared/voiceCatalog'
import { listVoiceCatalog } from '@vendor/desktop/voice/voiceCatalog'
import { voiceProviders } from '@/voice/endpoints'
import { Multiline, NumberField, Segmented } from '@/settings/ui'
import { Sheet, SheetItem } from '@/ui/Sheet'
import { colors, radius, spacing } from '@/ui/theme'

/** Catálogo de modelos/vozes do provedor (cache de 10 min no módulo vendorado). */
export function useVoiceCatalog(
  capability: 'stt' | 'tts',
  provider: Provider | null,
  enabled: boolean
): { view: VoiceCatalogView | null; loading: boolean; refresh: () => void } {
  const [tick, setTick] = useState(0)
  const [res, setRes] = useState<{ key: string; view: VoiceCatalogView } | null>(null)
  const pid = provider?.id ?? null
  const key = enabled && pid ? `${capability}:${pid}:${tick}` : null
  useEffect(() => {
    if (!key || !provider) return
    let alive = true
    void listVoiceCatalog(
      { capability, providerId: provider.id, ...(tick ? { refresh: true } : {}) },
      { provider: (id) => (id === provider.id ? provider : null) }
    ).then((view) => {
      if (alive) setRes({ key, view })
    })
    return () => {
      alive = false
    }
    // o provedor entra pelo id (objeto novo a cada leitura do cache)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return {
    view: provider && res && res.view.providerId === pid ? res.view : null,
    loading: !!key && res?.key !== key,
    refresh: () => setTick((t) => t + 1)
  }
}

/** Linha clicável com valor (abre uma folha). */
export function PickRow({
  icon,
  title,
  value,
  sub,
  onPress,
  testID,
  disabled
}: {
  icon: React.ComponentProps<typeof Ionicons>['name']
  title: string
  value: string
  sub?: string | null
  onPress: () => void
  testID?: string
  disabled?: boolean
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        st.row,
        pressed && { backgroundColor: colors.hover },
        disabled && { opacity: 0.5 }
      ]}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={title}
    >
      <Ionicons name={icon} size={19} color={colors.accentStrong} />
      <View style={{ flex: 1 }}>
        <Text style={st.rowTitle}>{title}</Text>
        <Text style={st.rowValue} numberOfLines={1}>
          {value}
        </Text>
        {sub ? (
          <Text style={st.rowSub} numberOfLines={3}>
            {sub}
          </Text>
        ) : null}
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.subtle} />
    </Pressable>
  )
}

/** Provedor de voz (sem nenhum = "Nenhum"). */
export function VoiceProviderField({
  capability,
  providers,
  value,
  onChange,
  testID
}: {
  capability: 'stt' | 'tts'
  providers: Provider[]
  value: string | null
  onChange: (id: string | null) => void
  testID?: string
}) {
  const [open, setOpen] = useState(false)
  const list = voiceProviders(providers, capability)
  const cur = value ? providers.find((p) => p.id === value) : null
  return (
    <>
      <PickRow
        icon="server-outline"
        title="Provedor"
        value={cur ? cur.name : value ? 'Provedor apagado' : 'Nenhum'}
        sub={
          !list.length
            ? capability === 'stt'
              ? 'Cadastre um provedor OpenAI-compatível ou OpenRouter em Provedores.'
              : 'Cadastre um provedor OpenAI-compatível, OpenRouter ou ElevenLabs em Provedores.'
            : value && !cur
              ? 'O provedor escolhido não existe neste aparelho.'
              : null
        }
        onPress={() => setOpen(true)}
        testID={testID}
      />
      <Sheet visible={open} onClose={() => setOpen(false)} title="Provedor">
        <SheetItem
          icon="remove-circle-outline"
          label="Nenhum"
          onPress={() => {
            setOpen(false)
            onChange(null)
          }}
          testID={testID ? `${testID}-none` : undefined}
        />
        {list.map((p) => (
          <SheetItem
            key={p.id}
            icon={p.id === value ? 'radio-button-on' : 'radio-button-off'}
            label={p.name}
            detail={p.baseUrl}
            onPress={() => {
              setOpen(false)
              onChange(p.id)
            }}
            testID={testID ? `${testID}-${p.name}` : undefined}
          />
        ))}
      </Sheet>
    </>
  )
}

/** Modelo ou voz da listagem do provedor, com id digitado. */
export function CatalogField({
  title,
  icon,
  value,
  items,
  loading,
  error,
  hint,
  onChange,
  onRefresh,
  emptyLabel,
  allowEmpty,
  testID
}: {
  title: string
  icon: React.ComponentProps<typeof Ionicons>['name']
  value: string
  items: { id: string; name?: string; detail?: string }[]
  loading?: boolean
  error?: string | null
  hint?: string | null
  onChange: (v: string) => void
  onRefresh?: () => void
  emptyLabel: string
  allowEmpty?: boolean
  testID?: string
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const cur = items.find((i) => i.id === value)
  const filtered = q.trim()
    ? items.filter((i) => `${i.id} ${i.name ?? ''}`.toLowerCase().includes(q.trim().toLowerCase()))
    : items
  const typed = q.trim()
  return (
    <>
      <PickRow
        icon={icon}
        title={title}
        value={
          value ? (cur?.name && cur.name !== value ? `${cur.name} · ${value}` : value) : emptyLabel
        }
        sub={error ?? hint ?? null}
        onPress={() => {
          setQ('')
          setOpen(true)
        }}
        testID={testID}
      />
      <Sheet visible={open} onClose={() => setOpen(false)} title={title} maxHeight="90%">
        <View style={st.search}>
          <Ionicons name="search" size={16} color={colors.subtle} />
          <TextInput
            value={q}
            onChangeText={setQ}
            placeholder="Buscar ou digitar o id"
            placeholderTextColor={colors.faint}
            style={st.searchInput}
            autoCapitalize="none"
            autoCorrect={false}
            testID={testID ? `${testID}-search` : undefined}
          />
          {loading ? <ActivityIndicator size={14} color={colors.accentStrong} /> : null}
          {onRefresh ? (
            <Pressable onPress={onRefresh} hitSlop={8} accessibilityLabel="Atualizar a lista">
              <Ionicons name="refresh" size={17} color={colors.muted} />
            </Pressable>
          ) : null}
        </View>
        {error ? <Text style={st.err}>{error}</Text> : null}
        {typed && !items.some((i) => i.id === typed) ? (
          <SheetItem
            icon="create-outline"
            label={`Usar “${typed}”`}
            onPress={() => {
              setOpen(false)
              onChange(typed)
            }}
            testID={testID ? `${testID}-typed` : undefined}
          />
        ) : null}
        {allowEmpty ? (
          <SheetItem
            icon="remove-circle-outline"
            label={emptyLabel}
            onPress={() => {
              setOpen(false)
              onChange('')
            }}
          />
        ) : null}
        {filtered.slice(0, 200).map((i) => (
          <SheetItem
            key={i.id}
            icon={i.id === value ? 'radio-button-on' : 'radio-button-off'}
            label={i.name || i.id}
            detail={
              [i.name && i.name !== i.id ? i.id : null, i.detail].filter(Boolean).join(' · ') ||
              undefined
            }
            onPress={() => {
              setOpen(false)
              onChange(i.id)
            }}
            testID={testID ? `${testID}-item-${i.id}` : undefined}
          />
        ))}
      </Sheet>
    </>
  )
}

const st = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: 12
  },
  rowTitle: { color: colors.muted, fontSize: 12.5 },
  rowValue: { color: colors.fg, fontSize: 15, marginTop: 1 },
  rowSub: { color: colors.subtle, fontSize: 12, marginTop: 2, lineHeight: 16 },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingHorizontal: 10
  },
  searchInput: { flex: 1, color: colors.fg, fontSize: 15, paddingVertical: 9 },
  err: { color: colors.danger, fontSize: 12.5, marginHorizontal: spacing.lg, marginBottom: 6 }
})

/** Parâmetros do modelo de voz (specs vendorados do desktop): só os escolhidos são gravados. */
export function VoiceParamsEditor({
  specs,
  values,
  onChange,
  testID
}: {
  specs: import('@shared/voiceParams').VoiceParamSpec[]
  values: import('@shared/voiceParams').VoiceParamValues
  onChange: (key: string, v: import('@shared/voiceParams').VoiceParamValue | null) => void
  testID?: string
}) {
  if (!specs.length) return null
  return (
    <View style={{ gap: spacing.sm }}>
      {specs.map((s) => {
        const cur = values[s.key]
        const tid = testID ? `${testID}-${s.key}` : undefined
        if (s.kind === 'number')
          return (
            <View key={s.key} style={{ gap: 2 }}>
              <NumberField
                label={s.label}
                value={typeof cur === 'number' ? cur : null}
                onChange={(v) => onChange(s.key, v ?? null)}
                min={s.min ?? 0}
                max={s.max ?? 1}
                int={(s.decimals ?? 2) === 0}
                placeholder={s.unsetLabel ?? (s.neutral != null ? String(s.neutral) : 'padrão')}
                testID={tid}
              />
              <Text style={pst.help}>{s.help}</Text>
            </View>
          )
        if (s.kind === 'boolean' || s.kind === 'select') {
          const options =
            s.kind === 'boolean'
              ? [
                  { value: '__unset', label: 'Padrão' },
                  { value: 'true', label: 'Sim' },
                  { value: 'false', label: 'Não' }
                ]
              : [
                  { value: '__unset', label: s.unsetLabel ?? 'Padrão' },
                  ...(s.options ?? []).map((o) => ({ value: o.value, label: o.label }))
                ]
          return (
            <View key={s.key} style={{ gap: 4 }}>
              <Text style={pst.label}>{s.label}</Text>
              <Segmented
                options={options}
                value={cur === undefined ? '__unset' : String(cur)}
                onChange={(o) =>
                  onChange(s.key, o === '__unset' ? null : s.kind === 'boolean' ? o === 'true' : o)
                }
                testID={tid}
              />
              <Text style={pst.help}>{s.help}</Text>
            </View>
          )
        }
        return (
          <View key={s.key} style={{ gap: 4 }}>
            <Text style={pst.label}>{s.label}</Text>
            <Multiline
              value={typeof cur === 'string' ? cur : ''}
              onChangeText={(t) => onChange(s.key, t.trim() ? t : null)}
              placeholder={s.placeholder}
              minHeight={60}
              testID={tid}
            />
            <Text style={pst.help}>{s.help}</Text>
          </View>
        )
      })}
    </View>
  )
}

const pst = StyleSheet.create({
  label: { color: colors.muted, fontSize: 13 },
  help: { color: colors.faint, fontSize: 11.5, lineHeight: 15 }
})
