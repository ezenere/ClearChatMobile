// Senha de criptografia nova (2×) com medidor de força e a política do contrato (§3.4), usando a
// mesma heurística do site (vendorada de ClearChatWebsite/frontend/src/lib/password.ts).
import { useMemo, useRef, type ComponentRef } from 'react'
import { StyleSheet, Text, TextInput, View } from 'react-native'
import { passwordStrength } from '@vendor/site/lib/password'
import { TextField } from './TextField'
import { colors, spacing } from './theme'

export function useNewPassword(pw: string, confirm: string, email: string) {
  const strength = useMemo(() => passwordStrength(pw, email), [pw, email])
  const mismatch = confirm.length > 0 && pw !== confirm
  return { strength, mismatch, ok: strength.ok && pw === confirm && pw.length > 0 }
}

const BAR_COLORS = [colors.danger, colors.danger, colors.warning, colors.success, colors.success]

function Meter({ score, label, empty }: { score: number; label: string; empty: boolean }) {
  return (
    <View style={styles.meter} accessibilityLabel={empty ? undefined : `Força da senha: ${label}`}>
      <View style={styles.bars}>
        {[0, 1, 2, 3].map((i) => (
          <View
            key={i}
            style={[
              styles.bar,
              {
                backgroundColor:
                  !empty && i < Math.max(score, 1) ? BAR_COLORS[score] : colors.active
              }
            ]}
          />
        ))}
      </View>
      <Text style={[styles.meterLabel, { color: empty ? colors.subtle : BAR_COLORS[score] }]}>
        {empty ? 'Força da senha' : label}
      </Text>
    </View>
  )
}

export function NewPasswordFields({
  pw,
  confirm,
  setPw,
  setConfirm,
  email,
  label = 'Senha de criptografia',
  disabled,
  showErrors,
  onSubmit
}: {
  pw: string
  confirm: string
  setPw: (v: string) => void
  setConfirm: (v: string) => void
  email: string
  label?: string
  disabled?: boolean
  showErrors?: boolean
  onSubmit?: () => void
}) {
  const { strength, mismatch } = useNewPassword(pw, confirm, email)
  const confirmRef = useRef<ComponentRef<typeof TextInput>>(null)
  const hint = pw
    ? (strength.hints[0] ?? null)
    : 'Pelo menos 10 caracteres. Frases longas são ótimas.'
  return (
    <View style={styles.wrap}>
      <TextField
        testID="new-password"
        label={label}
        value={pw}
        onChangeText={setPw}
        secure
        icon="key-outline"
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="new-password"
        textContentType="newPassword"
        editable={!disabled}
        returnKeyType="next"
        submitBehavior="submit"
        onSubmitEditing={() => confirmRef.current?.focus()}
        error={showErrors && pw ? (strength.errors[0] ?? null) : null}
        hint={hint}
        below={<Meter score={strength.score} label={strength.label} empty={!pw} />}
      />
      <TextField
        ref={confirmRef}
        testID="new-password-confirm"
        label="Confirme a senha"
        value={confirm}
        onChangeText={setConfirm}
        secure
        icon="key-outline"
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="new-password"
        textContentType="newPassword"
        editable={!disabled}
        returnKeyType="done"
        onSubmitEditing={onSubmit}
        error={mismatch ? 'As senhas não conferem.' : null}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.lg },
  meter: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginTop: 2 },
  bars: { flex: 1, flexDirection: 'row', gap: 4 },
  bar: { flex: 1, height: 4, borderRadius: 2 },
  meterLabel: { fontSize: 12.5, fontWeight: '600', minWidth: 92, textAlign: 'right' }
})
