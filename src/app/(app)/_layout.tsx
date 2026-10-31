// Dentro da conta (cofre aberto). Fase 2 adiciona a lista de chats e a conversa.
import { Stack } from 'expo-router'
import { colors } from '@/ui/theme'

export default function AppLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.bg },
        animation: 'slide_from_right'
      }}
    >
      <Stack.Screen name="home" />
      <Stack.Screen name="recovery-key" />
    </Stack>
  )
}
