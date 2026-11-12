// Configurações → Personas → editar/criar (= editor do desktop, enxuto): ícone, nome, descrição e
// as abas Modelo (par provedor + modelo ou "usar o padrão", parâmetros), Chat (system prompt,
// janela/compactação, assinatura do app, opções do computador), Ferramentas (as que rodam também no celular e as só do computador) e
// Memória (coleções ativas e onde grava — é a persona que define a memória dos chats novos) e
// Voz (a chamada de voz da persona — `VoiceConfigEditor`).
// Campos não alterados seguem "Novos chats"; os que o celular não edita ficam como estão.
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useState } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { DEFAULT_SYSTEM_PROMPT } from '@shared/defaults'
import { normalizeMemoryConfig, type MemoryCollection } from '@shared/memory'
import { patchPresetConfig, type PresetConfig } from '@shared/presets'
import { TOOL_LABELS, TOOL_NAMES } from '@shared/tools'
import type { ChatConfig, ToolName } from '@shared/types'
import { describeError } from '@/account/errors'
import { MOBILE_TOOLS } from '@/agent/request'
import { locationToolHelp, toolLabel } from '@/agent/toolLabels'
import { LOCATION_TOOLS } from '@/location/service'
import { ChatAvatar } from '@/chat/ChatBits'
import { MemoryConfigEditor } from '@/settings/MemoryConfigEditor'
import { VoiceConfigEditor } from '@/settings/VoiceConfigEditor'
import { useVoiceCallInheritance } from '@/settings/voiceUi'
import { ComputerOptions, ContextEditor, SignatureEditor } from '@/settings/PersonaAdvanced'
import { ModelField, chatProvidersOf, useModels } from '@/settings/ModelPicker'
import { ParamsEditor, withParam } from '@/settings/ParamsEditor'
import { resolvePresetConfig } from '@/settings/records'
import { settings } from '@/settings/react'
import { FieldLabel, IconPicker, Multiline, Note, Segmented, SettingsScreen } from '@/settings/ui'
import { BottomBarButton } from '@/ui/BottomBar'
import { TextButton } from '@/ui/Button'
import { Banner, Card, Divider, ToggleRow } from '@/ui/Card'
import { TextField } from '@/ui/TextField'
import { useToast } from '@/ui/Toast'
import { colors, radius, spacing } from '@/ui/theme'

type Tab = 'model' | 'chat' | 'tools' | 'memory' | 'voice'

const TOOL_HELP: Partial<Record<ToolName, string>> = {
  web_search: 'Pesquisa na web pelos buscadores configurados.',
  browse_url: 'Abre e lê páginas.',
  list_models: 'Lista os modelos dos seus provedores.',
  ask_user: 'Faz perguntas de múltipla escolha a você.',
  delegate_task: 'Cria subagentes para tarefas paralelas.',
  send_to_chat: 'Manda mensagens a outros chats.',
  read_history: 'Lê o histórico completo (inclusive o compactado).'
}

function loadDefaults() {
  return {
    defaultModel: settings.setting<{ providerId?: string | null; model?: string | null }>(
      'defaultModel'
    ),
    defaultSystemPrompt: settings.setting<string>('defaultSystemPrompt') ?? null
  }
}

function loadCollections(): MemoryCollection[] {
  try {
    return settings.collections()
  } catch {
    return []
  }
}

export default function PersonaEditor() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const isNew = id === 'new'
  const router = useRouter()
  const toast = useToast()
  const [initial] = useState(() => (isNew ? null : settings.preset(id)))
  const [providers] = useState(() => settings.providers())
  const [defaults] = useState(loadDefaults)
  const [cols] = useState(loadCollections)
  const [name, setName] = useState(initial?.name ?? '')
  const [icon, setIcon] = useState(initial?.icon || 'sparkles')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [draft, setDraft] = useState<PresetConfig>(() => initial?.config ?? {})
  const [tab, setTab] = useState<Tab>('model')
  const [icons, setIcons] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const voiceInherit = useVoiceCallInheritance()
  const { cfg, missingProvider } = resolvePresetConfig(defaults, providers, draft)
  const patch = (p: Partial<ChatConfig>) => setDraft((d) => patchPresetConfig(d, p))
  const unset = (...keys: (keyof ChatConfig)[]) =>
    setDraft((d) => {
      const next = { ...d } as Record<string, unknown>
      for (const k of keys) delete next[k]
      return next as PresetConfig
    })

  const provider = chatProvidersOf(providers).find((p) => p.id === cfg.providerId) ?? null
  const models = useModels(tab === 'model' ? provider : null)
  const info =
    models.pid === cfg.providerId ? (models.list?.find((m) => m.id === cfg.model) ?? null) : null
  const ownModel = !!draft.model?.trim() && !missingProvider

  const save = () => {
    try {
      const saved = settings.savePreset(
        { name, description, icon, config: draft },
        isNew ? undefined : id,
        initial
          ? {
              name: initial.name,
              description: initial.description,
              icon: initial.icon,
              config: initial.config
            }
          : undefined
      )
      toast(isNew ? `Persona “${saved.name}” criada` : `Persona “${saved.name}” salva`)
      router.back()
    } catch (e) {
      setError(describeError(e))
    }
  }

  if (!isNew && !initial)
    return (
      <SettingsScreen title="Persona">
        <Banner tone="warning">Esta persona não existe mais (pode ter sido apagada).</Banner>
      </SettingsScreen>
    )

  const tools = cfg.enabledTools ?? []
  const toggleTool = (t: ToolName, on: boolean) =>
    patch({
      enabledTools: on ? [...tools.filter((x) => x !== t), t] : tools.filter((x) => x !== t)
    })
  // "também no celular" = as tools que o celular executa (MOBILE_TOOLS); o resto só no computador
  const portable = [...TOOL_NAMES, ...LOCATION_TOOLS].filter((t) => MOBILE_TOOLS.includes(t))
  const local = TOOL_NAMES.filter((t) => !MOBILE_TOOLS.includes(t))

  return (
    <SettingsScreen
      title={isNew ? 'Nova persona' : 'Persona'}
      testID="screen-persona"
      footer={
        <BottomBarButton
          title={isNew ? 'Criar persona' : 'Salvar persona'}
          icon="checkmark"
          disabled={!name.trim()}
          onPress={save}
          testID="persona-save"
        />
      }
    >
      <View style={st.head}>
        <Pressable
          onPress={() => setIcons((v) => !v)}
          accessibilityLabel="Escolher ícone"
          testID="persona-icon"
        >
          <ChatAvatar icon={icon} size={52} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <TextField
            testID="persona-name"
            label="Nome"
            value={name}
            onChangeText={setName}
            placeholder="Ex.: Revisor de código"
          />
        </View>
      </View>
      {icons ? (
        <Card>
          <IconPicker
            value={icon}
            onChange={(v) => {
              if (v) setIcon(v)
              setIcons(false)
            }}
          />
        </Card>
      ) : null}
      <TextField
        testID="persona-description"
        label="Descrição"
        value={description}
        onChangeText={setDescription}
        multiline
        submitBehavior="blurAndSubmit"
        placeholder="Opcional — para que serve esta persona"
      />
      {error ? <Banner tone="danger">{error}</Banner> : null}

      <Segmented
        options={[
          { value: 'model', label: 'Modelo' },
          { value: 'chat', label: 'Chat' },
          { value: 'tools', label: 'Tools' },
          { value: 'memory', label: 'Memória' },
          { value: 'voice', label: 'Voz' }
        ]}
        value={tab}
        onChange={setTab}
        testID="persona-tab"
      />
      <Note>Campos não alterados seguem “Novos chats”.</Note>

      {tab === 'model' ? (
        <>
          <ModelField
            providers={providers}
            value={cfg.model ? { providerId: cfg.providerId, model: cfg.model } : null}
            onChange={(v) =>
              v ? patch({ providerId: v.providerId, model: v.model }) : unset('providerId', 'model')
            }
            noneLabel="Usar o modelo padrão"
            note={
              missingProvider
                ? 'O provedor desta persona não existe mais — usando o modelo padrão.'
                : ownModel
                  ? 'Definido nesta persona.'
                  : 'Segue o modelo padrão de “Novos chats”.'
            }
            testID="persona-model"
          />
          {ownModel || missingProvider ? (
            <TextButton
              title="Usar o padrão"
              icon="arrow-undo-outline"
              onPress={() => unset('providerId', 'model')}
              testID="persona-model-default"
            />
          ) : null}
          {provider && cfg.model ? (
            <>
              <FieldLabel>Parâmetros</FieldLabel>
              <ParamsEditor
                provider={provider}
                model={cfg.model}
                info={info}
                params={cfg.params ?? {}}
                onParam={(k, v) =>
                  setDraft((d) => ({ ...d, params: withParam(d.params ?? {}, k, v) }))
                }
              />
            </>
          ) : null}
        </>
      ) : null}

      {tab === 'chat' ? (
        <>
          <FieldLabel
            right={
              draft.systemPrompt !== undefined ? (
                <TextButton
                  title="Usar o padrão"
                  icon="arrow-undo-outline"
                  onPress={() => unset('systemPrompt')}
                />
              ) : undefined
            }
          >
            System prompt
          </FieldLabel>
          <Multiline
            testID="persona-system-prompt"
            value={cfg.systemPrompt ?? DEFAULT_SYSTEM_PROMPT}
            onChangeText={(systemPrompt) => patch({ systemPrompt })}
            minHeight={150}
          />
          <Note>
            {draft.systemPrompt !== undefined
              ? 'Definido nesta persona.'
              : 'Segue o system prompt padrão de “Novos chats”.'}
          </Note>
          <ContextEditor cfg={cfg} patch={patch} />
          <SignatureEditor cfg={cfg} patch={patch} />
          <ComputerOptions cfg={cfg} patch={patch} />
        </>
      ) : null}

      {tab === 'tools' ? (
        <>
          <FieldLabel>Também no celular</FieldLabel>
          <Card padded={false}>
            {portable.map((t, i) => (
              <View key={t} style={st.toolRow}>
                {i ? <Divider /> : null}
                <ToggleRow
                  title={toolLabel(t)}
                  subtitle={TOOL_HELP[t] ?? locationToolHelp(t)}
                  value={tools.includes(t)}
                  onChange={(v) => toggleTool(t, v)}
                  testID={`persona-tool-${t}`}
                />
              </View>
            ))}
          </Card>
          <FieldLabel>Só no computador</FieldLabel>
          <Card padded={false}>
            {local.map((t, i) => (
              <View key={t} style={st.toolRow}>
                {i ? <Divider /> : null}
                <ToggleRow
                  title={TOOL_LABELS[t]}
                  value={tools.includes(t)}
                  onChange={(v) => toggleTool(t, v)}
                  testID={`persona-tool-${t}`}
                />
              </View>
            ))}
          </Card>
          <Note>
            Com uma ferramenta local ligada, os chats desta persona criados no celular nascem sem
            ela (o celular não executa arquivos, shell nem processos); no computador ela vale.
          </Note>
        </>
      ) : null}

      {tab === 'memory' ? (
        <View style={st.memory}>
          <MemoryConfigEditor
            cfg={normalizeMemoryConfig(cfg.memory)}
            cols={cols}
            onChange={(memory) => patch({ memory })}
          />
        </View>
      ) : null}

      {tab === 'voice' ? (
        <VoiceConfigEditor
          value={cfg.voice}
          onChange={(voice) => patch({ voice })}
          providers={providers}
          defaults={voiceInherit.defaults}
          tagsSupport={voiceInherit.tagsSupport}
          chatTools={cfg.enabledTools ?? null}
        />
      ) : null}
    </SettingsScreen>
  )
}

const st = StyleSheet.create({
  toolRow: { paddingHorizontal: spacing.lg, paddingVertical: 2 },
  head: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.md },
  memory: {
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md
  }
})
