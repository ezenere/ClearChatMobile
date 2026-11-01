// Dentro da conta (cofre aberto): lista de chats, conversa, conta/aparelho e chave de recuperação.
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
      <Stack.Screen name="files/[chat]" />
      <Stack.Screen name="file/[chat]" />
      <Stack.Screen name="home" />
      <Stack.Screen name="recovery-key" />
    </Stack>
  )
}
