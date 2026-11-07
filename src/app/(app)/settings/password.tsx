// Configurações → Conta → Trocar senha de criptografia (§5.5): confere a senha atual (Argon2id no
// aparelho), deriva a nova (salt novo, Argon2id nativo) e regrava só a wrap da DEK com `key_proof`
// (`PUT /keys/password`). A DEK não muda: os outros dispositivos continuam funcionando e recebem
// `keys.changed`. Tela protegida (FLAG_SECURE).
import { useRouter } from 'expo-router'
import { useState } from 'react'
import { account } from '@/account/native'
import { useAction, useSession } from '@/account/react'
import { SettingsScreen, Note } from '@/settings/ui'
import { BottomBarButton } from '@/ui/BottomBar'
import { Banner } from '@/ui/Card'
import { NewPasswordFields, useNewPassword } from '@/ui/NewPasswordFields'
import { useSecureScreen } from '@/ui/secure'
import { TextField } from '@/ui/TextField'
import { useToast } from '@/ui/Toast'
import { AccountRequired } from '@/settings/AccountRequired'

/** Sem conta: explica e leva ao login (§ "Usar sem conta"). */
export default function ChangePasswordGate() {
  const { phase } = useSession()
  if (phase === 'local')
    return (
      <AccountRequired
        title="Trocar senha"
        what="A senha de criptografia protege os dados da conta no servidor. Sem conta não há nada no servidor para proteger."
      />
    )
  return <ChangePassword />
}

function ChangePassword() {
  useSecureScreen()
  const s = useSession()
  const router = useRouter()
  const toast = useToast()
  const [current, setCurrent] = useState('')
  const [pw, setPw] = useState('')
  const [confirm, setConfirm] = useState('')
  const [tried, setTried] = useState(false)
  const email = s.account?.email ?? ''
  const check = useNewPassword(pw, confirm, email)
  const { busy, error, setError, run } = useAction()

  const submit = () => {
    setTried(true)
    if (!current || !check.ok || busy) return
    void run(async () => {
      await account.changePasswordWithCurrent(current, pw)
      setCurrent('')
      setPw('')
      setConfirm('')
      toast('Senha trocada. Os outros dispositivos continuam funcionando.')
      router.back()
    })
  }

  return (
    <SettingsScreen
      title="Trocar senha"
      testID="screen-password"
      footer={
        <BottomBarButton
          testID="password-save"
          title={busy ? 'Trocando… (pode levar alguns segundos)' : 'Trocar senha'}
          icon="lock-closed-outline"
          loading={busy}
          disabled={!current || !check.ok}
          onPress={submit}
        />
      }
    >
      <Note>
        A senha de criptografia abre a chave dos seus dados em todos os dispositivos. Trocar aqui
        não desconecta os outros aparelhos; a chave de recuperação continua valendo.
      </Note>
      {error ? <Banner tone="danger">{error}</Banner> : null}
      <TextField
        testID="password-current"
        label="Senha atual"
        value={current}
        onChangeText={(v) => {
          setCurrent(v)
          if (error) setError(null)
        }}
        secure
        icon="lock-closed-outline"
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="current-password"
        textContentType="password"
        editable={!busy}
        error={tried && !current ? 'Digite a senha atual.' : null}
      />
      <NewPasswordFields
        pw={pw}
        confirm={confirm}
        setPw={(v) => {
          setPw(v)
          if (error) setError(null)
        }}
        setConfirm={setConfirm}
        email={email}
        label="Nova senha de criptografia"
        disabled={busy}
        showErrors={tried}
        onSubmit={submit}
      />
    </SettingsScreen>
  )
}
