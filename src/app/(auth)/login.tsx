// Entrar (§5.2): servidor escolhido + e-mail → código por e-mail (captcha antes, se a instância usar).
import { Link, useRouter } from 'expo-router'
import { useEffect, useState } from 'react'
import { Linking, StyleSheet, Text, View } from 'react-native'
import { account } from '@/account/native'
import { hostOf, useAction, useSession } from '@/account/react'
import type { SyncServerInfo } from '@shared/sync'
import { Button, TextButton } from '@/ui/Button'
import { Banner, Card, ListItem, Logo } from '@/ui/Card'
import { Hero, Screen } from '@/ui/Screen'
import { TextField } from '@/ui/TextField'
import { colors, spacing } from '@/ui/theme'

export default function Login() {
  const s = useSession()
  const router = useRouter()
  const [email, setEmail] = useState(s.login?.email ?? account.lastEmail)
  const [info, setInfo] = useState<SyncServerInfo | null>(account.serverInfo)
  const { busy, error, run } = useAction()

  // nome da instância e "Criar conta" (só com cadastro aberto) vêm do /api/info
  useEffect(() => {
    let alive = true
    account
      .probeServer()
      .then((i) => alive && setInfo(i))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [s.server.url])

  // o texto do evento evita perder a última tecla se o Enter chegar antes do estado
  const submit = (text = email) =>
    void run(async () => {
      await account.requestCode(text)
      router.push('/code')
    })

  const serverName = s.server.name ?? (s.server.kind === 'official' ? 'ClearChat' : 'Self-host')
  const signupUrl = info?.signupOpen
    ? `${info.signupUrl ?? `${s.server.url}/signup`}?from=app`
    : null

  return (
    <Screen testID="screen-login">
      <View style={styles.top}>
        <Logo />
        <Hero
          title={`Entrar em ${serverName}`}
          subtitle="Use o e-mail da sua conta. Vamos enviar um código de 6 dígitos — sem senha para lembrar no login."
        />
      </View>

      {s.notice ? (
        <Banner
          testID="session-notice"
          tone={s.notice.tone}
          title={s.notice.title}
          onClose={() => account.dismissNotice()}
        >
          {s.notice.text}
        </Banner>
      ) : null}

      <Card padded={false}>
        <ListItem
          testID="server-card"
          icon={s.server.kind === 'official' ? 'cloud-outline' : 'server-outline'}
          title={serverName}
          subtitle={hostOf(s.server.url)}
          onPress={s.server.envOverride ? undefined : () => router.push('/server')}
          right={
            s.server.envOverride ? (
              <Text style={styles.fixed}>fixo</Text>
            ) : (
              <Text style={styles.change}>Trocar</Text>
            )
          }
        />
      </Card>
      {info?.insecure ? (
        <Banner tone="warning" title="Conexão sem criptografia de transporte">
          Este servidor usa http://. Use só em rede local: seus dados continuam cifrados ponta a
          ponta, mas o login e os metadados não.
        </Banner>
      ) : null}

      <View style={styles.form}>
        <TextField
          testID="login-email"
          label="E-mail"
          value={email}
          onChangeText={setEmail}
          placeholder="voce@exemplo.com"
          icon="mail-outline"
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="email"
          textContentType="emailAddress"
          returnKeyType="send"
          onSubmitEditing={(e) => submit(e.nativeEvent.text)}
          editable={!busy}
          error={error}
        />
        <Button
          testID="login-submit"
          title={busy ? 'Enviando…' : 'Enviar código'}
          icon="paper-plane-outline"
          loading={busy}
          disabled={!email.trim()}
          onPress={() => submit()}
        />
      </View>

      <View style={styles.bottom}>
        {signupUrl ? (
          <View style={styles.signup}>
            <Text style={styles.muted}>Não tem conta?</Text>
            <TextButton
              testID="login-signup"
              title="Criar conta no site"
              icon="open-outline"
              onPress={() => void Linking.openURL(signupUrl)}
            />
          </View>
        ) : null}
        {__DEV__ ? (
          <Link href="/dev/selftest" style={styles.dev}>
            Self-test da cripto (dev)
          </Link>
        ) : null}
      </View>
    </Screen>
  )
}

const styles = StyleSheet.create({
  top: { gap: spacing.lg, marginTop: spacing.xl },
  form: { gap: spacing.lg },
  change: { color: colors.accentStrong, fontSize: 14.5, fontWeight: '600' },
  fixed: { color: colors.subtle, fontSize: 13 },
  bottom: { flexGrow: 1, justifyContent: 'flex-end', gap: spacing.sm, paddingTop: spacing.lg },
  signup: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  muted: { color: colors.muted, fontSize: 14.5 },
  dev: { color: colors.subtle, fontSize: 12.5, textAlign: 'center', paddingVertical: 6 }
})
