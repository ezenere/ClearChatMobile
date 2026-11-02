// Configurações (pilha própria dentro da conta): início, provedores, personas, memórias, pesquisa
// na web, novos chats, aprovações, dispositivos, conta e troca de senha.
import { Stack } from 'expo-router'
import { colors } from '@/ui/theme'

export default function SettingsLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.bg },
        animation: 'slide_from_right'
      }}
    />
  )
}
