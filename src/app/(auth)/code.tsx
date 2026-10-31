// Código por e-mail (§5.3): 6 dígitos (colar/autofill), reenviar com espera, nome do aparelho
// (editável) e o registro do dispositivo no verify (client: mobile, can_host: true — §5.4).
import Ionicons from '@expo/vector-icons/Ionicons'
import { useRouter } from 'expo-router'
import { useEffect, useRef, useState, type ComponentRef } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { formatWait } from '@/account/errors'
import { account } from '@/account/native'
import { useAction, useSession } from '@/account/react'
import { RESEND_COOLDOWN_MS } from '@/account/service'
import { Button, TextButton } from '@/ui/Button'
import { Banner, Card } from '@/ui/Card'
import { CODE_LENGTH, CodeInput } from '@/ui/CodeInput'
import { Hero, Screen, ScreenHeader } from '@/ui/Screen'
import { TextField } from '@/ui/TextField'
import { colors, spacing } from '@/ui/theme'

function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

export default function Code() {
  const s = useSession()
  const router = useRouter()
  const now = useNow()
  const input = useRef<ComponentRef<typeof TextInput>>(null)
  const [code, setCode] = useState('')
  const [editName, setEditName] = useState(false)
  const [name, setName] = useState(s.device?.name ?? account.defaultDeviceName)
  const verify = useAction()
  const resend = useAction()
  const [resent, setResent] = useState(false)
  const login = s.login

  useEffect(() => {
    if (!login) router.replace('/login')
  }, [login, router])
  if (!login) return null

  const waitUntil = Math.max(login.sentAt + RESEND_COOLDOWN_MS, login.retryAt ?? 0)
  const wait = Math.max(0, Math.ceil((waitUntil - now) / 1000))
  const blocked = (login.retryAt ?? 0) > now

  const submit = (c = code) => {
    if (c.length !== CODE_LENGTH || verify.busy) return
    void verify.run(async () => {
      try {
        await account.verifyCode(c, name)
      } catch (e) {
        setCode('')
        setTimeout(() => input.current?.focus(), 50)
        throw e
      }
    })
  }

  const doResend = () =>
    void resend.run(async () => {
      setResent(false)
      await account.requestCode(login.email)
      setResent(true)
      setCode('')
      verify.setError(null)
    })

  const back = () => {
    account.cancelLogin()
    router.back()
  }

  return (
    <Screen
      testID="screen-code"
      header={<ScreenHeader title="Verificação" onBack={back} backLabel="Usar outro e-mail" />}
    >
      <Hero
        title="Digite o código"
        subtitle={
          <Text style={styles.sub}>
            Enviamos um código de 6 dígitos para{' '}
            <Text style={styles.email} testID="code-email">
              {login.email}
            </Text>
            . Ele vale por 10 minutos.
          </Text>
        }
      />

      <CodeInput
        ref={input}
        testID="code-input"
        value={code}
        onChange={(v) => {
          setCode(v)
          if (verify.error) verify.setError(null)
        }}
        onComplete={(v) => submit(v)}
        error={!!verify.error}
        disabled={verify.busy}
        autoFocus
      />
      {verify.error ? (
        <Banner tone="danger" testID="code-error">
          {verify.error}
        </Banner>
      ) : null}
      {resend.error ? <Banner tone="danger">{resend.error}</Banner> : null}
      {resent && !resend.error ? (
        <Banner tone="success">Enviamos um código novo. O anterior deixou de valer.</Banner>
      ) : null}

      <Card padded={false} style={styles.deviceCard}>
        {editName ? (
          <View style={styles.deviceEdit}>
            <TextField
              testID="device-name"
              label="Nome deste aparelho"
              value={name}
              onChangeText={(v) => setName(v.slice(0, 64))}
              icon="phone-portrait-outline"
              autoCapitalize="sentences"
              returnKeyType="done"
              onSubmitEditing={() => setEditName(false)}
              hint="Aparece na lista de dispositivos da sua conta."
              autoFocus
            />
          </View>
        ) : (
          <Pressable
            testID="device-name-edit"
            onPress={() => setEditName(true)}
            accessibilityRole="button"
            accessibilityLabel={`Nome deste aparelho: ${name}. Alterar`}
            style={({ pressed }) => [styles.device, pressed && { backgroundColor: colors.hover }]}
          >
            <Ionicons name="phone-portrait-outline" size={18} color={colors.accentStrong} />
            <View style={{ flex: 1 }}>
              <Text style={styles.deviceLabel}>Nome deste aparelho</Text>
              <Text style={styles.deviceName} numberOfLines={1}>
                {name || account.defaultDeviceName}
              </Text>
            </View>
            <Text style={styles.change}>Alterar</Text>
          </Pressable>
        )}
      </Card>

      <Button
        testID="code-submit"
        title={verify.busy ? 'Entrando…' : 'Entrar'}
        icon="log-in-outline"
        loading={verify.busy}
        disabled={code.length !== CODE_LENGTH}
        onPress={() => submit()}
      />

      <View style={styles.links}>
        <TextButton
          testID="code-resend"
          title={
            resend.busy
              ? 'Reenviando…'
              : wait > 0
                ? `${blocked ? 'Aguarde' : 'Reenviar código em'} ${formatWait(wait)}`
                : 'Reenviar código'
          }
          icon="refresh"
          tone={wait > 0 ? 'muted' : 'accent'}
          disabled={wait > 0 || resend.busy}
          onPress={doResend}
        />
        <Text style={styles.tip}>Não chegou? Confira o spam ou se o e-mail está certo.</Text>
      </View>
    </Screen>
  )
}

const styles = StyleSheet.create({
  sub: { color: colors.muted, fontSize: 15, lineHeight: 22 },
  email: { color: colors.fg, fontWeight: '600' },
  deviceCard: { marginTop: spacing.xs },
  device: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md
  },
  deviceEdit: { padding: spacing.lg },
  deviceLabel: { color: colors.subtle, fontSize: 12.5 },
  deviceName: { color: colors.fg, fontSize: 15, fontWeight: '500' },
  change: { color: colors.accentStrong, fontSize: 14.5, fontWeight: '600' },
  links: { alignItems: 'center', gap: 2 },
  tip: { color: colors.subtle, fontSize: 12.5, textAlign: 'center' }
})
