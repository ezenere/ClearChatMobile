// Aba "Voz" da persona (e a mesma edição para um chat): a chamada de voz (`VoiceCallConfig`,
// §4.3.3/§4.3.6) com os campos que HERDAM (null) — chat → persona → Configurações → Voz. Mesmos
// campos do desktop (VoiceChoiceSections + VoiceCallConfigSection): a voz (Fala) e a transcrição da
// persona/chat (protocolo 1.9.0), disponível, modelo da chamada, como o prompt do modo voz compõe,
// o "Prompt do modo voz" e logo abaixo as tags de voz (os dois textos que a chamada acrescenta, na
// ordem da request — sem prévia que os repita), "o agente pode encerrar", preâmbulos, frases de
// ferramenta e tools próprias. As escolhas com herança seguem o `InheritChoice` (★ na opção igual
// ao herdado — nunca uma opção "Padrão" duplicando o padrão). As tools da chamada que só rodam no
// computador ficam na lista, esmaecidas e alternáveis (§4.3.6: o celular não as manda ao modelo).
// Tools compactadas (1.11.0): as da chamada vão como no chat (a compactação do chat/persona); cada uma
// mostra a definição que vai.
import {
  DEFAULT_VOICE_CALL_DEFAULTS,
  VOICE_CALL_PROMPT_MODES,
  normalizeVoiceCallConfig,
  resolveVoiceCallConfig,
  SUGGESTED_VOICE_PROMPT,
  type VoiceCallConfig,
  type VoiceCallDefaults,
  type VoiceCallPromptMode
} from '@shared/voice'
import { DEFAULT_AUDIO_TAGS_PROMPT } from '@shared/audioTags'
import { withTool } from '@shared/deviceTools'
import { TOOL_NAMES } from '@shared/tools'
import type { Provider, ToolName } from '@shared/types'
import { Text, View } from 'react-native'
import { MOBILE_TOOLS } from '@/agent/request'
import { toolLabel } from '@/agent/toolLabels'
import { LOCATION_TOOLS } from '@/location/service'
import { ComputerToolsGroup } from '@/settings/ComputerTools'
import { ToolSendLine, type CompactCfg } from '@/settings/ToolsSend'
import { compactToolsOn } from '@shared/compactTools'
import { ModelField } from '@/settings/ModelPicker'
import { FieldLabel, Multiline, Note, NumberField } from '@/settings/ui'
import { Card, Divider, ToggleRow } from '@/ui/Card'
import { colors, spacing } from '@/ui/theme'
import type { VoiceSettings } from '@/voice/endpoints'
import { TextButton } from '@/ui/Button'
import { AudioTagsField } from './AudioTagsField'
import { InheritChoice } from './InheritChoice'
import { VoiceChoiceSections } from './VoiceChoiceSections'

const PROMPT_MODE_LABEL: Record<VoiceCallPromptMode, string> = {
  append: 'Complementar',
  replace: 'Substituto',
  none: 'Nenhum'
}
const PROMPT_MODE_HELP: Record<VoiceCallPromptMode, string> = {
  append: 'System prompt normal + o prompt do modo voz no fim (padrão).',
  replace: 'Na chamada, o prompt do modo voz SUBSTITUI o system prompt normal.',
  none: 'Sem prompt de voz: só o system prompt normal.'
}

/** Camada herdada: no chat, a persona de origem (ao vivo); na persona, só o padrão global. */
export interface VoicePersonaLayer {
  name: string
  voice: VoiceCallConfig | null
}

export function VoiceConfigEditor({
  value,
  onChange,
  providers,
  scope = 'persona',
  defaults = DEFAULT_VOICE_CALL_DEFAULTS,
  persona = null,
  chatTools = null,
  compactCfg = null,
  tagsSupport = { supported: false, model: null },
  device = null,
  testID = 'voice-config'
}: {
  value: VoiceCallConfig | null | undefined
  onChange: (v: VoiceCallConfig) => void
  providers: Provider[]
  /** De onde vem a herança (textos): persona → global; chat → persona → global. */
  scope?: 'persona' | 'chat'
  /** Padrões globais (`voiceCallDefaults`). */
  defaults?: VoiceCallDefaults
  /** Chat: a persona de origem (camada do meio). */
  persona?: VoicePersonaLayer | null
  /** Tools do chat/persona (ponto de partida de "Tools próprias na chamada"). */
  chatTools?: ToolName[] | null
  /** Compactação do chat/persona (1.11.0): as tools da chamada vão assim (a definição de cada uma). */
  compactCfg?: CompactCfg | null
  /** A voz da chamada interpreta tags de voz? */
  tagsSupport?: { supported: boolean; model: string | null }
  /** Settings de voz deste aparelho: com elas, as seções "Fala"/"Transcrição" (voz da persona/chat). */
  device?: VoiceSettings | null
  testID?: string
}) {
  // normalizado: campos legados de registros antigos (`interjections`) nunca são regravados
  const v = normalizeVoiceCallConfig(value ?? null)
  const set = (p: Partial<VoiceCallConfig>) => onChange({ ...v, ...p })
  const where = scope === 'chat' ? 'neste chat' : 'nesta persona'
  const pv = scope === 'chat' ? (persona?.voice ?? null) : null
  const personaLabel = `Padrão da persona${persona?.name ? ` “${persona.name}”` : ''}`
  const GLOBAL = 'Padrão global (Configurações → Voz)'
  /** De onde vem o herdado de um campo: a persona (quando ela fixa) ou o global. */
  const from = (personaSets: boolean): string => (personaSets ? personaLabel : GLOBAL)
  const resolved = resolveVoiceCallConfig(v, defaults, pv)
  const tools = v.tools?.enabledTools ?? null
  const portable = [...TOOL_NAMES, ...LOCATION_TOOLS].filter((t) => MOBILE_TOOLS.includes(t))
  const toggleTool = (t: ToolName, on: boolean) => {
    set({
      tools: {
        enabledTools: withTool(tools ?? [], t, on),
        maxToolOutputChars: v.tools?.maxToolOutputChars ?? null
      }
    })
  }

  const inheritedEnabled = pv?.enabled ?? defaults.enabled
  const inheritedEndCall = pv?.endCall ?? defaults.endCall
  const inheritedMode: VoiceCallPromptMode = pv?.promptMode ?? 'append'
  const inheritedFillers = pv?.fillers ? pv.fillers.enabled : defaults.fillers.enabled
  const inheritedTags = pv?.audioTags ?? defaults.audioTags
  const inheritedToolPhrases = pv?.toolPhrases ?? defaults.toolPhrases.enabled
  const inheritedTagsPrompt =
    pv?.audioTagsPrompt ?? defaults.audioTagsPrompt ?? DEFAULT_AUDIO_TAGS_PROMPT
  const mode = resolved.promptMode

  return (
    <View style={{ gap: spacing.md }} testID={testID}>
      <Note>
        Conversa falada com o agente (botão de telefone nos chats executados neste aparelho). A
        opção com ★ é a herdada ({scope === 'chat' ? 'da persona ou ' : ''}de Configurações → Voz):
        escolhida, segue o padrão; outra fixa o valor {where}.
      </Note>
      {device ? (
        <VoiceChoiceSections
          value={v}
          onChange={({ tts, stt }) => {
            const next: VoiceCallConfig = { ...v, tts, stt }
            if (!next.tts) delete next.tts
            if (!next.stt) delete next.stt
            onChange(next)
          }}
          scope={scope}
          persona={scope === 'chat' ? persona : null}
          device={device}
          providers={providers}
          testID={`${testID}-choice`}
        />
      ) : null}
      <FieldLabel>{`Disponível ${where}`}</FieldLabel>
      <InheritChoice
        label={`Chamada de voz ${where}`}
        options={[
          { value: true, label: 'Ligada' },
          { value: false, label: 'Desligada' }
        ]}
        value={v.enabled}
        inherited={inheritedEnabled}
        inheritedFrom={from(pv?.enabled != null)}
        onChange={(enabled) => set({ enabled })}
        testID={`${testID}-enabled`}
      />
      {!resolved.enabled ? (
        <Text style={{ color: colors.warning, fontSize: 12.5, lineHeight: 17 }}>
          {v.enabled === false
            ? `O telefone fica desabilitado ${scope === 'chat' ? 'neste chat' : 'nos chats desta persona (um chat pode religar)'}.`
            : pv?.enabled === false
              ? `A persona “${persona?.name ?? ''}” desliga a chamada: escolha “Ligada” para usar neste chat.`
              : 'Desligada em Configurações → Voz: o telefone some dos chats sem override.'}
        </Text>
      ) : null}

      <FieldLabel>Modelo da chamada</FieldLabel>
      <ModelField
        providers={providers}
        value={v.model ? { providerId: v.model.providerId, model: v.model.model } : null}
        onChange={(m) =>
          set({
            model: m
              ? { providerId: m.providerId, model: m.model, params: v.model?.params ?? {} }
              : null
          })
        }
        placeholder="Igual ao chat"
        noneLabel="Igual ao chat (padrão)"
        note={
          v.model
            ? 'Modelo próprio nos turnos da chamada (o raciocínio fica desligado/mínimo).'
            : 'Sem modelo próprio: a chamada usa o modelo do chat (com o raciocínio desligado).'
        }
        testID={`${testID}-model`}
      />

      <FieldLabel>Prompt na chamada</FieldLabel>
      <InheritChoice
        label="Prompt na chamada"
        options={VOICE_CALL_PROMPT_MODES.map((m) => ({ value: m, label: PROMPT_MODE_LABEL[m] }))}
        value={v.promptMode ?? null}
        inherited={inheritedMode}
        inheritedFrom={from(!!pv?.promptMode)}
        onChange={(promptMode) => set({ promptMode })}
        testID={`${testID}-prompt-mode`}
      />
      <Note>{PROMPT_MODE_HELP[mode]}</Note>
      {mode !== 'none' ? (
        <>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Text style={{ flex: 1, color: colors.muted, fontSize: 13 }}>Prompt do modo voz</Text>
            {!v.voicePrompt?.trim() ? (
              // a sugestão vai PARA O CAMPO (visível e editável) — nunca é enviada sozinha
              <TextButton
                title="Usar sugestão"
                icon="sparkles-outline"
                onPress={() => set({ voicePrompt: SUGGESTED_VOICE_PROMPT })}
                testID={`${testID}-prompt-suggest`}
              />
            ) : null}
          </View>
          <Multiline
            value={v.voicePrompt ?? ''}
            onChangeText={(t) => set({ voicePrompt: t.trim() ? t : null })}
            placeholder={
              scope === 'chat' && pv?.voicePrompt
                ? `Da persona: ${pv.voicePrompt}`
                : 'Vazio (padrão) = a chamada manda exatamente o system prompt normal.'
            }
            minHeight={90}
            testID={`${testID}-prompt`}
          />
        </>
      ) : null}
      <AudioTagsField
        value={v.audioTags ?? null}
        inherited={inheritedTags}
        inheritedFrom={from(pv?.audioTags != null)}
        prompt={v.audioTagsPrompt ?? null}
        inheritedPrompt={inheritedTagsPrompt}
        onChange={(audioTags) => set({ audioTags })}
        onPromptChange={(audioTagsPrompt) => set({ audioTagsPrompt })}
        support={tagsSupport}
        testID={`${testID}-audio-tags`}
      />

      <FieldLabel>O agente pode encerrar a chamada</FieldLabel>
      <InheritChoice
        label="O agente pode encerrar a chamada"
        options={[
          { value: true, label: 'Sim' },
          { value: false, label: 'Não' }
        ]}
        value={v.endCall ?? null}
        inherited={inheritedEndCall}
        inheritedFrom={from(pv?.endCall != null)}
        onChange={(endCall) => set({ endCall })}
        testID={`${testID}-end-call`}
      />
      <Note>
        Tool end_call (só nos turnos da chamada, sem aprovação): quando você se despede, o agente
        diz tchau e a chamada cai depois de a despedida tocar.
      </Note>

      <FieldLabel>Preâmbulos (“Hum, deixa eu ver.”)</FieldLabel>
      <InheritChoice
        label="Preâmbulos"
        options={[
          { value: true, label: 'Ligados' },
          { value: false, label: 'Desligados' }
        ]}
        value={v.fillers ? v.fillers.enabled : null}
        inherited={inheritedFillers}
        inheritedFrom={from(!!pv?.fillers)}
        onChange={(on) =>
          set({ fillers: on == null ? null : { enabled: on, prompt: v.fillers?.prompt ?? null } })
        }
        testID={`${testID}-fillers`}
      />

      <FieldLabel>Frases de ferramenta (“Vou pesquisar isso.”)</FieldLabel>
      <InheritChoice
        label="Frases de ferramenta"
        options={[
          { value: true, label: 'Ligadas' },
          { value: false, label: 'Desligadas' }
        ]}
        value={v.toolPhrases ?? null}
        inherited={inheritedToolPhrases}
        inheritedFrom={from(pv?.toolPhrases != null)}
        onChange={(toolPhrases) => set({ toolPhrases })}
        testID={`${testID}-tool-phrases`}
      />
      <Note>
        Uma frase curta sobre a 1ª ferramenta do turno (no máximo uma por turno), com a voz da
        chamada. As frases ficam em Configurações → Voz.
      </Note>

      <FieldLabel>Tools na chamada</FieldLabel>
      <Card>
        <ToggleRow
          title="Tools próprias na chamada"
          subtitle="Desligado: as mesmas tools do chat. Ligado: só as marcadas abaixo valem nos turnos de voz (nenhuma = sem tools)."
          value={!!tools}
          onChange={(on) =>
            set({
              tools: on
                ? {
                    // a lista inteira do chat (as do computador inclusive — §4.3.6)
                    enabledTools: [...(chatTools ?? [])],
                    maxToolOutputChars: v.tools?.maxToolOutputChars ?? null
                  }
                : v.tools?.maxToolOutputChars != null
                  ? { enabledTools: null, maxToolOutputChars: v.tools.maxToolOutputChars }
                  : null
            })
          }
          testID={`${testID}-tools`}
        />
      </Card>
      {tools && compactCfg ? (
        <Note>
          {compactToolsOn(compactCfg)
            ? 'Vão compactas como no chat (Tools → “Enviar tools compactadas”); “Definição” mostra o que vai. Encerrar a chamada (end_call) vai sempre completa.'
            : 'Vão completas como no chat (Tools → “Enviar tools compactadas” desligado).'}
        </Note>
      ) : null}
      {tools ? (
        <Card padded={false}>
          {portable.map((t, i) => (
            <View key={t} style={{ paddingHorizontal: spacing.lg, paddingVertical: 2 }}>
              {i ? <Divider /> : null}
              <ToggleRow
                title={toolLabel(t)}
                value={tools.includes(t)}
                onChange={(on) => toggleTool(t, on)}
                testID={`${testID}-tool-${t}`}
              />
              {compactCfg ? (
                <ToolSendLine
                  name={t}
                  cfg={compactCfg}
                  enabled={tools.includes(t)}
                  chip={false}
                  testID={`${testID}-tool-send-${t}`}
                />
              ) : null}
            </View>
          ))}
        </Card>
      ) : null}
      {tools ? (
        <ComputerToolsGroup
          tools={tools}
          onToggle={toggleTool}
          testID={`${testID}-tools-computer`}
          rowTestID={(t) => `${testID}-tool-${t}`}
        />
      ) : null}
      <NumberField
        label="Teto da saída das tools"
        value={v.tools?.maxToolOutputChars ?? null}
        onChange={(n) =>
          set({
            tools:
              n == null && !tools ? null : { enabledTools: tools, maxToolOutputChars: n ?? null }
          })
        }
        min={500}
        max={200000}
        suffix="car."
        placeholder="do chat"
      />
    </View>
  )
}
