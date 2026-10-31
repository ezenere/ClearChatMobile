// Peças pequenas da conversa (estilo do desktop): copiar, hora, pílula do dia, seletor de versão
// ‹ i/n ›, cartão recolhível e bloco monoespaçado com "mostrar tudo".
import Ionicons from '@expo/vector-icons/Ionicons'
import * as Clipboard from 'expo-clipboard'
import { memo, useState, type ReactNode } from 'react'
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle
} from 'react-native'
import type { SiblingInfo } from '@shared/branches'
import { formatTime } from '@vendor/renderer/dates'
import type { IconName } from '@/ui/Button'
import { colors, font, radius } from '@/ui/theme'

export function CopyButton({
  text,
  label = 'Copiar',
  compact,
  testID
}: {
  text: string
  label?: string
  compact?: boolean
  testID?: string
}) {
  const [done, setDone] = useState(false)
  return (
    <Pressable
      testID={testID}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={done ? 'Copiado' : label || 'Copiar'}
      onPress={() => {
        void Clipboard.setStringAsync(text).then(() => {
          setDone(true)
          setTimeout(() => setDone(false), 1400)
        })
      }}
      style={({ pressed }) => [s.copy, pressed && { backgroundColor: colors.hover }]}
    >
      <Ionicons
        name={done ? 'checkmark' : 'copy-outline'}
        size={14}
        color={done ? colors.success : colors.subtle}
      />
      {!compact ? <Text style={s.copyText}>{done ? 'Copiado' : label}</Text> : null}
    </Pressable>
  )
}

export function MsgTime({ ts, style }: { ts: number; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={style}>
      <Text style={s.time}>{formatTime(ts)}</Text>
    </View>
  )
}

export function DayPill({ label }: { label: string }) {
  return (
    <View style={s.dayRow} testID="day-separator">
      <View style={s.dayPill}>
        <Text style={s.dayText}>{label}</Text>
      </View>
    </View>
  )
}

/** ‹ i/n › — troca a versão mostrada (só na tela nesta fase). */
export const BranchSwitcher = memo(function BranchSwitcher({
  info,
  onSelect,
  local
}: {
  info: SiblingInfo
  onSelect: (id: string) => void
  /** A tela está numa versão escolhida aqui (não sincronizada). */
  local?: boolean
}) {
  const btn = (id: string | null, icon: IconName, label: string, testID: string) => (
    <Pressable
      testID={testID}
      disabled={!id}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => id && onSelect(id)}
      style={({ pressed }) => [
        s.branchBtn,
        pressed && { backgroundColor: colors.hover },
        !id && { opacity: 0.35 }
      ]}
    >
      <Ionicons name={icon} size={15} color={colors.muted} />
    </Pressable>
  )
  return (
    <View
      style={s.branch}
      testID="branch-switcher"
      accessibilityLabel={`Versão ${info.index + 1} de ${info.count}`}
    >
      {btn(info.prevId, 'chevron-back', 'Versão anterior', 'branch-prev')}
      <Text style={[s.branchText, local && { color: colors.accentStrong }]} testID="branch-label">
        {info.index + 1}/{info.count}
      </Text>
      {btn(info.nextId, 'chevron-forward', 'Próxima versão', 'branch-next')}
    </View>
  )
})

/** Cartão com cabeçalho tocável que abre/fecha o corpo (tool, raciocínio, resumo…). */
export function Collapsible({
  icon,
  iconColor = colors.muted,
  title,
  summary,
  right,
  children,
  open,
  onToggle,
  tone,
  below,
  testID
}: {
  icon: IconName
  iconColor?: string
  title: string
  summary?: string
  right?: ReactNode
  children?: ReactNode
  open: boolean
  onToggle: () => void
  tone?: 'warning' | 'danger' | 'accent'
  /** Sempre visível sob o cabeçalho (ex.: faixa de negada, corpo do delegate). */
  below?: ReactNode
  testID?: string
}) {
  const border =
    tone === 'warning'
      ? 'rgba(245, 181, 68, 0.35)'
      : tone === 'danger'
        ? 'rgba(248, 113, 113, 0.3)'
        : tone === 'accent'
          ? colors.accentBorder
          : colors.border
  return (
    <View style={[s.card, { borderColor: border }]} testID={testID}>
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={title}
        style={({ pressed }) => [
          s.cardHead,
          pressed && { backgroundColor: 'rgba(255,255,255,0.03)' }
        ]}
      >
        <Ionicons
          name="chevron-forward"
          size={13}
          color={colors.faint}
          style={{ transform: [{ rotate: open ? '90deg' : '0deg' }] }}
        />
        <Ionicons name={icon} size={14} color={iconColor} />
        <Text style={s.cardTitle} numberOfLines={1}>
          {title}
        </Text>
        {summary ? (
          <Text style={s.cardSummary} numberOfLines={1}>
            {summary}
          </Text>
        ) : (
          <View style={{ flex: 1 }} />
        )}
        {right}
      </Pressable>
      {below}
      {open ? <View style={s.cardBody}>{children}</View> : null}
    </View>
  )
}

const MAX_CHARS = 6000

/** Bloco monoespaçado (argumentos, resultados) com cópia e "mostrar tudo" para textos longos. */
export function MonoBlock({
  label,
  text,
  wrap = true,
  testID
}: {
  label?: string
  text: string
  /** false = linhas longas rolam na horizontal (código). */
  wrap?: boolean
  testID?: string
}) {
  const [all, setAll] = useState(false)
  const long = text.length > MAX_CHARS
  const shown = long && !all ? `${text.slice(0, MAX_CHARS)}\n…` : text
  const body = (
    <Text style={s.mono} selectable>
      {shown || <Text style={s.empty}>(vazio)</Text>}
    </Text>
  )
  return (
    <View style={s.section} testID={testID}>
      {label ? (
        <View style={s.sectionHead}>
          <Text style={s.sectionLabel} numberOfLines={1}>
            {label}
          </Text>
          <CopyButton text={text} />
        </View>
      ) : null}
      <View style={s.pre}>
        {wrap ? (
          body
        ) : (
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            {body}
          </ScrollView>
        )}
      </View>
      {long ? (
        <Pressable onPress={() => setAll((a) => !a)} hitSlop={6}>
          <Text style={s.more}>
            {all
              ? 'Mostrar menos'
              : `Mostrar tudo (${text.length.toLocaleString('pt-BR')} caracteres)`}
          </Text>
        </Pressable>
      ) : null}
    </View>
  )
}

export const s = StyleSheet.create({
  copy: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderRadius: radius.sm
  },
  copyText: { color: colors.subtle, fontSize: 11.5 },
  time: { color: colors.faint, fontSize: 11, fontVariant: ['tabular-nums'] },
  dayRow: { alignItems: 'center', paddingVertical: 10 },
  dayPill: {
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: 'rgba(23,23,30,0.92)',
    paddingHorizontal: 10,
    paddingVertical: 3
  },
  dayText: { color: colors.muted, fontSize: 11, fontWeight: '500' },
  branch: { flexDirection: 'row', alignItems: 'center', gap: 1 },
  branchBtn: {
    width: 26,
    height: 26,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center'
  },
  branchText: {
    color: colors.subtle,
    fontSize: 12,
    fontFamily: font.mono,
    minWidth: 30,
    textAlign: 'center'
  },
  card: {
    marginVertical: 5,
    borderRadius: 12,
    borderWidth: 1,
    backgroundColor: 'rgba(16,16,21,0.7)',
    overflow: 'hidden'
  },
  cardHead: {
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 11
  },
  cardTitle: {
    color: 'rgba(230,230,234,0.92)',
    fontSize: 13,
    fontWeight: '500',
    flexShrink: 0,
    maxWidth: '55%'
  },
  cardSummary: {
    flex: 1,
    color: colors.subtle,
    fontSize: 12,
    fontFamily: font.mono
  },
  cardBody: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  section: { paddingHorizontal: 12, paddingVertical: 9, gap: 6 },
  sectionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sectionLabel: { color: colors.subtle, fontSize: 11.5, fontWeight: '500', flex: 1 },
  pre: {
    backgroundColor: 'rgba(11,11,15,0.7)',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8
  },
  mono: { color: 'rgba(230,230,234,0.85)', fontFamily: font.mono, fontSize: 12, lineHeight: 18 },
  empty: { color: colors.faint, fontStyle: 'italic' },
  more: { color: colors.accentStrong, fontSize: 12.5, paddingTop: 2 }
})
