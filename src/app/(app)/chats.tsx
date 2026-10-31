// Lista de chats (registros do sync, cache local): mais recentes primeiro, prévia da última mensagem
// do caminho ativo, persona, selo do host; busca por título e conteúdo (FTS5); puxar para atualizar;
// estados de carregando/vazio/offline; toque longo → renomear/apagar.
import Ionicons from '@expo/vector-icons/Ionicons'
import { FlashList } from '@shopify/flash-list'
import { useRouter } from 'expo-router'
import { memo, useCallback, useState } from 'react'
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { describeError } from '@/account/errors'
import { chatTitle } from '@/data/decode'
import { engine, useChatList, useNow, useSyncStatus } from '@/data/react'
import type { ChatListItem } from '@/data/store'
import type { ChatState } from '@/data/types'
import {
  ChatActionsSheet,
  ChatAvatar,
  HostBadge,
  RenameDialog,
  SyncIndicator
} from '@/chat/ChatBits'
import { relativeTime } from '@/chat/format'
import { Banner } from '@/ui/Card'
import { ConfirmDialog } from '@/ui/Dialog'
import { useToast } from '@/ui/Toast'
import { colors, radius } from '@/ui/theme'

/** Trecho da busca com os termos (entre `[` `]` vindos do FTS) destacados. */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/(\[[^\]]*\])/g)
  return (
    <Text style={st.preview} numberOfLines={2}>
      {parts.map((p, i) =>
        p.startsWith('[') && p.endsWith(']') ? (
          <Text key={i} style={st.hit}>
            {p.slice(1, -1)}
          </Text>
        ) : (
          p
        )
      )}
    </Text>
  )
}

const ChatRow = memo(function ChatRow({
  item,
  state,
  icon,
  now,
  onOpen,
  onLong
}: {
  item: ChatListItem
  state: ChatState | undefined
  icon: string | null
  now: number
  onOpen: (id: string) => void
  onLong: (item: ChatListItem) => void
}) {
  return (
    <Pressable
      testID={`chat-row-${item.id}`}
      onPress={() => onOpen(item.id)}
      onLongPress={() => onLong(item)}
      delayLongPress={350}
      style={({ pressed }) => [st.row, pressed && { backgroundColor: colors.hover }]}
      accessibilityRole="button"
      accessibilityLabel={chatTitle(item.title)}
    >
      <ChatAvatar icon={icon} />
      <View style={st.rowBody}>
        <View style={st.rowTop}>
          <Text style={st.title} numberOfLines={1}>
            {chatTitle(item.title)}
          </Text>
          <Text style={st.time}>{relativeTime(item.updatedAt, now)}</Text>
        </View>
        {item.snippet ? (
          <Snippet text={item.snippet} />
        ) : item.preview ? (
          <Text style={st.preview} numberOfLines={2}>
            {item.previewRole === 'user' ? <Text style={st.you}>Você: </Text> : null}
            {item.preview}
          </Text>
        ) : (
          <Text style={[st.preview, { color: colors.faint }]}>Sem mensagens</Text>
        )}
        {state?.host ? (
          <View style={{ marginTop: 3 }}>
            <HostBadge state={state} />
          </View>
        ) : null}
      </View>
    </Pressable>
  )
})

export default function Chats() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const toast = useToast()
  const status = useSyncStatus()
  const [query, setQuery] = useState('')
  const { items, states, presets } = useChatList(query)
  const [refreshing, setRefreshing] = useState(false)
  const [menu, setMenu] = useState<ChatListItem | null>(null)
  const [renaming, setRenaming] = useState<ChatListItem | null>(null)
  const [deleting, setDeleting] = useState<ChatListItem | null>(null)
  const [busy, setBusy] = useState(false)
  const now = useNow()

  const open = useCallback(
    (id: string) => router.push({ pathname: '/chat/[id]', params: { id } }),
    [router]
  )
  const onLong = useCallback((item: ChatListItem) => setMenu(item), [])
  const refresh = async () => {
    setRefreshing(true)
    try {
      await engine.sync()
    } finally {
      setRefreshing(false)
    }
  }

  const loadingFirst = !items.length && !query && status.initial && status.phase !== 'offline'
  const empty = !items.length && !loadingFirst

  return (
    <View style={[st.root, { paddingTop: insets.top }]} testID="screen-chats">
      <View style={st.header}>
        <Text style={st.h1}>Chats</Text>
        <SyncIndicator status={status} onPress={() => void engine.sync()} />
        <Pressable
          onPress={() => router.push('/home')}
          hitSlop={8}
          style={st.iconBtn}
          accessibilityLabel="Conta e aparelho"
          testID="open-account"
        >
          <Ionicons name="person-circle-outline" size={26} color={colors.muted} />
        </Pressable>
      </View>
      <View style={st.search}>
        <Ionicons name="search" size={17} color={colors.subtle} />
        <TextInput
          testID="chat-search"
          value={query}
          onChangeText={setQuery}
          placeholder="Buscar nos chats"
          placeholderTextColor={colors.faint}
          style={st.searchInput}
          returnKeyType="search"
          autoCorrect={false}
        />
        {query ? (
          <Pressable onPress={() => setQuery('')} hitSlop={10} accessibilityLabel="Limpar busca">
            <Ionicons name="close-circle" size={18} color={colors.subtle} />
          </Pressable>
        ) : null}
      </View>
      {status.phase === 'offline' && items.length ? (
        <View style={st.banner}>
          <Banner tone="warning">Sem conexão — mostrando o que está salvo neste aparelho.</Banner>
        </View>
      ) : null}
      {status.phase === 'error' && status.error ? (
        <View style={st.banner}>
          <Banner tone="danger">{status.error}</Banner>
        </View>
      ) : null}
      {loadingFirst ? (
        <View style={st.center} testID="chats-loading">
          <ActivityIndicator color={colors.accentStrong} size="large" />
          <Text style={st.centerTitle}>Baixando suas conversas…</Text>
          <Text style={st.centerText}>
            {status.progress != null
              ? `${Math.round(status.progress * 100)}% — decifrando neste aparelho`
              : 'Os dados são decifrados aqui, no aparelho.'}
          </Text>
        </View>
      ) : empty ? (
        <View style={st.center} testID="chats-empty">
          <View style={st.emptyIcon}>
            <Ionicons
              name={
                query
                  ? 'search-outline'
                  : status.phase === 'offline'
                    ? 'cloud-offline-outline'
                    : 'chatbubbles-outline'
              }
              size={26}
              color={colors.accentStrong}
            />
          </View>
          <Text style={st.centerTitle}>
            {query
              ? 'Nada encontrado'
              : status.phase === 'offline'
                ? 'Sem conexão'
                : 'Nenhuma conversa ainda'}
          </Text>
          <Text style={st.centerText}>
            {query
              ? `Nenhum chat com “${query}” no título ou nas mensagens.`
              : status.phase === 'offline'
                ? 'Conecte-se para baixar suas conversas.'
                : 'As conversas do app desktop aparecem aqui assim que sincronizam.'}
          </Text>
        </View>
      ) : (
        <FlashList
          data={items}
          keyExtractor={(c) => c.id}
          extraData={states}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => void refresh()}
              tintColor={colors.accentStrong}
              colors={[colors.accent]}
              progressBackgroundColor={colors.elevated}
            />
          }
          renderItem={({ item }) => (
            <ChatRow
              item={item}
              state={states.get(item.id)}
              icon={item.presetId ? (presets.get(item.presetId)?.icon ?? null) : null}
              now={now}
              onOpen={open}
              onLong={onLong}
            />
          )}
        />
      )}
      {menu ? (
        <ChatActionsSheet
          title={chatTitle(menu.title)}
          onClose={() => setMenu(null)}
          onRename={() => {
            setRenaming(menu)
            setMenu(null)
          }}
          onDelete={() => {
            setDeleting(menu)
            setMenu(null)
          }}
        />
      ) : null}
      {renaming ? (
        <RenameDialog
          initial={renaming.title}
          onClose={() => setRenaming(null)}
          onSave={(t) => engine.renameChat(renaming.id, t)}
        />
      ) : null}
      <ConfirmDialog
        visible={!!deleting}
        title="Apagar chat?"
        message={`“${chatTitle(deleting?.title)}” será apagado em todos os seus dispositivos, com todas as mensagens. Não dá para desfazer.`}
        confirmLabel="Apagar"
        destructive
        busy={busy}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          const d = deleting
          if (!d) return
          setBusy(true)
          engine
            .deleteChat(d.id)
            .then(() => toast('Chat apagado'))
            .catch((e: unknown) => toast(describeError(e), 'danger'))
            .finally(() => {
              setBusy(false)
              setDeleting(null)
            })
        }}
      />
    </View>
  )
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 18,
    paddingTop: 10,
    paddingBottom: 6
  },
  h1: { flex: 1, color: colors.fg, fontSize: 28, fontWeight: '700' },
  iconBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginTop: 6,
    marginBottom: 8,
    paddingHorizontal: 12,
    height: 42,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border
  },
  searchInput: { flex: 1, color: colors.fg, fontSize: 15, paddingVertical: 0 },
  banner: { paddingHorizontal: 16, paddingBottom: 8 },
  row: {
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 11,
    alignItems: 'flex-start'
  },
  rowBody: { flex: 1, gap: 2 },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { flex: 1, color: colors.fg, fontSize: 15.5, fontWeight: '600' },
  time: { color: colors.subtle, fontSize: 12, fontVariant: ['tabular-nums'] },
  preview: { color: colors.muted, fontSize: 13.5, lineHeight: 19 },
  you: { color: colors.subtle },
  hit: { color: colors.accentStrong, fontWeight: '600' },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 40,
    paddingBottom: 80
  },
  emptyIcon: {
    width: 54,
    height: 54,
    borderRadius: 16,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4
  },
  centerTitle: { color: colors.fg, fontSize: 16.5, fontWeight: '600', textAlign: 'center' },
  centerText: { color: colors.muted, fontSize: 14, lineHeight: 20, textAlign: 'center' }
})
