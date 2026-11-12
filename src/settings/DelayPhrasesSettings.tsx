// Configurações → Voz → Chamada de voz → "Frases de espera" (`voiceCallDefaults.delayPhrases`, deste
// aparelho) — = `DelayPhrasesSettings.tsx` do desktop: liga/desliga, "Manter viva após (silêncio)",
// "Agradecer se a última frase foi há mais de" e os três pools (recolhidos; uma frase por linha;
// "Restaurar padrão" em cada) — "manter viva" pensando / com uma ferramenta rodando e "obrigado por
// aguardar". As regras são do `VoiceCallManager` vendorado (SPEC → "Frases de demora").
import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import Ionicons from '@expo/vector-icons/Ionicons'
import {
  DEFAULT_DELAY_PHRASES,
  DEFAULT_KEEPALIVE_POOL,
  DEFAULT_KEEPALIVE_TOOL_POOL,
  DEFAULT_THANKS_POOL,
  DELAY_PHRASE_MS_RANGE,
  normalizeDelayPhrasePool,
  THANKS_AFTER_MS_RANGE,
  type VoiceDelayPhrases
} from '@shared/voice'
import { KEEPALIVE_MAX_PER_TURN } from '@shared/voicePolicy'
import { TextButton } from '@/ui/Button'
import { Card, ToggleRow } from '@/ui/Card'
import { colors, spacing } from '@/ui/theme'
import { Multiline, Note, NumberField } from './ui'

const poolText = (pool: readonly string[]): string => pool.join('\n')
const seconds = (ms: number): string => String(ms / 1000).replace('.', ',')

/** Pool editável (uma frase por linha; grava ao sair do campo; igual ao padrão ou vazio → padrão). */
function PoolField({
  label,
  value,
  defaults,
  testID,
  onCommit
}: {
  label: string
  value: string[] | null
  defaults: readonly string[]
  testID: string
  onCommit: (pool: string[] | null) => void
}) {
  const effective = value ?? defaults
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    if (draft == null) return
    setDraft(null)
    const pool = normalizeDelayPhrasePool(draft.split('\n'))
    const next = !pool || poolText(pool) === poolText(defaults) ? null : pool
    if (poolText(next ?? defaults) !== poolText(effective)) onCommit(next)
  }
  return (
    <View style={{ gap: 4 }}>
      <View style={st.poolHead}>
        <Text style={st.poolLabel}>{label}</Text>
        {value ? (
          <TextButton
            title="Restaurar padrão"
            onPress={() => {
              setDraft(null)
              onCommit(null)
            }}
            testID={`${testID}-reset`}
          />
        ) : null}
      </View>
      <Multiline
        value={draft ?? poolText(effective)}
        onChangeText={setDraft}
        onBlur={commit}
        minHeight={64}
        testID={testID}
      />
    </View>
  )
}

export function DelayPhrasesSettings({
  value,
  onChange
}: {
  value: VoiceDelayPhrases | null | undefined
  onChange: (next: VoiceDelayPhrases) => void
}) {
  const dp = value ?? DEFAULT_DELAY_PHRASES
  const [open, setOpen] = useState(false)
  const set = (patch: Partial<VoiceDelayPhrases>) => onChange({ ...dp, ...patch })
  return (
    <View style={{ gap: spacing.sm }} testID="voice-call-delay-phrases">
      <Card>
        <ToggleRow
          title="Frases de espera"
          subtitle="“Só mais um instante…” quando a resposta demora; “Obrigado por aguardar.” antes da resposta que demorou."
          value={dp.enabled}
          onChange={(enabled) => set({ enabled })}
          testID="voice-call-delay"
        />
        {dp.enabled ? (
          <>
            <NumberField
              label="Manter viva após (silêncio)"
              value={dp.keepAliveAfterMs}
              onChange={(n) =>
                set({ keepAliveAfterMs: n ?? DEFAULT_DELAY_PHRASES.keepAliveAfterMs })
              }
              min={DELAY_PHRASE_MS_RANGE.min}
              max={DELAY_PHRASE_MS_RANGE.max}
              suffix="ms"
              placeholder={String(DEFAULT_DELAY_PHRASES.keepAliveAfterMs)}
              testID="voice-call-keepalive-after"
            />
            <Text style={st.hint}>
              {`Silêncio desde o fim da última fala (preâmbulo, frase de ferramenta, a “manter viva” anterior — ou o envio da sua fala) até a próxima “manter viva”; é também o espaço entre duas delas. Padrão ${seconds(DEFAULT_DELAY_PHRASES.keepAliveAfterMs)} s.`}
            </Text>
            <NumberField
              label="Agradecer se a última frase foi há mais de"
              value={dp.thanksAfterMs}
              onChange={(n) => set({ thanksAfterMs: n ?? DEFAULT_DELAY_PHRASES.thanksAfterMs })}
              min={THANKS_AFTER_MS_RANGE.min}
              max={THANKS_AFTER_MS_RANGE.max}
              suffix="ms"
              placeholder={String(DEFAULT_DELAY_PHRASES.thanksAfterMs)}
              testID="voice-call-thanks-after"
            />
            <Text style={st.hint}>
              {`“Obrigado por aguardar” antes da resposta só se a última frase de espera terminou há mais que isto (a resposta logo depois do “só mais um instante” dispensa o agradecimento). Padrão ${seconds(DEFAULT_DELAY_PHRASES.thanksAfterMs)} s.`}
            </Text>
          </>
        ) : null}
      </Card>
      {dp.enabled ? (
        <>
          <Note>
            {`“Manter viva”: a cada “Manter viva após” de silêncio sem a resposta — com a ferramenta rodando ou com o modelo pensando de novo depois dela —, no máximo ${KEEPALIVE_MAX_PER_TURN} por turno. “Obrigado por aguardar”: só depois de uma “manter viva”; fica pronto na hora (clipe de “Gerar clipes” ou sintetizado enquanto você espera) — a resposta nunca espera por ele. Nunca enquanto você fala (um ruído só pausa), depois de um barge-in, da despedida ou com uma aprovação/pergunta esperando você. Não entram no histórico; os caracteres sintetizados contam no custo da voz.`}
          </Note>
          <Pressable
            onPress={() => setOpen((o) => !o)}
            style={st.expand}
            accessibilityRole="button"
            testID="voice-call-delay-pools-edit"
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
              <View style={{ gap: spacing.md }} testID="voice-call-delay-pools">
                <PoolField
                  label="Manter viva — pensando"
                  value={dp.keepAlivePool}
                  defaults={DEFAULT_KEEPALIVE_POOL}
                  testID="voice-call-keepalive-pool"
                  onCommit={(keepAlivePool) => set({ keepAlivePool })}
                />
                <PoolField
                  label="Manter viva — ferramenta rodando"
                  value={dp.keepAliveToolPool}
                  defaults={DEFAULT_KEEPALIVE_TOOL_POOL}
                  testID="voice-call-keepalive-tool-pool"
                  onCommit={(keepAliveToolPool) => set({ keepAliveToolPool })}
                />
                <PoolField
                  label="Obrigado por aguardar"
                  value={dp.thanksPool}
                  defaults={DEFAULT_THANKS_POOL}
                  testID="voice-call-thanks-pool"
                  onCommit={(thanksPool) => set({ thanksPool })}
                />
                <Text style={st.hint}>
                  Mudou as frases de agradecimento? Gere os clipes de novo — sem eles, saem
                  sintetizadas na hora.
                </Text>
              </View>
            </Card>
          ) : null}
        </>
      ) : null}
    </View>
  )
}

const st = StyleSheet.create({
  hint: { color: colors.subtle, fontSize: 12, lineHeight: 16 },
  poolHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 28 },
  poolLabel: { flex: 1, color: colors.fg, fontSize: 13.5 },
  expand: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 4 },
  expandText: { color: colors.muted, fontSize: 13.5 }
})
