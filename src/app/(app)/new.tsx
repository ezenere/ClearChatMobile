// Novo chat executado NESTE celular: persona (personas sincronizadas), provedor + modelo (provedores
// sincronizados; modelos pelo /models do provedor, com busca), parâmetros que o modelo aceita
// (@shared/modelParams) e as tools portáveis (pesquisa na web, abrir páginas, listar modelos,
// perguntar ao usuário). O chat nasce sem ferramentas locais (§8.9) e roda aqui ao enviar.
import Ionicons from '@expo/vector-icons/Ionicons'
import { useRouter } from 'expo-router'
import { useEffect, useMemo, useState } from 'react'
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { EFFORT_ORDER, paramRules, PARAM_KEYS, type ParamKey } from '@shared/modelParams'
import { providerKind } from '@shared/providerKinds'
import { TOOL_LABELS } from '@shared/tools'
import { ENGINE_META } from '@shared/webSearchSettings'
import type { ChatParams, ModelInfo, ReasoningEffort, ToolName } from '@shared/types'
import { describeError } from '@/account/errors'
import { ChatAvatar } from '@/chat/ChatBits'
import { store } from '@/data/native'
import { listModels } from '@/agent/providers'
import { MOBILE_TOOLS } from '@/agent/request'
import { searchPlan } from '@/agent/tools/web'
import { hostStack } from '@/host/native'
import {
  droppedLocalTools,
  finalizeNewChat,
  initialPresetId,
  presetFromPlain,
  resolveNewChat,
  type NewChatSettings
} from '@/host/newChat'
import { Button } from '@/ui/Button'
import { Banner, ToggleRow } from '@/ui/Card'
import { Sheet } from '@/ui/Sheet'
import { useToast } from '@/ui/Toast'
import { colors, radius } from '@/ui/theme'

const PARAM_UI: Record<
  Exclude<ParamKey, 'reasoning_effort'>,
  { label: string; min: number; max: number; int?: boolean; def: number }
> = {
  temperature: { label: 'Temperature', min: 0, max: 2, def: 0.7 },
  top_p: { label: 'Top P', min: 0, max: 1, def: 0.9 },
  top_k: { label: 'Top K', min: 0, max: 500, int: true, def: 40 },
  max_tokens: { label: 'Máx. de tokens', min: 1, max: 1_000_000, int: true, def: 4096 },
  frequency_penalty: { label: 'Frequency penalty', min: -2, max: 2, def: 0 },
  presence_penalty: { label: 'Presence penalty', min: -2, max: 2, def: 0 },
  repetition_penalty: { label: 'Repetition penalty', min: 0, max: 2, def: 1 },
  seed: { label: 'Seed', min: 0, max: 2 ** 31, int: true, def: 42 }
}

const EFFORT_LABEL: Partial<Record<ReasoningEffort, string>> = {
  none: 'nenhum',
  minimal: 'mínimo',
  low: 'baixo',
  medium: 'médio',
  high: 'alto',
  xhigh: 'muito alto',
  max: 'máximo'
}

const TOOL_HELP: Partial<Record<ToolName, string>> = {
  web_search: 'Pesquisa na web pelos buscadores configurados.',
  browse_url: 'Abre e lê páginas (sem executar JavaScript).',
  list_models: 'Lista os modelos dos seus provedores.',
  ask_user: 'Faz perguntas de múltipla escolha a você.'
}

export default function NewChatScreen() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const toast = useToast()
  const [presets] = useState(() =>
    store
      .plainsOf('preset')
      .map((r) => presetFromPlain(r.id, r.plain))
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))
  )
  const [providers] = useState(() =>
    hostStack.providers().filter((p) => providerKind(p) !== 'elevenlabs')
  )
  const [settings] = useState<NewChatSettings>(() => ({
    defaultModel: store.setting('defaultModel') ?? null,
    defaultSystemPrompt: store.setting<string>('defaultSystemPrompt') ?? null,
    defaultPresetId: store.setting<string>('defaultPresetId') ?? null
  }))
  const [presetId, setPresetId] = useState<string | null>(() =>
    initialPresetId(presets, settings.defaultPresetId)
  )
  const preset = presets.find((p) => p.id === presetId) ?? null
  const base = useMemo(
    () => resolveNewChat(settings, providers, preset),
    [settings, providers, preset]
  )
  const [providerId, setProviderId] = useState(base.providerId)
  const [model, setModel] = useState(base.model)
  const [params, setParams] = useState<ChatParams>(base.params ?? {})
  const [tools, setTools] = useState<ToolName[]>(base.enabledTools)
  const [picker, setPicker] = useState(false)
  const [creating, setCreating] = useState(false)

  /** Trocar de persona: o resto volta ao que ela define. */
  const pickPreset = (id: string) => {
    const b = resolveNewChat(settings, providers, presets.find((p) => p.id === id) ?? null)
    setPresetId(id)
    setProviderId(b.providerId)
    setModel(b.model)
    setParams(b.params ?? {})
    setTools(b.enabledTools)
  }

  const provider = providers.find((p) => p.id === providerId) ?? null
  const [models, setModels] = useState<{
    pid: string
    list: ModelInfo[] | null
    error: string | null
  }>({
    pid: '',
    list: null,
    error: null
  })
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
  const modelList = models.pid === providerId ? models.list : null
  const info = modelList?.find((m) => m.id === model) ?? null
  const rules = useMemo(
    () => (provider ? paramRules({ kind: providerKind(provider), model, info }) : null),
    [provider, model, info]
  )
  const dropped = droppedLocalTools(preset)
  const engines = searchPlan((id) => store.setting(id)).map((e) => ENGINE_META[e.id].label)

  const create = async () => {
    if (!provider || !model.trim()) {
      toast('Escolha o modelo do chat.', 'danger')
      return
    }
    setCreating(true)
    try {
      const config = finalizeNewChat(
        base,
        { providerId, model: model.trim(), params, tools, presetId },
        providers
      )
      const { chat } = hostStack.repo.createChat({ config, title: '' })
      router.replace({ pathname: '/chat/[id]', params: { id: chat.id } })
    } catch (e) {
      toast(describeError(e), 'danger')
      setCreating(false)
    }
  }

  const setParam = (k: ParamKey, v: number | string | undefined) => {
    setParams((p) => {
      const next = { ...p } as Record<string, unknown>
      if (v === undefined || v === '') delete next[k]
      else next[k] = v
      return next as ChatParams
    })
  }

  return (
    <View style={st.root} testID="screen-new-chat">
      <View style={[st.header, { paddingTop: insets.top + 4 }]}>
        <Pressable
          onPress={() => router.back()}
          hitSlop={10}
          style={st.iconBtn}
          accessibilityLabel="Voltar"
          testID="new-back"
        >
          <Ionicons name="chevron-back" size={24} color={colors.fg} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={st.title}>Novo chat</Text>
          <Text style={st.sub}>Executado neste celular</Text>
        </View>
      </View>
      <ScrollView
        contentContainerStyle={[st.body, { paddingBottom: insets.bottom + 110 }]}
        keyboardShouldPersistTaps="handled"
      >
        {!providers.length ? (
          <Banner tone="warning" title="Nenhum provedor">
            Cadastre um provedor (OpenRouter, Anthropic ou OpenAI-compatible) no app desktop ou no
            site — ele sincroniza para cá com a chave cifrada.
          </Banner>
        ) : null}

        {presets.length ? (
          <>
            <Text style={st.label}>Persona</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={st.chips}
            >
              {presets.map((p) => {
                const on = p.id === presetId
                return (
                  <Pressable
                    key={p.id}
                    onPress={() => pickPreset(p.id)}
                    style={[st.persona, on && st.personaOn]}
                    testID={`persona-${p.name}`}
                    accessibilityState={{ selected: on }}
                  >
                    <ChatAvatar icon={p.icon} size={30} />
                    <Text style={[st.personaText, on && { color: colors.fg }]} numberOfLines={1}>
                      {p.name || 'Persona'}
                    </Text>
                  </Pressable>
                )
              })}
            </ScrollView>
            {preset?.description ? <Text style={st.hint}>{preset.description}</Text> : null}
          </>
        ) : null}

        <Text style={st.label}>Modelo</Text>
        <Pressable
          onPress={() => setPicker(true)}
          style={st.card}
          testID="new-model"
          disabled={!providers.length}
        >
          <Ionicons name="hardware-chip-outline" size={20} color={colors.accentStrong} />
          <View style={{ flex: 1 }}>
            <Text style={st.cardTitle} numberOfLines={1}>
              {model || 'Escolher modelo'}
            </Text>
            <Text style={st.cardSub} numberOfLines={1}>
              {provider ? provider.name : 'Sem provedor'}
              {info?.contextLength
                ? ` · ${Math.round(info.contextLength / 1000)}k de contexto`
                : ''}
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.subtle} />
        </Pressable>

        {rules ? (
          <>
            <Text style={st.label}>Parâmetros</Text>
            <View style={st.box}>
              {PARAM_KEYS.filter(
                (k) => k !== 'reasoning_effort' && rules.supported.includes(k)
              ).map((k) => {
                const ui = PARAM_UI[k as Exclude<ParamKey, 'reasoning_effort'>]
                const v = params[k] as number | undefined
                return (
                  <View key={k} style={st.paramRow}>
                    <Text style={st.paramLabel}>{ui.label}</Text>
                    <TextInput
                      testID={`param-${k}`}
                      value={v === undefined ? '' : String(v)}
                      placeholder="padrão"
                      placeholderTextColor={colors.faint}
                      keyboardType="decimal-pad"
                      onChangeText={(t) => {
                        const n = Number(t.replace(',', '.'))
                        if (!t.trim()) setParam(k, undefined)
                        else if (Number.isFinite(n))
                          setParam(
                            k,
                            Math.min(ui.max, Math.max(ui.min, ui.int ? Math.round(n) : n))
                          )
                      }}
                      style={st.paramInput}
                    />
                  </View>
                )
              })}
              {rules.effort ? (
                <View style={{ gap: 6 }}>
                  <Text style={st.paramLabel}>Raciocínio</Text>
                  <View style={st.wrap}>
                    {[
                      undefined,
                      ...EFFORT_ORDER.filter((e) => rules.effort!.levels.includes(e))
                    ].map((e) => {
                      const on = params.reasoning_effort === e
                      return (
                        <Pressable
                          key={e ?? 'padrao'}
                          onPress={() => setParam('reasoning_effort', e)}
                          style={[st.chip, on && st.chipOn]}
                          testID={`effort-${e ?? 'padrao'}`}
                        >
                          <Text style={[st.chipText, on && { color: colors.fg }]}>
                            {e ? (EFFORT_LABEL[e] ?? e) : 'padrão'}
                          </Text>
                        </Pressable>
                      )
                    })}
                  </View>
                </View>
              ) : null}
              {PARAM_KEYS.some((k) => !rules.supported.includes(k)) ? (
                <Text style={st.hint}>
                  O modelo não aceita:{' '}
                  {PARAM_KEYS.filter((k) => !rules.supported.includes(k)).join(', ')} — esses não
                  vão na request.
                </Text>
              ) : null}
            </View>
          </>
        ) : null}

        <Text style={st.label}>Ferramentas</Text>
        <View style={st.box}>
          {MOBILE_TOOLS.map((t) => (
            <ToggleRow
              key={t}
              title={TOOL_LABELS[t]}
              subtitle={TOOL_HELP[t]}
              value={tools.includes(t)}
              onChange={(v) =>
                setTools((x) => (v ? [...x.filter((y) => y !== t), t] : x.filter((y) => y !== t)))
              }
              testID={`tool-${t}`}
            />
          ))}
          {tools.includes('web_search') ? (
            <Text style={st.hint}>
              {engines.length
                ? `Buscadores: ${engines.join(' → ')} (Configurações → Pesquisa na web no desktop).`
                : 'Nenhum buscador habilitado nas configurações sincronizadas.'}
            </Text>
          ) : null}
          {dropped.length ? (
            <Text style={st.hint} testID="new-dropped-tools">
              Ferramentas locais da persona (
              {dropped.map((t) => TOOL_LABELS[t as ToolName] ?? t).join(', ')}) ficam desligadas: o
              celular não executa arquivos, shell nem processos.
            </Text>
          ) : null}
        </View>
      </ScrollView>
      <View style={[st.footer, { paddingBottom: insets.bottom + 10 }]}>
        <Button
          title="Começar conversa"
          icon="chatbubble-ellipses-outline"
          loading={creating}
          disabled={!provider || !model.trim()}
          onPress={() => void create()}
          testID="new-create"
        />
      </View>
      <ModelPicker
        visible={picker}
        onClose={() => setPicker(false)}
        providers={providers}
        providerId={providerId}
        model={model}
        models={modelList}
        error={models.pid === providerId ? models.error : null}
        onProvider={(id) => {
          setProviderId(id)
          setModel('')
        }}
        onModel={(m) => {
          setModel(m)
          setPicker(false)
        }}
      />
    </View>
  )
}

function ModelPicker({
  visible,
  onClose,
  providers,
  providerId,
  model,
  models,
  error,
  onProvider,
  onModel
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
      {!models && !error ? (
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
              <Text style={st.cardSub} numberOfLines={1}>
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

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 6,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border
  },
  iconBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  title: { color: colors.fg, fontSize: 17, fontWeight: '600' },
  sub: { color: colors.subtle, fontSize: 12 },
  body: { padding: 16, gap: 8 },
  label: {
    color: colors.subtle,
    fontSize: 12.5,
    fontWeight: '600',
    marginTop: 10,
    textTransform: 'uppercase',
    letterSpacing: 0.4
  },
  hint: { color: colors.subtle, fontSize: 12.5, lineHeight: 18 },
  chips: { gap: 8, paddingVertical: 4 },
  persona: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 6,
    paddingRight: 12,
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    maxWidth: 200
  },
  personaOn: { backgroundColor: colors.active, borderColor: colors.accent },
  personaText: { color: colors.muted, fontSize: 14 },
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
  cardSub: { color: colors.subtle, fontSize: 12.5 },
  box: {
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    padding: 12,
    gap: 10
  },
  paramRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  paramLabel: { flex: 1, color: colors.fg, fontSize: 14 },
  paramInput: {
    width: 110,
    color: colors.fg,
    fontSize: 14,
    textAlign: 'right',
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderStrong
  },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border
  },
  chipOn: { backgroundColor: colors.active, borderColor: colors.accent },
  chipText: { color: colors.muted, fontSize: 13 },
  footer: {
    paddingHorizontal: 16,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.surface
  },
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
