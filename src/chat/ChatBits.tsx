// Peças da lista e do cabeçalho do chat: ícone da persona, selo do host (§8.2), indicador do sync,
// renomear/apagar.
import Ionicons from '@expo/vector-icons/Ionicons'
import { useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import type { SyncStatus } from '@/data/engine'
import type { ChatState } from '@/data/types'
import { Button } from '@/ui/Button'
import { Dialog } from '@/ui/Dialog'
import { TextField } from '@/ui/TextField'
import type { IconName } from '@/ui/Button'
import { colors, radius } from '@/ui/theme'

/** Ícones lucide curados das personas (desktop: presetIcons.ts) → Ionicons. */
const PRESET_ICONS: Record<string, IconName> = {
  sparkles: 'sparkles-outline',
  bot: 'happy-outline',
  brain: 'bulb-outline',
  code: 'code-slash-outline',
  terminal: 'terminal-outline',
  pen: 'pencil-outline',
  feather: 'leaf-outline',
  search: 'search-outline',
  book: 'book-outline',
  graduation: 'school-outline',
  flask: 'flask-outline',
  chart: 'trending-up-outline',
  database: 'server-outline',
  globe: 'globe-outline',
  languages: 'language-outline',
  briefcase: 'briefcase-outline',
  scale: 'scale-outline',
  shield: 'shield-checkmark-outline',
  wrench: 'construct-outline',
  palette: 'color-palette-outline',
  lightbulb: 'bulb-outline',
  message: 'chatbox-outline',
  rocket: 'rocket-outline',
  zap: 'flash-outline'
}

export function ChatAvatar({ icon, size = 40 }: { icon?: string | null; size?: number }) {
  const ion = icon ? PRESET_ICONS[icon] : undefined
  const emoji = icon && !ion && icon.length <= 4 ? icon : null
  return (
    <View style={[st.avatar, { width: size, height: size, borderRadius: size * 0.3 }]}>
      {emoji ? (
        <Text style={{ fontSize: size * 0.48 }}>{emoji}</Text>
      ) : (
        <Ionicons
          name={ion ?? 'chatbubble-ellipses-outline'}
          size={size * 0.48}
          color={colors.accentStrong}
        />
      )}
    </View>
  )
}

/** "PC de casa" + estado do host; "rodando" com janela aberta. */
export function HostBadge({
  state,
  compact
}: {
  state: ChatState | null | undefined
  compact?: boolean
}) {
  const h = state?.host
  if (!h) return null
  const running = !!state?.window
  const dot =
    h.status === 'online' ? colors.success : h.status === 'grace' ? colors.warning : colors.faint
  return (
    <View style={st.host} testID="host-badge">
      <View style={[st.dot, { backgroundColor: running ? colors.accentStrong : dot }]} />
      <Text style={st.hostText} numberOfLines={1}>
        {compact ? '' : 'Executando em '}
        {h.name}
        {running
          ? ' · rodando'
          : h.status === 'offline'
            ? ' · offline'
            : h.status === 'grace'
              ? ' · reconectando'
              : ''}
      </Text>
    </View>
  )
}

export function syncLabel(s: SyncStatus): { text: string; tone: 'ok' | 'busy' | 'warn' | 'err' } {
  if (s.phase === 'syncing')
    return {
      text:
        s.progress != null ? `Sincronizando ${Math.round(s.progress * 100)}%` : 'Sincronizando…',
      tone: 'busy'
    }
  if (s.phase === 'offline') return { text: 'Offline', tone: 'warn' }
  if (s.phase === 'error') return { text: 'Erro no sync', tone: 'err' }
  if (s.phase === 'locked') return { text: 'Bloqueado', tone: 'warn' }
  return { text: s.live ? 'Ao vivo' : 'Atualizado', tone: 'ok' }
}

export function SyncIndicator({ status, onPress }: { status: SyncStatus; onPress?: () => void }) {
  const { text, tone } = syncLabel(status)
  const color =
    tone === 'ok'
      ? colors.success
      : tone === 'busy'
        ? colors.accentStrong
        : tone === 'warn'
          ? colors.warning
          : colors.danger
  return (
    <Pressable
      onPress={onPress}
      hitSlop={6}
      style={st.sync}
      testID="sync-indicator"
      accessibilityLabel={`Sincronização: ${text}`}
    >
      {tone === 'busy' ? (
        <ActivityIndicator size={10} color={color} />
      ) : (
        <View style={[st.dot, { backgroundColor: color }]} />
      )}
      <Text style={[st.syncText, { color: tone === 'ok' ? colors.muted : color }]}>{text}</Text>
    </Pressable>
  )
}

export function RenameDialog({
  initial,
  onClose,
  onSave
}: {
  initial: string
  onClose: () => void
  onSave: (title: string) => Promise<void>
}) {
  const [title, setTitle] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      await onSave(title)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível renomear.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      visible
      withInput
      title="Renomear chat"
      onClose={onClose}
      actions={
        <>
          <Button
            title="Cancelar"
            variant="secondary"
            full={false}
            style={{ flex: 1 }}
            onPress={onClose}
          />
          <Button
            testID="rename-chat-save"
            title="Salvar"
            full={false}
            style={{ flex: 1 }}
            loading={busy}
            disabled={!title.trim() || title.trim() === initial.trim()}
            onPress={() => void save()}
          />
        </>
      }
    >
      <TextField
        testID="rename-chat-input"
        value={title}
        onChangeText={(v) => setTitle(v.slice(0, 200))}
        autoFocus
        icon="create-outline"
        error={error}
        onSubmitEditing={() => void save()}
      />
    </Dialog>
  )
}

/** Folha de ações de um chat (toque longo na lista / menu do cabeçalho). */
export function ChatActionsSheet({
  title,
  onClose,
  onRename,
  onDelete
}: {
  title: string
  onClose: () => void
  onRename: () => void
  onDelete: () => void
}) {
  const item = (
    icon: IconName,
    label: string,
    onPress: () => void,
    danger?: boolean,
    testID?: string
  ) => (
    <Pressable
      testID={testID}
      onPress={onPress}
      style={({ pressed }) => [st.action, pressed && { backgroundColor: colors.hover }]}
    >
      <Ionicons name={icon} size={19} color={danger ? colors.danger : colors.muted} />
      <Text style={[st.actionText, danger && { color: colors.danger }]}>{label}</Text>
    </Pressable>
  )
  return (
    <Dialog
      visible
      title={title}
      onClose={onClose}
      actions={
        <Button
          title="Cancelar"
          variant="secondary"
          full={false}
          style={{ flex: 1 }}
          onPress={onClose}
          testID="chat-action-cancel"
        />
      }
    >
      <View style={{ marginHorizontal: -8, marginTop: -4 }}>
        {item('create-outline', 'Renomear', onRename, false, 'chat-action-rename')}
        {item('trash-outline', 'Apagar chat', onDelete, true, 'chat-action-delete')}
      </View>
    </Dialog>
  )
}

const st = StyleSheet.create({
  avatar: { backgroundColor: colors.accentSoft, alignItems: 'center', justifyContent: 'center' },
  host: { flexDirection: 'row', alignItems: 'center', gap: 5, flexShrink: 1 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  hostText: { color: colors.subtle, fontSize: 11.5, flexShrink: 1 },
  sync: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radius.pill,
    backgroundColor: colors.elevated,
    borderWidth: 1,
    borderColor: colors.border
  },
  syncText: { fontSize: 12, fontWeight: '600' },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 8,
    paddingVertical: 13,
    borderRadius: 10
  },
  actionText: { color: colors.fg, fontSize: 15.5 }
})
