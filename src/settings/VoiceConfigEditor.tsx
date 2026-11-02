// Aba "Voz" da persona (e a mesma edição para um chat): a chamada de voz (`VoiceCallConfig`,
// §4.3.3/§4.3.6) com os campos que HERDAM (null) — chat → persona → Configurações → Voz. Mesmos
// campos do desktop (VoiceCallConfigSection): disponível, modelo da chamada, tools da chamada,
// prompt do modo voz e como ele compõe, preâmbulos, interjeições e "o agente pode encerrar".
// Tools da chamada que só rodam no computador aparecem marcadas e ficam como estão (a chamada no
// celular só existe em chats sem ferramentas locais, §8.9).
import {
  DEFAULT_INTERJECTION_POLICY,
  INTERJECTION_CLASSES,
  normalizeVoiceCallConfig,
  type InterjectionClass,
  type InterjectionPolicy,
  type VoiceCallConfig,
  type VoiceCallPromptMode
} from '@shared/voice'
import { TOOL_LABELS, TOOL_NAMES } from '@shared/tools'
import type { Provider, ToolName } from '@shared/types'
import { Text, View } from 'react-native'
import { MOBILE_TOOLS } from '@/agent/request'
import { ModelField } from '@/settings/ModelPicker'
import { FieldLabel, Multiline, Note, NumberField, Segmented } from '@/settings/ui'
import { Card, Checkbox, Divider, ToggleRow } from '@/ui/Card'
import { colors, spacing } from '@/ui/theme'

type Tri = 'inherit' | 'on' | 'off'
const tri = (v: boolean | null | undefined): Tri => (v == null ? 'inherit' : v ? 'on' : 'off')
const fromTri = (t: Tri): boolean | null => (t === 'inherit' ? null : t === 'on')

export const INTERJECTION_LABEL: Record<InterjectionClass, string> = {
  ACK: 'Uhum / Aham (no meio da fala)',
  AGREEMENT: 'Concordância (Sim. / Certo.)',
  ENCOURAGEMENT: 'Incentivo (Isso! / Boa!)',
  THINKING: 'Pensando (Hum, deixa eu ver.)'
}

/** Edição da política de interjeições (também usada nos padrões globais). */
export function InterjectionFields({
  value,
  onChange,
  testID
}: {
  value: InterjectionPolicy
  onChange: (v: InterjectionPolicy) => void
  testID?: string
}) {
  const set = (p: Partial<InterjectionPolicy>) => onChange({ ...value, ...p })
  return (
    <Card>
      <View style={{ gap: spacing.sm }}>
        <ToggleRow
          title="Interjeições"
          subtitle="“Uhum.”/“Aham.” curtos nas pausas da sua fala (clipes gerados com a voz)."
          value={value.enabled}
          onChange={(enabled) => set({ enabled })}
          testID={testID ? `${testID}-enabled` : undefined}
        />
        {value.enabled ? (
          <>
            <ToggleRow
              title="Modo sombra"
              subtitle="Decide mas não toca (calibração)."
              value={value.shadow}
              onChange={(shadow) => set({ shadow })}
            />
            <NumberField
              label="Probabilidade (0–1)"
              value={value.fireProbability}
              onChange={(v) =>
                set({ fireProbability: v ?? DEFAULT_INTERJECTION_POLICY.fireProbability })
              }
              min={0}
              max={1}
              int={false}
            />
            <NumberField
              label="Intervalo mínimo"
              value={value.cooldownMs}
              onChange={(v) => set({ cooldownMs: v ?? DEFAULT_INTERJECTION_POLICY.cooldownMs })}
              min={0}
              max={60000}
              suffix="ms"
            />
            <NumberField
              label="Fala mínima"
              value={value.minSpeechMs}
              onChange={(v) => set({ minSpeechMs: v ?? DEFAULT_INTERJECTION_POLICY.minSpeechMs })}
              min={0}
              max={10000}
              suffix="ms"
            />
            <NumberField
              label="Pausa"
              value={value.minPauseMs}
              onChange={(v) => set({ minPauseMs: v ?? DEFAULT_INTERJECTION_POLICY.minPauseMs })}
              min={100}
              max={5000}
              suffix="ms"
            />
            <NumberField
              label="Volume (0–1)"
              value={value.volume}
              onChange={(v) => set({ volume: v ?? DEFAULT_INTERJECTION_POLICY.volume })}
              min={0}
              max={1}
              int={false}
            />
            {INTERJECTION_CLASSES.map((c) => (
              <Checkbox
                key={c}
                label={INTERJECTION_LABEL[c]}
                value={value.classes.includes(c)}
                onChange={(on) =>
                  set({
                    classes: on
                      ? [...value.classes.filter((x) => x !== c), c]
                      : value.classes.filter((x) => x !== c)
                  })
                }
                testID={testID ? `${testID}-class-${c}` : undefined}
              />
            ))}
          </>
        ) : null}
      </View>
    </Card>
  )
}

export function VoiceConfigEditor({
  value,
  onChange,
  providers,
  scope = 'persona',
  testID = 'voice-config'
}: {
  value: VoiceCallConfig | null | undefined
  onChange: (v: VoiceCallConfig) => void
  providers: Provider[]
  /** De onde vem a herança (textos): persona → global; chat → persona → global. */
  scope?: 'persona' | 'chat'
  testID?: string
}) {
  const v = normalizeVoiceCallConfig(value ?? null)
  const set = (p: Partial<VoiceCallConfig>) => onChange({ ...v, ...p })
  const from = scope === 'chat' ? 'a persona e Configurações → Voz' : 'Configurações → Voz'
  const tools = v.tools?.enabledTools ?? null
  const portable = TOOL_NAMES.filter((t) => MOBILE_TOOLS.includes(t))
  const localOn = (tools ?? []).filter((t) => !MOBILE_TOOLS.includes(t))
  const toggleTool = (t: ToolName, on: boolean) => {
    const cur = tools ?? []
    set({
      tools: {
        enabledTools: on ? [...cur.filter((x) => x !== t), t] : cur.filter((x) => x !== t),
        maxToolOutputChars: v.tools?.maxToolOutputChars ?? null
      }
    })
  }
  const promptMode: VoiceCallPromptMode | 'inherit' = v.promptMode ?? 'inherit'

  return (
    <View style={{ gap: spacing.md }} testID={testID}>
      <Note>
        Conversa falada com o agente (botão de telefone nos chats executados neste aparelho). Campos
        em “Padrão” seguem {from}.
      </Note>
      <FieldLabel>Chamada de voz</FieldLabel>
      <Segmented
        options={[
          { value: 'inherit', label: 'Padrão' },
          { value: 'on', label: 'Disponível' },
          { value: 'off', label: 'Desligada' }
        ]}
        value={tri(v.enabled)}
        onChange={(t) => set({ enabled: fromTri(t) })}
        testID={`${testID}-enabled`}
      />

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
      <Segmented
        options={[
          { value: 'inherit', label: 'Padrão' },
          { value: 'append', label: 'Somar' },
          { value: 'replace', label: 'Substituto' },
          { value: 'none', label: 'Nenhum' }
        ]}
        value={promptMode}
        onChange={(m) => set({ promptMode: m === 'inherit' ? null : m })}
        testID={`${testID}-prompt-mode`}
      />
      <Multiline
        value={v.voicePrompt ?? ''}
        onChangeText={(t) => set({ voicePrompt: t.trim() ? t : null })}
        placeholder="Prompt do modo voz — ex.: Responda em frases curtas e naturais, sem markdown nem listas."
        minHeight={90}
        testID={`${testID}-prompt`}
      />
      <Note>
        {promptMode === 'replace'
          ? 'Vai NO LUGAR do system prompt do chat (depois do prompt-base de voz).'
          : promptMode === 'none'
            ? 'Sem prompt de voz: só o system prompt normal (nem o prompt-base global).'
            : 'Vai no fim do system prompt do chat, separado por uma linha em branco.'}
      </Note>

      <FieldLabel>O agente pode encerrar a chamada</FieldLabel>
      <Segmented
        options={[
          { value: 'inherit', label: 'Padrão' },
          { value: 'on', label: 'Sim' },
          { value: 'off', label: 'Não' }
        ]}
        value={tri(v.endCall)}
        onChange={(t) => set({ endCall: fromTri(t) })}
        testID={`${testID}-end-call`}
      />
      <Note>Tool end_call: só nos turnos da chamada, sem aprovação.</Note>

      <FieldLabel>Preâmbulos (“Hum, deixa eu ver.”)</FieldLabel>
      <Segmented
        options={[
          { value: 'inherit', label: 'Padrão' },
          { value: 'on', label: 'Ligados' },
          { value: 'off', label: 'Desligados' }
        ]}
        value={v.fillers ? (v.fillers.enabled ? 'on' : 'off') : 'inherit'}
        onChange={(t) =>
          set({
            fillers:
              t === 'inherit' ? null : { enabled: t === 'on', prompt: v.fillers?.prompt ?? null }
          })
        }
        testID={`${testID}-fillers`}
      />

      <FieldLabel>Interjeições</FieldLabel>
      <Segmented
        options={[
          { value: 'inherit', label: 'Padrão' },
          { value: 'custom', label: 'Personalizar' }
        ]}
        value={v.interjections ? 'custom' : 'inherit'}
        onChange={(t) =>
          set({ interjections: t === 'inherit' ? null : { ...DEFAULT_INTERJECTION_POLICY } })
        }
        testID={`${testID}-interjections`}
      />
      {v.interjections ? (
        <InterjectionFields
          value={v.interjections}
          onChange={(interjections) => set({ interjections })}
          testID={`${testID}-interjections`}
        />
      ) : null}

      <FieldLabel>Tools na chamada</FieldLabel>
      <Segmented
        options={[
          { value: 'inherit', label: 'Iguais ao chat' },
          { value: 'custom', label: 'Escolher' }
        ]}
        value={tools ? 'custom' : 'inherit'}
        onChange={(t) =>
          set({
            tools:
              t === 'inherit'
                ? v.tools?.maxToolOutputChars != null
                  ? { enabledTools: null, maxToolOutputChars: v.tools.maxToolOutputChars }
                  : null
                : { enabledTools: [], maxToolOutputChars: v.tools?.maxToolOutputChars ?? null }
          })
        }
        testID={`${testID}-tools`}
      />
      {tools ? (
        <Card padded={false}>
          {portable.map((t, i) => (
            <View key={t} style={{ paddingHorizontal: spacing.lg, paddingVertical: 2 }}>
              {i ? <Divider /> : null}
              <ToggleRow
                title={TOOL_LABELS[t]}
                value={tools.includes(t)}
                onChange={(on) => toggleTool(t, on)}
                testID={`${testID}-tool-${t}`}
              />
            </View>
          ))}
        </Card>
      ) : null}
      {localOn.length ? (
        <Text style={{ color: colors.warning, fontSize: 12.5, lineHeight: 17 }}>
          Ligadas no computador: {localOn.map((t) => TOOL_LABELS[t] ?? t).join(', ')} — com elas a
          chamada (e o chat) só roda no computador.
        </Text>
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
