// Mostra a chave de recuperação UMA vez: copiar / compartilhar (gerenciador de senhas, arquivo) e
// exige a confirmação explícita ("guardei" + os 4 últimos caracteres) antes de seguir (§3.5).
import * as Clipboard from 'expo-clipboard'
import { useState } from 'react'
import { Share, StyleSheet, Text, View } from 'react-native'
import { normalizeRecoveryInput } from '@/crypto'
import { Button } from './Button'
import { Banner, Card, Checkbox } from './Card'
import { TextField } from './TextField'
import { useToast } from './Toast'
import { colors, font, radius, spacing } from './theme'

export function RecoveryKeyPanel({
  recoveryKey,
  email,
  instanceName,
  serverUrl,
  onConfirmed,
  confirmLabel = 'Continuar',
  busy
}: {
  recoveryKey: string
  email: string
  instanceName: string
  serverUrl: string
  onConfirmed: () => void
  confirmLabel?: string
  busy?: boolean
}) {
  const toast = useToast()
  const [saved, setSaved] = useState(false)
  const [last4, setLast4] = useState('')
  const groups = recoveryKey.split('-')
  const expected = recoveryKey.replace(/-/g, '').slice(-4)
  const last4ok = normalizeRecoveryInput(last4) === expected
  const text = [
    `${instanceName} — chave de recuperação`,
    '',
    `Conta: ${email}`,
    `Servidor: ${serverUrl}`,
    '',
    recoveryKey,
    '',
    'Com esta chave você recupera seus dados se esquecer a senha de criptografia.',
    'Guarde-a em um lugar seguro. Ninguém — nem o servidor — consegue recuperá-la para você.'
  ].join('\n')

  return (
    <View style={styles.wrap}>
      <Card style={styles.keyCard} testID="recovery-key">
        <Text style={styles.keyTitle}>Sua chave de recuperação</Text>
        <View style={styles.grid} accessibilityLabel={`Chave de recuperação: ${recoveryKey}`}>
          {groups.map((g, i) => (
            <View key={i} style={styles.group}>
              <Text style={styles.groupText} selectable>
                {g}
              </Text>
            </View>
          ))}
        </View>
      </Card>
      <View style={styles.actions}>
        <Button
          title="Copiar"
          icon="copy-outline"
          variant="secondary"
          full={false}
          style={styles.action}
          onPress={() => {
            void Clipboard.setStringAsync(recoveryKey).then(() => toast('Chave copiada'))
          }}
        />
        <Button
          title="Compartilhar"
          icon="share-outline"
          variant="secondary"
          full={false}
          style={styles.action}
          onPress={() => void Share.share({ message: text, title: 'Chave de recuperação' })}
        />
      </View>
      <Banner tone="warning" title="Ela aparece só agora">
        Sem a senha de criptografia e sem esta chave, seus dados ficam ilegíveis para sempre — nem o
        servidor consegue recuperá-los. Guarde-a fora deste aparelho (gerenciador de senhas ou
        papel).
      </Banner>
      <Card>
        <Checkbox
          testID="recovery-saved"
          label="Guardei minha chave de recuperação em um lugar seguro."
          value={saved}
          onChange={setSaved}
        />
        <TextField
          testID="recovery-last4"
          label="Para confirmar, digite os 4 últimos caracteres"
          value={last4}
          onChangeText={(v) => setLast4(v.slice(0, 6))}
          placeholder="XXXX"
          autoCapitalize="characters"
          autoCorrect={false}
          mono
          error={last4.length >= 4 && !last4ok ? 'Não confere com o fim da chave.' : null}
        />
        <Button
          testID="recovery-confirm"
          title={confirmLabel}
          disabled={!saved || !last4ok}
          loading={busy}
          onPress={onConfirmed}
        />
      </Card>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.lg },
  keyCard: {
    borderColor: colors.accentBorder,
    backgroundColor: colors.accentSoft
  },
  keyTitle: { color: colors.accentStrong, fontSize: 13.5, fontWeight: '600' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  group: {
    width: '31%',
    flexGrow: 1,
    paddingVertical: 10,
    borderRadius: radius.sm + 2,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: 'rgba(11, 11, 15, 0.7)',
    alignItems: 'center'
  },
  groupText: {
    color: colors.fg,
    fontFamily: font.mono,
    fontSize: 17,
    fontWeight: '600',
    letterSpacing: 1.5
  },
  actions: { flexDirection: 'row', gap: spacing.sm },
  action: { flex: 1 }
})
