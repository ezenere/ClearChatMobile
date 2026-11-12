// "Tags de voz (ElevenLabs v3/v4 e Fish Audio Drama 3/S2)" — opt-in por persona/chat (★ herda) e no
// padrão global (= `AudioTagsField` do desktop): liga a instrução que deixa a IA escrever tags como
// [laughs]/[whispers] (ou direções livres do Fish — "[warm, softly]") que mudam o jeito da voz
// falar, e o texto EXATO dessa instrução (editável; "Usar o padrão" volta ao do app). A instrução só
// entra no prompt da chamada com a voz da chamada interpretando tags (`supportsAudioTags`); sem
// suporte as tags são tiradas da fala (nunca lidas em voz alta).
import { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { AUDIO_TAGS_PROMPT_MAX, DEFAULT_AUDIO_TAGS_PROMPT } from '@shared/audioTags'
import { TextButton } from '@/ui/Button'
import { Card, ToggleRow } from '@/ui/Card'
import { colors, spacing } from '@/ui/theme'
import { InheritChoice } from './InheritChoice'
import { FieldLabel, Multiline, Note } from './ui'

/** Texto curto do que as tags fazem. */
export const AUDIO_TAGS_HELP =
  'Com as tags de voz ligadas, a IA pode escrever marcas como [risos], [sussurra], [suspira] ou [animado] no meio da fala — elas mudam o jeito da voz falar (riso, sussurro, pausa, emoção). Só os modelos de voz ElevenLabs Eleven v3/v4 e Fish Audio Drama 3/S2 Pro/S2.1 Pro interpretam; nos demais as tags são tiradas antes da síntese (nunca lidas em voz alta). No chat elas aparecem esmaecidas no texto da resposta.'

export function AudioTagsField({
  value,
  inherited,
  inheritedFrom,
  prompt,
  inheritedPrompt,
  onChange,
  onPromptChange,
  support,
  global = false,
  testID = 'voice-call-audio-tags'
}: {
  /** Override deste nível (null = herda); no global, o valor gravado. */
  value: boolean | null
  /** Valor herdado (persona/global) — ★; no global, ignorado. */
  inherited: boolean
  inheritedFrom: string
  /** Texto deste nível (null = herda/padrão). */
  prompt: string | null
  /** Texto herdado (persona/global/padrão do app) — o que vale quando `prompt` é null. */
  inheritedPrompt: string
  onChange: (v: boolean | null) => void
  onPromptChange: (text: string | null) => void
  /** A voz da chamada interpreta tags? (`callTtsTagsSupport`). */
  support: { supported: boolean; model: string | null }
  /** Editor do padrão global (interruptor em vez do ★). */
  global?: boolean
  testID?: string
}) {
  const on = value ?? inherited
  const effective = prompt ?? inheritedPrompt
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    if (draft == null) return
    const t = draft.replace(/\r/g, '').trim()
    setDraft(null)
    // igual ao herdado (ou vazio) = volta a herdar
    onPromptChange(!t || t === inheritedPrompt.trim() ? null : t.slice(0, AUDIO_TAGS_PROMPT_MAX))
  }
  return (
    <View style={{ gap: spacing.sm }} testID={testID}>
      {global ? (
        <Card>
          <ToggleRow
            title="Tags de voz (ElevenLabs v3/v4 e Fish Audio Drama 3/S2)"
            subtitle="A IA pode escrever [risos], [sussurra]… que mudam o jeito da voz falar."
            value={on}
            onChange={(v) => onChange(v)}
            testID={`${testID}-switch`}
          />
        </Card>
      ) : (
        <>
          <FieldLabel>Tags de voz (ElevenLabs v3/v4 e Fish Audio Drama 3/S2)</FieldLabel>
          <InheritChoice
            label="Tags de voz"
            options={[
              { value: true, label: 'Ligadas' },
              { value: false, label: 'Desligadas' }
            ]}
            value={value}
            inherited={inherited}
            inheritedFrom={inheritedFrom}
            onChange={onChange}
            testID={`${testID}-choice`}
          />
        </>
      )}
      <Note>{AUDIO_TAGS_HELP}</Note>
      {on && !support.supported ? (
        <Text style={st.warn} testID={`${testID}-unsupported`}>
          O modelo de voz atual{support.model ? ` (${support.model})` : ''} não interpreta tags —
          elas serão removidas da fala.
        </Text>
      ) : null}
      <View style={st.promptHead}>
        <Text style={st.promptLabel}>Instrução das tags (somada ao prompt da chamada)</Text>
        {prompt != null ? (
          <TextButton
            title="Usar o padrão"
            disabled={!on}
            onPress={() => {
              setDraft(null)
              onPromptChange(null)
            }}
            testID={`${testID}-reset`}
          />
        ) : null}
      </View>
      <Multiline
        value={draft ?? effective}
        onChangeText={setDraft}
        onBlur={commit}
        editable={on}
        minHeight={96}
        testID={`${testID}-prompt`}
      />
      {prompt == null ? (
        <Text style={st.caption}>
          {inheritedPrompt === DEFAULT_AUDIO_TAGS_PROMPT
            ? 'Texto padrão do app.'
            : `Herdado (${inheritedFrom.replace(/^Padrão/, 'padrão')}).`}
        </Text>
      ) : null}
    </View>
  )
}

const st = StyleSheet.create({
  warn: { color: colors.warning, fontSize: 12.5, lineHeight: 17 },
  promptHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 28 },
  promptLabel: { flex: 1, color: colors.muted, fontSize: 13 },
  caption: { color: colors.faint, fontSize: 11.5, marginTop: -2 }
})
