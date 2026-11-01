// Conversa: sessões (principal + subagentes), caminho ativo pelo algoritmo normativo (§4.3.8) e, com
// o host online, controle remoto completo (§8.6, §11): resposta ao vivo com raciocínio e tools,
// composer (anexos, skills do host, fila, ⚡, parar), aprovações/questionário/retry, ações das
// mensagens (toque longo), trocar de versão no host, fixar host, arquivos do host, compactar,
// extrair memórias e parar subagentes. Host offline / sem host / divergente: faixa explicando.
import Ionicons from '@expo/vector-icons/Ionicons'
import { FlashList, type FlashListRef } from '@shopify/flash-list'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { KeyboardAvoidingView } from 'react-native-keyboard-controller'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { ApprovalItemDecision } from '@shared/approvalPolicy'
import { TOOL_LABELS } from '@shared/tools'
import type { ApiMessage, ApprovalRequest, Session, StoredMessage, ToolName } from '@shared/types'
import { regenerateTargets, trailingErrorId } from '@vendor/renderer/branchView'
import { describeError } from '@/account/errors'
import { HostBadge, RenameDialog } from '@/chat/ChatBits'
import { MessageRow, RowCtx, type RowContext, type RowLive } from '@/chat/MessageRow'
import { RemoteComposer, type SendInput } from '@/chat/remote/Composer'
import { HostStateBanner, usesLocalTools } from '@/chat/remote/HostBanner'
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
import { engine, store, useChat, useNow } from '@/data/react'
import { BUSY_STATUS, liveStatus } from '@/remote/mirror'
import { remote, useRemoteChat, useRemoteNotices } from '@/remote/react'
import { handoverOf } from '@/remote/types'
import { ConfirmDialog } from '@/ui/Dialog'
import { Sheet, SheetItem } from '@/ui/Sheet'
import { useToast } from '@/ui/Toast'
import { colors, radius } from '@/ui/theme'

interface SendingItem {
  key: string
  sessionId: string
  text: string
  files: number
}

export default function ChatScreen() {
  const { id, session: sessionParam } = useLocalSearchParams<{ id: string; session?: string }>()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const toast = useToast()
  const { loaded, state } = useChat(id)
  const { mode, view: live } = useRemoteChat(id, state)
  const [sessionId, setSessionId] = useState<string | null>(sessionParam ?? null)
  const [localSel, setLocalSel] = useState<LocalSel | null>(null)
  const [showOld, setShowOld] = useState(true)
  const [menu, setMenu] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [busyDelete, setBusyDelete] = useState(false)
  const [atBottom, setAtBottom] = useState(true)
  const [sending, setSending] = useState<SendingItem[]>([])
  const [actionMsg, setActionMsg] = useState<StoredMessage | null>(null)
  const [processes, setProcesses] = useState(false)
  const [confirmStopSubs, setConfirmStopSubs] = useState(false)
  const [dismissedError, setDismissedError] = useState<string | null>(null)
  const list = useRef<FlashListRef<Row>>(null)
  /** Preso ao fim até o usuário arrastar (imagens/draft que crescem mudam a altura). */
  const stick = useRef(true)
  const now = useNow()
  const remoteOn = mode === 'remote'

  useRemoteNotices(
    id,
    useCallback((n) => toast(n.text, n.tone === 'danger' ? 'danger' : n.tone), [toast])
  )

  /** Sessões com a versão ativa ao vivo do host (o registro chega logo depois). */
  const sessions = useMemo<Session[]>(() => {
    const all = loaded?.sessions ?? []
    if (!live) return all
    return all.map((s) => (live.branchSel[s.id] ? { ...s, branchSel: live.branchSel[s.id] } : s))
  }, [loaded, live])

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

  const windowOpen = !!state?.window
  const status = session ? liveStatus(session, live, windowOpen) : 'idle'
  const busy = BUSY_STATUS.has(status)
  const sid = view?.session.id ?? ''
  const hostName = state?.host?.name ?? 'host'

  // ---------------- comandos ----------------

  /** Roda um comando remoto; erro → toast em pt-BR. true = aceito. */
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
      // controle remoto: a versão muda no host (branch.select); subsessão/host fora: só na tela
      if (remoteOn && view.session.depth === 0 && !busy) {
        void run(() => remote.selectBranch(id, msgId))
        return
      }
      if (remoteOn && busy && view.session.depth === 0)
        toast('Espere o agente terminar para trocar de versão no host — mostrando só aqui.', 'info')
      setLocalSel(localSelectFor(view, { ...loaded, sessions }, msgId))
    },
    [loaded, view, remoteOn, busy, run, id, sessions, toast]
  )
  const onOpenSession = useCallback((s: string) => {
    setSessionId(s)
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

  const rowLive = useMemo<RowLive | undefined>(() => {
    if (!remoteOn && !live) return undefined
    const awaiting: Record<string, 'approval' | 'question'> = {}
    for (const a of live?.approvals ?? [])
      if (a.sessionId === sid) awaiting[a.toolCallId] = 'approval'
    for (const q of live?.questions ?? [])
      if (q.sessionId === sid) awaiting[q.toolCallId] = 'question'
    return {
      tools: live?.tools[sid] ?? {},
      awaiting,
      onSmartOverride: remoteOn
        ? (messageId: string) => void run(() => remote.smartOverride(id, messageId), 'Liberado')
        : undefined,
      onLongPress: (m: StoredMessage) => setActionMsg(m)
    }
  }, [remoteOn, live, sid, run, id])

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

  const draft = live?.drafts[sid] ?? null
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

  // ---------------- estado derivado ----------------

  const busySubs = sessions.filter(
    (s) => s.depth > 0 && BUSY_STATUS.has(liveStatus(s, live, windowOpen))
  )
  const question = live?.questions[0] ?? null
  const retry = live?.retries.find((r) => r.sessionId === sid) ?? live?.retries[0] ?? null
  const runningTool = Object.entries(live?.tools[sid] ?? {}).find(([, r]) => r.running)
  const toolName = runningTool
    ? (view?.path
        .flatMap((m) => (m.message.role === 'assistant' ? (m.message.tool_calls ?? []) : []))
        .find((t) => t.id === runningTool[0])?.function.name ??
      draft?.toolCalls.find((t) => t.id === runningTool[0])?.name)
    : null
  const compaction = live?.compaction[sid]
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
                ? `Executando ${TOOL_LABELS[toolName as ToolName] ?? toolName}…`
                : draft && draft.reasoning && !draft.content && !draft.toolCalls.length
                  ? 'Pensando…'
                  : 'Trabalhando…'
  const sessionError = live?.errors[sid]
  const localTools = usesLocalTools(loaded?.chat.config)
  const canAct = !remoteOn
    ? 'O host não está online — ações desativadas.'
    : busy
      ? 'Espere o agente terminar para mudar o conteúdo.'
      : null

  const title = loaded ? chatTitle(loaded.chat.title) : ''

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
          <View style={st.badgeRow}>
            {state.pinned ? (
              <Ionicons name="lock-closed" size={10} color={colors.subtle} testID="host-pinned" />
            ) : null}
            <HostBadge state={state} />
          </View>
        ) : view && view.session.depth > 0 ? (
          <Text style={st.sub} numberOfLines={1}>
            Subagente · {sessionLabel(view.session)}
          </Text>
        ) : null}
      </Pressable>
      {remoteOn ? (
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

  const handover = handoverOf(state)
  const queue = live?.queues[sid] ?? []

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
            const sBusy = BUSY_STATUS.has(liveStatus(s, live, windowOpen))
            return (
              <Pressable
                key={s.id}
                testID={`session-tab-${s.depth === 0 ? 'main' : s.id}`}
                onPress={() => onOpenSession(s.id)}
                style={[st.tab, active && st.tabOn]}
              >
                {sBusy ? (
                  <ActivityIndicator size={10} color={colors.accentStrong} />
                ) : (
                  <Ionicons
                    name={s.depth === 0 ? 'chatbubble-outline' : 'git-network-outline'}
                    size={13}
                    color={active ? colors.fg : colors.subtle}
                  />
                )}
                <Text style={[st.tabText, active && { color: colors.fg }]} numberOfLines={1}>
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
            style={st.toBottom}
            onPress={toEnd}
            accessibilityLabel="Ir para o fim"
            testID="scroll-to-bottom"
          >
            <Ionicons name="arrow-down" size={18} color={colors.muted} />
          </Pressable>
        ) : null}
        <View style={[st.footer, { paddingBottom: insets.bottom + 8 }]}>
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
          {!remoteOn ? (
            <HostStateBanner chatId={id} mode={mode} state={state} localTools={localTools} />
          ) : null}
          {remoteOn && handover ? (
            <Strip icon="swap-horizontal-outline" tone="accent" testID="strip-handover">
              {handover.to_name} vai assumir este chat{' '}
              {handover.mode === 'force' ? 'agora' : 'ao fim do turno'}.
            </Strip>
          ) : null}
          {remoteOn && busySubs.length ? (
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
          {remoteOn && sessionError && sessionError !== dismissedError ? (
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
          {remoteOn && question ? (
            <QuestionPanel
              key={question.id}
              request={question}
              onAnswer={(answers) => run(() => remote.answer(id, question.id, answers))}
              onCancel={() => run(() => remote.cancelQuestion(id, question.id))}
            />
          ) : null}
          {remoteOn && !question && retry ? (
            <RetryPanel
              request={retry}
              onDecide={(a) => run(() => remote.retry(id, retry.id, a))}
            />
          ) : null}
          {remoteOn && !question && !retry ? (
            <ApprovalPanel
              approvals={live?.approvals ?? []}
              sessions={sessions}
              viewSessionId={sid}
              onDecide={decideApproval}
              onOpenSession={onOpenSession}
            />
          ) : null}
          {/* o composer fica sempre na mesma posição (o rascunho e os anexos sobrevivem a uma
              queda da conexão — ex.: voltar do seletor de fotos — e ao questionário/retry) */}
          {remoteOn || mode === 'offline' ? (
            <View style={remoteOn && (question || retry) ? st.hidden : undefined}>
              <RemoteComposer
                busy={remoteOn && busy}
                statusText={remoteOn ? statusText : 'Reconectando…'}
                hostName={hostName}
                queue={remoteOn ? queue : []}
                skills={live?.skills ?? []}
                placeholder={
                  view?.session.depth ? 'Mensagem ao subagente…' : `Mensagem para ${hostName}…`
                }
                disabled={remoteOn ? null : 'Sem conexão — reconectando…'}
                onSend={send}
                onStop={() => run(() => remote.stop(id, sid))}
                onQueueForce={(qid) => run(() => remote.queueForce(id, sid, qid))}
                onQueueRemove={(qid) => run(() => remote.queueRemove(id, sid, qid))}
              />
            </View>
          ) : null}
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
        <SheetItem
          icon="create-outline"
          label="Renomear"
          onPress={() => {
            setMenu(false)
            setRenaming(true)
          }}
          testID="chat-action-rename"
        />
        {state?.host ? (
          <SheetItem
            icon={state.pinned ? 'lock-open-outline' : 'lock-closed-outline'}
            label={state.pinned ? 'Desafixar host' : `Fixar host (${state.host.name})`}
            detail="Com o host fixado, assumir o chat em outro aparelho pede confirmação extra."
            disabled={mode === 'offline'}
            onPress={() => {
              setMenu(false)
              const pinned = !state.pinned
              void run(
                () => remote.setPinned(id, pinned),
                pinned ? 'Host fixado' : 'Host desafixado'
              )
            }}
            testID="chat-action-pin"
          />
        ) : null}
        {remoteOn ? (
          <>
            <SheetItem
              icon="folder-open-outline"
              label="Arquivos do host"
              detail={`Navegar e ler arquivos no ${hostName} (somente leitura).`}
              onPress={() => {
                setMenu(false)
                router.push({ pathname: '/files/[chat]', params: { chat: id, path: '' } })
              }}
              testID="chat-action-files"
            />
            {live?.processes.length ? (
              <SheetItem
                icon="pulse-outline"
                label={`Processos (${live.processes.length})`}
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
              onPress={() => {
                setMenu(false)
                void run(() => remote.compact(id, sid), 'Compactação pedida ao host')
              }}
              testID="chat-action-compact"
            />
            <SheetItem
              icon="bookmarks-outline"
              label="Extrair memórias agora"
              onPress={() => {
                setMenu(false)
                void run(() => remote.extractMemory(id, sid), 'Extração iniciada no host')
              }}
              testID="chat-action-memory"
            />
            <SheetItem
              icon="stop-circle-outline"
              label="Parar subagentes"
              disabled={!busySubs.length}
              onPress={() => {
                setMenu(false)
                setConfirmStopSubs(true)
              }}
              testID="chat-action-stop-subagents"
            />
          </>
        ) : null}
        <SheetItem
          icon="trash-outline"
          label="Apagar chat"
          danger
          onPress={() => {
            setMenu(false)
            setDeleting(true)
          }}
          testID="chat-action-delete"
        />
      </Sheet>
      <Sheet
        visible={processes}
        onClose={() => setProcesses(false)}
        title="Processos no host"
        subtitle="Somente leitura — os logs completos ficam no host."
      >
        {(live?.processes ?? []).map((p) => (
          <View key={p.id} style={st.proc} testID="process-row">
            <View style={st.procHead}>
              <View
                style={[
                  st.procDot,
                  { backgroundColor: p.status === 'running' ? colors.success : colors.faint }
                ]}
              />
              <Text style={st.procName} numberOfLines={1}>
                {p.id} · {p.name || p.command}
              </Text>
              <Text style={st.procMeta}>
                {p.status === 'running'
                  ? 'rodando'
                  : `saiu${p.exitCode != null ? ` (${p.exitCode})` : p.signal ? ` (${p.signal})` : ''}`}
              </Text>
            </View>
            <Text style={st.procCmd} numberOfLines={2}>
              {p.command}
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
          onSave={(t) => engine.renameChat(id, t)}
        />
      ) : null}
      <ConfirmDialog
        visible={deleting}
        title="Apagar chat?"
        message={`“${title}” será apagado em todos os seus dispositivos, com todas as mensagens. Não dá para desfazer.`}
        confirmLabel="Apagar"
        destructive
        busy={busyDelete}
        onClose={() => setDeleting(false)}
        onConfirm={() => {
          setBusyDelete(true)
          engine
            .deleteChat(id)
            .then(() => {
              toast('Chat apagado')
              router.back()
            })
            .catch((e: unknown) => toast(describeError(e), 'danger'))
            .finally(() => {
              setBusyDelete(false)
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
  proc: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.elevated,
    padding: 10,
    marginBottom: 8,
    gap: 4
  },
  procHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  procDot: { width: 8, height: 8, borderRadius: 4 },
  procName: { flex: 1, color: colors.fg, fontSize: 14, fontWeight: '500' },
  procMeta: { color: colors.subtle, fontSize: 12 },
  procCmd: { color: colors.muted, fontFamily: 'monospace', fontSize: 12 },
  procLine: { color: colors.faint, fontFamily: 'monospace', fontSize: 11.5 }
})
