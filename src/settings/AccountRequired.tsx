// Sem conta ("Usar sem conta"): o que só existe com uma conta (sync, dispositivos, notificações push,
// controle remoto dos chats do PC, senha e chave de recuperação) explica por quê e leva ao login —
// sem tela que dê erro nem beco sem saída. Entrar une os dados deste celular aos da conta (§12).
import { StyleSheet, Text, View } from 'react-native'
import { account } from '@/account/native'
import { Button } from '@/ui/Button'
import { Card } from '@/ui/Card'
import { colors, spacing } from '@/ui/theme'
import { SettingsScreen } from './ui'

/** Botão "Entrar numa conta" + uma linha sobre o que acontece com os dados daqui. */
export function SignInCard({ text, testID }: { text?: string; testID?: string }) {
  return (
    <Card testID={testID ?? 'signin-card'} style={st.card}>
      <Text style={st.text}>
        {text ??
          'Com uma conta, este celular sincroniza com o computador e o site (cifrado de ponta a ponta), controla os chats do PC e recebe notificações. O que você criou aqui é unido aos dados da conta.'}
      </Text>
      <Button
        title="Entrar numa conta"
        icon="log-in-outline"
        onPress={() => account.beginSignIn()}
        testID="signin-button"
      />
    </Card>
  )
}

/** Tela inteira de um recurso que precisa de conta. */
export function AccountRequired({
  title,
  what,
  testID
}: {
  title: string
  /** Uma frase: o que o recurso faz e por que precisa da conta. */
  what: string
  testID?: string
}) {
  return (
    <SettingsScreen title={title} testID={testID ?? 'screen-account-required'}>
      <View style={st.box}>
        <Text style={st.head}>Precisa de uma conta</Text>
        <Text style={st.text}>{what}</Text>
      </View>
      <SignInCard />
    </SettingsScreen>
  )
}

const st = StyleSheet.create({
  box: { gap: spacing.xs, marginTop: spacing.sm },
  head: { color: colors.fg, fontSize: 17, fontWeight: '600' },
  text: { color: colors.muted, fontSize: 14, lineHeight: 20 },
  card: { gap: spacing.md }
})
