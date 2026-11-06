// Dentro da conta (cofre aberto): lista de chats, conversa, Configurações e chave de recuperação.
// Também: abrir o chat de uma notificação tocada (§22.7) e, na primeira entrada, o convite para
// ligar as notificações (antes do diálogo de permissão do Android 13+). Sem conta: as mesmas telas,
// só com os dados deste aparelho (sem convite de notificações). Primeiro desbloqueio de uma conta
// com dados criados sem conta: a pergunta do merge (§12) no lugar de tudo até terminar.
import { Stack, useRouter } from 'expo-router'
import { useEffect, useState } from 'react'
import {
  declinePermissionOffer,
  pushNavigation,
  registrar,
  requestPermission,
  shouldOfferPermission
} from '@/push/native'
import { useSession } from '@/account/react'
import { useFirstLoginMerge } from '@/data/react'
import { MergeScreen } from '@/settings/MergeScreen'
import { Button } from '@/ui/Button'
import { Dialog } from '@/ui/Dialog'
import { useToast } from '@/ui/Toast'
import { colors } from '@/ui/theme'

export default function AppLayout() {
  const router = useRouter()
  const toast = useToast()
  const [offer, setOffer] = useState(false)
  const local = useSession().phase === 'local'
  const merge = useFirstLoginMerge()

  useEffect(() => {
    const open = () => {
      const chatId = pushNavigation.take()
      if (chatId) router.push({ pathname: '/chat/[id]', params: { id: chatId } })
    }
    open()
    return pushNavigation.subscribe(open)
  }, [router])

  useEffect(() => {
    // notificações push precisam de conta
    if (local) return
    let alive = true
    void shouldOfferPermission()
      .then((yes) => {
        if (alive && yes) setOffer(true)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [local])

  const later = () => {
    setOffer(false)
    declinePermissionOffer()
  }
  const allow = () => {
    setOffer(false)
    void requestPermission()
      .then(async (p) => {
        await registrar.sync('permissão')
        if (p !== 'granted')
          toast('Notificações bloqueadas. Para ativar: Configurações → Notificações.', 'warning')
      })
      .catch(() => undefined)
  }

  if (merge.phase !== 'idle') return <MergeScreen state={merge} />

  return (
    <>
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
      <Dialog
        visible={offer}
        title="Receber notificações?"
        onClose={later}
        actions={
          <>
            <Button
              title="Agora não"
              variant="secondary"
              style={{ flex: 1 }}
              onPress={later}
              testID="push-offer-later"
            />
            <Button
              title="Permitir"
              style={{ flex: 1 }}
              onPress={allow}
              testID="push-offer-allow"
            />
          </>
        }
      >
        {'O ClearChat avisa neste celular quando um chat precisa da sua aprovação, faz uma ' +
          'pergunta ou termina uma resposta que você pediu daqui (ou com o computador ausente). ' +
          'O texto do aviso vem cifrado de ponta a ponta. Dá para mudar depois em ' +
          'Configurações → Notificações.'}
      </Dialog>
    </>
  )
}
