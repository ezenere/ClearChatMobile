// Configurações → Voz → Chamada de voz → "Frases de ferramenta" (`voiceCallDefaults.toolPhrases`,
// deste aparelho): liga/desliga e as frases por categoria de tool (recolhidas; uma por linha;
// "Restaurar padrão") — = `ToolPhrasesSettings.tsx` do desktop. A frase sai na 1ª tool do turno —
// clipe pré-gerado (`TOOL_<n>`, "Gerar clipes") ou síntese ao vivo sem ele.
import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import Ionicons from '@expo/vector-icons/Ionicons'
import {
  DEFAULT_TOOL_PHRASE_POOL,
  DEFAULT_TOOL_PHRASES,
  TOOL_PHRASE_CATEGORIES,
  type ToolPhrase,
  type ToolPhraseCategory,
  type VoiceToolPhrases
} from '@shared/voice'
import { TOOL_PHRASE_AFTER_PREAMBLE_MS } from '@shared/voicePolicy'
import {
  replaceCategoryLines,
  TOOL_PHRASE_CATEGORY_LABELS
} from '@vendor/renderer/voice/toolPhrases'
import { TextButton } from '@/ui/Button'
import { Card, ToggleRow } from '@/ui/Card'
import { colors, spacing } from '@/ui/theme'
import { Multiline, Note } from './ui'

/** Frases de uma categoria (na ordem do pool). */
const linesOf = (pool: readonly ToolPhrase[], cat: ToolPhraseCategory): string[] =>
  pool.filter((p) => p.categories.includes(cat)).map((p) => p.text)

/** Frases de UMA categoria (uma por linha; grava ao sair do campo). */
function CategoryField({
  cat,
  pool,
  onCommit
}: {
  cat: ToolPhraseCategory
  pool: readonly ToolPhrase[]
  onCommit: (pool: ToolPhrase[] | null) => void
}) {
  const lines = linesOf(pool, cat)
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    if (draft == null) return
    setDraft(null)
    const next = draft
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    if (next.join('\n') === lines.join('\n')) return
    onCommit(replaceCategoryLines(pool, cat, next))
  }
  return (
    <View style={{ gap: 4 }}>
      <Text style={st.cat}>{TOOL_PHRASE_CATEGORY_LABELS[cat]}</Text>
      <Multiline
        value={draft ?? lines.join('\n')}
        onChangeText={setDraft}
        onBlur={commit}
        minHeight={56}
        testID={`voice-call-tool-phrases-${cat}`}
      />
    </View>
  )
}

export function ToolPhrasesSettings({
  value,
  onChange
}: {
  value: VoiceToolPhrases | null | undefined
  onChange: (next: VoiceToolPhrases) => void
}) {
  const tp = value ?? DEFAULT_TOOL_PHRASES
  const pool = tp.pool ?? DEFAULT_TOOL_PHRASE_POOL
  const [open, setOpen] = useState(false)
  const set = (patch: Partial<VoiceToolPhrases>) => onChange({ ...tp, ...patch })
  return (
    <View style={{ gap: spacing.sm }} testID="voice-call-tool-phrases">
      <Card>
        <ToggleRow
          title="Frases de ferramenta"
          subtitle="“Vou pesquisar isso.”, “Deixa eu ver onde você está.” — uma frase curta na 1ª ferramenta do turno."
          value={tp.enabled}
          onChange={(enabled) => set({ enabled })}
          testID="voice-call-tool-phrases-toggle"
        />
      </Card>
      {tp.enabled ? (
        <>
          <Note>
            {`Só na 1ª tool do turno, nunca mais de uma por turno. Fica no lugar do preâmbulo quando ele ainda não tocou; se o preâmbulo já tocou, só sai ${TOOL_PHRASE_AFTER_PREAMBLE_MS / 1000} s depois do fim dele. Pulada quando o assistente já falou algo antes da tool, quando você está falando ou com outra frase curta tocando. Usa os clipes pré-gerados (“Gerar clipes”); sem eles, sintetiza na hora. Persona/chat podem ligar/desligar (★ segue este padrão).`}
          </Note>
          <Pressable
            onPress={() => setOpen((o) => !o)}
            style={st.expand}
            accessibilityRole="button"
            testID="voice-call-tool-phrases-edit"
          >
            <Ionicons
              name={open ? 'chevron-down' : 'chevron-forward'}
              size={14}
              color={colors.muted}
            />
            <Text style={st.expandText}>Editar as frases</Text>
          </Pressable>
          {open ? (
            <Card>
              <View style={{ gap: spacing.md }} testID="voice-call-tool-phrases-pools">
                {tp.pool ? (
                  <View style={st.custom}>
                    <Text style={st.customText}>
                      Frases personalizadas — gere os clipes de novo depois de editar.
                    </Text>
                    <TextButton
                      title="Restaurar padrão"
                      onPress={() => set({ pool: null })}
                      testID="voice-call-tool-phrases-reset"
                    />
                  </View>
                ) : null}
                {TOOL_PHRASE_CATEGORIES.map((cat) => (
                  <CategoryField
                    key={`${cat}-${tp.pool ? 'custom' : 'default'}`}
                    cat={cat}
                    pool={pool}
                    onCommit={(next) => set({ pool: next })}
                  />
                ))}
              </View>
            </Card>
          ) : null}
        </>
      ) : null}
    </View>
  )
}

const st = StyleSheet.create({
  cat: { color: colors.fg, fontSize: 13.5 },
  expand: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 4 },
  expandText: { color: colors.muted, fontSize: 13.5 },
  custom: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  customText: { flex: 1, color: colors.subtle, fontSize: 12 }
})
