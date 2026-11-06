// Seção "Ao vivo em <host>" da lista de chats (SYNC_PROTOCOL.md §23.10): os chats só ao vivo dos
// outros dispositivos enquanto o app deles está aberto, conectado e desbloqueado — agrupados por
// host, mais recentes primeiro, com o status (rodando / aguardando você / ocioso / reconectando…).
// Nada daqui é gravado: some quando o host fecha o app (ou depois da tolerância de queda).
import Ionicons from '@expo/vector-icons/Ionicons'
import { memo } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { LiveEntry, LiveGroup } from '@/live/list'
import { liveStatusText } from '@/live/types'
import { chatTitle } from '@/data/decode'
import { ChatAvatar } from './ChatBits'
import { relativeTime } from './format'
import { colors, radius } from '@/ui/theme'

const LiveRow = memo(function LiveRow({
  e,
  now,
  onOpen
}: {
  e: LiveEntry
  now: number
  onOpen: (id: string) => void
}) {
  const reconnecting = e.stale || e.host.status === 'grace'
  const status = e.stale ? 'reconectando…' : liveStatusText(e.info, e.host.status)
  const waiting = !reconnecting && e.info.status === 'waiting'
  const running = !reconnecting && e.info.status === 'running'
  const p = e.info.pending
  const pend = p.approvals + p.questions + p.retries
  const model = e.info.model.model
  return (
    <Pressable
      testID={`live-row-${e.chatId}`}
      onPress={() => onOpen(e.chatId)}
      style={({ pressed }) => [st.row, pressed && { backgroundColor: colors.hover }]}
      accessibilityRole="button"
      accessibilityLabel={`${chatTitle(e.info.title)}, ao vivo em ${e.host.name}, ${status}`}
    >
      <ChatAvatar icon={e.info.persona?.icon ?? null} />
      <View style={st.body}>
        <View style={st.top}>
          <Text style={st.title} numberOfLines={1}>
            {chatTitle(e.info.title)}
          </Text>
          <Text style={st.time}>{relativeTime(e.info.updatedAt, now)}</Text>
        </View>
        <View style={st.meta}>
          <View
            style={[
              st.pill,
              waiting && st.pillWait,
              running && st.pillRun,
              reconnecting && st.pillGrace
            ]}
            testID="live-status"
          >
            <Text
              style={[
                st.pillText,
                waiting && { color: colors.warning },
                running && { color: colors.accentStrong },
                reconnecting && { color: colors.subtle }
              ]}
            >
              {status}
              {waiting && pend ? ` (${pend})` : ''}
            </Text>
          </View>
          {model ? (
            <Text style={st.model} numberOfLines={1}>
              {model}
            </Text>
          ) : null}
        </View>
      </View>
    </Pressable>
  )
})

export function LiveSection({
  groups,
  now,
  onOpen
}: {
  groups: LiveGroup[]
  now: number
  onOpen: (id: string) => void
}) {
  if (!groups.length) return null
  return (
    <View testID="live-section">
      {groups.map((g) => (
        <View key={g.host.device_id}>
          <View style={st.head}>
            <Ionicons name="radio-outline" size={14} color={colors.accentStrong} />
            <Text style={st.headText} numberOfLines={1}>
              Ao vivo em {g.host.name}
            </Text>
            {g.host.status === 'grace' ? (
              <Text style={st.headSub}>reconectando…</Text>
            ) : (
              <Text style={st.headSub}>
                {g.chats.length} {g.chats.length === 1 ? 'chat' : 'chats'}
              </Text>
            )}
          </View>
          {g.chats.map((e) => (
            <LiveRow key={e.chatId} e={e} now={now} onOpen={onOpen} />
          ))}
        </View>
      ))}
      <View style={st.sep} />
    </View>
  )
}

const st = StyleSheet.create({
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 18,
    paddingTop: 10,
    paddingBottom: 4
  },
  headText: { flex: 1, color: colors.accentStrong, fontSize: 13, fontWeight: '600' },
  headSub: { color: colors.subtle, fontSize: 12 },
  row: { flexDirection: 'row', gap: 12, paddingHorizontal: 16, paddingVertical: 10 },
  body: { flex: 1, gap: 4 },
  top: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { flex: 1, color: colors.fg, fontSize: 15.5, fontWeight: '600' },
  time: { color: colors.subtle, fontSize: 12, fontVariant: ['tabular-nums'] },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pill: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border
  },
  pillWait: { borderColor: 'rgba(251,191,36,0.45)', backgroundColor: 'rgba(251,191,36,0.08)' },
  pillRun: { borderColor: colors.accentSoft, backgroundColor: colors.accentSoft },
  pillGrace: { borderStyle: 'dashed' },
  pillText: { color: colors.muted, fontSize: 11.5 },
  model: { flex: 1, color: colors.faint, fontSize: 12 },
  sep: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginHorizontal: 16,
    marginTop: 6,
    marginBottom: 4
  }
})
