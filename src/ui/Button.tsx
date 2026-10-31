// Botão com variantes (primário, secundário, fantasma, perigo), carregando e ícone.
import Ionicons from '@expo/vector-icons/Ionicons'
import type { ComponentProps, ReactNode } from 'react'
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle
} from 'react-native'
import { colors, radius, spacing } from './theme'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'dangerGhost'
export type IconName = ComponentProps<typeof Ionicons>['name']

const V: Record<
  ButtonVariant,
  { bg: string; pressed: string; fg: string; border: string; spinner: string }
> = {
  primary: {
    bg: colors.accent,
    pressed: '#7c4ee6',
    fg: colors.onAccent,
    border: colors.accent,
    spinner: colors.onAccent
  },
  secondary: {
    bg: colors.elevated,
    pressed: colors.active,
    fg: colors.fg,
    border: colors.borderStrong,
    spinner: colors.fg
  },
  ghost: {
    bg: 'transparent',
    pressed: colors.hover,
    fg: colors.accentStrong,
    border: 'transparent',
    spinner: colors.accentStrong
  },
  danger: {
    bg: colors.dangerSoft,
    pressed: 'rgba(248, 113, 113, 0.2)',
    fg: colors.danger,
    border: 'rgba(248, 113, 113, 0.35)',
    spinner: colors.danger
  },
  dangerGhost: {
    bg: 'transparent',
    pressed: colors.dangerSoft,
    fg: colors.danger,
    border: 'transparent',
    spinner: colors.danger
  }
}

export interface ButtonProps {
  title: string
  onPress?: () => void
  variant?: ButtonVariant
  size?: 'md' | 'sm'
  icon?: IconName
  iconRight?: IconName
  loading?: boolean
  disabled?: boolean
  full?: boolean
  style?: StyleProp<ViewStyle>
  testID?: string
  accessibilityHint?: string
  children?: ReactNode
}

export function Button({
  title,
  onPress,
  variant = 'primary',
  size = 'md',
  icon,
  iconRight,
  loading,
  disabled,
  full = true,
  style,
  testID,
  accessibilityHint
}: ButtonProps) {
  const v = V[variant]
  const inactive = disabled || loading
  const h = size === 'sm' ? 38 : 50
  const fs = size === 'sm' ? 14 : 16
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!inactive, busy: !!loading }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        {
          height: h,
          paddingHorizontal: size === 'sm' ? spacing.md : spacing.lg,
          backgroundColor: pressed ? v.pressed : v.bg,
          borderColor: v.border,
          alignSelf: full ? 'stretch' : 'flex-start',
          opacity: disabled && !loading ? 0.45 : 1
        },
        style
      ]}
    >
      <View style={styles.row}>
        {loading ? (
          <ActivityIndicator size="small" color={v.spinner} />
        ) : icon ? (
          <Ionicons name={icon} size={fs + 2} color={v.fg} />
        ) : null}
        <Text numberOfLines={1} style={[styles.text, { color: v.fg, fontSize: fs }]}>
          {title}
        </Text>
        {iconRight && !loading ? <Ionicons name={iconRight} size={fs + 2} color={v.fg} /> : null}
      </View>
    </Pressable>
  )
}

/** Link de texto (ações secundárias). */
export function TextButton({
  title,
  onPress,
  tone = 'accent',
  testID,
  disabled,
  icon
}: {
  title: string
  onPress?: () => void
  tone?: 'accent' | 'muted' | 'danger'
  testID?: string
  disabled?: boolean
  icon?: IconName
}) {
  const color =
    tone === 'accent' ? colors.accentStrong : tone === 'danger' ? colors.danger : colors.muted
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => [styles.link, { opacity: disabled ? 0.45 : pressed ? 0.6 : 1 }]}
    >
      {icon ? <Ionicons name={icon} size={15} color={color} /> : null}
      <Text style={[styles.linkText, { color }]}>{title}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  base: {
    borderRadius: radius.md,
    borderWidth: 1,
    justifyContent: 'center',
    alignItems: 'center'
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  text: { fontWeight: '600', letterSpacing: 0.1 },
  link: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: spacing.sm,
    alignSelf: 'center'
  },
  linkText: { fontSize: 14.5, fontWeight: '500' }
})
