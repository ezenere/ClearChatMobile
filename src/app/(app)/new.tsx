// Novo chat executado NESTE celular: persona (personas sincronizadas), provedor + modelo (provedores
// sincronizados; modelos pelo /models do provedor, com busca), parâmetros que o modelo aceita
// (@shared/modelParams) e as tools portáveis (pesquisa na web, abrir páginas, listar modelos,
// perguntar ao usuário). O chat nasce sem ferramentas locais (§8.9) e roda aqui ao enviar.
import Ionicons from '@expo/vector-icons/Ionicons'
import { useRouter } from 'expo-router'
import { useMemo, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { providerKind } from '@shared/providerKinds'
import { ENGINE_META } from '@shared/webSearchSettings'
import type { ChatParams, ToolName } from '@shared/types'
import { describeError } from '@/account/errors'
import { useSession } from '@/account/react'
import { settings as settingsService } from '@/settings/react'
import { ChatAvatar } from '@/chat/ChatBits'
import { store } from '@/data/native'
import { MOBILE_TOOLS } from '@/agent/request'
import { locationToolHelp, toolLabel } from '@/agent/toolLabels'
import { searchPlan } from '@/agent/tools/web'
import { hostStack } from '@/host/native'
import { kv } from '@/account/native'
import {
  rememberChoice,
  STORAGE_TEXT,
  storageOffer,
  type NewChatStorage
} from '@/host/storageChoice'
import { useLiveSupported } from '@/live/react'
import {
  droppedLocalTools,
  finalizeNewChat,
  initialPresetId,
  presetFromPlain,
  resolveNewChat,
  type NewChatSettings
} from '@/host/newChat'
import { ModelPicker, useModels } from '@/settings/ModelPicker'
import { ParamsEditor, withParam } from '@/settings/ParamsEditor'
import { Button } from '@/ui/Button'
import { Banner, ToggleRow } from '@/ui/Card'
import { useToast } from '@/ui/Toast'
import { colors, radius } from '@/ui/theme'

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
  const local = useSession().phase === 'local'
  // §23.1/§23.10: "Salvar online" · "Só neste aparelho" (padrão = a última escolha daqui)
  const liveSupported = useLiveSupported()
  const offer = storageOffer(kv, !local, liveSupported)
  const [storagePick, setStoragePick] = useState<NewChatStorage | null>(null)
  const storage: NewChatStorage = offer.show ? (storagePick ?? offer.storage) : offer.storage
  /** Sem modelo padrão (começo do uso): o modelo escolhido aqui vira o padrão dos próximos. */
  const noDefault = !settings.defaultModel?.model
  const [saveDefault, setSaveDefault] = useState(true)

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
  const models = useModels(provider)
  const modelList = models.pid === providerId ? models.list : null
  const info = modelList?.find((m) => m.id === model) ?? null
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
      if (noDefault && saveDefault)
        settingsService.setSetting('defaultModel', { providerId, model: model.trim() })
      if (offer.show) rememberChoice(kv, storage)
      const { chat } = hostStack.repo.createChat({ config, title: '', storage })
      router.replace({ pathname: '/chat/[id]', params: { id: chat.id } })
    } catch (e) {
      toast(describeError(e), 'danger')
      setCreating(false)
    }
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
          <Text style={st.sub}>
            {storage === 'live' && !local
              ? 'Executado e guardado só neste celular'
              : 'Executado neste celular'}
          </Text>
        </View>
      </View>
      <ScrollView
        contentContainerStyle={[st.body, { paddingBottom: insets.bottom + 110 }]}
        keyboardShouldPersistTaps="handled"
      >
        {!providers.length ? (
          <Banner
            tone="warning"
            title="Nenhum provedor"
            testID="new-no-provider"
            action={
              <View style={{ marginTop: 8 }}>
                <Button
                  title="Adicionar provedor"
                  icon="add"
                  variant="secondary"
                  onPress={() =>
                    router.replace({ pathname: '/settings/provider/[id]', params: { id: 'new' } })
                  }
                  testID="new-add-provider"
                />
              </View>
            }
          >
            {local
              ? 'Cadastre um provedor (OpenRouter, Anthropic ou OpenAI-compatible) com a sua chave de API — ela fica só neste celular.'
              : 'Cadastre um provedor (OpenRouter, Anthropic ou OpenAI-compatible) em Configurações → Provedores — aqui ou no computador; ele sincroniza com a chave cifrada.'}
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

        {provider && noDefault ? (
          <ToggleRow
            title="Usar como modelo padrão"
            subtitle="Os próximos chats já abrem com este modelo (Configurações → Novos chats)."
            value={saveDefault}
            onChange={setSaveDefault}
            testID="new-save-default"
          />
        ) : null}

        {provider ? (
          <>
            <Text style={st.label}>Parâmetros</Text>
            <ParamsEditor
              provider={provider}
              model={model}
              info={info}
              params={params}
              onParam={(k, v) => setParams((p) => withParam(p, k, v))}
            />
          </>
        ) : null}

        {offer.show ? (
          <>
            <Text style={st.label}>Onde guardar</Text>
            <View style={st.storageRow} testID="new-storage">
              {(['online', 'live'] as const).map((k) => {
                const on = storage === k
                return (
                  <Pressable
                    key={k}
                    onPress={() => setStoragePick(k)}
                    style={[st.storage, on && st.storageOn]}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: on }}
                    testID={`new-storage-${k}`}
                  >
                    <View style={st.storageHead}>
                      <Ionicons
                        name={k === 'online' ? 'cloud-outline' : 'phone-portrait-outline'}
                        size={16}
                        color={on ? colors.accentStrong : colors.subtle}
                      />
                      <Text style={[st.storageTitle, on && { color: colors.fg }]}>
                        {STORAGE_TEXT[k].title}
                      </Text>
                    </View>
                    <Text style={st.storageText}>{STORAGE_TEXT[k].detail}</Text>
                  </Pressable>
                )
              })}
            </View>
          </>
        ) : null}

        <Text style={st.label}>Ferramentas</Text>
        <View style={st.box}>
          {MOBILE_TOOLS.map((t) => (
            <ToggleRow
              key={t}
              title={toolLabel(t)}
              subtitle={TOOL_HELP[t] ?? locationToolHelp(t)}
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
                ? `Buscadores: ${engines.join(' → ')} (Configurações → Pesquisa na web).`
                : 'Nenhum buscador habilitado nas configurações sincronizadas.'}
            </Text>
          ) : null}
          {dropped.length ? (
            <Text style={st.hint} testID="new-dropped-tools">
              Ferramentas locais da persona ({dropped.map((t) => toolLabel(t)).join(', ')}) ficam
              desligadas: o celular não executa arquivos, shell nem processos.
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
  storageRow: { flexDirection: 'row', gap: 10 },
  storage: {
    flex: 1,
    gap: 4,
    padding: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface
  },
  storageOn: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  storageHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  storageTitle: { color: colors.muted, fontSize: 14, fontWeight: '600' },
  storageText: { color: colors.subtle, fontSize: 12, lineHeight: 16 },
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
  footer: {
    paddingHorizontal: 16,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.surface
  }
})
