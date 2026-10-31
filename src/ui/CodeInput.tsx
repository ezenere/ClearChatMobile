// Código de 6 dígitos: um TextInput invisível por cima de 6 caixas (colar, autofill de SMS/e-mail,
// apagar e digitar funcionam como num campo normal).
import { forwardRef, useState, type ComponentRef } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { colors, font, radius } from './theme'

export const CODE_LENGTH = 6

export const onlyDigits = (s: string, max = CODE_LENGTH): string =>
  s.replace(/\D/g, '').slice(0, max)

export const CodeInput = forwardRef<
  ComponentRef<typeof TextInput>,
  {
    value: string
    onChange: (v: string) => void
    onComplete?: (v: string) => void
    error?: boolean
    disabled?: boolean
    autoFocus?: boolean
    testID?: string
  }
>(function CodeInput({ value, onChange, onComplete, error, disabled, autoFocus, testID }, ref) {
  const [focused, setFocused] = useState(false)
  const digits = value.split('')
  const active = Math.min(value.length, CODE_LENGTH - 1)
  return (
    <Pressable style={styles.row} accessible={false}>
      {Array.from({ length: CODE_LENGTH }, (_, i) => {
        const filled = i < digits.length
        const isActive = focused && i === active && !disabled
        return (
          <View
            key={i}
            style={[
              styles.cell,
              filled && styles.cellFilled,
              isActive && styles.cellActive,
              error && styles.cellError
            ]}
          >
            <Text style={styles.digit}>{digits[i] ?? ''}</Text>
            {isActive && !filled ? <View style={styles.caret} /> : null}
          </View>
        )
      })}
      <TextInput
        ref={ref}
        testID={testID}
        value={value}
        onChangeText={(t) => {
          const d = onlyDigits(t)
          onChange(d)
          if (d.length === CODE_LENGTH) onComplete?.(d)
        }}
        editable={!disabled}
        autoFocus={autoFocus}
        keyboardType="number-pad"
        inputMode="numeric"
        textContentType="oneTimeCode"
        autoComplete="one-time-code"
        maxLength={CODE_LENGTH + 4}
        caretHidden
        contextMenuHidden={false}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        accessibilityLabel="Código de 6 dígitos"
        style={styles.hidden}
      />
    </Pressable>
  )
})

const styles = StyleSheet.create({
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  cell: {
    flex: 1,
    aspectRatio: 0.82,
    maxHeight: 64,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center'
  },
  cellFilled: { borderColor: colors.faint, backgroundColor: colors.elevated },
  cellActive: { borderColor: colors.accent, backgroundColor: colors.elevated },
  cellError: { borderColor: colors.danger },
  digit: { color: colors.fg, fontSize: 26, fontWeight: '600', fontFamily: font.mono },
  caret: {
    position: 'absolute',
    width: 2,
    height: 26,
    borderRadius: 1,
    backgroundColor: colors.accentStrong
  },
  hidden: {
    ...StyleSheet.absoluteFill,
    color: 'transparent',
    backgroundColor: 'transparent',
    opacity: 0.011,
    fontSize: 1
  }
})
