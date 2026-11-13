// Novo chat executado NESTE celular: persona (personas sincronizadas), provedor + modelo (provedores
// sincronizados; modelos pelo /models do provedor, com busca), parâmetros que o modelo aceita
// (@shared/modelParams) e as tools: as que o celular roda e, esmaecidas, as só do computador — a
// lista do chat é a mesma em todo aparelho (§4.3.6); o celular só manda ao modelo as que executa.
// Como vão (1.11.0): "Enviar tools compactadas" com o que vai junto, o chip "compacta"/"completa" e a
// definição de cada uma; 1.12.0: o modo efetivo com o provedor + modelo escolhidos (busca nativa do
// provedor ou versão local, com o motivo e o aviso), "adiada"/"carregada" e o item exato.
// Nada vira próprio do chat por causa do aparelho, só o que o usuário muda aqui. Roda aqui ao enviar.
import Ionicons from '@expo/vector-icons/Ionicons'
import { useRouter } from 'expo-router'
import { useMemo, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { providerKind } from '@shared/providerKinds'
import { ENGINE_META } from '@shared/webSearchSettings'
import { withTool } from '@shared/deviceTools'
import type { ChatConfig, ChatParams, ToolName } from '@shared/types'
import { describeError } from '@/account/errors'
import { useSession } from '@/account/react'
import { readAt, settings as settingsService } from '@/settings/react'
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
  finalizeNewChat,
  initialPresetId,
  presetFromPlain,
  resolveNewChat,
  type NewChatSettings
} from '@/host/newChat'
import { ComputerToolsGroup } from '@/settings/ComputerTools'
import { CompactToolsCard, ToolSendLine } from '@/settings/ToolsSend'
import { toolSearchViewOf } from '@/settings/toolSearchUi'
import { useToolSearchCapsVersion } from '@/settings/useToolSearch'
import { ModelPicker, useModels } from '@/settings/ModelPicker'
import { ParamsEditor, withParam } from '@/settings/ParamsEditor'
import { Button } from '@/ui/Button'
import { BottomBarButton } from '@/ui/BottomBar'
import { Banner, ToggleRow } from '@/ui/Card'
import { useToast } from '@/ui/Toast'
import { colors, radius } from '@/ui/theme'

const TOOL_HELP: Partial<Record<ToolName, string>> = {
  web_search: 'Pesquisa na web pelos buscadores configurados.',
  browse_url: 'Abre e lê páginas (sem executar JavaScript).',
  list_models: 'Lista os modelos dos seus provedores.',
  ask_user: 'Faz perguntas de múltipla escolha a você.',
  datetime: 'Data e hora do celular, no fuso dele.'
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
  // como as tools vão (1.11.0): o que a persona (ou o padrão do app) define
  const [send, setSend] = useState<Pick<ChatConfig, 'toolsCompact' | 'toolsFull'>>({
    toolsCompact: base.toolsCompact,
    toolsFull: base.toolsFull
  })
  const sendCfg = { ...send, nativeTools: base.nativeTools }
  const patchSend = (p: Partial<ChatConfig>) =>
    setSend((s) => ({
      toolsCompact: p.toolsCompact ?? s.toolsCompact,
      toolsFull: p.toolsFull ?? s.toolsFull
    }))
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
    setSend({ toolsCompact: b.toolsCompact, toolsFull: b.toolsFull })
  }

  const provider = providers.find((p) => p.id === providerId) ?? null
  const models = useModels(provider)
  const modelList = models.pid === providerId ? models.list : null
  const info = modelList?.find((m) => m.id === model) ?? null
  const engines = searchPlan((id) => store.setting(id)).map((e) => ENGINE_META[e.id].label)
  // busca nativa (1.12.0): o modo com o provedor + modelo + tools do formulário (o da 1ª request)
  const tv = useToolSearchCapsVersion()
  const toolView = readAt(tv, () =>
    toolSearchViewOf({
      cfg: { ...base, providerId, model: model.trim(), params, enabledTools: tools, ...send },
      provider,
      model,
      models: modelList
    })
  )

  const create = async () => {
    if (!provider || !model.trim()) {
      toast('Escolha o modelo do chat.', 'danger')
      return
    }
    setCreating(true)
    try {
      const config = finalizeNewChat(
        base,
        { providerId, model: model.trim(), params, tools, presetId, ...send },
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
        <CompactToolsCard
          cfg={sendCfg}
          onChange={(toolsCompact) => patchSend({ toolsCompact })}
          sent={MOBILE_TOOLS.filter((t) => tools.includes(t))}
          view={toolView}
          testID="new-tools-compact"
        />
        <View style={st.box}>
          {MOBILE_TOOLS.map((t) => (
            <View key={t}>
              <ToggleRow
                title={toolLabel(t)}
                subtitle={TOOL_HELP[t] ?? locationToolHelp(t)}
                value={tools.includes(t)}
                onChange={(v) => setTools((x) => withTool(x, t, v))}
                testID={`tool-${t}`}
              />
              <ToolSendLine
                name={t}
                cfg={sendCfg}
                patch={patchSend}
                enabled={tools.includes(t)}
                view={toolView}
                testID={`new-tool-send-${t}`}
              />
            </View>
          ))}
          {tools.includes('web_search') ? (
            <Text style={st.hint}>
              {engines.length
                ? `Buscadores: ${engines.join(' → ')} (Configurações → Pesquisa na web).`
                : 'Nenhum buscador habilitado nas configurações sincronizadas.'}
            </Text>
          ) : null}
        </View>
        <ComputerToolsGroup
          tools={tools}
          onToggle={(t, v) => setTools((x) => withTool(x, t, v))}
          send={{ cfg: sendCfg, patch: patchSend, view: toolView }}
        />
      </ScrollView>
      <BottomBarButton
        title="Começar conversa"
        icon="chatbubble-ellipses-outline"
        loading={creating}
        disabled={!provider || !model.trim()}
        onPress={() => void create()}
        testID="new-create"
      />
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
  }
})
