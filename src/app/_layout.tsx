// Layout raiz: restaura a sessão (splash até lá) e separa as rotas por fase da conta —
// (auth) = login/chaves/desbloqueio, (app) = dentro da conta. O self-test de dev fica sempre acessível.
import { DarkTheme, Stack, ThemeProvider } from 'expo-router'
import * as SplashScreen from 'expo-splash-screen'
import { StatusBar } from 'expo-status-bar'
import { useEffect } from 'react'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { KeyboardProvider } from 'react-native-keyboard-controller'
import { startAccount } from '@/account/native'
import { useSession } from '@/account/react'
import { startData } from '@/data/native'
import { ToastProvider } from '@/ui/Toast'
import { colors } from '@/ui/theme'

void SplashScreen.preventAutoHideAsync().catch(() => undefined)

const theme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    primary: colors.accent,
    background: colors.bg,
    card: colors.surface,
    text: colors.fg,
    border: colors.border
  }
}

export default function RootLayout() {
  const { phase } = useSession()

  useEffect(() => {
    startData()
    void startAccount()
      .catch(() => undefined)
      .finally(() => void SplashScreen.hideAsync().catch(() => undefined))
  }, [])

  // splash na tela até a sessão salva ser restaurada (decide login × desbloqueio × direto)
  if (phase === 'boot') return null

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.bg }}>
      <KeyboardProvider>
        <ThemeProvider value={theme}>
          <ToastProvider>
            <StatusBar style="light" />
            <Stack
              screenOptions={{
                headerShown: false,
                contentStyle: { backgroundColor: colors.bg },
                animation: 'fade'
              }}
            >
              <Stack.Screen name="index" />
              <Stack.Protected guard={phase === 'unlocked'}>
                <Stack.Screen name="(app)" />
              </Stack.Protected>
              <Stack.Protected guard={phase !== 'unlocked'}>
                <Stack.Screen name="(auth)" />
              </Stack.Protected>
              <Stack.Screen
                name="dev/selftest"
                options={{
                  headerShown: true,
                  title: 'Self-test da cripto',
                  headerStyle: { backgroundColor: colors.surface },
                  headerTintColor: colors.fg,
                  animation: 'default'
                }}
              />
            </Stack>
          </ToastProvider>
        </ThemeProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  )
}
