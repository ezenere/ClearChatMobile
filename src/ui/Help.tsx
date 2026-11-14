// Peças da regra "sem texto solto nas configurações" (= desktop 18f4d8c, SPEC → "Texto solto nas
// telas de configuração"): explicação estática, listas de modelos aceitos e limites ficam atrás do
// (?) — `HelpButton`, que abre uma folha pequena (o celular não tem hover); fato curto da seleção
// atual (capacidade, transporte, idioma, disponibilidade) vira `Chip` neutro, com o detalhe numa folha
// ao tocar. O estado que pede ação mora no próprio botão (Button variant="warning").
import Ionicons from '@expo/vector-icons/Ionicons'
import { useState, type ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { IconName } from './Button'
import { Sheet } from './Sheet'
import { colors, radius } from './theme'

/** Corpo de uma folha de ajuda: texto (parágrafos separados por linha em branco) ou nós. */
function HelpBody({ children }: { children: ReactNode }) {
  if (typeof children !== 'string') return <View style={st.body}>{children}</View>
  return (
    <View style={st.body}>
      {children.split(/\n{2,}/).map((p, i) => (
        <Text key={i} style={st.text}>
          {p}
        </Text>
      ))}
    </View>
  )
}

/** (?) ao lado de um título/campo: a explicação abre numa folha pequena. */
export function HelpButton({
  title,
  children,
  testID,
  size = 17
}: {
  title: string
  children: ReactNode
  testID?: string
  size?: number
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel={`Ajuda: ${title}`}
        testID={testID}
        style={({ pressed }) => [st.help, pressed && { opacity: 0.6 }]}
      >
        <Ionicons name="help-circle-outline" size={size} color={colors.subtle} />
      </Pressable>
      <Sheet
        visible={open}
        onClose={() => setOpen(false)}
        title={title}
        testID={testID ? `${testID}-sheet` : undefined}
      >
        <HelpBody>{children}</HelpBody>
      </Sheet>
    </>
  )
}

export type ChipTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'

const TONES: Record<ChipTone, { fg: string; bg: string; border: string }> = {
  neutral: { fg: colors.muted, bg: 'rgba(255,255,255,0.04)', border: colors.border },
  accent: { fg: colors.accentStrong, bg: colors.accentSoft, border: colors.accentBorder },
  success: { fg: colors.success, bg: colors.successSoft, border: 'rgba(74, 222, 128, 0.3)' },
  warning: { fg: colors.warning, bg: colors.warningSoft, border: 'rgba(245, 181, 68, 0.32)' },
  danger: { fg: colors.danger, bg: colors.dangerSoft, border: 'rgba(248, 113, 113, 0.32)' }
}

/**
 * Fato curto da seleção atual ("tags", "HTTP", "também no ditado", "usa o padrão daqui"). Com
 * `detail`, tocar abre o detalhe numa folha (o texto também vai para o leitor de tela).
 */
export function Chip({
  label,
  detail,
  tone = 'neutral',
  icon,
  testID
}: {
  label: string
  detail?: string | null
  tone?: ChipTone
  icon?: IconName
  testID?: string
}) {
  const [open, setOpen] = useState(false)
  const c = TONES[tone]
  const body = (
    <>
      {icon ? <Ionicons name={icon} size={11} color={c.fg} /> : null}
      <Text style={[st.chipText, { color: c.fg }]} numberOfLines={1}>
        {label}
      </Text>
    </>
  )
  const style = [st.chip, { backgroundColor: c.bg, borderColor: c.border }]
  if (!detail)
    return (
      <View style={style} testID={testID} accessibilityLabel={label}>
        {body}
      </View>
    )
  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        hitSlop={6}
        style={({ pressed }) => [...style, pressed && { opacity: 0.7 }]}
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${detail}`}
        testID={testID}
      >
        {body}
      </Pressable>
      <Sheet
        visible={open}
        onClose={() => setOpen(false)}
        title={label}
        testID={testID ? `${testID}-sheet` : undefined}
      >
        <HelpBody>{detail}</HelpBody>
      </Sheet>
    </>
  )
}

/** Linha de chips (quebra de linha quando não cabem). */
export function Chips({ children }: { children: ReactNode }) {
  return <View style={st.chips}>{children}</View>
}

const st = StyleSheet.create({
  help: { padding: 1 },
  body: { gap: 10, paddingHorizontal: 10, paddingBottom: 10 },
  text: { color: colors.muted, fontSize: 14, lineHeight: 20 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'flex-start',
    borderRadius: radius.sm,
    borderWidth: 1,
    paddingHorizontal: 7,
    paddingVertical: 2,
    maxWidth: 260
  },
  chipText: { fontSize: 11.5, fontWeight: '500' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 }
})
