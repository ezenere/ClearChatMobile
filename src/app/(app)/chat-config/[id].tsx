// Configurações de um chat (herança ao vivo da persona, protocolo 1.10.0 — §4.3.6; = abas Modelo ·
// Chat · Tools · Memória do painel do desktop, no jeito do celular). Os campos que o chat não mudou
// seguem a persona de origem AO VIVO (e, onde ela não define, "Novos chats"); um campo mudado aqui
// vira deste chat — marcado com "↺ neste chat" (tocar mostra o valor que voltaria e de onde ele vem,
// com "Voltar a herdar"). A persona é um seletor: outra persona mantém os campos deste chat; "Nenhuma"
// congela os valores atuais (explicado e confirmado aqui mesmo). Nas opções, a ★ marca o valor
// herdado e escolhê-la volta a herdar — nunca uma opção "herdar" duplicada.
// Chats do cache (executados aqui ou em outro dispositivo): grava o registro `chat` (LWW, §7.5).
// Chats só ao vivo de outro host (`?live=1`, §23.7): cada mudança vai ao host por `chat.update`.
// Tudo que a tela mostra é a config EFETIVA — o mesmo que vai ao modelo (nada escondido). As tools
// só do computador (§4.3.6) ficam na lista do chat, esmaecidas e alternáveis, com a nota de que o
// celular não as manda ao modelo. Tools compactadas (1.11.0): "Enviar tools compactadas" com o que vai
// junto (prompt fixo e tool_search), o chip "compacta"/"completa" e a definição que vai de cada tool;
// busca nativa (1.12.0): o modo efetivo deste chat + modelo calculado aqui com o resolvedor da
// request (busca nativa da Anthropic / do OpenRouter / versão local com o motivo e o aviso), chips
// "adiada"/"carregada" e o item exato de `tools[]` de cada tool.
import { useLocalSearchParams } from 'expo-router'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { readUnit, type InheritConfig } from '@shared/chatInherit'
import { DEFAULT_SYSTEM_PROMPT } from '@shared/defaults'
import { normalizeMemoryConfig, type MemoryCollection } from '@shared/memory'
import type { ParamKey } from '@shared/modelParams'
import { withTool } from '@shared/deviceTools'
import { TOOL_NAMES } from '@shared/tools'
import type { ChatConfig, ReasoningEffort, ToolName } from '@shared/types'
import { describeError } from '@/account/errors'
import { MOBILE_TOOLS } from '@/agent/request'
import { locationToolHelp, toolLabel } from '@/agent/toolLabels'
import { ChatAvatar } from '@/chat/ChatBits'
import {
  ChatInheritProvider,
  InheritInline,
  InheritLabel,
  type ChatInheritCtx
} from '@/chat/InheritMark'
import {
  inheritView,
  ownCountText,
  personaPatch,
  revertPatch,
  unitLabel,
  unitValueText
} from '@/chat/inheritUi'
import { chatTitle } from '@/data/decode'
import { chatRecordFrom, effectiveOf, inheritEnvOf, presetConfigOf } from '@/data/inherit'
import { engine, store } from '@/data/native'
import { hostStack } from '@/host/native'
import { live } from '@/live/native'
import { useLiveVersion } from '@/live/react'
import { remote } from '@/remote/native'
import { ComputerToolsGroup } from '@/settings/ComputerTools'
import { CompactToolsCard, OtherToolsGroup, ToolSendLine } from '@/settings/ToolsSend'
import { toolSearchViewOf } from '@/settings/toolSearchUi'
import { useToolSearchCapsVersion } from '@/settings/useToolSearch'
import { MemoryConfigEditor } from '@/settings/MemoryConfigEditor'
import { ModelField, chatProvidersOf, useModels } from '@/settings/ModelPicker'
import { ParamsEditor } from '@/settings/ParamsEditor'
import {
  ComputerOptions,
  ContextEditor,
  EnvironmentOption,
  SignatureEditor,
  type LabelFn
} from '@/settings/PersonaAdvanced'
import { readAt, settings, useSettingsVersion } from '@/settings/react'
import { FieldLabel, Multiline, Note, Row, SettingsScreen } from '@/settings/ui'
import { Button, TextButton } from '@/ui/Button'
import { Banner, Card, Divider, ToggleRow } from '@/ui/Card'
import { Sheet, SheetItem } from '@/ui/Sheet'
import { useToast } from '@/ui/Toast'
import { colors, radius, spacing } from '@/ui/theme'

const TOOL_HELP: Partial<Record<ToolName, string>> = {
  web_search: 'Pesquisa na web pelos buscadores configurados.',
  browse_url: 'Abre e lê páginas.',
  list_models: 'Lista os modelos dos seus provedores.',
  ask_user: 'Faz perguntas de múltipla escolha a você.',
  delegate_task: 'Cria subagentes para tarefas paralelas.',
  send_to_chat: 'Manda mensagens a outros chats.',
  read_history: 'Lê o histórico completo (inclusive o compactado).',
  datetime: 'Data e hora do celular, no fuso dele.'
}

/** Campos sem editor no celular: aparecem com o valor efetivo e de onde ele vem. */
const OTHER_UNITS = [
  'nativeTools',
  'toolsInPrompt',
  'toolsPromptText',
  'cacheEnabled',
  'params.extraBody',
  'subagentSystemPrompt',
  'maxToolOutputChars',
  'acceptEditsInRoot',
  'smartApprove',
  'skills'
]

interface Source {
  title: string
  record: InheritConfig
  /** Muda a config (patch com a semântica da herança — quem guarda o chat interpreta). */
  apply: (patch: Partial<InheritConfig>) => Promise<void>
  /** Chat só ao vivo de outro host: o nome dele (as mudanças vão por `chat.update`). */
  liveHost: string | null
}

/** Versão que sobe quando o registro deste chat muda (pull, ao vivo, escrita local). */
function useChatVersion(chatId: string): number {
  const [v, setV] = useState(0)
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null
    const off = engine.subscribe((e) => {
      if (e.kind !== 'data' || (!e.all && !e.chats.includes(chatId))) return
      if (t) clearTimeout(t)
      t = setTimeout(() => setV((x) => x + 1), 40)
    })
    return () => {
      off()
      if (t) clearTimeout(t)
    }
  }, [chatId])
  return v
}

function readSource(chatId: string, isLive: boolean): Source | null {
  if (isLive) {
    const l = live.history(chatId)?.loaded
    const entry = live.entry(chatId)
    if (!l) return null
    return {
      title: chatTitle(l.chat.title),
      record: chatRecordFrom(store, l.chat.config),
      apply: async (patch) => {
        await remote.chatUpdate(chatId, { config: patch as Record<string, unknown> })
      },
      liveHost: entry?.host.name ?? 'o host'
    }
  }
  const p = store.getPlain('chat', chatId)
  if (!p) return null
  const record = hostStack.repo.record(chatId)
  if (!record) return null
  return {
    title: chatTitle(typeof p.title === 'string' ? p.title : ''),
    record,
    apply: async (patch) => hostStack.repo.updateChat(chatId, { config: patch }),
    liveHost: null
  }
}

/** Texto longo salvo ao sair do campo (e ao sair da tela); muda de fora → acompanha. */
function useDraft(
  value: string,
  save: (v: string) => void
): [string, (v: string) => void, () => void] {
  const [text, setText] = useState(value)
  const [seen, setSeen] = useState(value)
  const latest = useRef({ text, value, save })
  if (value !== seen) {
    setSeen(value)
    setText(value)
  }
  useEffect(() => {
    latest.current = { text, value, save }
  })
  const commit = useCallback(() => {
    const l = latest.current
    if (l.text !== l.value) l.save(l.text)
  }, [])
  useEffect(() => commit, [commit])
  return [text, setText, commit]
}

export default function ChatConfigScreen() {
  const { id, live: liveParam } = useLocalSearchParams<{ id: string; live?: string }>()
  const isLive = liveParam === '1'
  const toast = useToast()
  const sv = useSettingsVersion()
  const cv = useChatVersion(id)
  const lv = useLiveVersion()
  const tv = useToolSearchCapsVersion()
  // as versões são os gatilhos de releitura (o React Compiler memoiza chamadas a objetos externos)
  const src = readAt(sv + cv + lv, () => readSource(id, isLive))
  const providers = readAt(sv, () => settings.providers())
  const presets = readAt(sv, () => settings.presets())
  const [cols] = useState<MemoryCollection[]>(() => {
    try {
      return settings.collections()
    } catch {
      return []
    }
  })
  const [picker, setPicker] = useState(false)
  const [confirmNone, setConfirmNone] = useState(false)

  const env = readAt(sv, () => inheritEnvOf(store))
  const record = src?.record ?? null
  const presetId = record?.presetId ?? null
  const origin = presetId ? (presets.find((p) => p.id === presetId) ?? null) : null
  const personaCfg = readAt(sv, () => presetConfigOf(store, presetId))
  const providerName = (pid: string) => providers.find((p) => p.id === pid)?.name ?? null
  const view = record
    ? inheritView(
        record,
        origin && personaCfg ? { name: origin.name, config: personaCfg } : null,
        env,
        providerName
      )
    : null
  const eff: InheritConfig | null = record ? effectiveOf(store, record, env) : null

  const run = (p: Partial<InheritConfig>, ok?: string) => {
    if (!src) return
    src
      .apply(p)
      .then(() => ok && toast(ok))
      .catch((e: unknown) => toast(describeError(e), 'danger'))
  }
  const patch = (p: Partial<ChatConfig>) => run(p)
  const revert = (units: readonly string[]) => {
    if (!record || !units.length) return
    run(
      revertPatch(record, units),
      units.length === 1
        ? `${unitLabel(units[0])}: segue a persona de novo`
        : `${units.length} campos seguem a persona de novo`
    )
  }
  const ctx: ChatInheritCtx | null = view ? { view, revert } : null

  const [prompt, setPrompt, commitPrompt] = useDraft(
    eff?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    (v) => patch({ systemPrompt: v })
  )

  const provider = eff
    ? (chatProvidersOf(providers).find((p) => p.id === eff.providerId) ?? null)
    : null
  const models = useModels(provider)
  const info =
    eff && models.pid === eff.providerId
      ? (models.list?.find((m) => m.id === eff.model) ?? null)
      : null
  // busca nativa (1.12.0): o modo efetivo deste chat + modelo (o mesmo resolvedor da request; o
  // histórico da principal decide a mídia enviada — chats ao vivo de outro host, sem ele)
  const toolView = readAt(cv + tv, () => {
    if (!eff) return null
    const sid = isLive ? null : (hostStack.repo.chat(id)?.mainSessionId ?? null)
    return toolSearchViewOf({
      cfg: eff,
      provider,
      model: eff.model,
      chatId: id,
      ...(sid ? { sessionId: sid, history: hostStack.repo.path(sid) } : {}),
      models: models.list
    })
  })

  if (!src || !record || !eff || !view)
    return (
      <SettingsScreen title="Configurações do chat" testID="screen-chat-config">
        <Banner tone="warning">
          {isLive
            ? 'O histórico deste chat ao vivo ainda não chegou do host.'
            : 'Este chat não existe mais (pode ter sido apagado).'}
        </Banner>
      </SettingsScreen>
    )

  const label: LabelFn = (title, units, right) => (
    <InheritLabel key={title} title={title} units={units} right={right} />
  )
  const own = view.own
  const tools = eff.enabledTools ?? []
  // a lista inteira: as do computador e as desconhecidas ficam (§4.3.6)
  const toggleTool = (t: ToolName, on: boolean) => patch({ enabledTools: withTool(tools, t, on) })
  const portable = [
    ...TOOL_NAMES,
    ...(MOBILE_TOOLS.filter((t) => !TOOL_NAMES.includes(t)) as ToolName[])
  ].filter((t) => MOBILE_TOOLS.includes(t))
  const paramUnits = Object.keys(eff.params ?? {})
    .concat(Object.keys(record.params ?? {}))
    .filter((k) => k !== 'extraBody')
    .map((k) => `params.${k}`)
  const approvalUnits = [
    ...new Set([
      ...Object.keys(eff.approvalModes ?? {}),
      ...own.filter((u) => u.startsWith('approvalModes.')).map((u) => u.slice(14))
    ])
  ].map((k) => `approvalModes.${k}`)
  const inheritedEffort = view.active
    ? {
        value: view.inherited('params.reasoning_effort') as ReasoningEffort | undefined,
        own: view.isOwn('params.reasoning_effort'),
        revert: () => revert(['params.reasoning_effort'])
      }
    : undefined
  const whereNote = src.liveHost ? ` As mudanças vão para ${src.liveHost}, que guarda o chat.` : ''

  return (
    <SettingsScreen title="Configurações do chat" testID="screen-chat-config">
      <ChatInheritProvider value={ctx}>
        <Text style={st.chatTitle} numberOfLines={2}>
          {src.title}
        </Text>

        {/* ---------------- persona ---------------- */}
        <FieldLabel>Persona</FieldLabel>
        <Card padded={false}>
          <Row
            left={<ChatAvatar icon={origin?.icon} size={36} />}
            title={origin ? origin.name || 'Persona' : presetId ? '(persona apagada)' : 'Nenhuma'}
            subtitle="Persona de origem — toque para trocar"
            onPress={() => setPicker(true)}
            right={<Text style={st.chev}>›</Text>}
            testID="chat-persona"
          />
        </Card>
        {confirmNone ? (
          <View style={st.warn} testID="persona-none-confirm">
            <Text style={st.warnText}>
              Sem persona, este chat fica com os valores que usa agora
              {origin ? ` (os herdados de “${origin.name}” são copiados para ele)` : ''} e deixa de
              acompanhar mudanças da persona e de “Novos chats”. Os campos que você já mudou
              continuam marcados — valem de novo se escolher uma persona depois.
            </Text>
            <View style={st.warnActions}>
              <Button
                title="Cancelar"
                variant="secondary"
                size="sm"
                full={false}
                onPress={() => setConfirmNone(false)}
                testID="persona-none-cancel"
              />
              <Button
                title="Ficar sem persona"
                size="sm"
                full={false}
                onPress={() => {
                  setConfirmNone(false)
                  run(personaPatch(null), 'Chat sem persona: valores atuais congelados')
                }}
                testID="persona-none-apply"
              />
            </View>
          </View>
        ) : (
          <View style={{ gap: 6 }} testID="persona-inherit-note">
            <Note>
              {view.active
                ? `Segue “${view.personaName}” ao vivo: o que você não mudou aqui acompanha a persona (e, onde ela não define, “Novos chats”). Campos sem marca seguem a persona; ↺ neste chat = deste chat.`
                : view.legacy
                  ? `Cópia de “${origin?.name}” feita na criação — passa a herdar ao vivo na próxima sincronização.`
                  : view.missing
                    ? 'A persona deste chat não existe neste aparelho: valem os valores do próprio chat.'
                    : 'Sem persona: todos os valores são deste chat. Escolha uma para herdar dela ao vivo (os campos que você mudou continuam deste chat).'}
              {whereNote}
            </Note>
            {view.active ? (
              <View style={st.ownLine}>
                <Text style={st.ownText} testID="inherit-own-count">
                  {own.length ? `${ownCountText(own.length)}.` : 'Nenhum campo próprio deste chat.'}
                </Text>
                {own.length ? (
                  <TextButton
                    title="Voltar a herdar tudo"
                    icon="arrow-undo"
                    onPress={() => revert(own)}
                    testID="inherit-revert-all"
                  />
                ) : null}
              </View>
            ) : null}
          </View>
        )}

        {/* ---------------- modelo ---------------- */}
        {label('Modelo', ['model'])}
        <ModelField
          providers={providers}
          value={eff.model ? { providerId: eff.providerId, model: eff.model } : null}
          onChange={(v) => v && patch({ providerId: v.providerId, model: v.model })}
          note={
            view.active && !view.isOwn('model') ? `Herdado: ${view.source('model')}.` : undefined
          }
          testID="chat-model"
        />
        {provider && eff.model ? (
          <>
            {label('Parâmetros', paramUnits)}
            <ParamsEditor
              provider={provider}
              model={eff.model}
              info={info}
              params={eff.params ?? {}}
              // o objeto inteiro (o `chat.update` troca a chave inteira, §23.7); null = remover
              onParam={(k, v) =>
                patch({ params: { ...(eff.params ?? {}), [k]: v ?? null } as ChatConfig['params'] })
              }
              wrap={(k: ParamKey, row: ReactNode) => (
                <InheritInline units={[`params.${k}`]} testID={`inherit-mark-param-${k}`}>
                  {row}
                </InheritInline>
              )}
              inheritedEffort={inheritedEffort}
            />
          </>
        ) : null}

        {/* ---------------- system prompt ---------------- */}
        {label('System prompt', ['systemPrompt'])}
        <Multiline
          testID="chat-system-prompt"
          value={prompt}
          onChangeText={setPrompt}
          onBlur={commitPrompt}
          minHeight={150}
        />
        <Note>
          {view.isOwn('systemPrompt')
            ? 'Deste chat — vai assim ao modelo.'
            : view.active
              ? `Herdado: ${view.source('systemPrompt')}. Editar aqui torna o campo deste chat.`
              : 'Vai assim ao modelo.'}
        </Note>

        {/* ---------------- ferramentas ---------------- */}
        <FieldLabel>Envio das tools</FieldLabel>
        <CompactToolsCard
          cfg={eff}
          onChange={(toolsCompact) => patch({ toolsCompact })}
          sent={portable.filter((t) => tools.includes(t))}
          view={toolView}
          wrap={(row) => (
            <InheritInline units={['toolsCompact']} testID="inherit-mark-toolsCompact">
              {row}
            </InheritInline>
          )}
          testID="chat-tools-compact"
        />
        <FieldLabel>Ferramentas — também no celular</FieldLabel>
        <Card padded={false}>
          {portable.map((t, i) => (
            <View key={t} style={st.toolRow}>
              {i ? <Divider /> : null}
              <InheritInline units={[`enabledTools.${t}`]} testID={`inherit-mark-tool-${t}`}>
                <ToggleRow
                  title={toolLabel(t)}
                  subtitle={TOOL_HELP[t] ?? locationToolHelp(t)}
                  value={tools.includes(t)}
                  onChange={(v) => toggleTool(t, v)}
                  testID={`chat-tool-${t}`}
                />
                <ToolSendLine
                  name={t}
                  cfg={eff}
                  patch={patch}
                  enabled={tools.includes(t)}
                  view={toolView}
                  testID={`chat-tool-send-${t}`}
                />
              </InheritInline>
            </View>
          ))}
        </Card>
        <OtherToolsGroup cfg={eff} patch={patch} view={toolView} />
        <ComputerToolsGroup
          tools={tools}
          onToggle={toggleTool}
          rowTestID={(t) => `chat-tool-${t}`}
          send={{ cfg: eff, patch, view: toolView }}
          wrap={(t, row) => (
            <InheritInline units={[`enabledTools.${t}`]} testID={`inherit-mark-tool-${t}`}>
              {row}
            </InheritInline>
          )}
        />

        {/* ---------------- memória ---------------- */}
        {label('Memória', ['memory'])}
        <View style={st.memory}>
          <MemoryConfigEditor
            cfg={normalizeMemoryConfig(eff.memory)}
            cols={cols}
            onChange={(memory) => patch({ memory })}
          />
        </View>

        {/* ---------------- contexto, assinatura, ambiente, computador ---------------- */}
        <ContextEditor cfg={eff} patch={patch} label={label} where="neste chat" />
        <SignatureEditor
          cfg={eff}
          patch={patch}
          label={label}
          inherited={
            view.active
              ? {
                  id: String(
                    (view.inherited('appSignature') as { appSignature?: string } | undefined)
                      ?.appSignature ?? ''
                  ),
                  own: view.isOwn('appSignature'),
                  revert: () => revert(['appSignature'])
                }
              : undefined
          }
        />
        <EnvironmentOption cfg={eff} patch={patch} label={label} />
        <ComputerOptions cfg={eff} patch={patch} label={label} />

        {/* ---------------- o resto (sem editor aqui) ---------------- */}
        <FieldLabel>Outros campos</FieldLabel>
        <Card padded={false}>
          {[...OTHER_UNITS, ...approvalUnits].map((u, i) => (
            <View key={u} style={st.toolRow}>
              {i ? <Divider /> : null}
              <InheritInline units={[u]} testID={`inherit-mark-${u}`}>
                <View style={st.other}>
                  <Text style={st.otherTitle}>{unitLabel(u)}</Text>
                  <Text style={st.otherValue} numberOfLines={3}>
                    {unitValueText(u, readUnit(eff, u), providerName)}
                  </Text>
                  {view.active && !view.isOwn(u) ? (
                    <Text style={st.otherSource}>Herdado: {view.source(u)}</Text>
                  ) : null}
                </View>
              </InheritInline>
            </View>
          ))}
        </Card>
        <Note>Estes campos se editam no computador; aqui aparecem os valores que o chat usa.</Note>
      </ChatInheritProvider>

      <Sheet
        visible={picker}
        onClose={() => setPicker(false)}
        title="Persona do chat"
        subtitle="Outra persona: os campos deste chat continuam; os outros passam a segui-la."
        testID="persona-picker"
      >
        {presets.map((p) => (
          <SheetItem
            key={p.id}
            icon={p.id === presetId ? 'radio-button-on' : 'radio-button-off'}
            label={p.name || 'Persona'}
            detail={p.description || undefined}
            onPress={() => {
              setPicker(false)
              setConfirmNone(false)
              if (p.id !== presetId)
                run(personaPatch(p.id), `Agora segue “${p.name}” — os campos deste chat continuam`)
            }}
            testID={`persona-pick-${p.name}`}
          />
        ))}
        <SheetItem
          icon={!presetId ? 'radio-button-on' : 'radio-button-off'}
          label="Nenhuma"
          detail="Congela os valores atuais; não acompanha nenhuma persona"
          onPress={() => {
            setPicker(false)
            if (presetId) setConfirmNone(true)
          }}
          testID="persona-pick-none"
        />
      </Sheet>
    </SettingsScreen>
  )
}

const st = StyleSheet.create({
  chatTitle: { color: colors.fg, fontSize: 16, fontWeight: '600', marginTop: -spacing.xs },
  chev: { color: colors.subtle, fontSize: 22 },
  ownLine: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.sm },
  ownText: { color: colors.accentStrong, fontSize: 12.5, lineHeight: 17, flexShrink: 1 },
  warn: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: 'rgba(245, 181, 68, 0.32)',
    backgroundColor: colors.warningSoft,
    padding: 12,
    gap: 10
  },
  warnText: { color: colors.muted, fontSize: 13, lineHeight: 18 },
  warnActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm },
  toolRow: { paddingHorizontal: spacing.lg, paddingVertical: 2 },
  memory: {
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md
  },
  other: { paddingVertical: 10, gap: 2 },
  otherTitle: { color: colors.fg, fontSize: 14.5 },
  otherValue: { color: colors.muted, fontSize: 13, lineHeight: 18 },
  otherSource: { color: colors.faint, fontSize: 11.5 }
})
