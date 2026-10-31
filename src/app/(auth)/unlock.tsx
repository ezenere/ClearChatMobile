// Desbloqueio (§5.2, §3.4): senha de criptografia → Argon2id (nativo, fora da thread do JS) → DEK.
// "Lembrar neste dispositivo" guarda a DEK no Keystore; biometria opcional (§3.13).
import { useRouter } from 'expo-router'
import { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { account } from '@/account/native'
import { hostOf, useAction, useSession } from '@/account/react'
import { Button, TextButton } from '@/ui/Button'
import { Banner, Logo, Spinner } from '@/ui/Card'
import { RememberOptions } from '@/ui/RememberOptions'
import { ConfirmDialog } from '@/ui/Dialog'
import { Hero, Screen } from '@/ui/Screen'
import { TextField } from '@/ui/TextField'
import { colors, spacing } from '@/ui/theme'

export default function Unlock() {
  const s = useSession()
  const router = useRouter()
  const [pw, setPw] = useState('')
  const [remember, setRemember] = useState(s.remember)
  const [biometric, setBiometric] = useState(s.biometric)
  const { busy, error, setError, run } = useAction()
  const bio = useAction()

  const submit = () => {
    if (!pw || busy) return
    void run(async () => {
      await account.unlock(pw, { remember, biometric: remember && biometric })
      setPw('')
    })
  }

  // DEK lembrada com biometria e prompt cancelado na abertura: oferece tentar de novo
  const offerBio = account.hasBiometricDek
  const [confirmOut, setConfirmOut] = useState(false)
  const logout = () => setConfirmOut(true)

  return (
    <Screen testID="screen-unlock">
      <View style={styles.top}>
        <Logo size={52} />
        <Hero
          title="Desbloquear seus dados"
          subtitle={
            <Text style={styles.sub}>
              Conectado como <Text style={styles.strong}>{s.account?.email}</Text> em{' '}
              {s.server.name ?? hostOf(s.server.url)}. A senha de criptografia não sai deste
              aparelho.
            </Text>
          }
        />
      </View>

      {s.notice ? (
        <Banner tone={s.notice.tone} title={s.notice.title} onClose={() => account.dismissNotice()}>
          {s.notice.text}
        </Banner>
      ) : null}

      <TextField
        testID="unlock-password"
        label="Senha de criptografia"
        value={pw}
        onChangeText={(v) => {
          setPw(v)
          if (error) setError(null)
        }}
        secure
        icon="lock-closed-outline"
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="current-password"
        textContentType="password"
        returnKeyType="go"
        onSubmitEditing={submit}
        editable={!busy}
        error={error}
      />

      <RememberOptions
        remember={remember}
        setRemember={setRemember}
        biometric={biometric}
        setBiometric={setBiometric}
        canUseBiometrics={account.canUseBiometrics}
        disabled={busy}
      />

      <View style={styles.actions}>
        <Button
          testID="unlock-submit"
          title={busy ? 'Desbloqueando…' : 'Desbloquear'}
          icon="lock-open-outline"
          loading={busy}
          disabled={!pw}
          onPress={submit}
        />
        {busy ? (
          <Spinner testID="unlock-progress" label="Derivando a chave (Argon2id, 64 MiB)…" />
        ) : null}
        {offerBio && !busy ? (
          <Button
            title="Desbloquear com biometria"
            variant="secondary"
            icon="finger-print"
            loading={bio.busy}
            onPress={() => void bio.run(() => account.unlockWithBiometrics())}
          />
        ) : null}
        {bio.error ? <Banner tone="danger">{bio.error}</Banner> : null}
      </View>

      <View style={styles.links}>
        <TextButton
          testID="unlock-recover"
          title="Esqueci a senha — usar a chave de recuperação"
          icon="key-outline"
          onPress={() => router.push('/recover')}
          disabled={busy}
        />
        <TextButton
          testID="unlock-logout"
          title="Sair da conta"
          icon="log-out-outline"
          tone="muted"
          onPress={logout}
          disabled={busy}
        />
      </View>
      <ConfirmDialog
        visible={confirmOut}
        title="Sair da conta?"
        message="Este aparelho será desconectado da conta. Para voltar, entre de novo com o código por e-mail."
        confirmLabel="Sair"
        destructive
        onClose={() => setConfirmOut(false)}
        onConfirm={() => {
          setConfirmOut(false)
          void account.logout()
        }}
      />
    </Screen>
  )
}

const styles = StyleSheet.create({
  top: { gap: spacing.lg, marginTop: spacing.xl },
  sub: { color: colors.muted, fontSize: 15, lineHeight: 22 },
  strong: { color: colors.fg, fontWeight: '600' },
  actions: { gap: spacing.md },
  links: { flexGrow: 1, justifyContent: 'flex-end', gap: 2, paddingTop: spacing.md }
})
