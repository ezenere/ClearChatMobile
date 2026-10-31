import { DarkTheme, Stack, ThemeProvider } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { colors } from '@/ui/theme'

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
  return (
    <ThemeProvider value={theme}>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.surface },
          headerTintColor: colors.fg,
          contentStyle: { backgroundColor: colors.bg }
        }}
      >
        <Stack.Screen name="index" options={{ title: 'ClearChat' }} />
        <Stack.Screen name="dev/selftest" options={{ title: 'Self-test da cripto' }} />
      </Stack>
    </ThemeProvider>
  )
}
