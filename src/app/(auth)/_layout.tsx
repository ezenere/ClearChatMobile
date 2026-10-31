// Fora da conta (ou com o cofre fechado): cada fase libera só as suas telas — mudar de fase leva
// sozinho à primeira tela permitida (login, definir senha ou desbloquear).
import { Stack, useRouter } from 'expo-router'
import { useEffect } from 'react'
import { captchaBroker } from '@/account/native'
import { useSession } from '@/account/react'
import { colors } from '@/ui/theme'

export default function AuthLayout() {
  const { phase } = useSession()
  const router = useRouter()

  useEffect(() => {
    captchaBroker.setOpener(() => router.push('/captcha'))
    return () => captchaBroker.setOpener(null)
  }, [router])

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.bg },
        animation: 'slide_from_right'
      }}
    >
      <Stack.Protected guard={phase === 'signed-out'}>
        <Stack.Screen name="login" />
        <Stack.Screen name="code" />
        <Stack.Screen name="server" />
        <Stack.Screen
          name="captcha"
          options={{ presentation: 'modal', animation: 'slide_from_bottom' }}
        />
      </Stack.Protected>
      <Stack.Protected guard={phase === 'needs-setup'}>
        <Stack.Screen name="setup" />
      </Stack.Protected>
      <Stack.Protected guard={phase === 'locked'}>
        <Stack.Screen name="unlock" />
        <Stack.Screen name="recover" />
      </Stack.Protected>
    </Stack>
  )
}
