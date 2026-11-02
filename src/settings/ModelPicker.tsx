// Escolha de provedor + modelo (lista do /models do provedor com busca, ou id digitado) e o campo
// que a abre — usados no Novo chat, nas personas, no modelo padrão, no título automático e no
// resumidor do Smart-Approve. Só provedores de chat (a ElevenLabs é só voz).
import Ionicons from '@expo/vector-icons/Ionicons'
import { useEffect, useState } from 'react'
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native'
import { isChatProvider } from '@shared/providerKinds'
import type { ModelInfo, Provider } from '@shared/types'
import { describeError } from '@/account/errors'
import { listModels } from '@/agent/providers'
import { Sheet } from '@/ui/Sheet'
import { colors, radius } from '@/ui/theme'

export interface ModelsState {
  pid: string
  list: ModelInfo[] | null
  error: string | null
}

/** Modelos do provedor (cache de 5 min do providers.ts). */
export function useModels(provider: Provider | null): ModelsState {
  const [models, setModels] = useState<ModelsState>({ pid: '', list: null, error: null })
  useEffect(() => {
    if (!provider) return
    let alive = true
    listModels(provider)
      .then((list) => alive && setModels({ pid: provider.id, list, error: null }))
      .catch(
        (e: unknown) =>
          alive && setModels({ pid: provider.id, list: null, error: describeError(e) })
      )
    return () => {
      alive = false
    }
  }, [provider])
  return models
}

export const chatProvidersOf = (list: Provider[]): Provider[] => list.filter(isChatProvider)

export function ModelPicker({
  visible,
  onClose,
  providers,
  providerId,
  model,
  models,
  error,
  onProvider,
  onModel,
  noneLabel,
  onNone
}: {
  visible: boolean
  onClose: () => void
  providers: { id: string; name: string }[]
  providerId: string
  model: string
  models: ModelInfo[] | null
  error: string | null
  onProvider: (id: string) => void
  onModel: (id: string) => void
  /** Opção "nenhum"/"usar o padrão" no topo (ex.: título automático desligado). */
  noneLabel?: string
  onNone?: () => void
}) {
  const [q, setQ] = useState('')
  const needle = q.trim().toLowerCase()
  const shown = (models ?? [])
    .filter(
      (m) =>
        !needle ||
        m.id.toLowerCase().includes(needle) ||
        (m.name ?? '').toLowerCase().includes(needle)
    )
    .slice(0, 300)
  return (
    <Sheet visible={visible} onClose={onClose} title="Modelo" testID="model-picker" maxHeight="90%">
      {noneLabel && onNone ? (
        <Pressable onPress={onNone} style={st.modelRow} testID="model-none">
          <Ionicons name="remove-circle-outline" size={16} color={colors.muted} />
          <Text style={[st.modelId, !model && { color: colors.accentStrong }]}>{noneLabel}</Text>
        </Pressable>
      ) : null}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={st.chips}
      >
        {providers.map((p) => {
          const on = p.id === providerId
          return (
            <Pressable
              key={p.id}
              onPress={() => onProvider(p.id)}
              style={[st.chip, on && st.chipOn]}
              testID={`provider-${p.name}`}
            >
              <Text style={[st.chipText, on && { color: colors.fg }]}>{p.name}</Text>
            </Pressable>
          )
        })}
      </ScrollView>
      <View style={st.search}>
        <Ionicons name="search" size={16} color={colors.subtle} />
        <TextInput
          testID="model-search"
          value={q}
          onChangeText={setQ}
          placeholder="Buscar ou digitar o id do modelo"
          placeholderTextColor={colors.faint}
          autoCapitalize="none"
          autoCorrect={false}
          style={st.searchInput}
        />
      </View>
      {q.trim() && !shown.some((m) => m.id === q.trim()) ? (
        <Pressable onPress={() => onModel(q.trim())} style={st.modelRow} testID="model-use-typed">
          <Ionicons name="create-outline" size={16} color={colors.accentStrong} />
          <Text style={st.modelId}>Usar “{q.trim()}”</Text>
        </Pressable>
      ) : null}
      {error ? <Text style={[st.hint, { color: colors.warning }]}>{error}</Text> : null}
      {!models && !error && providerId ? (
        <ActivityIndicator color={colors.accentStrong} style={{ marginVertical: 16 }} />
      ) : null}
      {shown.map((m) => (
        <Pressable
          key={m.id}
          onPress={() => onModel(m.id)}
          style={st.modelRow}
          testID={`model-${m.id}`}
        >
          <View style={{ flex: 1 }}>
            <Text
              style={[st.modelId, m.id === model && { color: colors.accentStrong }]}
              numberOfLines={1}
            >
              {m.id}
            </Text>
            {m.name || m.contextLength ? (
              <Text style={st.sub} numberOfLines={1}>
                {[
                  m.name,
                  m.contextLength ? `${Math.round(m.contextLength / 1000)}k` : null,
                  m.supportsTools === false ? 'sem tools' : null
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
            ) : null}
          </View>
          {m.id === model ? (
            <Ionicons name="checkmark" size={18} color={colors.accentStrong} />
          ) : null}
        </Pressable>
      ))}
    </Sheet>
  )
}

/**
 * Campo "Modelo" completo: linha com o modelo atual e a folha de escolha. `value` null = sem modelo
 * (mostra `placeholder`); com `noneLabel`, a folha oferece voltar a "nenhum".
 */
export function ModelField({
  providers,
  value,
  onChange,
  placeholder = 'Escolher modelo',
  noneLabel,
  testID,
  note
}: {
  providers: Provider[]
  value: { providerId: string | null; model: string | null } | null
  onChange: (v: { providerId: string; model: string } | null) => void
  placeholder?: string
  noneLabel?: string
  testID?: string
  /** Linha abaixo do modelo (ex.: "Segue o modelo padrão"). */
  note?: string | null
}) {
  const chat = chatProvidersOf(providers)
  const [open, setOpen] = useState(false)
  const [pid, setPid] = useState<string>(value?.providerId ?? chat[0]?.id ?? '')
  // valor trocado de fora (outro dispositivo): o provedor da folha acompanha (ajuste no render)
  const [seen, setSeen] = useState(value?.providerId ?? null)
  if ((value?.providerId ?? null) !== seen) {
    setSeen(value?.providerId ?? null)
    if (value?.providerId) setPid(value.providerId)
  }
  const provider = chat.find((p) => p.id === pid) ?? null
  const models = useModels(open ? provider : null)
  const current = value?.providerId ? chat.find((p) => p.id === value.providerId) : null
  const missing = !!value?.providerId && !current
  const info =
    models.pid === value?.providerId ? models.list?.find((m) => m.id === value?.model) : null
  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        style={st.card}
        testID={testID}
        disabled={!chat.length}
        accessibilityRole="button"
      >
        <Ionicons name="hardware-chip-outline" size={20} color={colors.accentStrong} />
        <View style={{ flex: 1 }}>
          <Text style={st.cardTitle} numberOfLines={1}>
            {value?.model && !missing
              ? value.model
              : chat.length
                ? placeholder
                : 'Sem provedor de chat'}
          </Text>
          <Text style={st.sub} numberOfLines={2}>
            {missing
              ? 'O provedor deste modelo não existe mais.'
              : current
                ? `${current.name}${info?.contextLength ? ` · ${Math.round(info.contextLength / 1000)}k de contexto` : ''}`
                : chat.length
                  ? 'Toque para escolher'
                  : 'Cadastre um provedor primeiro.'}
          </Text>
          {note ? (
            <Text style={st.sub} numberOfLines={2}>
              {note}
            </Text>
          ) : null}
        </View>
        <Ionicons name="chevron-forward" size={18} color={colors.subtle} />
      </Pressable>
      <ModelPicker
        visible={open}
        onClose={() => setOpen(false)}
        providers={chat}
        providerId={pid}
        model={value?.providerId === pid ? (value?.model ?? '') : ''}
        models={models.pid === pid ? models.list : null}
        error={models.pid === pid ? models.error : null}
        onProvider={setPid}
        onModel={(m) => {
          onChange({ providerId: pid, model: m })
          setOpen(false)
        }}
        noneLabel={noneLabel}
        onNone={
          noneLabel
            ? () => {
                onChange(null)
                setOpen(false)
              }
            : undefined
        }
      />
    </>
  )
}

const st = StyleSheet.create({
  hint: { color: colors.subtle, fontSize: 12.5, lineHeight: 18 },
  chips: { gap: 8, paddingVertical: 4 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border
  },
  chipOn: { backgroundColor: colors.active, borderColor: colors.accent },
  chipText: { color: colors.muted, fontSize: 13 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface
  },
  cardTitle: { color: colors.fg, fontSize: 15, fontWeight: '500' },
  sub: { color: colors.subtle, fontSize: 12.5 },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginVertical: 8,
    paddingHorizontal: 12,
    height: 42,
    borderRadius: radius.md,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border
  },
  searchInput: { flex: 1, color: colors.fg, fontSize: 15, paddingVertical: 0 },
  modelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 11,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border
  },
  modelId: { color: colors.fg, fontSize: 14.5 }
})
