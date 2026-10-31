// Tela base: áreas seguras, rolagem que acompanha o teclado (react-native-keyboard-controller — o
// teclado nunca cobre o campo em foco, também com edge-to-edge) e cabeçalho opcional com voltar.
import Ionicons from '@expo/vector-icons/Ionicons'
import type { ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native'
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { colors, spacing } from './theme'

export function Screen({
  children,
  header,
  footer,
  scroll = true,
  center,
  contentStyle,
  testID
}: {
  children: ReactNode
  header?: ReactNode
  /** Fica fora da rolagem, colado embaixo (acima do teclado quando aberto). */
  footer?: ReactNode
  scroll?: boolean
  /** Centraliza o conteúdo na vertical quando sobra espaço. */
  center?: boolean
  contentStyle?: StyleProp<ViewStyle>
  testID?: string
}) {
  const insets = useSafeAreaInsets()
  const pad = {
    paddingLeft: Math.max(insets.left, 0) + spacing.xl,
    paddingRight: Math.max(insets.right, 0) + spacing.xl
  }
  const body = (
    <View style={[styles.content, center && styles.center, contentStyle]}>{children}</View>
  )
  return (
    <View
      testID={testID}
      style={[styles.root, { paddingTop: header ? 0 : insets.top }]}
      collapsable={false}
    >
      {header ? <View style={{ paddingTop: insets.top }}>{header}</View> : null}
      {scroll ? (
        <KeyboardAwareScrollView
          bottomOffset={96}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={[
            styles.scroll,
            pad,
            { paddingBottom: (footer ? spacing.lg : insets.bottom + spacing.xl) as number }
          ]}
          showsVerticalScrollIndicator={false}
        >
          {body}
        </KeyboardAwareScrollView>
      ) : (
        <View style={[styles.flex, pad, { paddingBottom: footer ? 0 : insets.bottom }]}>
          {body}
        </View>
      )}
      {footer ? (
        <View style={[styles.footer, pad, { paddingBottom: insets.bottom + spacing.lg }]}>
          {footer}
        </View>
      ) : null}
    </View>
  )
}

export function ScreenHeader({
  title,
  onBack,
  right,
  backLabel = 'Voltar'
}: {
  title?: string
  onBack?: () => void
  right?: ReactNode
  backLabel?: string
}) {
  return (
    <View style={styles.header}>
      <View style={styles.headerSide}>
        {onBack ? (
          <Pressable
            onPress={onBack}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel={backLabel}
            testID="header-back"
            style={({ pressed }) => [styles.back, pressed && { backgroundColor: colors.hover }]}
          >
            <Ionicons name="chevron-back" size={24} color={colors.fg} />
          </Pressable>
        ) : null}
      </View>
      <Text style={styles.headerTitle} numberOfLines={1}>
        {title ?? ''}
      </Text>
      <View style={[styles.headerSide, styles.headerRight]}>{right}</View>
    </View>
  )
}

/** Título + subtítulo do topo das telas de autenticação. */
export function Hero({
  title,
  subtitle,
  icon
}: {
  title: string
  subtitle?: ReactNode
  icon?: ReactNode
}) {
  return (
    <View style={styles.hero}>
      {icon}
      <Text style={styles.heroTitle} accessibilityRole="header">
        {title}
      </Text>
      {subtitle ? (
        typeof subtitle === 'string' ? (
          <Text style={styles.heroSub}>{subtitle}</Text>
        ) : (
          subtitle
        )
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  scroll: { flexGrow: 1, paddingTop: spacing.lg },
  content: { flexGrow: 1, gap: spacing.lg, width: '100%', maxWidth: 520, alignSelf: 'center' },
  center: { justifyContent: 'center' },
  footer: {
    paddingTop: spacing.md,
    gap: spacing.sm,
    backgroundColor: colors.bg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border
  },
  header: {
    height: 56,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm
  },
  headerSide: { width: 56, flexDirection: 'row' },
  headerRight: { justifyContent: 'flex-end', paddingRight: spacing.sm },
  back: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center'
  },
  headerTitle: {
    flex: 1,
    textAlign: 'center',
    color: colors.fg,
    fontSize: 17,
    fontWeight: '600'
  },
  hero: { gap: spacing.sm, marginBottom: spacing.xs },
  heroTitle: { color: colors.fg, fontSize: 26, lineHeight: 32, fontWeight: '700' },
  heroSub: { color: colors.muted, fontSize: 15, lineHeight: 22 }
})
