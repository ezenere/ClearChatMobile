// Peças das telas de Configurações: tela com cabeçalho e voltar, rótulos de seção, seletor
// segmentado, área de texto longa, campo numérico e o seletor de ícone (personas e coleções).
import Ionicons from '@expo/vector-icons/Ionicons'
import { useRouter } from 'expo-router'
import { useState, type ReactNode } from 'react'
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type ViewStyle
} from 'react-native'
import { ChatAvatar, PRESET_ICONS } from '@/chat/ChatBits'
import { Screen, ScreenHeader } from '@/ui/Screen'
import { colors, radius, spacing } from '@/ui/theme'

export function SettingsScreen({
  title,
  children,
  footer,
  right,
  testID,
  onBack
}: {
  title: string
  children: ReactNode
  footer?: ReactNode
  right?: ReactNode
  testID?: string
  /** Padrão: voltar na pilha. */
  onBack?: () => void
}) {
  const router = useRouter()
  return (
    <Screen
      testID={testID}
      header={<ScreenHeader title={title} onBack={onBack ?? (() => router.back())} right={right} />}
      footer={footer}
      contentStyle={{ gap: spacing.md }}
    >
      {children}
    </Screen>
  )
}

/** Texto explicativo pequeno. */
export function Note({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={style}>
      <Text style={st.note}>{children}</Text>
    </View>
  )
}

export function FieldLabel({ children, right }: { children: string; right?: ReactNode }) {
  return (
    <View style={st.labelRow}>
      <Text style={st.label}>{children}</Text>
      {right}
    </View>
  )
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  testID
}: {
  options: { value: T; label: string; disabled?: boolean }[]
  value: T | null
  onChange: (v: T) => void
  testID?: string
}) {
  return (
    <View style={st.seg} testID={testID} accessibilityRole="radiogroup">
      {options.map((o) => {
        const on = o.value === value
        return (
          <Pressable
            key={o.value}
            onPress={() => !o.disabled && onChange(o.value)}
            style={[st.segItem, on && st.segOn, o.disabled && { opacity: 0.4 }]}
            accessibilityRole="radio"
            accessibilityState={{ checked: on, disabled: !!o.disabled }}
            accessibilityLabel={o.label}
            testID={testID ? `${testID}-${o.value}` : undefined}
          >
            <Text style={[st.segText, on && st.segTextOn]} numberOfLines={1}>
              {o.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

/** Área de texto longa (prompts). */
export function Multiline({
  value,
  onChangeText,
  placeholder,
  minHeight = 110,
  testID,
  onBlur,
  mono
}: {
  value: string
  onChangeText: (v: string) => void
  placeholder?: string
  minHeight?: number
  testID?: string
  onBlur?: () => void
  mono?: boolean
}) {
  const [focused, setFocused] = useState(false)
  return (
    <TextInput
      testID={testID}
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={colors.faint}
      multiline
      textAlignVertical="top"
      autoCapitalize="sentences"
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false)
        onBlur?.()
      }}
      style={[
        st.multi,
        { minHeight },
        focused && { borderColor: colors.accent, backgroundColor: colors.elevated },
        mono && { fontFamily: 'monospace', fontSize: 13 }
      ]}
    />
  )
}

/** Número com faixa; vazio = `undefined` (padrão). Valida ao sair do campo. */
export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  int = true,
  placeholder = 'padrão',
  testID,
  suffix
}: {
  label: string
  value: number | null | undefined
  onChange: (v: number | undefined) => void
  min: number
  max: number
  int?: boolean
  placeholder?: string
  testID?: string
  suffix?: string
}) {
  const [text, setText] = useState(value == null ? '' : String(value))
  const [seen, setSeen] = useState(value)
  if (value !== seen) {
    setSeen(value)
    setText(value == null ? '' : String(value))
  }
  const commit = () => {
    const t = text.trim().replace(',', '.')
    if (!t) return onChange(undefined)
    const n = Number(t)
    if (!Number.isFinite(n)) return setText(value == null ? '' : String(value))
    const v = Math.min(max, Math.max(min, int ? Math.round(n) : n))
    setText(String(v))
    onChange(v)
  }
  return (
    <View style={st.numRow}>
      <Text style={st.numLabel}>{label}</Text>
      <TextInput
        testID={testID}
        value={text}
        onChangeText={setText}
        onBlur={commit}
        onSubmitEditing={commit}
        placeholder={placeholder}
        placeholderTextColor={colors.faint}
        keyboardType="decimal-pad"
        style={st.numInput}
      />
      {suffix ? <Text style={st.numSuffix}>{suffix}</Text> : null}
    </View>
  )
}

const EMOJIS = ['🤖', '🧠', '🧐', '✍️', '💻', '🔬', '📚', '🌐', '⚖️', '🎨', '🛡️', '⚡']

/** Ícones de persona (os nomes lucide do desktop) + emojis. */
export function IconPicker({
  value,
  onChange,
  allowNone
}: {
  value: string | null
  onChange: (v: string | null) => void
  /** "Ícone da categoria" (coleções). */
  allowNone?: string
}) {
  const names = Object.keys(PRESET_ICONS)
  return (
    <View style={st.icons}>
      {allowNone ? (
        <Pressable
          onPress={() => onChange(null)}
          style={[st.iconCell, st.iconNone, !value && st.iconOn]}
          accessibilityLabel={allowNone}
        >
          <Ionicons name="close" size={18} color={colors.muted} />
        </Pressable>
      ) : null}
      {[...names, ...EMOJIS].map((n) => (
        <Pressable
          key={n}
          onPress={() => onChange(n)}
          style={[st.iconCell, value === n && st.iconOn]}
          accessibilityLabel={`Ícone ${n}`}
          testID={`icon-${n}`}
        >
          <ChatAvatar icon={n} size={34} />
        </Pressable>
      ))}
    </View>
  )
}

/** Linha "título + detalhe + ações" usada nas listas (provedores, personas, dispositivos). */
export function Row({
  left,
  title,
  badge,
  subtitle,
  onPress,
  onLongPress,
  right,
  testID
}: {
  left?: ReactNode
  title: string
  badge?: string | null
  subtitle?: string | null
  onPress?: () => void
  onLongPress?: () => void
  right?: ReactNode
  testID?: string
}) {
  const body = (
    <>
      {left}
      <View style={{ flex: 1, gap: 2 }}>
        <View style={st.rowTitleLine}>
          <Text style={st.rowTitle} numberOfLines={1}>
            {title}
          </Text>
          {badge ? (
            <View style={st.badge}>
              <Text style={st.badgeText}>{badge}</Text>
            </View>
          ) : null}
        </View>
        {subtitle ? (
          <Text style={st.rowSub} numberOfLines={2}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right}
    </>
  )
  if (!onPress)
    return (
      <View style={st.row} testID={testID}>
        {body}
      </View>
    )
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={350}
      accessibilityRole="button"
      accessibilityLabel={title}
      style={({ pressed }) => [st.row, pressed && { backgroundColor: colors.hover }]}
    >
      {body}
    </Pressable>
  )
}

const st = StyleSheet.create({
  note: { color: colors.subtle, fontSize: 12.5, lineHeight: 18 },
  labelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  label: {
    color: colors.subtle,
    fontSize: 12.5,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginTop: spacing.xs
  },
  seg: {
    flexDirection: 'row',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
    padding: 3,
    gap: 3
  },
  segItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    paddingHorizontal: 4,
    borderRadius: radius.sm
  },
  segOn: { backgroundColor: colors.active },
  segText: { color: colors.subtle, fontSize: 13, fontWeight: '500' },
  segTextOn: { color: colors.fg },
  multi: {
    color: colors.fg,
    fontSize: 14.5,
    lineHeight: 20,
    padding: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface
  },
  numRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 },
  numLabel: { flex: 1, color: colors.fg, fontSize: 14.5 },
  numInput: {
    width: 110,
    color: colors.fg,
    fontSize: 14,
    textAlign: 'right',
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderStrong
  },
  numSuffix: { color: colors.subtle, fontSize: 13 },
  icons: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  iconCell: { padding: 3, borderRadius: radius.md, borderWidth: 1, borderColor: 'transparent' },
  iconNone: { width: 42, height: 42, alignItems: 'center', justifyContent: 'center' },
  iconOn: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: 12,
    minHeight: 58
  },
  rowTitleLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowTitle: { color: colors.fg, fontSize: 15.5, fontWeight: '500', flexShrink: 1 },
  rowSub: { color: colors.subtle, fontSize: 12.5, lineHeight: 17 },
  badge: {
    paddingHorizontal: 7,
    paddingVertical: 1,
    borderRadius: radius.sm,
    backgroundColor: colors.accentSoft
  },
  badgeText: { color: colors.accentStrong, fontSize: 11, fontWeight: '600' }
})
