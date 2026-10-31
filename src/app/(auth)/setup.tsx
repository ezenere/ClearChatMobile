// Conta sem chaves (§5.1): definir a senha de criptografia AQUI (DEK, wraps e chave de recuperação
// gerados no aparelho, como o site faz) ou no site (<base>/setup) e voltar.
import Ionicons from '@expo/vector-icons/Ionicons'
import { useState } from 'react'
import { Linking, StyleSheet, Text, View } from 'react-native'
import { account } from '@/account/native'
import { hostOf, useAction, useSession } from '@/account/react'
import type { PendingKeys } from '@/account/service'
import { Button, TextButton, type IconName } from '@/ui/Button'
import { Banner, Card, Logo, Spinner } from '@/ui/Card'
import { NewPasswordFields, useNewPassword } from '@/ui/NewPasswordFields'
import { RecoveryKeyPanel } from '@/ui/RecoveryKeyPanel'
import { RememberOptions } from '@/ui/RememberOptions'
import { ConfirmDialog } from '@/ui/Dialog'
import { Hero, Screen } from '@/ui/Screen'
import { colors, spacing } from '@/ui/theme'

function Point({ icon, children }: { icon: IconName; children: React.ReactNode }) {
  return (
    <View style={styles.point}>
      <Ionicons name={icon} size={18} color={colors.accentStrong} style={{ marginTop: 1 }} />
      <Text style={styles.pointText}>{children}</Text>
    </View>
  )
}

export default function Setup() {
  const s = useSession()
  const [pw, setPw] = useState('')
  const [confirm, setConfirm] = useState('')
  const [tried, setTried] = useState(false)
  const [remember, setRemember] = useState(true)
  const [biometric, setBiometric] = useState(false)
  const [pending, setPending] = useState<PendingKeys | null>(null)
  const email = s.account?.email ?? ''
  const { ok } = useNewPassword(pw, confirm, email)
  const gen = useAction()
  const commit = useAction()
  const check = useAction()

  const generate = () => {
    setTried(true)
    if (!ok || gen.busy) return
    void gen.run(async () => {
      const p = await account.setupKeys(pw)
      setPw('')
      setConfirm('')
      setPending(p)
    })
  }

  const [confirmOut, setConfirmOut] = useState(false)
  const logout = () => setConfirmOut(true)

  if (pending)
    return (
      <Screen testID="screen-setup-recovery">
        <Hero
          title="Guarde sua chave de recuperação"
          subtitle="Se esquecer a senha de criptografia, só esta chave devolve o acesso aos seus dados."
        />
        {commit.error ? <Banner tone="danger">{commit.error}</Banner> : null}
        <RecoveryKeyPanel
          recoveryKey={pending.recoveryKey}
          email={email}
          instanceName={s.server.name ?? 'ClearChat'}
          serverUrl={s.server.url}
          confirmLabel="Guardei — concluir"
          busy={commit.busy}
          onConfirmed={() =>
            void commit.run(() => pending.commit({ remember, biometric: remember && biometric }))
          }
        />
      </Screen>
    )

  return (
    <Screen testID="screen-setup">
      <View style={styles.top}>
        <Logo size={52} />
        <Hero
          title="Crie sua senha de criptografia"
          subtitle={`Sua conta em ${s.server.name ?? hostOf(s.server.url)} ainda não tem chaves. Elas são geradas aqui, no aparelho.`}
        />
      </View>
      {s.notice ? (
        <Banner tone={s.notice.tone} title={s.notice.title} onClose={() => account.dismissNotice()}>
          {s.notice.text}
        </Banner>
      ) : null}
      <Card>
        <Point icon="eye-off-outline">
          A senha cifra seus dados <Text style={styles.strong}>neste aparelho</Text> e nunca é
          enviada ao servidor.
        </Point>
        <Point icon="lock-closed-outline">
          É diferente do login: para <Text style={styles.strong}>entrar</Text> você usa o código por
          e-mail; para <Text style={styles.strong}>ler os dados</Text>, esta senha.
        </Point>
        <Point icon="key-outline">
          Se esquecer, só a <Text style={styles.strong}>chave de recuperação</Text> (próximo passo)
          devolve o acesso.
        </Point>
      </Card>
      {gen.error ? <Banner tone="danger">{gen.error}</Banner> : null}
      <NewPasswordFields
        pw={pw}
        confirm={confirm}
        setPw={setPw}
        setConfirm={setConfirm}
        email={email}
        disabled={gen.busy}
        showErrors={tried}
        onSubmit={generate}
      />
      <RememberOptions
        remember={remember}
        setRemember={setRemember}
        biometric={biometric}
        setBiometric={setBiometric}
        canUseBiometrics={account.canUseBiometrics}
        disabled={gen.busy}
      />
      <Button
        testID="setup-generate"
        title={gen.busy ? 'Gerando suas chaves…' : 'Gerar chaves'}
        icon="sparkles-outline"
        loading={gen.busy}
        disabled={!ok}
        onPress={generate}
      />
      {gen.busy ? <Spinner label="Argon2id (64 MiB) rodando no aparelho…" /> : null}

      <View style={styles.alt}>
        <Text style={styles.altTitle}>Prefere usar o computador?</Text>
        <TextButton
          title="Definir no site"
          icon="open-outline"
          onPress={() => void Linking.openURL(`${s.server.url}/setup`)}
        />
        <TextButton
          testID="setup-check"
          title={check.busy ? 'Verificando…' : 'Já defini — verificar de novo'}
          icon="refresh"
          disabled={check.busy}
          onPress={() => void check.run(() => account.refreshKeys())}
        />
        {check.error ? <Banner tone="warning">{check.error}</Banner> : null}
        <TextButton title="Sair da conta" icon="log-out-outline" tone="muted" onPress={logout} />
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
  point: { flexDirection: 'row', gap: spacing.md },
  pointText: { flex: 1, color: colors.muted, fontSize: 14, lineHeight: 20 },
  strong: { color: colors.fg, fontWeight: '600' },
  alt: {
    marginTop: spacing.md,
    paddingTop: spacing.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    gap: 2
  },
  altTitle: { color: colors.subtle, fontSize: 13, textAlign: 'center' }
})
