// Card de uma tool call (como o do desktop): ícone, nome, resumo dos argumentos, tamanho do
// resultado e selo de status; toque abre argumentos + resultado (com copiar). Faixas fixas: negada
// (motivo), delegate_task (tarefa + abrir subsessão), send_to_chat, questionário (perguntas e
// respostas) e mídia devolvida (read_file de imagem/PDF). Somente leitura nesta fase.
import Ionicons from '@expo/vector-icons/Ionicons'
import { memo, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { toolContentText } from '@shared/attachments'
import { approxTokens } from '@shared/limits'
import { TOOL_LABELS } from '@shared/tools'
import type { AskUserRecord, ContentPart, Session, StoredMessage, ToolName } from '@shared/types'
import { approvalOutcome, type ApprovalOutcome } from '@vendor/renderer/approvalOutcome'
import type { ToolRun } from '@/remote/mirror'
import type { IconName } from '@/ui/Button'
import { colors, font } from '@/ui/theme'
import { FileChip, ImageThumb } from './Attachments'
import { formatTokens } from './format'
import { parseArgs, prettyJson, toolIcon, toolSummary } from './toolSummary'
import { Collapsible, MonoBlock } from './ui'

type Status = 'ok' | 'error' | 'denied' | 'cancelled' | 'pending'

const STATUS: Record<Status, { label: string; color: string; icon: IconName | null }> = {
  ok: { label: 'ok', color: 'rgba(74,222,128,0.9)', icon: 'checkmark' },
  error: { label: 'erro', color: colors.danger, icon: 'close-circle-outline' },
  denied: { label: 'negada', color: 'rgba(248,113,113,0.9)', icon: 'ban-outline' },
  cancelled: { label: 'interrompida', color: colors.subtle, icon: 'ban-outline' },
  pending: { label: 'sem resultado', color: colors.faint, icon: null }
}

const BY_TEXT: Record<string, string> = {
  lists: 'whitelist',
  smart: 'Smart-Approve',
  user: 'você',
  readonly: 'leitura (sempre liberada)',
  edits: 'aceitar edições na raiz',
  denied: 'você negou',
  blocked: 'blacklist'
}

function OutcomeDetails({ outcome }: { outcome: ApprovalOutcome }) {
  const approved = outcome.kind === 'approved'
  return (
    <View style={st.outcome} testID="approval-details">
      <View style={st.row}>
        <Ionicons
          name={approved ? 'shield-checkmark-outline' : 'shield-outline'}
          size={14}
          color={approved ? 'rgba(74,222,128,0.9)' : 'rgba(248,113,113,0.9)'}
        />
        <Text
          style={[
            st.outcomeTitle,
            { color: approved ? 'rgba(74,222,128,0.9)' : 'rgba(248,113,113,0.9)' }
          ]}
        >
          {outcome.title}
        </Text>
      </View>
      {outcome.reason ? <Text style={st.reason}>{outcome.reason}</Text> : null}
      {outcome.items.map((it, i) => (
        <View key={i} style={[st.row, { alignItems: 'flex-start' }]}>
          <Ionicons
            name={it.by === 'denied' || it.by === 'blocked' ? 'ban-outline' : 'checkmark'}
            size={12}
            color={it.by === 'denied' || it.by === 'blocked' ? colors.danger : colors.success}
            style={{ marginTop: 2 }}
          />
          <Text style={st.itemCode}>{it.text}</Text>
          <Text style={st.itemBy}>
            {BY_TEXT[it.by] ?? it.by}
            {it.detail ? (it.by === 'user' ? ` · ${it.detail}` : ` “${it.detail}”`) : ''}
          </Text>
        </View>
      ))}
      {outcome.protectedPath ? (
        <Text style={[st.reason, { color: colors.warning }]}>
          Perguntou porque toca um caminho protegido: {outcome.protectedPath}
        </Text>
      ) : null}
    </View>
  )
}

function AskUserBody({
  args,
  result
}: {
  args: Record<string, unknown> | null
  result?: StoredMessage
}) {
  const rec = result?.meta.askUser as AskUserRecord | undefined
  const raw = (Array.isArray(args?.questions) ? args.questions : []) as { title?: unknown }[]
  const titles = rec
    ? rec.questions
    : raw.map((q, i) => ({
        title: typeof q?.title === 'string' ? q.title : `Pergunta ${i + 1}`,
        options: []
      }))
  if (rec?.outcome === 'answered' && rec.answers)
    return (
      <View style={st.band} testID="ask-answers">
        {rec.questions.map((q, i) => {
          const a = rec.answers?.[i] ?? { selected: [] }
          return (
            <View key={i} style={{ gap: 5 }}>
              <Text style={st.q}>
                <Text style={st.qn}>{i + 1}. </Text>
                {q.title}
              </Text>
              <View style={st.answers}>
                {a.selected.map((n) => (
                  <View key={n} style={st.answer}>
                    <Text style={st.answerText}>{q.options[n]?.title ?? `opção ${n + 1}`}</Text>
                  </View>
                ))}
                {a.other ? (
                  <View style={st.answer}>
                    <Text style={st.answerText}>
                      <Text style={{ color: colors.subtle }}>Outro: </Text>
                      {a.other}
                    </Text>
                  </View>
                ) : null}
              </View>
            </View>
          )
        })}
        {rec.notes?.length ? <Text style={st.reason}>{rec.notes.join(' ')}</Text> : null}
      </View>
    )
  if (!result)
    return (
      <View style={st.band}>
        {titles.map((q, i) => (
          <Text key={i} style={st.q}>
            <Text style={st.qn}>{i + 1}. </Text>
            {q.title}
          </Text>
        ))}
      </View>
    )
  return (
    <View style={st.band}>
      <Text style={st.reason}>
        Não respondido
        {rec?.outcome === 'app-closed' ? ' — o app foi fechado com o questionário aberto.' : '.'}
      </Text>
      {titles.map((q, i) => (
        <Text key={i} style={st.q}>
          <Text style={st.qn}>{i + 1}. </Text>
          {q.title}
        </Text>
      ))}
    </View>
  )
}

/** Estado ao vivo de uma tool call (controle remoto, §11). */
export interface ToolLive {
  run?: ToolRun
  awaiting?: 'approval' | 'question' | null
}

export const ToolCard = memo(function ToolCard({
  call,
  result,
  subSession,
  chatTitle,
  onOpenSession,
  live,
  onSmartOverride
}: {
  call: { id: string; name: string; arguments: string }
  result?: StoredMessage
  /** Subsessão criada por este delegate_task. */
  subSession?: Session
  /** Título de outro chat (send_to_chat). */
  chatTitle?: (id: string) => string | null
  onOpenSession?: (sessionId: string) => void
  live?: ToolLive
  /** "Executar mesmo assim" depois de uma rejeição do Smart-Approve (comando smart_override). */
  onSmartOverride?: (messageId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [overriding, setOverriding] = useState(false)
  const [details, setDetails] = useState(false)
  const args = parseArgs(call.arguments)
  const name = call.name
  const label = TOOL_LABELS[name as ToolName] ?? name
  const isDelegate = name === 'delegate_task'
  const resultText =
    result && result.message.role === 'tool' ? toolContentText(result.message.content) : ''
  const media: ContentPart[] =
    result && result.message.role === 'tool' && Array.isArray(result.message.content)
      ? result.message.content.filter((p) => p._attachment)
      : []
  const status: Status = result ? (result.meta.toolStatus ?? 'ok') : 'pending'
  const outcome = result ? approvalOutcome(result.meta) : null
  let sum = toolSummary(name, args)
  const targetId =
    name === 'send_to_chat'
      ? (result?.meta.targetChatId ?? (typeof args?.chat_id === 'string' ? args.chat_id : ''))
      : ''
  const target = targetId ? chatTitle?.(targetId) : null
  if (target)
    sum = [`→ ${target}`, args?.wait_for_reply === true && 'aguarda resposta']
      .filter(Boolean)
      .join(' · ')
  const subId = result?.meta.subSessionId ?? subSession?.id
  const S = STATUS[status] ?? STATUS.ok

  const smart = result?.meta.smartApprove
  const liveChip =
    !result && live?.awaiting === 'approval'
      ? {
          text: 'aguardando aprovação',
          color: colors.warning,
          spin: false,
          icon: 'hand-left-outline' as IconName
        }
      : !result && live?.awaiting === 'question'
        ? {
            text: 'aguardando resposta',
            color: colors.accentStrong,
            spin: false,
            icon: 'help-circle-outline' as IconName
          }
        : !result && live?.run?.judging
          ? { text: 'Smart-Approve avaliando', color: colors.info, spin: true, icon: null }
          : !result && live?.run
            ? { text: 'executando', color: colors.accentStrong, spin: true, icon: null }
            : null
  const chip = liveChip ? (
    <View style={st.chip} testID="tool-live-status">
      {liveChip.spin ? (
        <ActivityIndicator size={10} color={liveChip.color} />
      ) : liveChip.icon ? (
        <Ionicons name={liveChip.icon} size={12} color={liveChip.color} />
      ) : null}
      <Text style={[st.chipText, { color: liveChip.color }]}>{liveChip.text}</Text>
    </View>
  ) : (
    <Pressable
      disabled={!outcome}
      onPress={() => setDetails((d) => !d)}
      hitSlop={6}
      style={st.chip}
      testID="tool-status"
      accessibilityLabel={outcome ? `${outcome.title} — detalhes` : S.label}
    >
      {S.icon ? <Ionicons name={S.icon} size={12} color={S.color} /> : null}
      <Text style={[st.chipText, { color: S.color }]}>{S.label}</Text>
      {outcome?.kind === 'approved' ? (
        <Ionicons name="shield-checkmark-outline" size={11} color={S.color} />
      ) : null}
    </Pressable>
  )

  const below = (
    <>
      {smart?.decision === 'reject' && result ? (
        <View style={st.smart} testID="smart-reject">
          <Ionicons name="shield-outline" size={13} color={colors.danger} />
          <Text style={st.smartText} numberOfLines={3}>
            Negado pelo Smart-Approve{smart.reason ? ` — ${smart.reason}` : ''}
          </Text>
          {smart.overridden ? (
            <Text style={st.smartDone}>Liberado · o agente pode repetir uma vez</Text>
          ) : onSmartOverride ? (
            <Pressable
              testID="smart-override"
              disabled={overriding}
              onPress={() => {
                setOverriding(true)
                onSmartOverride(result.id)
                setTimeout(() => setOverriding(false), 4000)
              }}
              style={({ pressed }) => [st.smartBtn, pressed && { backgroundColor: colors.hover }]}
            >
              {overriding ? (
                <ActivityIndicator size={12} color={colors.fg} />
              ) : (
                <Text style={st.smartBtnText}>Executar mesmo assim</Text>
              )}
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {outcome?.kind === 'denied' ? (
        <Pressable onPress={() => setDetails((d) => !d)} style={st.denied} testID="tool-denied">
          <Ionicons name="ban-outline" size={13} color={colors.danger} />
          <Text style={st.deniedText} numberOfLines={details ? undefined : 1}>
            {outcome.title}
            {outcome.reason ? ` — ${outcome.reason}` : ''}
          </Text>
        </Pressable>
      ) : null}
      {details && outcome ? <OutcomeDetails outcome={outcome} /> : null}
      {isDelegate ? (
        <View style={st.band}>
          <Text style={st.task} numberOfLines={3}>
            {typeof args?.task === 'string' ? args.task : ''}
          </Text>
          <View style={st.row}>
            {result?.meta.background === true || args?.background === true ? (
              <View style={st.bg}>
                <Text style={st.bgText}>em segundo plano</Text>
              </View>
            ) : null}
            {subSession?.model ? (
              <Text style={st.model} numberOfLines={1}>
                {subSession.model}
              </Text>
            ) : (
              <View style={{ flex: 1 }} />
            )}
            {subId && onOpenSession ? (
              <Pressable
                onPress={() => onOpenSession(subId)}
                style={st.openBtn}
                testID="open-subsession"
              >
                <Ionicons name="arrow-forward" size={13} color={colors.accentStrong} />
                <Text style={st.openText}>Abrir subsessão</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      ) : null}
      {name === 'send_to_chat' ? (
        <View style={st.band}>
          <Text style={st.task} numberOfLines={3}>
            {typeof args?.message === 'string' ? args.message : ''}
          </Text>
          {args?.wait_for_reply === true && status === 'ok' ? (
            <Text style={st.reply} numberOfLines={5}>
              {resultText.replace(/^Resposta do chat [^\n]*:\n\n/, '')}
            </Text>
          ) : null}
        </View>
      ) : null}
      {name === 'ask_user' ? <AskUserBody args={args} result={result} /> : null}
      {media.length ? (
        <View style={[st.band, st.media]}>
          {media.map((p, i) => {
            const m = p._attachment!
            return m.kind === 'image' ? (
              <ImageThumb key={i} file={m.file} name={m.name} mime={m.mime} size={m.size} />
            ) : (
              <FileChip key={i} meta={m} />
            )
          })}
        </View>
      ) : null}
    </>
  )

  return (
    <Collapsible
      testID={isDelegate ? 'delegate-card' : 'tool-card'}
      icon={toolIcon(name)}
      iconColor={isDelegate ? colors.accentStrong : colors.muted}
      title={label}
      summary={sum}
      open={open}
      onToggle={() => setOpen((o) => !o)}
      tone={status === 'error' && isDelegate ? 'danger' : undefined}
      right={
        <View style={st.right}>
          {result ? (
            <Text style={st.size}>
              ~{formatTokens(approxTokens(resultText.length))} tok{media.length ? ' + mídia' : ''}
            </Text>
          ) : null}
          {chip}
        </View>
      }
      below={below}
    >
      <MonoBlock label="Argumentos" text={prettyJson(call.arguments)} testID="tool-args" />
      {!result && live?.run?.output ? (
        <MonoBlock label="Saída ao vivo" text={live.run.output} testID="tool-live-output" />
      ) : null}
      {result ? (
        <MonoBlock
          label={`Resultado · ${resultText.length.toLocaleString('pt-BR')} caracteres`}
          text={resultText}
          testID="tool-result"
        />
      ) : live?.run || live?.awaiting ? null : (
        <Text style={[st.reason, { padding: 12 }]}>Sem resultado registrado.</Text>
      )}
    </Collapsible>
  )
})

/** `end_call` (chamada de voz encerrada pelo agente): linha compacta, sem card. */
export function EndCallLine({ args, result }: { args: string; result?: StoredMessage }) {
  const a = parseArgs(args)
  const reason = typeof a?.reason === 'string' ? a.reason.trim() : ''
  const failed = !!result && result.meta.toolStatus !== 'ok'
  return (
    <View style={[st.row, { marginTop: 6 }]} testID="end-call-line">
      <Ionicons name="call-outline" size={12} color={colors.subtle} />
      <Text style={st.endCall} numberOfLines={1}>
        {failed
          ? 'Encerrar chamada: não executado'
          : result
            ? 'Chamada encerrada pelo agente'
            : 'Encerrando a chamada…'}
        {reason ? <Text style={{ color: colors.faint }}> · {reason}</Text> : null}
      </Text>
    </View>
  )
}

const st = StyleSheet.create({
  smart: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: 'rgba(248,113,113,0.04)'
  },
  smartText: { flex: 1, minWidth: 160, color: colors.muted, fontSize: 12.5, lineHeight: 18 },
  smartDone: { color: colors.subtle, fontSize: 11.5 },
  smartBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.elevated,
    minWidth: 60,
    alignItems: 'center'
  },
  smartBtnText: { color: colors.fg, fontSize: 12.5, fontWeight: '500' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  right: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0 },
  size: { color: colors.faint, fontSize: 10.5, fontVariant: ['tabular-nums'] },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingVertical: 2 },
  chipText: { fontSize: 11 },
  band: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingHorizontal: 12,
    paddingVertical: 9,
    gap: 7
  },
  media: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  task: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  reply: {
    color: 'rgba(230,230,234,0.85)',
    fontSize: 13,
    lineHeight: 19,
    backgroundColor: 'rgba(11,11,15,0.6)',
    borderRadius: 8,
    padding: 9
  },
  model: { flex: 1, color: colors.faint, fontSize: 11.5, fontFamily: font.mono },
  bg: {
    backgroundColor: colors.accentSoft,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2
  },
  bgText: { color: colors.accentStrong, fontSize: 10.5, fontWeight: '500' },
  openBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.elevated
  },
  openText: { color: colors.fg, fontSize: 12.5 },
  denied: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(248,113,113,0.2)',
    backgroundColor: 'rgba(248,113,113,0.05)'
  },
  deniedText: { flex: 1, color: 'rgba(248,113,113,0.9)', fontSize: 12.5 },
  outcome: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingHorizontal: 12,
    paddingVertical: 9,
    gap: 6
  },
  outcomeTitle: { fontSize: 12.5, fontWeight: '500' },
  reason: { color: colors.subtle, fontSize: 12, lineHeight: 17 },
  itemCode: { flex: 1, color: 'rgba(230,230,234,0.85)', fontFamily: font.mono, fontSize: 11.5 },
  itemBy: { color: 'rgba(74,222,128,0.9)', fontSize: 10.5, maxWidth: '40%' },
  q: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  qn: { color: colors.faint },
  answers: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingLeft: 14 },
  answer: {
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.elevated,
    paddingHorizontal: 8,
    paddingVertical: 3
  },
  answerText: { color: 'rgba(230,230,234,0.92)', fontSize: 12.5 },
  endCall: { flex: 1, color: colors.subtle, fontSize: 12, fontStyle: 'italic' }
})
