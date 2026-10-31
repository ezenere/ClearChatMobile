// Conversa (somente leitura nesta fase): sessões (principal + subagentes), caminho ativo pelo
// algoritmo normativo (§4.3.8) com ‹ i/n › trocando a versão só na tela (§4.3.7), lista virtualizada
// (FlashList, linhas memorizadas) que abre no fim, e atualização ao vivo pelos registros do sync.
import Ionicons from '@expo/vector-icons/Ionicons'
import { FlashList, type FlashListRef } from '@shopify/flash-list'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { describeError } from '@/account/errors'
import { ChatActionsSheet, HostBadge, RenameDialog } from '@/chat/ChatBits'
import { MessageRow, RowCtx, type RowContext } from '@/chat/MessageRow'
import {
  buildSessionView,
  localSelectFor,
  mainSession,
  sessionLabel,
  type LocalSel,
  type Row
} from '@/chat/viewModel'
import { chatTitle } from '@/data/decode'
import { engine, store, useChat, useNow } from '@/data/react'
import { ConfirmDialog } from '@/ui/Dialog'
import { useToast } from '@/ui/Toast'
import { colors, radius } from '@/ui/theme'

export default function ChatScreen() {
  const { id, session: sessionParam } = useLocalSearchParams<{ id: string; session?: string }>()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const toast = useToast()
  const { loaded, state } = useChat(id)
  const [sessionId, setSessionId] = useState<string | null>(sessionParam ?? null)
  const [localSel, setLocalSel] = useState<LocalSel | null>(null)
  const [showOld, setShowOld] = useState(true)
  const [menu, setMenu] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [atBottom, setAtBottom] = useState(true)
  const list = useRef<FlashListRef<Row>>(null)
  /** Preso ao fim até o usuário arrastar (imagens que carregam depois mudam a altura). */
  const stick = useRef(true)
  const now = useNow()

  const session = useMemo(() => {
    if (!loaded) return null
    return loaded.sessions.find((s) => s.id === sessionId) ?? mainSession(loaded)
  }, [loaded, sessionId])

  const view = useMemo(
    () => (loaded && session ? buildSessionView(loaded, session, localSel, showOld) : null),
    [loaded, session, localSel, showOld]
  )

  const onSelectBranch = useCallback(
    (msgId: string) => {
      if (!loaded || !view) return
      setLocalSel(localSelectFor(view, loaded, msgId))
    },
    [loaded, view]
  )
  const onOpenSession = useCallback((sid: string) => {
    setSessionId(sid)
    setLocalSel(null)
  }, [])
  const shownSession = view?.session.id
  useEffect(() => {
    stick.current = true
  }, [shownSession])
  const unstick = useCallback(() => {
    stick.current = false
  }, [])
  const followEnd = useCallback(() => {
    if (stick.current) list.current?.scrollToEnd({ animated: false })
  }, [])
  const toEnd = useCallback(() => {
    stick.current = true
    list.current?.scrollToEnd({ animated: true })
  }, [])
  const chatTitleOf = useCallback((cid: string) => {
    const p = store.getPlain('chat', cid)
    return p ? chatTitle(typeof p.title === 'string' ? p.title : '') : null
  }, [])

  const ctx = useMemo<RowContext | null>(
    () =>
      view
        ? {
            depth: view.session.depth,
            siblings: view.siblings,
            results: view.results,
            childByToolCall: view.childByToolCall,
            localOverride: view.localOverride,
            now,
            onSelectBranch,
            onOpenSession,
            chatTitle: chatTitleOf
          }
        : null,
    [view, now, onSelectBranch, onOpenSession, chatTitleOf]
  )

  const title = loaded ? chatTitle(loaded.chat.title) : ''
  const sessions = loaded?.sessions ?? []

  const header = (
    <View style={[st.header, { paddingTop: insets.top + 4 }]}>
      <Pressable
        onPress={() => router.back()}
        hitSlop={10}
        style={st.iconBtn}
        accessibilityLabel="Voltar"
        testID="header-back"
      >
        <Ionicons name="chevron-back" size={24} color={colors.fg} />
      </Pressable>
      <Pressable
        style={st.headText}
        onPress={() => loaded && setRenaming(true)}
        testID="chat-title"
      >
        <Text style={st.title} numberOfLines={1}>
          {title}
        </Text>
        {state?.host ? (
          <HostBadge state={state} />
        ) : view && view.session.depth > 0 ? (
          <Text style={st.sub} numberOfLines={1}>
            Subagente · {sessionLabel(view.session)}
          </Text>
        ) : null}
      </Pressable>
      <Pressable
        onPress={() => loaded && setMenu(true)}
        hitSlop={10}
        style={st.iconBtn}
        accessibilityLabel="Ações do chat"
        testID="chat-menu"
      >
        <Ionicons name="ellipsis-vertical" size={20} color={colors.muted} />
      </Pressable>
    </View>
  )

  if (loaded === undefined)
    return (
      <View style={st.root}>
        {header}
        <View style={st.center}>
          <ActivityIndicator color={colors.accentStrong} />
        </View>
      </View>
    )

  if (loaded === null)
    return (
      <View style={st.root} testID="chat-gone">
        {header}
        <View style={st.center}>
          <Ionicons name="trash-outline" size={28} color={colors.subtle} />
          <Text style={st.goneTitle}>Este chat foi apagado</Text>
          <Text style={st.goneText}>Ele não existe mais neste aparelho nem no servidor.</Text>
          <Pressable onPress={() => router.back()} style={st.goneBtn}>
            <Text style={{ color: colors.accentStrong, fontSize: 15 }}>Voltar para os chats</Text>
          </Pressable>
        </View>
      </View>
    )

  return (
    <View style={st.root} testID="screen-chat">
      {header}
      {sessions.length > 1 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={st.tabs}
          contentContainerStyle={st.tabsIn}
        >
          {sessions.map((s) => {
            const active = s.id === view?.session.id
            return (
              <Pressable
                key={s.id}
                testID={`session-tab-${s.depth === 0 ? 'main' : s.id}`}
                onPress={() => onOpenSession(s.id)}
                style={[st.tab, active && st.tabOn]}
              >
                <Ionicons
                  name={s.depth === 0 ? 'chatbubble-outline' : 'git-network-outline'}
                  size={13}
                  color={active ? colors.fg : colors.subtle}
                />
                <Text style={[st.tabText, active && { color: colors.fg }]} numberOfLines={1}>
                  {sessionLabel(s)}
                </Text>
              </Pressable>
            )
          })}
        </ScrollView>
      ) : null}
      {view && ctx ? (
        <RowCtx.Provider value={ctx}>
          <FlashList
            key={view.session.id}
            ref={list}
            data={view.rows}
            keyExtractor={(r) => r.key}
            getItemType={(r) => r.type}
            extraData={ctx}
            initialScrollIndex={view.rows.length ? view.rows.length - 1 : undefined}
            maintainVisibleContentPosition={{
              startRenderingFromBottom: true,
              autoscrollToBottomThreshold: 0.2
            }}
            contentContainerStyle={{ paddingTop: 8, paddingBottom: 16 }}
            onScroll={(e) => {
              const n = e.nativeEvent
              const bottom =
                n.contentSize.height - n.contentOffset.y - n.layoutMeasurement.height < 80
              if (bottom !== atBottom) setAtBottom(bottom)
            }}
            scrollEventThrottle={100}
            onScrollBeginDrag={unstick}
            onContentSizeChange={followEnd}
            ListEmptyComponent={
              <View style={st.center}>
                <Text style={st.goneText}>Nenhuma mensagem nesta sessão.</Text>
              </View>
            }
            renderItem={({ item }) => (
              <MessageRow row={item} onToggleOld={() => setShowOld((v) => !v)} />
            )}
          />
        </RowCtx.Provider>
      ) : (
        <View style={st.center}>
          <Text style={st.goneText}>Nenhuma mensagem ainda.</Text>
        </View>
      )}
      {!atBottom ? (
        <Pressable
          style={[st.toBottom, { bottom: insets.bottom + 64 }]}
          onPress={toEnd}
          accessibilityLabel="Ir para o fim"
          testID="scroll-to-bottom"
        >
          <Ionicons name="arrow-down" size={18} color={colors.muted} />
        </Pressable>
      ) : null}
      <View style={[st.footer, { paddingBottom: insets.bottom + 10 }]}>
        {view?.localOverride ? (
          <View style={st.footRow} testID="local-version-note">
            <Ionicons name="git-branch-outline" size={14} color={colors.accentStrong} />
            <Text style={st.footText} numberOfLines={2}>
              Vendo outra versão só neste aparelho.
            </Text>
            <Pressable onPress={() => setLocalSel(null)} hitSlop={8}>
              <Text style={st.footLink}>Voltar à atual</Text>
            </Pressable>
          </View>
        ) : (
          <View style={st.footRow}>
            <Ionicons name="eye-outline" size={14} color={colors.subtle} />
            <Text style={st.footText} numberOfLines={2}>
              Somente leitura — enviar mensagens chega na próxima versão do app.
            </Text>
          </View>
        )}
        {loaded.broken ? (
          <Text style={st.broken}>
            {loaded.broken}{' '}
            {loaded.broken === 1
              ? 'registro não pôde ser decifrado'
              : 'registros não puderam ser decifrados'}{' '}
            e não aparece{loaded.broken === 1 ? '' : 'm'}.
          </Text>
        ) : null}
      </View>
      {menu ? (
        <ChatActionsSheet
          title={title}
          onClose={() => setMenu(false)}
          onRename={() => {
            setMenu(false)
            setRenaming(true)
          }}
          onDelete={() => {
            setMenu(false)
            setDeleting(true)
          }}
        />
      ) : null}
      {renaming ? (
        <RenameDialog
          initial={loaded.chat.title}
          onClose={() => setRenaming(false)}
          onSave={(t) => engine.renameChat(id, t)}
        />
      ) : null}
      <ConfirmDialog
        visible={deleting}
        title="Apagar chat?"
        message={`“${title}” será apagado em todos os seus dispositivos, com todas as mensagens. Não dá para desfazer.`}
        confirmLabel="Apagar"
        destructive
        busy={busy}
        onClose={() => setDeleting(false)}
        onConfirm={() => {
          setBusy(true)
          engine
            .deleteChat(id)
            .then(() => {
              toast('Chat apagado')
              router.back()
            })
            .catch((e: unknown) => toast(describeError(e), 'danger'))
            .finally(() => {
              setBusy(false)
              setDeleting(false)
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
    gap: 4,
    paddingHorizontal: 6,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: colors.bg
  },
  iconBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  headText: { flex: 1, gap: 2, paddingVertical: 2 },
  title: { color: colors.fg, fontSize: 16.5, fontWeight: '600' },
  sub: { color: colors.subtle, fontSize: 11.5 },
  tabs: {
    flexGrow: 0,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border
  },
  tabsIn: { gap: 6, paddingHorizontal: 12, paddingVertical: 8 },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    maxWidth: 220,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border
  },
  tabOn: { backgroundColor: colors.active, borderColor: colors.borderStrong },
  tabText: { color: colors.subtle, fontSize: 12.5 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, padding: 32 },
  goneTitle: { color: colors.fg, fontSize: 17, fontWeight: '600' },
  goneText: { color: colors.muted, fontSize: 14, textAlign: 'center' },
  goneBtn: { marginTop: 8, padding: 10 },
  toBottom: {
    position: 'absolute',
    alignSelf: 'center',
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.elevated,
    alignItems: 'center',
    justifyContent: 'center'
  },
  footer: {
    paddingHorizontal: 16,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
    gap: 4
  },
  footRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  footText: { flex: 1, color: colors.subtle, fontSize: 12.5 },
  footLink: { color: colors.accentStrong, fontSize: 13, fontWeight: '500' },
  broken: { color: colors.warning, fontSize: 11.5 }
})
