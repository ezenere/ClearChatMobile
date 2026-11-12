// "O que a chamada muda no prompt" (transparência — "o ClearChat não pode colocar prompts de sistema
// ou configurações ocultas"; = `VoicePromptPreview` do desktop): o MESMO cálculo da request
// (`voicePromptLayout` vendorado) — se o system prompt do chat fica ou é substituído e cada texto
// acrescentado, com a origem. Nada acrescentado → "a chamada manda exatamente o system prompt normal".
import { StyleSheet, Text, View } from 'react-native'
import type { voicePromptLayout } from '@shared/voice'
import { colors, font, radius, spacing } from '@/ui/theme'

export function VoicePromptPreview({
  layout,
  voiceFrom,
  tagsFrom,
  testID = 'voice-call-prompt-preview'
}: {
  layout: ReturnType<typeof voicePromptLayout>
  /** De onde vem o prompt do modo voz ("deste chat", "da persona “X”"). */
  voiceFrom: string | null
  /** De onde vem a escolha das tags de voz. */
  tagsFrom: string
  testID?: string
}) {
  const label = (kind: 'voice' | 'tags') =>
    kind === 'voice'
      ? `Prompt do modo voz${voiceFrom ? ` — ${voiceFrom}` : ''}`
      : `Instrução das tags de voz — ${tagsFrom} (só quando a voz da chamada interpreta tags: ElevenLabs v3/v4, Fish Audio Drama 3/S2)`
  return (
    <View style={st.box} testID={testID}>
      <Text style={st.title}>O que a chamada muda no prompt</Text>
      {!layout.parts.length ? (
        <Text style={st.note} testID={`${testID}-nothing`}>
          Nada: a chamada manda exatamente o system prompt normal (o app não acrescenta prompt
          próprio).
        </Text>
      ) : (
        <>
          <Text style={st.note}>
            {layout.replacesSystem
              ? 'O system prompt do chat SAI nos turnos de voz; entra no lugar dele:'
              : 'System prompt normal do chat e, depois dele, separado por linha em branco:'}
          </Text>
          {layout.parts.map((p) => (
            <View key={p.kind} testID={`${testID}-${p.kind}`} style={{ gap: 2 }}>
              <Text style={st.label}>{label(p.kind)}</Text>
              <Text style={st.text} numberOfLines={8}>
                {p.text}
              </Text>
            </View>
          ))}
        </>
      )}
    </View>
  )
}

const st = StyleSheet.create({
  box: {
    gap: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
    padding: spacing.md
  },
  title: { color: colors.muted, fontSize: 13, fontWeight: '500' },
  note: { color: colors.subtle, fontSize: 12.5, lineHeight: 17 },
  label: { color: colors.subtle, fontSize: 11.5 },
  text: {
    color: colors.fg,
    fontSize: 13,
    lineHeight: 18,
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    paddingHorizontal: 8,
    paddingVertical: 6,
    fontFamily: font.mono
  }
})
