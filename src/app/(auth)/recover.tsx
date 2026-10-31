// Recuperação (§5.5, §16.13): chave de recuperação (digitação tolerante, checksum antes da rede) →
// DEK → senha nova obrigatória (PUT /keys/password com key_proof) → cofre aberto.
import { useRouter } from 'expo-router'
import { useState } from 'react'
import { Platform, StyleSheet, Text, View } from 'react-native'
import { account } from '@/account/native'
import { useAction, useSession } from '@/account/react'
import { formatRecoveryTyping, recoveryInputComplete } from '@/account/recoveryInput'
import { Button } from '@/ui/Button'
import { Banner, Spinner } from '@/ui/Card'
import { NewPasswordFields, useNewPassword } from '@/ui/NewPasswordFields'
import { RememberOptions } from '@/ui/RememberOptions'
import { Hero, Screen, ScreenHeader } from '@/ui/Screen'
import { TextField } from '@/ui/TextField'
import { colors, spacing } from '@/ui/theme'

export default function Recover() {
  const s = useSession()
  const router = useRouter()
  const [step, setStep] = useState<'key' | 'password'>(account.recoveryPending ? 'password' : 'key')
  const [key, setKey] = useState('')
  const [pw, setPw] = useState('')
  const [confirm, setConfirm] = useState('')
  const [tried, setTried] = useState(false)
  const [remember, setRemember] = useState(s.remember)
  const [biometric, setBiometric] = useState(s.biometric)
  const email = s.account?.email ?? ''
  const { ok } = useNewPassword(pw, confirm, email)
  const { busy, error, setError, run } = useAction()

  const submitKey = () => {
    if (busy || !recoveryInputComplete(key)) return
    void run(async () => {
      await account.beginRecovery(key)
      setKey('')
      setStep('password')
    })
  }

  const finish = () => {
    setTried(true)
    if (!ok || busy) return
    void run(() => account.finishRecovery(pw, { remember, biometric: remember && biometric }))
  }

  if (step === 'password')
    return (
      <Screen
        testID="screen-recover-password"
        header={<ScreenHeader title="Recuperação" onBack={() => router.back()} />}
      >
        <Hero
          title="Defina uma senha nova"
          subtitle="Chave de recuperação aceita. Crie a nova senha de criptografia — a antiga deixa de valer em todos os seus dispositivos."
        />
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <NewPasswordFields
          pw={pw}
          confirm={confirm}
          setPw={setPw}
          setConfirm={setConfirm}
          email={email}
          label="Nova senha de criptografia"
          disabled={busy}
          showErrors={tried}
          onSubmit={finish}
        />
        <RememberOptions
          remember={remember}
          setRemember={setRemember}
          biometric={biometric}
          setBiometric={setBiometric}
          canUseBiometrics={account.canUseBiometrics}
          disabled={busy}
        />
        <Button
          testID="recover-finish"
          title={busy ? 'Salvando…' : 'Salvar senha e abrir'}
          icon="checkmark"
          loading={busy}
          disabled={!ok}
          onPress={finish}
        />
        {busy ? <Spinner label="Cifrando a chave com a senha nova (Argon2id)…" /> : null}
      </Screen>
    )

  return (
    <Screen
      testID="screen-recover"
      header={<ScreenHeader title="Recuperação" onBack={() => router.back()} />}
    >
      <Hero
        title="Usar a chave de recuperação"
        subtitle="Digite a chave que você guardou ao criar a conta (9 grupos de 4 caracteres). Maiúsculas, espaços e hífens não importam."
      />
      <TextField
        testID="recover-key"
        label="Chave de recuperação"
        value={key}
        onChangeText={(v) => {
          setKey(formatRecoveryTyping(v))
          if (error) setError(null)
        }}
        placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
        icon="key-outline"
        autoCapitalize="characters"
        autoCorrect={false}
        autoComplete="off"
        spellCheck={false}
        // sem sugestões/aprendizado do teclado para a chave (Android)
        keyboardType={Platform.OS === 'android' ? 'visible-password' : 'default'}
        importantForAutofill="no"
        multiline
        mono
        inputStyle={styles.keyInput}
        editable={!busy}
        error={error}
        hint={<Text style={styles.count}>{key.replace(/-/g, '').length}/36 caracteres</Text>}
      />
      <Button
        testID="recover-submit"
        title={busy ? 'Conferindo…' : 'Continuar'}
        icon="arrow-forward"
        loading={busy}
        disabled={!recoveryInputComplete(key)}
        onPress={submitKey}
      />
      <View style={styles.note}>
        <Banner tone="info" title="Perdeu a senha e a chave?">
          Sem as duas, os dados cifrados não podem ser recuperados. É possível zerar a conta e
          recomeçar pelo site da sua instância.
        </Banner>
      </View>
    </Screen>
  )
}

const styles = StyleSheet.create({
  keyInput: { fontSize: 17, lineHeight: 26, minHeight: 56, textAlignVertical: 'center' },
  count: { color: colors.subtle, fontSize: 12.5, marginLeft: 2 },
  note: { marginTop: spacing.sm }
})
