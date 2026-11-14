// Configurações → Notificações (SYNC_PROTOCOL.md §22, preferências do aparelho §4.4): interruptor
// geral (registra/remove o token do FCM no servidor), tipos de aviso, "Mostrar trecho", estado da
// permissão do Android (com atalho para as configurações do sistema quando negada) e um aviso de
// teste local. Nada disto sincroniza.
import { useCallback, useEffect, useState } from 'react'
import { AppState, StyleSheet, View } from 'react-native'
import { useSession } from '@/account/react'
import { randomBytes } from '@/crypto'
import { buildNotification, randomTag } from '@/push/model'
import {
  openSystemSettings,
  permissionState,
  pushPrefs,
  registrar,
  requestPermission
} from '@/push/native'
import { usePushPrefs, usePushStatus } from '@/push/react'
import type { PermissionState, PushStatus } from '@/push/registration'
import { present } from '@/push/task'
import { SettingsScreen } from '@/settings/ui'
import { Button } from '@/ui/Button'
import { Banner, Card, Divider, SectionLabel, StatusPill, ToggleRow } from '@/ui/Card'
import { Chip } from '@/ui/Help'
import { useToast } from '@/ui/Toast'
import { spacing } from '@/ui/theme'
import { AccountRequired } from '@/settings/AccountRequired'

const STATUS: Record<
  PushStatus,
  { tone: 'success' | 'warning' | 'danger' | 'muted'; label: string }
> = {
  idle: { tone: 'muted', label: 'Conferindo…' },
  'signed-out': { tone: 'muted', label: 'Sem conta' },
  off: { tone: 'muted', label: 'Desligadas' },
  unavailable: { tone: 'warning', label: 'Servidor sem push' },
  'no-token': { tone: 'warning', label: 'Push indisponível' },
  'no-permission': { tone: 'danger', label: 'Sem permissão' },
  registered: { tone: 'success', label: 'Ativas' },
  error: { tone: 'warning', label: 'Não registrado' }
}

/** Sem conta: explica e leva ao login (§ "Usar sem conta"). */
export default function NotificationSettingsGate() {
  const { phase } = useSession()
  if (phase === 'local')
    return (
      <AccountRequired
        title="Notificações"
        what="As notificações avisam quando um chat do computador precisa de você ou termina uma resposta — elas chegam pelo servidor da conta (cifradas de ponta a ponta)."
      />
    )
  return <NotificationSettings />
}

function NotificationSettings() {
  const s = useSession()
  const toast = useToast()
  const prefs = usePushPrefs()
  const status = usePushStatus()
  const [perm, setPerm] = useState<PermissionState | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    const p = await permissionState().catch((): PermissionState => 'undetermined')
    setPerm(p)
    await registrar.sync('configurações')
  }, [])

  useEffect(() => {
    const t = setTimeout(() => void refresh(), 0)
    // voltou das configurações do sistema: a permissão pode ter mudado
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'active') void refresh()
    })
    return () => {
      clearTimeout(t)
      sub.remove()
    }
  }, [refresh])

  const ask = async (): Promise<boolean> => {
    const p = await requestPermission()
    setPerm(p)
    if (p !== 'granted') toast('O Android não deixou o ClearChat mostrar notificações.', 'warning')
    return p === 'granted'
  }

  const setEnabled = (v: boolean) => {
    if (!v) {
      pushPrefs.set('enabled', false)
      return
    }
    setBusy(true)
    void (async () => {
      try {
        if (perm !== 'granted') await ask()
        pushPrefs.set('enabled', true)
      } finally {
        setBusy(false)
      }
    })()
  }

  const sendTest = () => {
    void (async () => {
      if (perm !== 'granted' && !(await ask())) return
      await present(
        buildNotification(
          randomTag(randomBytes(16)),
          {
            kind: 'reply',
            chatId: '',
            chatTitle: 'Teste do ClearChat',
            text: 'Assim aparece uma resposta pronta. Tocar abre o chat.',
            hostName: s.device?.name ?? ''
          },
          prefs
        )
      )
      toast('Notificação de teste enviada')
    })().catch(() => toast('Não foi possível mostrar a notificação.', 'danger'))
  }

  const pill = STATUS[status]
  const generic = !s.remember || s.biometric

  return (
    <SettingsScreen
      title="Notificações"
      testID="screen-notifications"
      help="Pendências avisam na hora quando o turno foi pedido daqui ou o computador está ausente, e depois de 1 minuto nos outros casos. Os canais (som, vibração, importância) podem ser ajustados nas configurações do sistema."
    >
      {/* avisos com ação: o botão é o aviso */}
      {perm === 'denied' ? (
        <View testID="push-perm-denied">
          <Button
            title="Notificações bloqueadas · Abrir configurações"
            variant="warning"
            onPress={openSystemSettings}
            accessibilityHint="Ative as notificações do ClearChat nas configurações do sistema."
            testID="push-open-settings"
          />
        </View>
      ) : perm === 'undetermined' && prefs.enabled ? (
        <Button
          title="Falta a permissão · Permitir"
          variant="warning"
          onPress={() => void ask().then(() => registrar.sync('permissão'))}
          accessibilityHint="O Android pede a sua autorização antes de o app mostrar notificações."
          testID="push-ask"
        />
      ) : null}
      {status === 'unavailable' && prefs.enabled ? (
        <Banner tone="warning" testID="push-unavailable">
          Servidor sem push — os avisos dos chats executados aqui continuam.
        </Banner>
      ) : null}
      {status === 'no-token' && prefs.enabled ? (
        <Banner tone="warning" testID="push-no-token">
          Sem token de push neste aparelho (Firebase/Play Services) — os avisos dos chats executados
          aqui continuam.
        </Banner>
      ) : null}
      {status === 'error' && prefs.enabled ? (
        <Button
          title="Registro no servidor falhou · Tentar de novo"
          variant="warning"
          onPress={() => void registrar.sync('tentar de novo')}
          accessibilityHint="O app também tenta de novo na próxima abertura."
          testID="push-retry"
        />
      ) : null}

      <Card padded={false}>
        <ToggleRow
          title="Notificações neste aparelho"
          help="Avisos dos chats mesmo com o app fechado."
          value={prefs.enabled}
          onChange={setEnabled}
          disabled={busy}
          testID="push-enabled"
        />
        <Divider />
        <View style={st.statusRow}>
          <StatusPill testID="push-status" tone={pill.tone} label={pill.label} />
        </View>
      </Card>

      <SectionLabel>Avisar sobre</SectionLabel>
      <Card padded={false}>
        <ToggleRow
          title="Pendências"
          help="Aprovações, perguntas do agente e novas tentativas."
          value={prefs.pending}
          onChange={(v) => pushPrefs.set('pending', v)}
          disabled={!prefs.enabled}
          testID="push-kind-pending"
        />
        <Divider />
        <ToggleRow
          title="Respostas prontas"
          help="Turnos que você começou daqui ou com o computador ausente."
          value={prefs.reply}
          onChange={(v) => pushPrefs.set('reply', v)}
          disabled={!prefs.enabled}
          testID="push-kind-reply"
        />
        <Divider />
        <ToggleRow
          title="Erros"
          help="Turno que parou com erro (nas mesmas condições das respostas)."
          value={prefs.error}
          onChange={(v) => pushPrefs.set('error', v)}
          disabled={!prefs.enabled}
          testID="push-kind-error"
        />
        <Divider />
        <ToggleRow
          title="Host offline"
          help="O computador que executava um chat caiu."
          value={prefs.hostOffline}
          onChange={(v) => pushPrefs.set('hostOffline', v)}
          disabled={!prefs.enabled}
          testID="push-kind-host-offline"
        />
      </Card>

      <SectionLabel>Conteúdo</SectionLabel>
      <Card padded={false}>
        <ToggleRow
          title="Mostrar trecho"
          help="O começo da resposta, a pergunta ou o que a aprovação pede. O texto do aviso vem cifrado de ponta a ponta: o servidor e o Google só veem o tipo e o horário. Na tela bloqueada o Android esconde o conteúdo."
          chips={
            generic ? (
              <Chip
                label="texto genérico"
                tone="warning"
                detail='Como a chave deste aparelho está protegida por biometria (ou não fica lembrada), o app não consegue decifrar o aviso sozinho: aparece um texto genérico, como "Um chat precisa da sua aprovação".'
                testID="push-generic"
              />
            ) : null
          }
          value={prefs.excerpt}
          onChange={(v) => pushPrefs.set('excerpt', v)}
          disabled={!prefs.enabled}
          testID="push-excerpt"
        />
      </Card>

      <Button
        title="Enviar notificação de teste"
        variant="secondary"
        icon="notifications-outline"
        onPress={sendTest}
        disabled={!prefs.enabled}
        testID="push-test"
      />
    </SettingsScreen>
  )
}

const st = StyleSheet.create({
  statusRow: {
    flexDirection: 'row',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md
  }
})
