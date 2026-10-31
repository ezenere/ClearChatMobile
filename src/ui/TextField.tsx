// Campo de texto com rótulo, dica, erro e (para senhas) botão de mostrar/esconder.
import Ionicons from '@expo/vector-icons/Ionicons'
import { forwardRef, useState, type ComponentRef, type ReactNode } from 'react'
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type TextStyle
} from 'react-native'
import type { IconName } from './Button'
import { colors, font, radius, spacing } from './theme'

export interface TextFieldProps extends Omit<TextInputProps, 'style'> {
  label?: string
  hint?: ReactNode
  error?: string | null
  icon?: IconName
  secure?: boolean
  mono?: boolean
  inputStyle?: StyleProp<TextStyle>
  /** Conteúdo abaixo do campo (ex.: medidor de força). */
  below?: ReactNode
}

export const TextField = forwardRef<ComponentRef<typeof TextInput>, TextFieldProps>(
  function TextField(
    { label, hint, error, icon, secure, mono, inputStyle, below, editable = true, ...rest },
    ref
  ) {
    const [focused, setFocused] = useState(false)
    const [reveal, setReveal] = useState(false)
    const border = error ? colors.danger : focused ? colors.accent : colors.borderStrong
    return (
      <View style={styles.wrap}>
        {label ? <Text style={styles.label}>{label}</Text> : null}
        <View
          style={[
            styles.box,
            { borderColor: border, opacity: editable ? 1 : 0.6 },
            focused && styles.boxFocused
          ]}
        >
          {icon ? (
            <Ionicons
              name={icon}
              size={18}
              color={focused ? colors.accentStrong : colors.subtle}
              style={styles.icon}
            />
          ) : null}
          <TextInput
            ref={ref}
            placeholderTextColor={colors.faint}
            selectionColor={colors.accentStrong}
            cursorColor={colors.accentStrong}
            secureTextEntry={secure && !reveal}
            editable={editable}
            accessibilityLabel={rest.accessibilityLabel ?? label}
            {...rest}
            onFocus={(e) => {
              setFocused(true)
              rest.onFocus?.(e)
            }}
            onBlur={(e) => {
              setFocused(false)
              rest.onBlur?.(e)
            }}
            style={[styles.input, mono && styles.mono, inputStyle]}
          />
          {secure ? (
            <Pressable
              onPress={() => setReveal((r) => !r)}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel={reveal ? 'Esconder senha' : 'Mostrar senha'}
              style={styles.eye}
            >
              <Ionicons
                name={reveal ? 'eye-off-outline' : 'eye-outline'}
                size={20}
                color={colors.muted}
              />
            </Pressable>
          ) : null}
        </View>
        {below}
        {error ? (
          <View style={styles.errorRow}>
            <Ionicons name="alert-circle" size={14} color={colors.danger} />
            <Text style={styles.error} accessibilityLiveRegion="polite">
              {error}
            </Text>
          </View>
        ) : hint ? (
          typeof hint === 'string' ? (
            <Text style={styles.hint}>{hint}</Text>
          ) : (
            hint
          )
        ) : null}
      </View>
    )
  }
)

const styles = StyleSheet.create({
  wrap: { gap: 6 },
  label: { color: colors.muted, fontSize: 13, fontWeight: '500', marginLeft: 2 },
  box: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 50,
    borderRadius: radius.md,
    borderWidth: 1,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md
  },
  boxFocused: { backgroundColor: colors.elevated },
  icon: { marginRight: spacing.sm },
  input: {
    flex: 1,
    color: colors.fg,
    fontSize: 16,
    paddingVertical: 12
  },
  mono: { fontFamily: font.mono, letterSpacing: 0.5 },
  eye: { paddingLeft: spacing.sm, paddingVertical: spacing.xs },
  hint: { color: colors.subtle, fontSize: 12.5, lineHeight: 17, marginLeft: 2 },
  errorRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginLeft: 2 },
  error: { color: colors.danger, fontSize: 13, flexShrink: 1 }
})
