// Uma linha da conversa, no visual do MessageList do desktop: balão do usuário (com anexos, "da
// fila"/"enviada agora", voz), resposta do assistente (raciocínio recolhível, Markdown, cards das
// tools, rodapé com modelo/tokens/cache/custo/duração), resumo de compactação, erro, marcadores de
// chamada, mensagens de outros chats/agente pai/irmãos, resultado de subagente, extração de memória.
import Ionicons from '@expo/vector-icons/Ionicons'
import { createContext, memo, useContext, useState, type ReactNode } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import type { SiblingInfo } from '@shared/branches'
import { contentText, messageAttachments, toolContentText } from '@shared/attachments'
import { splitInterChatText } from '@shared/interChat'
import { isSiblingKind, splitSiblingText } from '@shared/siblings'
import type { Session, StoredMessage, StreamDraft } from '@shared/types'
import { callUsageLines, voiceBadgeText } from '@shared/voiceCallMarks'
import { dayLabel } from '@vendor/renderer/dates'
import { CHANGE_LABEL, extractionOf } from '@vendor/renderer/memory'
import { reasoningHeader } from '@vendor/renderer/reasoning'
import { callMarkLabel, readVoiceCallMark } from '@vendor/site/data/voice'
import { colors, font } from '@/ui/theme'
import { MessageAttachments } from './Attachments'
import { formatCost, formatDuration, formatTokens } from './format'
import { Markdown } from './Markdown'
import { EndCallLine, ToolCard, type ToolLive } from './ToolCard'
import type { ToolRun } from '@/remote/mirror'
import type { Row } from './viewModel'
import { BranchSwitcher, CopyButton, DayPill, MonoBlock, MsgTime } from './ui'

export interface RowContext {
  depth: number
  siblings: Map<string, SiblingInfo>
  results: Map<string, StoredMessage>
  childByToolCall: Map<string, Session>
  localOverride: boolean
  now: number
  onSelectBranch: (msgId: string) => void
  onOpenSession: (sessionId: string) => void
  chatTitle: (chatId: string) => string | null
  /** Controle remoto (§8.6, §11): estado ao vivo e ações. Ausente = somente leitura. */
  live?: RowLive
}

export interface RowLive {
  /** Tools rodando na sessão vista (por toolCallId). */
  tools: Record<string, ToolRun>
  /** Tool calls esperando aprovação/resposta (por toolCallId). */
  awaiting: Record<string, 'approval' | 'question'>
  onSmartOverride?: (messageId: string) => void
  /** Toque longo numa mensagem → folha de ações. */
  onLongPress?: (msg: StoredMessage) => void
}

function toolLive(c: RowContext, id: string): ToolLive | undefined {
  if (!c.live) return undefined
  const run = c.live.tools[id]
  const awaiting = c.live.awaiting[id] ?? null
  return run || awaiting ? { run, awaiting } : undefined
}

export const RowCtx = createContext<RowContext | null>(null)
const useRow = (): RowContext => {
  const c = useContext(RowCtx)
  if (!c) throw new Error('RowCtx ausente')
  return c
}

function Switcher({ msg }: { msg: StoredMessage }) {
  const c = useRow()
  const info = c.siblings.get(msg.id)
  if (!info) return null
  return <BranchSwitcher info={info} onSelect={c.onSelectBranch} local={c.localOverride} />
}

function VoiceBadge({ msg, role }: { msg: StoredMessage; role: 'user' | 'assistant' }) {
  const v = msg.meta.voice
  if (!v) return null
  return (
    <View accessibilityLabel={voiceBadgeText(v, role)} testID="voice-badge">
      <Ionicons
        name={role === 'assistant' ? 'volume-medium-outline' : 'mic-outline'}
        size={13}
        color={colors.faint}
        style={v.source === 'dictation' ? { opacity: 0.7 } : undefined}
      />
    </View>
  )
}

// ---------------- usuário ----------------

function OriginLabel({
  icon,
  children
}: {
  icon: React.ComponentProps<typeof Ionicons>['name']
  children: ReactNode
}) {
  return (
    <View style={st.origin}>
      <Ionicons name={icon} size={11} color={colors.accentStrong} />
      <Text style={st.originText} numberOfLines={1}>
        {children}
      </Text>
    </View>
  )
}

function UserMessage({ msg }: { msg: StoredMessage }) {
  const c = useRow()
  const m = msg.message
  const text = m.role === 'user' ? contentText(m.content) : ''
  const atts = m.role === 'user' && Array.isArray(m.content) ? m.content : null
  const hasAtts = messageAttachments(m).length > 0
  const kind = msg.meta.kind
  let origin: ReactNode = null
  let body = text
  let accent = false
  if (kind === 'inter-chat') {
    const t = msg.meta.fromChatId ? c.chatTitle(msg.meta.fromChatId) : null
    origin = (
      <OriginLabel icon="chatbubbles-outline">
        De: {t ?? msg.meta.fromChatTitle ?? 'outro chat'}
        {!t && msg.meta.fromChatId ? ' (chat apagado)' : ''}
        {msg.meta.interChatHops && msg.meta.interChatHops > 1
          ? ` · ${msg.meta.interChatHops}º salto`
          : ''}
      </OriginLabel>
    )
    body = splitInterChatText(text).body
    accent = true
  } else if (kind === 'parent-message') {
    origin = <OriginLabel icon="git-network-outline">Agente pai</OriginLabel>
    body = text.replace(/^\[Mensagem do agente pai\]\n/, '')
    accent = true
  } else if (isSiblingKind(kind)) {
    const sp = splitSiblingText(text)
    origin = (
      <OriginLabel icon={kind === 'sibling-broadcast' ? 'radio-outline' : 'people-outline'}>
        {kind === 'sibling-broadcast' ? 'Broadcast do irmão' : 'Mensagem do irmão'}{' '}
        {sp.title || 'Subagente'}
      </OriginLabel>
    )
    body = sp.body
    accent = true
  } else if (c.depth > 0) {
    origin = <OriginLabel icon="person-outline">Você</OriginLabel>
  }
  return (
    <View style={st.userWrap} testID="msg-user">
      {kind === 'queued' || kind === 'forced' ? (
        <View style={st.origin}>
          {kind === 'forced' ? <Ionicons name="flash" size={11} color={colors.warning} /> : null}
          <Text style={st.queued}>
            {kind === 'forced' ? 'enviada agora (interrompeu o agente)' : 'da fila'}
          </Text>
        </View>
      ) : null}
      {origin}
      {atts ? <MessageAttachments parts={atts} /> : null}
      {body || !hasAtts ? (
        <View style={[st.bubble, accent && st.bubbleAccent]}>
          <Text
            style={[st.bubbleText, msg.meta.voice?.source === 'call' && st.italic]}
            selectable={!c.live?.onLongPress}
          >
            {body}
          </Text>
        </View>
      ) : null}
      <View style={st.bubbleFoot}>
        <Switcher msg={msg} />
        <VoiceBadge msg={msg} role="user" />
        <MsgTime ts={msg.createdAt} />
      </View>
    </View>
  )
}

// ---------------- assistente ----------------

function Reasoning({ msg, text }: { msg: StoredMessage; text: string }) {
  const [open, setOpen] = useState(false)
  const h = reasoningHeader({
    durationMs: msg.meta.reasoningMs,
    tokens: msg.meta.usage?.reasoningTokens
  })
  return (
    <View style={st.reasoning}>
      <Pressable
        onPress={() => setOpen((o) => !o)}
        style={st.reasonHead}
        hitSlop={6}
        testID="reasoning-header"
      >
        <Ionicons name="bulb-outline" size={13} color={colors.subtle} />
        <Text style={st.reasonLabel}>
          {h.label}
          {h.details.map((d) => (
            <Text key={d} style={{ color: colors.faint }}>
              {' · '}
              {d}
            </Text>
          ))}
        </Text>
        <Ionicons
          name={open ? 'chevron-down' : 'chevron-forward'}
          size={12}
          color={colors.subtle}
        />
      </Pressable>
      {open ? (
        <View style={st.reasonBox} testID="reasoning-box">
          <Text style={st.reasonText} selectable>
            {text}
          </Text>
        </View>
      ) : null}
    </View>
  )
}

function UsageFooter({ msg }: { msg: StoredMessage }) {
  const u = msg.meta.usage
  const parts: string[] = []
  if (msg.meta.model) parts.push(msg.meta.model)
  if (u) {
    let t = `${formatTokens(u.promptTokens)} in · ${formatTokens(u.completionTokens)} out`
    if (u.cachedTokens) t += ` · ${formatTokens(u.cachedTokens)} cache`
    if (u.reasoningTokens) t += ` · ${formatTokens(u.reasoningTokens)} raciocínio`
    parts.push(t)
    const cost = formatCost(u.cost)
    if (cost) parts.push(cost)
  }
  const d = formatDuration(msg.meta.durationMs)
  if (d) parts.push(d)
  if (!parts.length) return <View style={{ flex: 1 }} />
  return (
    <View style={st.usage} testID="usage-footer">
      <Ionicons name="hardware-chip-outline" size={11} color={colors.faint} />
      <Text style={st.usageText} numberOfLines={2}>
        {parts.join('  ·  ')}
      </Text>
    </View>
  )
}

function ErrorRow({ text }: { text: string }) {
  return (
    <View style={st.error} testID="msg-error">
      <Ionicons
        name="alert-circle-outline"
        size={14}
        color={colors.danger}
        style={{ marginTop: 1 }}
      />
      <Text style={st.errorText} selectable>
        {text}
      </Text>
    </View>
  )
}

function AssistantMessage({ msg }: { msg: StoredMessage }) {
  const c = useRow()
  if (msg.message.role !== 'assistant') return null
  const m = msg.message
  const content = m.content ?? ''
  return (
    <View style={st.assistant} testID="msg-assistant">
      {m.reasoning ? <Reasoning msg={msg} text={m.reasoning} /> : null}
      {content ? (
        <Markdown
          text={content}
          italic={msg.meta.voice?.source === 'call'}
          selectable={!c.live?.onLongPress}
        />
      ) : null}
      {msg.meta.interrupted ? (
        <View style={st.interrupted}>
          <Ionicons name="close" size={11} color={colors.subtle} />
          <Text style={st.interruptedText}>Interrompida pelo usuário</Text>
        </View>
      ) : null}
      {(m.tool_calls ?? []).map((tc) =>
        tc.function.name === 'end_call' ? (
          <EndCallLine key={tc.id} args={tc.function.arguments} result={c.results.get(tc.id)} />
        ) : (
          <ToolCard
            key={tc.id}
            call={{ id: tc.id, name: tc.function.name, arguments: tc.function.arguments }}
            result={c.results.get(tc.id)}
            subSession={c.childByToolCall.get(tc.id)}
            chatTitle={c.chatTitle}
            onOpenSession={c.onOpenSession}
            live={toolLive(c, tc.id)}
            onSmartOverride={c.live?.onSmartOverride}
          />
        )
      )}
      {msg.meta.error ? <ErrorRow text={msg.meta.error} /> : null}
      <View style={st.assistantFoot}>
        <Switcher msg={msg} />
        <UsageFooter msg={msg} />
        {content ? <CopyButton text={content} label="" compact /> : null}
        <VoiceBadge msg={msg} role="assistant" />
        <MsgTime ts={msg.createdAt} />
      </View>
    </View>
  )
}

// ---------------- cartões e marcadores ----------------

function summaryOf(text: string): string {
  const m = /<conversation_summary>\n?([\s\S]*?)\n?<\/conversation_summary>/.exec(text)
  return (m ? m[1] : text).trim()
}

function CompactionCard({ msg, stale }: { msg: StoredMessage; stale: boolean }) {
  const [open, setOpen] = useState(false)
  const text = msg.message.role === 'user' ? contentText(msg.message.content) : ''
  const summary = summaryOf(text)
  const meta = msg.meta
  const cost = formatCost(meta.compactUsage?.cost)
  return (
    <View style={st.compaction} testID="compaction-card">
      <View style={st.compHead}>
        <Ionicons name="layers-outline" size={14} color={colors.accentStrong} />
        <Text style={st.compTitle}>Resumo da conversa</Text>
        <Text style={st.compSub} numberOfLines={1}>
          · {stale ? 'substituído por um mais recente' : 'início do histórico enviado'}
        </Text>
        <CopyButton text={summary} label="" compact />
      </View>
      <View style={[st.compBody, !open && st.compClamp]}>
        <Markdown text={summary} size={13.5} />
      </View>
      <View style={st.compFoot}>
        <Pressable onPress={() => setOpen((o) => !o)} hitSlop={6}>
          <Text style={st.link}>{open ? 'Recolher' : 'Ver resumo completo'}</Text>
        </Pressable>
        <Text style={st.compMeta} numberOfLines={1}>
          {[
            meta.usageBefore != null &&
              `${formatTokens(meta.usageBefore)} → ~${formatTokens(meta.contextEstimate)} tokens`,
            meta.model,
            cost,
            formatDuration(meta.durationMs)
          ]
            .filter(Boolean)
            .join(' · ')}
        </Text>
      </View>
    </View>
  )
}

function ErrorMessage({ msg }: { msg: StoredMessage }) {
  const text = msg.meta.error ?? contentText(msg.message.content as never) ?? ''
  return (
    <View style={{ paddingVertical: 4 }}>
      <ErrorRow text={text || 'Erro'} />
      <MsgTime ts={msg.createdAt} style={{ alignSelf: 'flex-end', marginTop: 2 }} />
    </View>
  )
}

function CallMarker({ msg }: { msg: StoredMessage }) {
  const [open, setOpen] = useState(false)
  const mark = readVoiceCallMark(msg.meta.voiceCall)
  const label = callMarkLabel(mark, contentText(msg.message.content as never))
  const end = mark?.phase === 'end'
  const lines = end && mark ? callUsageLines(msg.meta.voiceCall!) : []
  return (
    <View style={{ paddingVertical: 10 }} testID="call-marker">
      <Pressable style={st.markerRow} onPress={() => lines.length && setOpen((o) => !o)}>
        <View style={st.markerLine} />
        <View
          style={[
            st.markerPill,
            mark?.endedBy === 'error' && { borderColor: 'rgba(248,113,113,0.4)' }
          ]}
        >
          <Ionicons
            name={end ? 'call-outline' : 'call'}
            size={11}
            color={end ? colors.muted : colors.accentStrong}
          />
          <Text style={st.markerText} numberOfLines={2}>
            {label}
          </Text>
        </View>
        <View style={st.markerLine} />
      </Pressable>
      {open ? (
        <View style={st.markerDetails}>
          {lines.map(([k, v]) => (
            <View key={k} style={{ flexDirection: 'row', gap: 10 }}>
              <Text style={[st.compMeta, { width: 92 }]}>{k}</Text>
              <Text style={[st.compMeta, { color: colors.muted, flex: 1 }]}>{v}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  )
}

function CallbackCard({ msg }: { msg: StoredMessage }) {
  const c = useRow()
  const [open, setOpen] = useState(false)
  const text = msg.message.role === 'user' ? contentText(msg.message.content) : ''
  const nl = text.indexOf('\n')
  const header = (nl === -1 ? text : text.slice(0, nl))
    .replace(/^\[|\]$/g, '')
    .replace(/ \(id [^)]+\)/, '')
  const body = nl === -1 ? '' : text.slice(nl + 1)
  const failed = / (falhou|foi cancelado|não concluiu)$/.test(header)
  const sub = msg.meta.subSessionId
  return (
    <View style={st.callback} testID="subagent-callback">
      <Pressable style={st.callbackHead} onPress={() => setOpen((o) => !o)}>
        <Ionicons name={open ? 'chevron-down' : 'chevron-forward'} size={13} color={colors.faint} />
        <Ionicons
          name="git-network-outline"
          size={14}
          color={failed ? colors.danger : colors.accentStrong}
        />
        <Text style={st.callbackTitle} numberOfLines={1}>
          {header}
        </Text>
        <MsgTime ts={msg.createdAt} />
      </Pressable>
      {body ? (
        <View style={st.callbackBody}>
          {open ? (
            <Markdown text={body} size={13.5} />
          ) : (
            <Text style={st.callbackPreview} numberOfLines={2}>
              {body}
            </Text>
          )}
        </View>
      ) : null}
      {sub ? (
        <Pressable onPress={() => c.onOpenSession(sub)} style={st.callbackOpen}>
          <Ionicons name="arrow-forward" size={12} color={colors.accentStrong} />
          <Text style={st.link}>Abrir subsessão</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

function ExtractionCard({ msg }: { msg: StoredMessage }) {
  const [open, setOpen] = useState(false)
  const r = extractionOf(msg.meta)
  const counts = r
    ? [r.created && `+${r.created}`, r.updated && `~${r.updated}`, r.deleted && `−${r.deleted}`]
        .filter(Boolean)
        .join(' ')
    : ''
  return (
    <View style={st.callback} testID="extraction-card">
      <Pressable style={st.callbackHead} onPress={() => setOpen((o) => !o)}>
        <Ionicons name={open ? 'chevron-down' : 'chevron-forward'} size={13} color={colors.faint} />
        <Ionicons name="bookmarks-outline" size={14} color={colors.accentStrong} />
        <Text style={st.callbackTitle} numberOfLines={1}>
          {r?.error ? 'Extração de memórias falhou' : 'Memórias extraídas'}
          {counts ? <Text style={{ color: colors.subtle }}> · {counts}</Text> : null}
        </Text>
        <MsgTime ts={msg.createdAt} />
      </Pressable>
      {open && r ? (
        <View style={st.callbackBody}>
          {r.error ? <Text style={st.errorText}>{r.error}</Text> : null}
          {r.changes.length ? (
            r.changes.map((ch, i) => (
              <Text key={i} style={st.callbackPreview}>
                <Text style={{ color: colors.subtle }}>{CHANGE_LABEL[ch.op]}: </Text>
                {ch.title}
              </Text>
            ))
          ) : (
            <Text style={st.callbackPreview}>Nada novo para guardar.</Text>
          )}
          {r.model ? (
            <Text style={st.compMeta}>
              {[r.model, formatCost(r.usage?.cost)].filter(Boolean).join(' · ')}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  )
}

function SyntheticMessage({ msg }: { msg: StoredMessage }) {
  const m = msg.message
  const text = m.role === 'assistant' ? (m.content ?? '') : contentText(m.content)
  const isToolResult = /^<tool_result/.test(text)
  return (
    <View style={st.synthetic} testID="msg-synthetic">
      <View style={st.synthLine} />
      <Text style={st.synthLabel}>
        {isToolResult ? 'Resultado de tool (texto)' : 'Mensagem do app'} ·{' '}
        <Text style={{ fontFamily: font.mono }}>{m.role}</Text>
      </Text>
      <Text style={st.synthText} numberOfLines={1}>
        {text}
      </Text>
      <MsgTime ts={msg.createdAt} />
    </View>
  )
}

function OrphanTool({ msg }: { msg: StoredMessage }) {
  const text = msg.message.role === 'tool' ? toolContentText(msg.message.content) : ''
  return (
    <View style={st.callback}>
      <MonoBlock label="Resultado de tool" text={text} />
    </View>
  )
}

function SystemMessage({ msg }: { msg: StoredMessage }) {
  const [open, setOpen] = useState(false)
  const text = msg.message.role === 'system' ? contentText(msg.message.content) : ''
  return (
    <View style={st.callback}>
      <Pressable style={st.callbackHead} onPress={() => setOpen((o) => !o)}>
        <Ionicons name={open ? 'chevron-down' : 'chevron-forward'} size={13} color={colors.faint} />
        <Ionicons name="terminal-outline" size={14} color={colors.subtle} />
        <Text style={st.callbackTitle}>Prompt de sistema</Text>
      </Pressable>
      {open ? <MonoBlock text={text} /> : null}
    </View>
  )
}

// ---------------- ao vivo (controle remoto) ----------------

function DraftReasoning({ text, thinking }: { text: string; thinking: boolean }) {
  const [open, setOpen] = useState(false)
  const tail = text.split('\n').filter(Boolean).slice(-3).join('\n')
  return (
    <View style={st.reasoning}>
      <Pressable onPress={() => setOpen((o) => !o)} style={st.reasonHead} hitSlop={6}>
        {thinking ? (
          <ActivityIndicator size={11} color={colors.subtle} />
        ) : (
          <Ionicons name="bulb-outline" size={13} color={colors.subtle} />
        )}
        <Text style={st.reasonLabel}>{thinking ? 'Pensando…' : 'Raciocínio'}</Text>
        <Ionicons
          name={open ? 'chevron-down' : 'chevron-forward'}
          size={12}
          color={colors.subtle}
        />
      </Pressable>
      {open || thinking ? (
        <View style={st.reasonBox} testID="draft-reasoning">
          <Text style={st.reasonText} numberOfLines={open ? undefined : 3}>
            {open ? text : tail}
          </Text>
        </View>
      ) : null}
    </View>
  )
}

/** Resposta ao vivo do host: raciocínio, texto e tool calls atualizando no lugar (§11). */
export const DraftMessage = memo(function DraftMessage({ draft }: { draft: StreamDraft }) {
  const c = useRow()
  const content = draft.content
  const thinking = !!draft.reasoning && !content && !draft.toolCalls.length
  const empty = !content && !draft.reasoning && !draft.toolCalls.length
  return (
    <View style={st.assistant} testID="msg-draft">
      {draft.reasoning ? <DraftReasoning text={draft.reasoning} thinking={thinking} /> : null}
      {content ? <Markdown text={content} selectable={false} /> : null}
      {draft.toolCalls.map((tc, i) => (
        <ToolCard
          key={tc.id || `i${i}`}
          call={{ id: tc.id, name: tc.name || '…', arguments: tc.arguments }}
          live={toolLive(c, tc.id) ?? { run: { running: true } }}
        />
      ))}
      {empty ? (
        <View style={st.typing} testID="draft-typing">
          <ActivityIndicator size={12} color={colors.accentStrong} />
          <Text style={st.typingText}>Gerando resposta…</Text>
        </View>
      ) : null}
    </View>
  )
})

function SendingRow({ text, files }: { text: string; files: number }) {
  return (
    <View style={[st.userWrap, { opacity: 0.6 }]} testID="msg-sending">
      {text ? (
        <View style={st.bubble}>
          <Text style={st.bubbleText}>{text}</Text>
        </View>
      ) : null}
      <View style={st.bubbleFoot}>
        <ActivityIndicator size={10} color={colors.subtle} />
        <Text style={st.queued}>
          enviando…{files ? ` · ${files} ${files === 1 ? 'anexo' : 'anexos'}` : ''}
        </Text>
      </View>
    </View>
  )
}

function MessageBody({ msg, old }: { msg: StoredMessage; old: boolean }) {
  const c = useRow()
  const role = msg.message.role
  const kind = msg.meta.kind
  if (kind === 'memory-extraction') return <ExtractionCard msg={msg} />
  if (kind === 'compaction') return <CompactionCard msg={msg} stale={old} />
  if (kind === 'error') return <ErrorMessage msg={msg} />
  if (kind === 'voice-call') return <CallMarker msg={msg} />
  if (role === 'user' && kind === 'subagent-callback') return <CallbackCard msg={msg} />
  if (
    role === 'user' &&
    (kind === 'inter-chat' || kind === 'parent-message' || isSiblingKind(kind))
  )
    return <UserMessage msg={msg} />
  if (msg.meta.synthetic && role !== 'assistant') {
    if (role === 'tool' && c.results.get(msg.message.tool_call_id) === msg) return null
    return <SyntheticMessage msg={msg} />
  }
  if (role === 'user') return <UserMessage msg={msg} />
  if (role === 'assistant') return <AssistantMessage msg={msg} />
  if (role === 'tool') {
    if (c.results.get(msg.message.tool_call_id) === msg) return null
    return <OrphanTool msg={msg} />
  }
  return <SystemMessage msg={msg} />
}

/** Uma linha da lista (memo: só re-renderiza quando a mensagem/estado dela muda). */
export const MessageRow = memo(function MessageRow({
  row,
  onToggleOld
}: {
  row: Row
  onToggleOld: () => void
}) {
  const c = useRow()
  if (row.kind === 'draft')
    return (
      <View style={st.row}>
        <DraftMessage draft={row.draft} />
      </View>
    )
  if (row.kind === 'sending')
    return (
      <View style={st.row}>
        <SendingRow text={row.text} files={row.files} />
      </View>
    )
  if (row.kind === 'divider')
    return (
      <View style={st.divider} testID="compaction-divider">
        <View style={st.markerLine} />
        <Ionicons name="layers-outline" size={13} color={colors.accentStrong} />
        <Text style={st.dividerText}>
          Conversa compactada · {row.count}{' '}
          {row.count === 1 ? 'mensagem resumida' : 'mensagens resumidas'}
        </Text>
        <Pressable onPress={onToggleOld} hitSlop={8}>
          <Text style={st.link}>{row.showOld ? 'Ocultar' : 'Mostrar'}</Text>
        </Pressable>
        <View style={st.markerLine} />
      </View>
    )
  const { msg } = row
  const info = row.switcherAbove ? c.siblings.get(msg.id) : undefined
  const onLong = c.live?.onLongPress
  if (onLong)
    return (
      <Pressable
        onLongPress={() => onLong(msg)}
        delayLongPress={320}
        style={({ pressed }) => [
          st.row,
          row.old && { opacity: 0.55 },
          pressed && { backgroundColor: 'rgba(255,255,255,0.025)' }
        ]}
        testID={`row-${msg.id}`}
      >
        {row.dayStart ? <DayPill label={dayLabel(msg.createdAt, c.now)} /> : null}
        {info ? (
          <View style={{ flexDirection: 'row', paddingTop: 4 }}>
            <BranchSwitcher info={info} onSelect={c.onSelectBranch} local={c.localOverride} />
          </View>
        ) : null}
        <MessageBody msg={msg} old={row.old} />
      </Pressable>
    )
  return (
    <View style={[st.row, row.old && { opacity: 0.55 }]}>
      {row.dayStart ? <DayPill label={dayLabel(msg.createdAt, c.now)} /> : null}
      {info ? (
        <View style={{ flexDirection: 'row', paddingTop: 4 }}>
          <BranchSwitcher info={info} onSelect={c.onSelectBranch} local={c.localOverride} />
        </View>
      ) : null}
      <MessageBody msg={msg} old={row.old} />
    </View>
  )
})

const st = StyleSheet.create({
  row: { paddingHorizontal: 16 },
  italic: { fontStyle: 'italic' },
  userWrap: { alignItems: 'flex-end', gap: 5, paddingVertical: 6 },
  bubble: {
    maxWidth: '88%',
    borderRadius: 18,
    borderBottomRightRadius: 6,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.elevated,
    paddingHorizontal: 14,
    paddingVertical: 9
  },
  bubbleAccent: { borderColor: 'rgba(167,139,250,0.3)', backgroundColor: 'rgba(139,92,246,0.1)' },
  bubbleText: { color: colors.fg, fontSize: 15, lineHeight: 22 },
  bubbleFoot: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 22,
    paddingRight: 2
  },
  origin: { flexDirection: 'row', alignItems: 'center', gap: 4, maxWidth: '88%' },
  originText: { color: 'rgba(167,139,250,0.9)', fontSize: 11, fontWeight: '500' },
  queued: { color: colors.subtle, fontSize: 11 },
  assistant: { paddingVertical: 6 },
  assistantFoot: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 26,
    marginTop: 4
  },
  usage: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 5 },
  usageText: { flex: 1, color: colors.faint, fontSize: 11, fontVariant: ['tabular-nums'] },
  reasoning: { marginBottom: 6 },
  reasonHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    paddingVertical: 3
  },
  reasonLabel: { color: colors.subtle, fontSize: 12.5 },
  reasonBox: {
    marginTop: 6,
    paddingLeft: 12,
    borderLeftWidth: 2,
    borderLeftColor: colors.borderStrong
  },
  reasonText: { color: colors.subtle, fontSize: 13, lineHeight: 20 },
  interrupted: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'flex-start',
    marginTop: 6,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    backgroundColor: 'rgba(255,255,255,0.04)'
  },
  interruptedText: { color: colors.subtle, fontSize: 11 },
  error: {
    flexDirection: 'row',
    gap: 8,
    marginVertical: 6,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(248,113,113,0.25)',
    backgroundColor: 'rgba(248,113,113,0.06)',
    paddingHorizontal: 12,
    paddingVertical: 9
  },
  errorText: { flex: 1, color: colors.danger, fontFamily: font.mono, fontSize: 12, lineHeight: 18 },
  compaction: {
    marginVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(139,92,246,0.25)',
    backgroundColor: 'rgba(139,92,246,0.05)',
    overflow: 'hidden'
  },
  compHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingLeft: 12,
    paddingRight: 4,
    paddingTop: 8
  },
  compTitle: { color: 'rgba(230,230,234,0.9)', fontSize: 13, fontWeight: '500' },
  compSub: { flex: 1, color: colors.subtle, fontSize: 11.5 },
  compBody: { paddingHorizontal: 12 },
  compClamp: { maxHeight: 132, overflow: 'hidden' },
  compFoot: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 8
  },
  compMeta: { flex: 1, color: colors.faint, fontSize: 11, textAlign: 'right' },
  link: { color: colors.accentStrong, fontSize: 12.5 },
  markerRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  markerLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  markerPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    maxWidth: '78%',
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: 'rgba(23,23,30,0.9)',
    paddingHorizontal: 10,
    paddingVertical: 3
  },
  markerText: { flexShrink: 1, color: colors.muted, fontSize: 11, textAlign: 'center' },
  markerDetails: { marginTop: 8, marginHorizontal: 24, gap: 3 },
  callback: {
    marginVertical: 6,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: 'rgba(16,16,21,0.7)',
    overflow: 'hidden'
  },
  callbackHead: {
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 11
  },
  callbackTitle: { flex: 1, color: 'rgba(230,230,234,0.9)', fontSize: 13 },
  callbackBody: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 4
  },
  callbackPreview: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  callbackOpen: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 12,
    paddingBottom: 9
  },
  synthetic: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingVertical: 6 },
  synthLine: { width: 14, height: 1, backgroundColor: colors.borderStrong },
  synthLabel: { color: colors.subtle, fontSize: 12, flexShrink: 0 },
  synthText: { flex: 1, color: colors.faint, fontFamily: font.mono, fontSize: 11 },
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 16,
    paddingVertical: 14
  },
  dividerText: { color: colors.subtle, fontSize: 11.5, flexShrink: 1 },
  typing: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 },
  typingText: { color: colors.subtle, fontSize: 13 }
})
