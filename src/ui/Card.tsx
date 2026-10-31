// Cartões, linhas de lista, banner de aviso, interruptor, caixa de seleção, carregando e a marca.
import Ionicons from '@expo/vector-icons/Ionicons'
import type { ReactNode } from 'react'
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  View,
  type StyleProp,
  type ViewStyle
} from 'react-native'
import type { IconName } from './Button'
import { colors, radius, spacing, toneColors, type Tone } from './theme'

export function Card({
  children,
  style,
  padded = true,
  testID
}: {
  children: ReactNode
  style?: StyleProp<ViewStyle>
  padded?: boolean
  testID?: string
}) {
  return (
    <View testID={testID} style={[styles.card, padded && styles.cardPad, style]}>
      {children}
    </View>
  )
}

export function SectionLabel({ children }: { children: string }) {
  return <Text style={styles.section}>{children}</Text>
}

export function Divider() {
  return <View style={styles.divider} />
}

export function ListItem({
  icon,
  iconColor = colors.accentStrong,
  title,
  subtitle,
  right,
  onPress,
  chevron,
  testID,
  danger
}: {
  icon?: IconName
  iconColor?: string
  title: string
  subtitle?: string | null
  right?: ReactNode
  onPress?: () => void
  chevron?: boolean
  testID?: string
  danger?: boolean
}) {
  const content = (
    <>
      {icon ? (
        <View style={[styles.itemIcon, danger && { backgroundColor: colors.dangerSoft }]}>
          <Ionicons name={icon} size={18} color={danger ? colors.danger : iconColor} />
        </View>
      ) : null}
      <View style={styles.itemText}>
        <Text style={[styles.itemTitle, danger && { color: colors.danger }]} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={styles.itemSub} numberOfLines={2}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right}
      {chevron ? <Ionicons name="chevron-forward" size={18} color={colors.subtle} /> : null}
    </>
  )
  if (!onPress)
    return (
      <View testID={testID} style={styles.item}>
        {content}
      </View>
    )
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={title}
      style={({ pressed }) => [styles.item, pressed && { backgroundColor: colors.hover }]}
    >
      {content}
    </Pressable>
  )
}

const TONE_ICON: Record<Tone, IconName> = {
  info: 'information-circle',
  success: 'checkmark-circle',
  warning: 'warning',
  danger: 'alert-circle'
}

export function Banner({
  tone = 'info',
  title,
  children,
  onClose,
  action,
  testID
}: {
  tone?: Tone
  title?: string
  children?: ReactNode
  onClose?: () => void
  action?: ReactNode
  testID?: string
}) {
  const c = toneColors[tone]
  return (
    <View
      testID={testID}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={[styles.banner, { backgroundColor: c.bg, borderColor: c.border }]}
    >
      <Ionicons name={TONE_ICON[tone]} size={19} color={c.fg} style={styles.bannerIcon} />
      <View style={styles.bannerBody}>
        {title ? <Text style={[styles.bannerTitle, { color: c.fg }]}>{title}</Text> : null}
        {children ? (
          typeof children === 'string' ? (
            <Text style={styles.bannerText}>{children}</Text>
          ) : (
            children
          )
        ) : null}
        {action}
      </View>
      {onClose ? (
        <Pressable
          onPress={onClose}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Fechar aviso"
        >
          <Ionicons name="close" size={18} color={colors.muted} />
        </Pressable>
      ) : null}
    </View>
  )
}

export function ToggleRow({
  title,
  subtitle,
  value,
  onChange,
  disabled,
  testID
}: {
  title: string
  subtitle?: string
  value: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  testID?: string
}) {
  return (
    <Pressable
      testID={testID}
      onPress={() => !disabled && onChange(!value)}
      accessibilityRole="switch"
      accessibilityLabel={title}
      accessibilityState={{ checked: value, disabled: !!disabled }}
      style={[styles.toggle, disabled && { opacity: 0.5 }]}
    >
      <View style={styles.itemText}>
        <Text style={styles.toggleTitle}>{title}</Text>
        {subtitle ? <Text style={styles.itemSub}>{subtitle}</Text> : null}
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        trackColor={{ false: colors.active, true: colors.accent }}
        thumbColor={value ? '#ffffff' : colors.muted}
        importantForAccessibility="no-hide-descendants"
      />
    </Pressable>
  )
}

export function Checkbox({
  label,
  value,
  onChange,
  testID
}: {
  label: string
  value: boolean
  onChange: (v: boolean) => void
  testID?: string
}) {
  return (
    <Pressable
      testID={testID}
      onPress={() => onChange(!value)}
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityState={{ checked: value }}
      style={styles.check}
      hitSlop={6}
    >
      <View style={[styles.checkBox, value && styles.checkBoxOn]}>
        {value ? <Ionicons name="checkmark" size={15} color={colors.onAccent} /> : null}
      </View>
      <Text style={styles.checkLabel}>{label}</Text>
    </Pressable>
  )
}

export function Spinner({ label, testID }: { label?: string; testID?: string }) {
  return (
    <View testID={testID} style={styles.spinner} accessibilityLiveRegion="polite">
      <ActivityIndicator color={colors.accentStrong} />
      {label ? <Text style={styles.spinnerText}>{label}</Text> : null}
    </View>
  )
}

export function StatusPill({
  tone,
  label,
  testID
}: {
  tone: 'success' | 'warning' | 'danger' | 'muted'
  label: string
  testID?: string
}) {
  const fg =
    tone === 'success'
      ? colors.success
      : tone === 'warning'
        ? colors.warning
        : tone === 'danger'
          ? colors.danger
          : colors.subtle
  return (
    <View testID={testID} style={styles.pill} accessibilityLabel={`Conexão: ${label}`}>
      <View style={[styles.dot, { backgroundColor: fg }]} />
      <Text style={[styles.pillText, { color: tone === 'muted' ? colors.muted : fg }]}>
        {label}
      </Text>
    </View>
  )
}

/** Marca do app: bolha de conversa sobre o roxo do ícone. */
export function Logo({ size = 56 }: { size?: number }) {
  return (
    <View
      style={[styles.logo, { width: size, height: size, borderRadius: size * 0.28 }]}
      accessibilityLabel="ClearChat"
    >
      <Ionicons name="chatbubbles" size={size * 0.52} color="#ffffff" />
    </View>
  )
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden'
  },
  cardPad: { padding: spacing.lg, gap: spacing.md },
  section: {
    color: colors.subtle,
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginLeft: 4,
    marginBottom: -spacing.sm
  },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginLeft: 60 },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: 14,
    minHeight: 60
  },
  itemIcon: {
    width: 32,
    height: 32,
    borderRadius: 9,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center'
  },
  itemText: { flex: 1, gap: 2 },
  itemTitle: { color: colors.fg, fontSize: 15.5, fontWeight: '500' },
  itemSub: { color: colors.muted, fontSize: 13, lineHeight: 18 },
  banner: {
    flexDirection: 'row',
    gap: spacing.md,
    padding: spacing.md,
    paddingRight: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1
  },
  bannerIcon: { marginTop: 1 },
  bannerBody: { flex: 1, gap: 4 },
  bannerTitle: { fontSize: 14.5, fontWeight: '600' },
  bannerText: { color: colors.fg, fontSize: 14, lineHeight: 20, opacity: 0.92 },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: 6 },
  toggleTitle: { color: colors.fg, fontSize: 15, fontWeight: '500' },
  check: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  checkBox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: colors.faint,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1
  },
  checkBoxOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  checkLabel: { flex: 1, color: colors.fg, fontSize: 14.5, lineHeight: 21 },
  spinner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 },
  spinnerText: { color: colors.muted, fontSize: 13.5 },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radius.pill,
    backgroundColor: colors.elevated,
    borderWidth: 1,
    borderColor: colors.border
  },
  dot: { width: 7, height: 7, borderRadius: 4 },
  pillText: { fontSize: 12.5, fontWeight: '600' },
  logo: {
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center'
  }
})
