// Faixas de estado do host no lugar do composer (SYNC_PROTOCOL.md §8.7–8.9, §9): host offline
// (o celular não executa chats com ferramentas locais; "Executar neste dispositivo" chega na fase 4),
// chat sem host, sem conexão, troca de host em andamento e divergência — com "Descartar a versão de
// <D>" (manter a online, §9.3), a única resolução que o celular pode fazer com segurança.
import Ionicons from '@expo/vector-icons/Ionicons'
import { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { describeError } from '@/account/errors'
import type { ChatState } from '@/data/types'
import { remote } from '@/remote/react'
import { divergedOf, handoverOf, type HostMode } from '@/remote/types'
import { Button } from '@/ui/Button'
import { ConfirmDialog } from '@/ui/Dialog'
import type { IconName } from '@/ui/Button'
import { useToast } from '@/ui/Toast'
import { colors, radius } from '@/ui/theme'

/** Este chat usa ferramentas locais (§8.9) — o celular recusa ser host dele. */
export function usesLocalTools(config: Record<string, unknown> | undefined): boolean {
  const LOCAL = new Set([
    'list_dir',
    'read_file',
    'search_files',
    'find_files',
    'write_file',
    'edit_file',
    'shell',
    'process_start',
    'process_logs',
    'process_list',
    'process_stop'
  ])
  const tools = Array.isArray(config?.enabledTools) ? (config.enabledTools as unknown[]) : []
  const voice = (config?.voice as { tools?: { enabledTools?: unknown[] } } | undefined)?.tools
    ?.enabledTools
  const skills = (config?.skills as { enabled?: unknown } | undefined)?.enabled === true
  return (
    tools.some((t) => LOCAL.has(String(t))) ||
    (Array.isArray(voice) && voice.some((t) => LOCAL.has(String(t)))) ||
    skills
  )
}

function Panel({
  icon,
  tone,
  title,
  text,
  children,
  testID
}: {
  icon: IconName
  tone: 'warning' | 'danger' | 'muted' | 'accent'
  title: string
  text?: string
  children?: React.ReactNode
  testID?: string
}) {
  const c =
    tone === 'warning'
      ? colors.warning
      : tone === 'danger'
        ? colors.danger
        : tone === 'accent'
          ? colors.accentStrong
          : colors.subtle
  return (
    <View
      style={[s.panel, { borderColor: tone === 'muted' ? colors.border : `${c}55` }]}
      testID={testID}
    >
      <View style={s.head}>
        <Ionicons name={icon} size={17} color={c} />
        <Text style={[s.title, tone !== 'muted' && { color: c }]}>{title}</Text>
      </View>
      {text ? <Text style={s.text}>{text}</Text> : null}
      {children}
    </View>
  )
}

export function HostStateBanner({
  chatId,
  mode,
  state,
  localTools
}: {
  chatId: string
  mode: HostMode
  state: ChatState | null
  localTools: boolean
}) {
  const toast = useToast()
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const name = state?.host?.name ?? 'outro dispositivo'
  const d = divergedOf(state)
  const handover = handoverOf(state)

  if (mode === 'diverged' && d)
    return (
      <Panel
        icon="git-compare-outline"
        tone="danger"
        title="Este chat está divergente"
        text={`Duas versões foram produzidas sem uma ver a outra. Nada deste chat sincroniza até escolher qual fica. Resolva em ${d.device_name}, que tem a outra versão — ou descarte a versão dele e mantenha a online.`}
        testID="banner-diverged"
      >
        <Button
          title={`Descartar a versão de ${d.device_name}`}
          variant="danger"
          size="sm"
          icon="trash-outline"
          onPress={() => setConfirm(true)}
          testID="divergence-discard"
        />
        <ConfirmDialog
          visible={confirm}
          title="Apagar a outra versão?"
          message={`A versão de ${d.device_name} será apagada. Mensagens que só existem nela (desde ${new Date(d.since).toLocaleString('pt-BR')}) serão perdidas e não poderão ser recuperadas.`}
          confirmLabel="Apagar a outra versão e manter esta"
          destructive
          busy={busy}
          onClose={() => setConfirm(false)}
          onConfirm={() => {
            setBusy(true)
            remote
              .discardDivergentVersion(chatId)
              .then(() => toast('Divergência resolvida.'))
              .catch((e: unknown) => toast(describeError(e), 'danger'))
              .finally(() => {
                setBusy(false)
                setConfirm(false)
              })
          }}
        />
      </Panel>
    )
  if (mode === 'offline')
    return (
      <Panel
        icon="cloud-offline-outline"
        tone="muted"
        title="Sem conexão com o servidor"
        text="As mensagens e os comandos vão ao host pelo servidor. Reconectando…"
        testID="banner-offline"
      />
    )
  if (mode === 'host-offline')
    return (
      <Panel
        icon="power-outline"
        tone="warning"
        title={
          state?.host?.status === 'grace'
            ? `${name} está reconectando…`
            : `O host (${name}) está offline`
        }
        text={
          localTools
            ? `Este chat usa ferramentas locais (shell, arquivos, processos ou skills) no ${name}. O celular não executa chats assim — abra o ClearChat no ${name} para continuar.`
            : `Comandos remotos só funcionam com o host online. Executar este chat no celular chega numa próxima versão do app.`
        }
        testID="banner-host-offline"
      />
    )
  if (mode === 'none')
    return (
      <Panel
        icon="desktop-outline"
        tone="muted"
        title="Este chat não tem host"
        text={
          localTools
            ? 'Ele usa ferramentas locais — abra-o num computador com o ClearChat para executá-lo.'
            : 'Executar chats no celular chega numa próxima versão do app. Por enquanto, abra-o num computador.'
        }
        testID="banner-no-host"
      />
    )
  if (mode === 'local')
    return (
      <Panel
        icon="phone-portrait-outline"
        tone="muted"
        title="Este aparelho é o host deste chat"
        text="Executar chats no celular chega numa próxima versão do app."
      />
    )
  if (handover)
    return (
      <Panel
        icon="swap-horizontal-outline"
        tone="accent"
        title={`${handover.to_name} vai assumir este chat`}
        text={
          handover.mode === 'force'
            ? `${name} está parando o turno para passar o chat.`
            : `${name} termina o turno atual e passa o chat.`
        }
        testID="banner-handover"
      />
    )
  return null
}

const s = StyleSheet.create({
  panel: {
    marginHorizontal: 10,
    borderRadius: radius.lg,
    borderWidth: 1,
    backgroundColor: colors.elevated,
    padding: 14,
    gap: 8
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { flex: 1, color: colors.fg, fontSize: 14.5, fontWeight: '600' },
  text: { color: colors.muted, fontSize: 13, lineHeight: 19 }
})
