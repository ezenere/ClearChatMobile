// Dentro da conta (cofre aberto): lista de chats, conversa, Configurações e chave de recuperação.
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
      <Stack.Screen name="chats" />
      <Stack.Screen name="chat/[id]" />
      <Stack.Screen name="new" options={{ animation: 'slide_from_bottom' }} />
      <Stack.Screen name="files/[chat]" />
      <Stack.Screen name="file/[chat]" />
      <Stack.Screen name="settings" />
      <Stack.Screen name="recovery-key" />
    </Stack>
  )
}
