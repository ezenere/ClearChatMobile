// Chat só ao vivo de outro dispositivo (SYNC_PROTOCOL.md §23.5–§23.7, §23.10): aparece na seção
// "Ao vivo em <host>" enquanto o app do host está aberto, conectado e desbloqueado. O histórico vem
// do host sob demanda e fica SÓ EM MEMÓRIA (nada no banco, em arquivos, no cache de imagens nem no
// índice de busca); as atualizações vêm pelo stream (`rec`). Controle remoto completo: enviar (com
// anexos mandados ao host por `attach.put`), fila, ⚡, parar, aprovações, perguntas, retry, versões,
// editar/apagar mensagens, compactar, extrair memórias, parar subagentes, arquivos do host e
// `chat.update` (renomear / trocar o modelo). Não existe aqui: apagar, converter, "Executar neste
// dispositivo" (só no host, §23.9).
import Ionicons from '@expo/vector-icons/Ionicons'
import { FlashList, type FlashListRef } from '@shopify/flash-list'
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { KeyboardAvoidingView } from 'react-native-keyboard-controller'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { ApprovalItemDecision } from '@shared/approvalPolicy'
import { providerKind } from '@shared/providerKinds'
import type { ApiMessage, ApprovalRequest, StoredMessage } from '@shared/types'
import { regenerateTargets, trailingErrorId } from '@vendor/renderer/branchView'
import { describeError } from '@/account/errors'
import { toolLabel } from '@/agent/toolLabels'
import { ChatAvatar, RenameDialog } from '@/chat/ChatBits'
import { MessageRow, RowCtx, type RowContext, type RowLive } from '@/chat/MessageRow'
import { RemoteComposer, type ComposerAttach, type SendInput } from '@/chat/remote/Composer'
import { MessageActionsSheet, type MessageActionHandlers } from '@/chat/remote/MessageActions'
import { ApprovalPanel, QuestionPanel, RetryPanel, Strip } from '@/chat/remote/Panels'
import {
  buildSessionView,
  localSelectFor,
  mainSession,
  sessionLabel,
  type LocalSel,
  type Row
} from '@/chat/viewModel'
import { chatTitle } from '@/data/decode'
import { AttachmentSourceCtx, engine, store, useNow } from '@/data/react'
import { hostStack } from '@/host/react'
import { liveAttachmentSource } from '@/live/attachSource'
import { liveTempFile } from '@/live/native'
import { live, useLiveChat, useLiveNotices } from '@/live/react'
import { LiveService, type LiveNotice } from '@/live/service'
import { liveStatusText } from '@/live/types'
import { BUSY_STATUS, liveStatus } from '@/remote/mirror'
import { remote } from '@/remote/react'
import { setOpenChat } from '@/push/task'
import { ModelPicker, useModels } from '@/settings/ModelPicker'
import { Button } from '@/ui/Button'
import { ConfirmDialog } from '@/ui/Dialog'
import { BottomInset } from '@/ui/BottomBar'
import { Sheet, SheetItem } from '@/ui/Sheet'
import { useToast } from '@/ui/Toast'
import { colors, radius } from '@/ui/theme'

interface SendingItem {
  key: string
  sessionId: string
  text: string
  files: number
}

type Gone = { reason: string; hostName: string; title: string } | null

export default function LiveChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const toast = useToast()
  const lc = useLiveChat(id)
  const entry = lc.entry
  const loaded = lc.loaded
  const rv = useSyncExternalStore(remote.subscribe, remote.getVersion)
  // `rv`/`entry` são os gatilhos de releitura (o React Compiler memoiza chamadas a objetos externos)
  const mode = useMemo(() => remote.mode(id), [id, rv, lc]) // eslint-disable-line react-hooks/exhaustive-deps
  const liveView = useMemo(() => remote.view(id), [id, rv]) // eslint-disable-line react-hooks/exhaustive-deps
  const [gone, setGone] = useState<Gone>(null)
  const [savedOnline, setSavedOnline] = useState(false)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [localSel, setLocalSel] = useState<LocalSel | null>(null)
  const [showOld, setShowOld] = useState(true)
  const [menu, setMenu] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [modelPicker, setModelPicker] = useState(false)
  const [pickProvider, setPickProvider] = useState('')
  const [atBottom, setAtBottom] = useState(true)
  const [sending, setSending] = useState<SendingItem[]>([])
  const [actionMsg, setActionMsg] = useState<StoredMessage | null>(null)
  const [processes, setProcesses] = useState(false)
  const [confirmStopSubs, setConfirmStopSubs] = useState(false)
  const [dismissedError, setDismissedError] = useState<string | null>(null)
  const list = useRef<FlashListRef<Row>>(null)
  const stick = useRef(true)
  const now = useNow()

  // §22.7: com o chat aberto, os avisos dele não aparecem
  useFocusEffect(
    useCallback(() => {
      setOpenChat(id)
      return () => setOpenChat(null)
    }, [id])
  )

  // fonte dos anexos: o host, por attach.get, para a memória (§23.7)
  const source = useMemo(
    () => liveAttachmentSource({ live, chatId: id, temp: (n, b) => liveTempFile(n, b).uri }),
    [id]
  )

  useLiveNotices(
    useCallback(
      (n: LiveNotice) => {
        if (n.chatId !== id) return
        if (n.kind === 'restarted') {
          toast(`${n.chatId ? 'O host reiniciou' : ''} — recarregando o chat.`, 'info')
          return
        }
        if (n.reason === 'saved_online') setSavedOnline(true)
        else setGone({ reason: n.reason, hostName: n.hostName, title: n.title })
      },
      [id, toast]
    )
  )

  // virou chat online (§23.8.5): abre o chat comum quando o registro chegar
  useEffect(() => {
    if (!savedOnline) return
    const go = () => {
      if (!store.getPlain('chat', id)) return false
      router.replace({ pathname: '/chat/[id]', params: { id } })
      return true
    }
    if (go()) return
    const off = engine.subscribe(() => void go())
    const t = setTimeout(() => void engine.sync(), 1500)
    return () => {
      off()
      clearTimeout(t)
    }
  }, [savedOnline, id, router])

  const hostName = entry?.host.name ?? gone?.hostName ?? 'o host'
  const sessions = useMemo(() => {
    const all = loaded?.sessions ?? []
    if (!liveView) return all
    return all.map((s) =>
      liveView.branchSel[s.id] ? { ...s, branchSel: liveView.branchSel[s.id] } : s
    )
  }, [loaded, liveView])
  const session = useMemo(() => {
    if (!loaded) return null
    return (
      sessions.find((s) => s.id === sessionId) ??
      sessions.find((s) => s.id === mainSession(loaded)?.id) ??
      null
    )
  }, [loaded, sessions, sessionId])
  const view = useMemo(
    () =>
      loaded && session
        ? buildSessionView({ ...loaded, sessions }, session, localSel, showOld)
        : null,
    [loaded, sessions, session, localSel, showOld]
  )
  const sid = view?.session.id ?? ''
  const status = session ? liveStatus(session, liveView, entry?.running ?? false) : 'idle'
  const busy = BUSY_STATUS.has(status)
  // saiu da lista e voltou (o host reabriu o app): a tela volta sozinha
  const goneNow = !!gone && !entry
  const active = mode === 'remote' && !!entry && !goneNow

  // subsessão aberta: carrega as mensagens dela sob demanda (§23.5.2)
  useEffect(() => {
    if (view && view.session.depth > 0) live.ensureSession(id, view.session.id)
  }, [id, view])

  const run = useCallback(
    async (fn: () => Promise<unknown>, ok?: string): Promise<boolean> => {
      try {
        await fn()
        if (ok) toast(ok)
        return true
      } catch (e) {
        toast(describeError(e), 'danger')
        return false
      }
    },
    [toast]
  )

  const onSelectBranch = useCallback(
    (msgId: string) => {
      if (!loaded || !view) return
      if (active && view.session.depth === 0 && !busy) {
        void run(() => remote.selectBranch(id, msgId))
        return
      }
      if (active && busy && view.session.depth === 0)
        toast('Espere o agente terminar para trocar de versão — mostrando só aqui.', 'info')
      setLocalSel(localSelectFor(view, { ...loaded, sessions }, msgId))
    },
    [loaded, view, active, busy, run, id, sessions, toast]
  )
  const onOpenSession = useCallback((s: string) => {
    setSessionId(s)
    setLocalSel(null)
  }, [])
  const shownSession = view?.session.id
  useEffect(() => {
    stick.current = true
  }, [shownSession])
  const followEnd = useCallback(() => {
    if (stick.current) list.current?.scrollToEnd({ animated: false })
  }, [])
  const chatTitleOf = useCallback((cid: string) => {
    const e = live.entry(cid)
    if (e) return chatTitle(e.info.title)
    const p = store.getPlain('chat', cid)
    return p ? chatTitle(typeof p.title === 'string' ? p.title : '') : null
  }, [])

  const rowLive = useMemo<RowLive>(() => {
    const awaiting: Record<string, 'approval' | 'question'> = {}
    for (const a of liveView?.approvals ?? [])
      if (a.sessionId === sid) awaiting[a.toolCallId] = 'approval'
    for (const q of liveView?.questions ?? [])
      if (q.sessionId === sid) awaiting[q.toolCallId] = 'question'
    return {
      tools: liveView?.tools[sid] ?? {},
      awaiting,
      onSmartOverride: active
        ? (messageId: string) => void run(() => remote.smartOverride(id, messageId), 'Liberado')
        : undefined,
      onLongPress: (m: StoredMessage) => setActionMsg(m)
    }
  }, [active, liveView, sid, run, id])

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
            chatTitle: chatTitleOf,
            live: rowLive
          }
        : null,
    [view, now, onSelectBranch, onOpenSession, chatTitleOf, rowLive]
  )

  const draft = liveView?.drafts[sid] ?? null
  const rows = useMemo<Row[]>(() => {
    if (!view) return []
    const out = [...view.rows]
    for (const s of sending)
      if (s.sessionId === sid)
        out.push({ kind: 'sending', key: s.key, type: 'sending', text: s.text, files: s.files })
    if (draft)
      out.push({ kind: 'draft', key: `draft-${sid}`, type: 'draft', draft, sessionId: sid })
    return out
  }, [view, sending, draft, sid])

  const regen = useMemo(() => (view ? regenerateTargets(view.path) : new Set<string>()), [view])
  const trailingError = useMemo(() => (view ? trailingErrorId(view.path) : null), [view])

  const attach = useMemo<ComposerAttach>(
    () => ({
      ephemeral: true,
      checkLimits: (l) => LiveService.checkLimits(l),
      start: async (data, name, mime, onProgress) => {
        const up = await live.upload(id, data, name, mime, onProgress)
        return {
          file: up.file,
          kind: up.kind,
          size: up.size,
          name: up.name,
          done: up.handle.done,
          cancel: up.handle.cancel
        }
      }
    }),
    [id]
  )

  const send = useCallback(
    async (input: SendInput): Promise<boolean> => {
      if (!sid) return false
      const key = `s${Date.now()}`
      setSending((x) => [
        ...x,
        { key, sessionId: sid, text: input.text, files: input.attachments.length }
      ])
      stick.current = true
      try {
        const r = await remote.send(
          id,
          sid,
          input.text,
          input.attachments.map((a) => a.info),
          input.skills,
          input.force && busy
        )
        if (r.queued && !input.force) toast('Na fila — vai no próximo passo do agente.', 'info')
        return true
      } catch (e) {
        toast(describeError(e), 'danger')
        return false
      } finally {
        setSending((x) => x.filter((s) => s.key !== key))
      }
    },
    [id, sid, busy, toast]
  )

  const handlers = useMemo<MessageActionHandlers>(
    () => ({
      editInPlace: (m: StoredMessage, message: ApiMessage) =>
        run(() => remote.editMessage(id, m.id, message), 'Mensagem editada'),
      editBranch: (m: StoredMessage, message: ApiMessage) =>
        run(() => remote.editBranch(id, m.id, message)),
      remove: (m: StoredMessage) => run(() => remote.deleteMessage(id, m.id), 'Mensagem apagada'),
      regenerate: (m: StoredMessage) =>
        run(() => remote.regenerate(id, m.sessionId, m.meta.kind === 'error' ? undefined : m.id)),
      compactRetry: () => run(() => remote.compact(id, sid, { retry: true }))
    }),
    [run, id, sid]
  )

  const decideApproval = useCallback(
    (req: ApprovalRequest, decision: 'allow' | 'deny', items?: ApprovalItemDecision[]) =>
      run(() => remote.approve(id, req.id, decision, items)),
    [run, id]
  )

  // ---- modelo (chat.update) ----
  const providers = useMemo(
    () => hostStack.providers().filter((p) => providerKind(p) !== 'elevenlabs'),
    []
  )
  const cfg = (loaded?.chat.config ?? {}) as { providerId?: unknown; model?: unknown }
  const curProvider = typeof cfg.providerId === 'string' ? cfg.providerId : ''
  const curModel = typeof cfg.model === 'string' ? cfg.model : ''
  const pickerProvider = providers.find((p) => p.id === (pickProvider || curProvider)) ?? null
  const models = useModels(modelPicker ? pickerProvider : null)

  // ---------------- estado derivado ----------------

  const busySubs = sessions.filter(
    (s) => s.depth > 0 && BUSY_STATUS.has(liveStatus(s, liveView, entry?.running ?? false))
  )
  const question = liveView?.questions[0] ?? null
  const retry = liveView?.retries.find((r) => r.sessionId === sid) ?? liveView?.retries[0] ?? null
  const runningTool = Object.entries(liveView?.tools[sid] ?? {}).find(([, r]) => r.running)
  const toolName = runningTool
    ? (view?.path
        .flatMap((m) => (m.message.role === 'assistant' ? (m.message.tool_calls ?? []) : []))
        .find((t) => t.id === runningTool[0])?.function.name ??
      draft?.toolCalls.find((t) => t.id === runningTool[0])?.name)
    : null
  const compaction = liveView?.compaction[sid]
  const statusText = !busy
    ? compaction
      ? 'Compactação agendada'
      : null
    : question || status === 'awaiting_input'
      ? 'Aguardando sua resposta'
      : retry || status === 'awaiting_retry'
        ? 'Aguardando sua decisão (falha de conexão)'
        : status === 'awaiting_approval'
          ? 'Aguardando aprovação'
          : status === 'waiting'
            ? 'Aguardando subagentes'
            : compaction?.state === 'running'
              ? 'Compactando conversa…'
              : toolName
                ? `Executando ${toolLabel(toolName)}…`
                : draft && draft.reasoning && !draft.content && !draft.toolCalls.length
                  ? 'Pensando…'
                  : 'Trabalhando…'
  const sessionError = liveView?.errors[sid]
  const canAct = !active
    ? `${hostName} não está conectado — ações desativadas.`
    : busy
      ? 'Espere o agente terminar para mudar o conteúdo.'
      : null
  // o último título conhecido fica na tela depois que o chat sai da lista (só em memória)
  const title = chatTitle(loaded?.chat.title ?? entry?.info.title ?? gone?.title)
  const hostOnline = entry?.host.status === 'online' && !entry.stale
  const badge = entry
    ? `Ao vivo em ${entry.host.name} · ${entry.stale ? 'reconectando…' : liveStatusText(entry.info, entry.host.status)}`
    : `Ao vivo em ${hostName}`

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
        onPress={() => loaded && active && setRenaming(true)}
        testID="chat-title"
      >
        <Text style={st.title} numberOfLines={1}>
          {title}
        </Text>
        <View style={st.badgeRow} testID="live-badge">
          <View
            style={[
              st.dot,
              {
                backgroundColor: !hostOnline
                  ? colors.warning
                  : entry?.running
                    ? colors.accentStrong
                    : colors.success
              }
            ]}
          />
          <Ionicons name="radio-outline" size={11} color={colors.accentStrong} />
          <Text style={st.liveBadge} numberOfLines={1}>
            {badge}
          </Text>
        </View>
      </Pressable>
      {active && entry?.info.hostCwd ? (
        <Pressable
          onPress={() => router.push({ pathname: '/files/[chat]', params: { chat: id, path: '' } })}
          hitSlop={10}
          style={st.iconBtn}
          accessibilityLabel="Arquivos do host"
          testID="chat-files"
        >
          <Ionicons name="folder-open-outline" size={20} color={colors.muted} />
        </Pressable>
      ) : null}
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

  if (savedOnline)
    return (
      <View style={st.root} testID="live-saved-online">
        {header}
        <View style={st.center}>
          <ActivityIndicator color={colors.accentStrong} />
          <Text style={st.goneTitle}>Este chat foi salvo online</Text>
          <Text style={st.goneText}>
            Abrindo a versão sincronizada… o histórico vai aparecendo conforme {hostName} termina de
            enviar.
          </Text>
        </View>
      </View>
    )

  if (goneNow || (!entry && lc.phase === 'none'))
    return (
      <View style={st.root} testID="live-gone">
        {header}
        <View style={st.center}>
          <Ionicons name="radio-outline" size={30} color={colors.subtle} />
          <Text style={st.goneTitle}>Chat indisponível</Text>
          <Text style={st.goneText}>
            {gone?.reason === 'deleted'
              ? `Este chat foi apagado em ${hostName}.`
              : `Este chat só ao vivo não está disponível agora — ${hostName} não está conectado. Ele volta a aparecer quando o app abrir lá.`}
          </Text>
          <Pressable onPress={() => router.back()} style={st.goneBtn}>
            <Text style={{ color: colors.accentStrong, fontSize: 15 }}>Voltar para os chats</Text>
          </Pressable>
        </View>
      </View>
    )

  if (!loaded)
    return (
      <View style={st.root} testID="live-loading">
        {header}
        <View style={st.center}>
          {lc.phase === 'error' ? (
            <>
              <Ionicons name="cloud-offline-outline" size={28} color={colors.warning} />
              <Text style={st.goneTitle}>Não deu para carregar</Text>
              <Text style={st.goneText}>{lc.error}</Text>
              <View style={{ marginTop: 10 }}>
                <Button
                  title="Tentar de novo"
                  icon="refresh"
                  variant="secondary"
                  onPress={() => live.retry(id)}
                  testID="live-retry"
                />
              </View>
            </>
          ) : (
            <>
              <ActivityIndicator color={colors.accentStrong} />
              <Text style={st.goneTitle}>Carregando de {hostName}…</Text>
              <Text style={st.goneText}>
                {lc.progress
                  ? `${lc.progress}${entry?.info.messageCount ? ` de ~${entry.info.messageCount}` : ''} mensagens`
                  : 'O histórico vem do host, cifrado, e fica só na memória deste celular.'}
              </Text>
            </>
          )}
        </View>
      </View>
    )

  const queue = liveView?.queues[sid] ?? []
  const stillLoading = lc.phase === 'loading'

  return (
    <AttachmentSourceCtx.Provider value={source}>
      <View style={st.root} testID="screen-live-chat">
        {header}
        {sessions.length > 1 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={st.tabs}
            contentContainerStyle={st.tabsIn}
          >
            {sessions.map((s) => {
              const on = s.id === view?.session.id
              const sBusy = BUSY_STATUS.has(liveStatus(s, liveView, entry?.running ?? false))
              return (
                <Pressable
                  key={s.id}
                  testID={`session-tab-${s.depth === 0 ? 'main' : s.id}`}
                  onPress={() => onOpenSession(s.id)}
                  style={[st.tab, on && st.tabOn]}
                >
                  {sBusy ? (
                    <ActivityIndicator size={10} color={colors.accentStrong} />
                  ) : (
                    <Ionicons
                      name={s.depth === 0 ? 'chatbubble-outline' : 'git-network-outline'}
                      size={13}
                      color={on ? colors.fg : colors.subtle}
                    />
                  )}
                  <Text style={[st.tabText, on && { color: colors.fg }]} numberOfLines={1}>
                    {sessionLabel(s)}
                  </Text>
                </Pressable>
              )
            })}
          </ScrollView>
        ) : null}
        <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
          {view && ctx ? (
            <RowCtx.Provider value={ctx}>
              <FlashList
                key={view.session.id}
                ref={list}
                data={rows}
                keyExtractor={(r) => r.key}
                getItemType={(r) => r.type}
                extraData={ctx}
                initialScrollIndex={rows.length ? rows.length - 1 : undefined}
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
                  if (bottom) stick.current = true
                }}
                scrollEventThrottle={100}
                onScrollBeginDrag={() => {
                  stick.current = false
                }}
                onContentSizeChange={followEnd}
                ListEmptyComponent={
                  <View style={st.center}>
                    <Text style={st.goneText}>
                      {view.session.depth > 0 && !live.history(id)?.sessionLoaded(view.session.id)
                        ? 'Carregando o subagente…'
                        : 'Nenhuma mensagem nesta sessão.'}
                    </Text>
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
              style={st.toBottom}
              onPress={() => {
                stick.current = true
                list.current?.scrollToEnd({ animated: true })
              }}
              accessibilityLabel="Ir para o fim"
              testID="scroll-to-bottom"
            >
              <Ionicons name="arrow-down" size={18} color={colors.muted} />
            </Pressable>
          ) : null}
          <View style={st.footer}>
            {stillLoading ? (
              <Strip icon="sync-outline" tone="muted" testID="strip-live-loading">
                Carregando o resto do histórico de {hostName}…
              </Strip>
            ) : null}
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
            ) : null}
            {!active ? (
              <Strip icon="cloud-offline-outline" tone="warning" testID="strip-live-offline">
                {mode === 'offline'
                  ? 'Sem conexão com o servidor — reconectando…'
                  : `${hostName} está reconectando — o chat volta quando ele voltar.`}
              </Strip>
            ) : null}
            {active && busySubs.length ? (
              <Strip
                icon="git-network-outline"
                tone="accent"
                testID="strip-subagents"
                action={
                  <Pressable
                    onPress={() => setConfirmStopSubs(true)}
                    hitSlop={8}
                    testID="stop-subagents"
                  >
                    <Text style={st.footLink}>Parar</Text>
                  </Pressable>
                }
              >
                {busySubs.length === 1
                  ? `Subagente “${sessionLabel(busySubs[0])}” rodando`
                  : `${busySubs.length} subagentes rodando`}
              </Strip>
            ) : null}
            {active && sessionError && sessionError !== dismissedError ? (
              <Strip
                icon="alert-circle-outline"
                tone="danger"
                testID="strip-error"
                action={
                  <Pressable onPress={() => setDismissedError(sessionError)} hitSlop={8}>
                    <Ionicons name="close" size={16} color={colors.subtle} />
                  </Pressable>
                }
              >
                {sessionError}
              </Strip>
            ) : null}
            {active && question ? (
              <QuestionPanel
                key={question.id}
                request={question}
                onAnswer={(answers) => run(() => remote.answer(id, question.id, answers))}
                onCancel={() => run(() => remote.cancelQuestion(id, question.id))}
              />
            ) : null}
            {active && !question && retry ? (
              <RetryPanel
                request={retry}
                onDecide={(a) => run(() => remote.retry(id, retry.id, a))}
              />
            ) : null}
            {active && !question && !retry ? (
              <ApprovalPanel
                approvals={liveView?.approvals ?? []}
                sessions={sessions}
                viewSessionId={sid}
                onDecide={decideApproval}
                onOpenSession={onOpenSession}
              />
            ) : null}
            <View style={active && (question || retry) ? st.hidden : undefined}>
              <RemoteComposer
                busy={active && busy}
                statusText={active ? statusText : 'Reconectando…'}
                hostName={hostName}
                queue={active ? queue : []}
                skills={liveView?.skills ?? []}
                placeholder={
                  view?.session.depth ? 'Mensagem ao subagente…' : `Mensagem para ${hostName}…`
                }
                disabled={!active ? `${hostName} não está conectado — reconectando…` : null}
                onSend={send}
                onStop={() => run(() => remote.stop(id, sid))}
                onQueueForce={(qid) => run(() => remote.queueForce(id, sid, qid))}
                onQueueRemove={(qid) => run(() => remote.queueRemove(id, sid, qid))}
                attach={attach}
                hostUnavailable={!active}
                voiceConfig={loaded?.chat.config as Record<string, unknown> | undefined}
              />
            </View>
            {loaded.broken ? (
              <Text style={st.broken}>
                {loaded.broken === 1
                  ? '1 item do histórico não veio do host e não aparece.'
                  : `${loaded.broken} itens do histórico não vieram do host e não aparecem.`}
              </Text>
            ) : null}
            <BottomInset />
          </View>
        </KeyboardAvoidingView>
        <MessageActionsSheet
          msg={actionMsg}
          depth={view?.session.depth ?? 0}
          canAct={canAct}
          canRegenerate={!!actionMsg && regen.has(actionMsg.id) && view?.session.depth === 0}
          trailingError={!!actionMsg && trailingError === actionMsg.id}
          onClose={() => setActionMsg(null)}
          h={handlers}
        />
        <Sheet visible={menu} onClose={() => setMenu(false)} title={title} testID="chat-menu-sheet">
          <View style={st.menuHead}>
            <ChatAvatar icon={entry?.info.persona?.icon ?? null} size={30} />
            <Text style={st.menuHeadText}>
              Só ao vivo em {hostName}: o chat fica guardado só lá. Aqui ele existe só na memória,
              enquanto o app estiver aberto lá.
            </Text>
          </View>
          <SheetItem
            icon="create-outline"
            label="Renomear"
            disabled={!active}
            onPress={() => {
              setMenu(false)
              setRenaming(true)
            }}
            testID="chat-action-rename"
          />
          <SheetItem
            icon="hardware-chip-outline"
            label="Trocar o modelo"
            detail={curModel ? `${curModel}` : undefined}
            disabled={!active || busy}
            onPress={() => {
              setMenu(false)
              setPickProvider(curProvider)
              setModelPicker(true)
            }}
            testID="chat-action-model"
          />
          {entry?.info.hostCwd ? (
            <SheetItem
              icon="folder-open-outline"
              label="Arquivos do host"
              detail={`Navegar e ler arquivos no ${hostName} (somente leitura).`}
              disabled={!active}
              onPress={() => {
                setMenu(false)
                router.push({ pathname: '/files/[chat]', params: { chat: id, path: '' } })
              }}
              testID="chat-action-files"
            />
          ) : null}
          {liveView?.processes.length ? (
            <SheetItem
              icon="pulse-outline"
              label={`Processos (${liveView.processes.length})`}
              onPress={() => {
                setMenu(false)
                setProcesses(true)
              }}
              testID="chat-action-processes"
            />
          ) : null}
          <SheetItem
            icon="layers-outline"
            label="Compactar conversa"
            detail="Resume o histórico no host para liberar contexto."
            disabled={!active}
            onPress={() => {
              setMenu(false)
              void run(() => remote.compact(id, sid), 'Compactação pedida ao host')
            }}
            testID="chat-action-compact"
          />
          <SheetItem
            icon="bookmarks-outline"
            label="Extrair memórias agora"
            disabled={!active}
            onPress={() => {
              setMenu(false)
              void run(() => remote.extractMemory(id, sid), 'Extração iniciada no host')
            }}
            testID="chat-action-memory"
          />
          <SheetItem
            icon="stop-circle-outline"
            label="Parar subagentes"
            disabled={!busySubs.length || !active}
            onPress={() => {
              setMenu(false)
              setConfirmStopSubs(true)
            }}
            testID="chat-action-stop-subagents"
          />
        </Sheet>
        <Sheet
          visible={processes}
          onClose={() => setProcesses(false)}
          title="Processos no host"
          subtitle="Somente leitura — os logs completos ficam no host."
        >
          {(liveView?.processes ?? []).map((p) => (
            <View key={p.id} style={st.proc} testID="process-row">
              <Text style={st.procName} numberOfLines={1}>
                {p.id} · {p.name || p.command} ·{' '}
                {p.status === 'running'
                  ? 'rodando'
                  : `saiu${p.exitCode != null ? ` (${p.exitCode})` : ''}`}
              </Text>
              {p.lastLine ? (
                <Text style={st.procLine} numberOfLines={2}>
                  {p.lastLine}
                </Text>
              ) : null}
            </View>
          ))}
        </Sheet>
        <ConfirmDialog
          visible={confirmStopSubs}
          title="Parar subagentes?"
          message="Os subagentes em segundo plano deste chat param no host; os parciais ficam salvos."
          confirmLabel="Parar"
          destructive
          onClose={() => setConfirmStopSubs(false)}
          onConfirm={() => {
            setConfirmStopSubs(false)
            void run(() => remote.stopSubagents(id), 'Subagentes parados')
          }}
        />
        {renaming ? (
          <RenameDialog
            initial={loaded.chat.title}
            onClose={() => setRenaming(false)}
            onSave={async (t) => {
              const clean = t.trim().slice(0, 200)
              if (!clean) throw new Error('Dê um nome ao chat.')
              await remote.chatUpdate(id, { title: clean })
            }}
          />
        ) : null}
        <ModelPicker
          visible={modelPicker}
          onClose={() => setModelPicker(false)}
          providers={providers}
          providerId={pickProvider || curProvider}
          model={curModel}
          models={models.pid === (pickProvider || curProvider) ? models.list : null}
          error={models.pid === (pickProvider || curProvider) ? models.error : null}
          onProvider={(pid) => setPickProvider(pid)}
          onModel={(m) => {
            setModelPicker(false)
            const pid = pickProvider || curProvider
            void run(
              () => remote.chatUpdate(id, { config: { providerId: pid, model: m } }),
              'Modelo trocado no host'
            )
          }}
        />
      </View>
    </AttachmentSourceCtx.Provider>
  )
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: 6,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: colors.bg
  },
  iconBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  headText: { flex: 1, gap: 2, paddingVertical: 2 },
  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  title: { color: colors.fg, fontSize: 16.5, fontWeight: '600' },
  liveBadge: { color: colors.accentStrong, fontSize: 11.5, flexShrink: 1 },
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
  goneTitle: { color: colors.fg, fontSize: 17, fontWeight: '600', textAlign: 'center' },
  goneText: { color: colors.muted, fontSize: 14, textAlign: 'center' },
  goneBtn: { marginTop: 8, padding: 10 },
  toBottom: {
    alignSelf: 'center',
    width: 38,
    height: 38,
    marginTop: -46,
    marginBottom: 8,
    borderRadius: 19,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.elevated,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 2
  },
  footer: {
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
    gap: 4
  },
  footRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16 },
  footText: { flex: 1, color: colors.subtle, fontSize: 12.5 },
  footLink: { color: colors.accentStrong, fontSize: 13, fontWeight: '500' },
  broken: { color: colors.warning, fontSize: 11.5, paddingHorizontal: 16 },
  hidden: { display: 'none' },
  menuHead: { flexDirection: 'row', gap: 10, alignItems: 'center', paddingBottom: 10 },
  menuHeadText: { flex: 1, color: colors.subtle, fontSize: 12.5, lineHeight: 17 },
  proc: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.elevated,
    padding: 10,
    marginBottom: 8,
    gap: 4
  },
  procName: { color: colors.fg, fontSize: 14, fontWeight: '500' },
  procLine: { color: colors.faint, fontFamily: 'monospace', fontSize: 11.5 }
})
