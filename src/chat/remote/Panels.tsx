// Cards interativos do controle remoto (SYNC_PROTOCOL.md §8.6), no visual do desktop e pensados
// para o polegar: aprovação (simples ou por item no modo Listas, com o veredito do Smart-Approve),
// questionário do ask_user (passo a passo, ícones/imagens/ajuda, múltipla escolha, "Outro") e falha
// de conexão (tentar de novo / cancelar). Ficam acima do composer (questionário e retry no lugar
// dele, como no desktop); vibração ao permitir/negar.
import Ionicons from '@expo/vector-icons/Ionicons'
import * as Haptics from 'expo-haptics'
import { Image } from 'expo-image'
import { Fragment, useState, type ReactNode } from 'react'
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native'
import {
  isListItem,
  ITEM_LABEL,
  ITEM_TOOL,
  type ApprovalItemDecision
} from '@shared/approvalPolicy'
import { parseAttachmentUrl } from '@shared/attachments'
import { groupHeadings } from '@shared/shellParse'
import { categoryLabel } from '@shared/smartApprove'
import { TOOL_LABELS } from '@shared/tools'
import type {
  ApprovalRequest,
  AskUserHelp,
  AskUserIcon,
  AskUserOption,
  QuestionAnswer,
  QuestionRequest,
  RetryRequest,
  Session,
  SmartApproveRecord,
  ToolName
} from '@shared/types'
import { formatCost, formatDuration } from '@/chat/format'
import { toolSummary } from '@/chat/toolSummary'
import { sessionLabel } from '@/chat/viewModel'
import { useAttachment } from '@/data/react'
import type { IconName } from '@/ui/Button'
import { Sheet } from '@/ui/Sheet'
import { colors, font, radius } from '@/ui/theme'

const haptic = (kind: 'allow' | 'deny'): void => {
  void (
    kind === 'allow'
      ? Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
      : Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy)
  ).catch(() => undefined)
}

function Btn({
  label,
  onPress,
  variant = 'secondary',
  icon,
  disabled,
  loading,
  testID,
  flex
}: {
  label: string
  onPress: () => void
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost'
  icon?: IconName
  disabled?: boolean
  loading?: boolean
  testID?: string
  flex?: boolean
}) {
  const v = BTN[variant]
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled || loading}
      onPress={onPress}
      style={({ pressed }) => [
        p.btn,
        { backgroundColor: pressed ? v.pressed : v.bg, borderColor: v.border },
        flex && { flex: 1 },
        (disabled || loading) && { opacity: 0.5 }
      ]}
    >
      {loading ? (
        <ActivityIndicator size={14} color={v.fg} />
      ) : icon ? (
        <Ionicons name={icon} size={16} color={v.fg} />
      ) : null}
      <Text style={[p.btnText, { color: v.fg }]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  )
}

const BTN = {
  primary: { bg: colors.accent, pressed: '#7c4ee6', fg: '#fff', border: colors.accent },
  secondary: {
    bg: colors.elevated,
    pressed: colors.active,
    fg: colors.fg,
    border: colors.borderStrong
  },
  danger: {
    bg: colors.dangerSoft,
    pressed: 'rgba(248,113,113,0.2)',
    fg: colors.danger,
    border: 'rgba(248,113,113,0.35)'
  },
  ghost: { bg: 'transparent', pressed: colors.hover, fg: colors.muted, border: 'transparent' }
}

// ---------------- Smart-Approve ----------------

const FALLBACK_LABEL: Record<NonNullable<SmartApproveRecord['fallback']>, string> = {
  timeout: 'tempo esgotado',
  error: 'erro na chamada',
  ambiguous: 'resposta ambígua'
}

export function SmartVerdict({ rec }: { rec: SmartApproveRecord }) {
  const head =
    rec.decision === 'approve'
      ? {
          icon: 'shield-checkmark-outline' as IconName,
          text: 'Liberado pelo Smart-Approve',
          c: colors.success
        }
      : rec.decision === 'reject'
        ? {
            icon: 'shield-outline' as IconName,
            text: 'Negado pelo Smart-Approve',
            c: colors.danger
          }
        : rec.fallback
          ? {
              icon: 'alert-circle-outline' as IconName,
              text: `Smart-Approve não decidiu (${FALLBACK_LABEL[rec.fallback]})`,
              c: colors.warning
            }
          : {
              icon: 'help-circle-outline' as IconName,
              text: 'Smart-Approve sugeriu perguntar',
              c: colors.warning
            }
  const reason = (rec.fallback ? rec.error : rec.reason) ?? ''
  const meta = [rec.model, formatCost(rec.usage?.cost), formatDuration(rec.durationMs)]
    .filter(Boolean)
    .join(' · ')
  return (
    <View style={p.smart} testID="smart-verdict">
      <View style={p.row}>
        <Ionicons name={head.icon} size={14} color={head.c} />
        <Text style={[p.smartHead, { color: head.c }]} numberOfLines={1}>
          {head.text}
        </Text>
        {rec.category ? (
          <View style={p.tag}>
            <Text style={p.tagText}>{categoryLabel(rec.category)}</Text>
          </View>
        ) : null}
        {rec.wouldReject ? (
          <View style={[p.tag, { backgroundColor: colors.warningSoft }]}>
            <Text style={[p.tagText, { color: colors.warning }]}>teria negado</Text>
          </View>
        ) : null}
      </View>
      {meta ? (
        <Text style={p.smartMeta} numberOfLines={1}>
          {meta}
        </Text>
      ) : null}
      {reason ? (
        <Text style={p.smartReason} numberOfLines={4}>
          {reason}
        </Text>
      ) : null}
    </View>
  )
}

// ---------------- aprovações ----------------

type Choice = { allow: boolean; pattern?: string }

export function ApprovalPanel({
  approvals,
  sessions,
  viewSessionId,
  onDecide,
  onOpenSession
}: {
  approvals: ApprovalRequest[]
  sessions: Session[]
  viewSessionId: string
  onDecide: (
    req: ApprovalRequest,
    decision: 'allow' | 'deny',
    items?: ApprovalItemDecision[]
  ) => Promise<boolean>
  onOpenSession: (sessionId: string) => void
}) {
  const [sel, setSel] = useState<{ id: string; index: number }>({ id: '', index: 0 })
  if (!approvals.length) return null
  const found = approvals.findIndex((a) => a.id === sel.id)
  const index = found >= 0 ? found : Math.min(sel.index, approvals.length - 1)
  const cur = approvals[index]
  const go = (i: number) => setSel({ id: approvals[i].id, index: i })
  const sub = sessions.find((s) => s.id === cur.sessionId)
  const fromSub = !!sub && sub.depth > 0
  return (
    <View style={[p.card, p.cardWarn]} testID="approval-panel">
      <View style={p.row}>
        <Ionicons name="hand-left-outline" size={15} color={colors.warning} />
        <Text style={p.kicker} numberOfLines={1}>
          {fromSub ? `Subagente “${sessionLabel(sub!)}”` : 'Aprovação pendente'}
        </Text>
        {approvals.length > 1 ? (
          <View style={p.pager}>
            <Pressable
              hitSlop={8}
              disabled={index === 0}
              onPress={() => go(index - 1)}
              style={{ opacity: index === 0 ? 0.3 : 1 }}
              accessibilityLabel="Aprovação anterior"
            >
              <Ionicons name="chevron-back" size={16} color={colors.muted} />
            </Pressable>
            <Text style={p.pagerText} testID="approval-pager">
              {index + 1} de {approvals.length}
            </Text>
            <Pressable
              hitSlop={8}
              disabled={index === approvals.length - 1}
              onPress={() => go(index + 1)}
              style={{ opacity: index === approvals.length - 1 ? 0.3 : 1 }}
              accessibilityLabel="Próxima aprovação"
            >
              <Ionicons name="chevron-forward" size={16} color={colors.muted} />
            </Pressable>
          </View>
        ) : null}
        {fromSub && cur.sessionId !== viewSessionId ? (
          <Pressable hitSlop={8} onPress={() => onOpenSession(cur.sessionId)}>
            <Text style={p.link}>Abrir</Text>
          </Pressable>
        ) : null}
      </View>
      {cur.check && isListItem(cur.check.item) ? (
        <ListsPrompt
          key={cur.id}
          request={cur}
          who={fromSub ? 'o subagente' : 'o agente'}
          onDecide={onDecide}
        />
      ) : (
        <SimplePrompt
          key={cur.id}
          request={cur}
          who={fromSub ? 'o subagente' : 'o agente'}
          onDecide={onDecide}
        />
      )}
    </View>
  )
}

function argsText(r: ApprovalRequest): string {
  const args = r.args && typeof r.args === 'object' ? (r.args as Record<string, unknown>) : null
  const sum = toolSummary(r.toolName, args)
  if (sum) return sum
  try {
    return JSON.stringify(r.args, null, 2)
  } catch {
    return ''
  }
}

function Notes({ request }: { request: ApprovalRequest }) {
  return (
    <>
      {request.protectedPath ? (
        <View style={[p.row, { alignItems: 'flex-start' }]} testID="approval-protected">
          <Ionicons
            name="lock-closed-outline"
            size={13}
            color={colors.warning}
            style={{ marginTop: 2 }}
          />
          <Text style={p.note}>
            <Text style={{ fontWeight: '600' }}>caminho protegido</Text>: {request.protectedPath} —
            sempre pergunta.
          </Text>
        </View>
      ) : null}
      {request.smartMissing ? (
        <Text style={p.note}>
          Smart-Approve sem modelo configurado no host — por isso a pergunta.
        </Text>
      ) : null}
      {request.smartApprove ? <SmartVerdict rec={request.smartApprove} /> : null}
    </>
  )
}

function SimplePrompt({
  request,
  who,
  onDecide
}: {
  request: ApprovalRequest
  who: string
  onDecide: (r: ApprovalRequest, d: 'allow' | 'deny') => Promise<boolean>
}) {
  const [busy, setBusy] = useState<'allow' | 'deny' | null>(null)
  const [full, setFull] = useState(false)
  const label = TOOL_LABELS[request.toolName as ToolName] ?? request.toolName
  const text = argsText(request)
  const decide = async (d: 'allow' | 'deny') => {
    haptic(d)
    setBusy(d)
    if (!(await onDecide(request, d))) setBusy(null)
  }
  return (
    <>
      <Text style={p.question}>
        Permitir que {who} use <Text style={p.mono}>{label}</Text>?
      </Text>
      {text ? (
        <Pressable onPress={() => setFull(true)} style={p.pre} testID="approval-args">
          <Text style={p.preText} numberOfLines={6}>
            {text}
          </Text>
        </Pressable>
      ) : null}
      <Notes request={request} />
      <View style={p.actions}>
        <Btn
          label="Negar"
          icon="close"
          variant="secondary"
          flex
          loading={busy === 'deny'}
          disabled={!!busy}
          onPress={() => void decide('deny')}
          testID="approval-deny"
        />
        <Btn
          label="Permitir"
          icon="checkmark"
          variant="primary"
          flex
          loading={busy === 'allow'}
          disabled={!!busy}
          onPress={() => void decide('allow')}
          testID="approval-allow"
        />
      </View>
      <Sheet visible={full} onClose={() => setFull(false)} title={`Argumentos de ${label}`}>
        <Text style={[p.preText, { padding: 8 }]} selectable>
          {(() => {
            try {
              return JSON.stringify(request.args, null, 2)
            } catch {
              return text
            }
          })()}
        </Text>
      </Sheet>
    </>
  )
}

function ListsPrompt({
  request,
  who,
  onDecide
}: {
  request: ApprovalRequest
  who: string
  onDecide: (
    r: ApprovalRequest,
    d: 'allow' | 'deny',
    items?: ApprovalItemDecision[]
  ) => Promise<boolean>
}) {
  const check = request.check!
  const item = check.item as 'commands' | 'processes' | 'pages'
  const items = check.items
  const [choices, setChoices] = useState<Record<number, Choice>>({})
  const [editing, setEditing] = useState<{ index: number; list: 'allow' | 'deny' } | null>(null)
  const [pattern, setPattern] = useState('')
  const [menu, setMenu] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const pending = items
    .map((it, index) => ({ it, index }))
    .filter(({ it }) => it.verdict !== 'allow')
  const heads = groupHeadings(items)

  const submit = async (next: Record<number, Choice>) => {
    const decided = pending.filter(({ index }) => next[index])
    const anyNo = decided.some(({ index }) => !next[index].allow)
    // envia quando todos decidiram — ou já no primeiro "Não" (nada vai rodar mesmo)
    if (!anyNo && decided.length < pending.length) return
    const list: ApprovalItemDecision[] = decided.map(({ index }) => ({
      index,
      allow: next[index].allow,
      ...(next[index].pattern ? { pattern: next[index].pattern } : {})
    }))
    haptic(anyNo ? 'deny' : 'allow')
    setBusy(true)
    if (!(await onDecide(request, anyNo ? 'deny' : 'allow', list))) setBusy(false)
  }
  const decide = (index: number, c: Choice) => {
    const next = { ...choices, [index]: c }
    setChoices(next)
    setEditing(null)
    setMenu(null)
    void submit(next)
  }
  const multi = items.length > 1
  return (
    <>
      <Text style={p.question}>
        {item === 'pages'
          ? `Permitir que ${who} abra esta página?`
          : multi
            ? `Permitir que ${who} execute estes ${items.length} sub-comandos?`
            : `Permitir que ${who} execute este comando?`}
      </Text>
      <Text style={p.meta}>
        {ITEM_LABEL[item]} · {request.smartApprove ? 'listas + Smart-Approve' : 'listas'} ·{' '}
        <Text style={p.mono}>{ITEM_TOOL[item]}</Text>
      </Text>
      {request.smartApprove ? <SmartVerdict rec={request.smartApprove} /> : null}
      <ScrollView style={{ maxHeight: 230 }} nestedScrollEnabled>
        <View style={{ gap: 6 }}>
          {items.map((it, index) => {
            const c = choices[index]
            const indent = { marginLeft: (it.depth ?? 0) * 12 }
            return (
              <Fragment key={index}>
                {heads[index] ? (
                  <Text style={[p.group, indent]} testID="approval-group">
                    ↳ {heads[index]}
                  </Text>
                ) : null}
                <View
                  testID="approval-sub"
                  style={[
                    p.sub,
                    indent,
                    it.verdict === 'allow'
                      ? { borderColor: 'rgba(74,222,128,0.22)' }
                      : c
                        ? {
                            borderColor: c.allow ? 'rgba(74,222,128,0.3)' : 'rgba(248,113,113,0.35)'
                          }
                        : null
                  ]}
                >
                  <Text style={p.subCode} selectable>
                    {it.text || '(vazio)'}
                  </Text>
                  {it.protectedPath ? (
                    <Text style={[p.note, { color: colors.danger }]}>
                      caminho protegido: {it.protectedPath}
                    </Text>
                  ) : null}
                  {(it.note && it.note !== it.group) || it.reason ? (
                    <Text style={p.note}>
                      {[
                        it.note !== it.group && it.note,
                        it.reason && `pergunta sempre: ${it.reason}`
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </Text>
                  ) : null}
                  {it.script?.content ? (
                    <Text style={p.script} numberOfLines={6}>
                      {it.script.content}
                    </Text>
                  ) : null}
                  {it.verdict === 'allow' ? (
                    <Text style={p.ok}>
                      ✓{' '}
                      {it.readOnly
                        ? 'leitura (sempre liberada)'
                        : `liberado pela lista “${it.entry}”`}
                    </Text>
                  ) : c ? (
                    <View style={p.row}>
                      <Text style={[p.ok, !c.allow && { color: colors.danger }]}>
                        {c.allow ? '✓ Sim' : '✕ Não'}
                        {c.pattern
                          ? ` + ${c.allow ? 'whitelist' : 'blacklist'} “${c.pattern}”`
                          : ''}
                      </Text>
                      {!busy ? (
                        <Pressable
                          hitSlop={8}
                          onPress={() => {
                            const n = { ...choices }
                            delete n[index]
                            setChoices(n)
                          }}
                        >
                          <Text style={p.link}>desfazer</Text>
                        </Pressable>
                      ) : null}
                    </View>
                  ) : (
                    <View style={p.subActions}>
                      <Btn
                        label="Não"
                        variant="secondary"
                        flex
                        disabled={busy}
                        onPress={() => decide(index, { allow: false })}
                        testID={`approval-sub-no-${index}`}
                      />
                      <Btn
                        label="Sim"
                        variant="primary"
                        flex
                        disabled={busy}
                        onPress={() => decide(index, { allow: true })}
                        testID={`approval-sub-yes-${index}`}
                      />
                      <Pressable
                        hitSlop={6}
                        disabled={busy}
                        onPress={() => setMenu(index)}
                        style={p.more}
                        accessibilityLabel="Mais opções (listas)"
                        testID={`approval-sub-more-${index}`}
                      >
                        <Ionicons name="ellipsis-horizontal" size={18} color={colors.muted} />
                      </Pressable>
                    </View>
                  )}
                </View>
              </Fragment>
            )
          })}
        </View>
      </ScrollView>
      {pending.length > 1 ? (
        <View style={p.actions}>
          <Btn
            label="Negar"
            icon="close"
            flex
            disabled={busy}
            onPress={() => {
              const first = pending.find(({ index }) => !choices[index])
              if (first) decide(first.index, { allow: false })
            }}
            testID="approval-deny"
          />
          <Btn
            label="Sim para todos"
            icon="shield-checkmark-outline"
            variant="primary"
            flex
            loading={busy}
            onPress={() => {
              const next = { ...choices }
              for (const { index } of pending) next[index] ??= { allow: true }
              setChoices(next)
              void submit(next)
            }}
            testID="approval-allow-all"
          />
        </View>
      ) : null}
      <Text style={p.hint}>
        {pending.length > 1
          ? 'Executa só quando todos forem “Sim”; qualquer “Não” cancela tudo.'
          : '“⋯” salva um padrão nas listas globais do host.'}
      </Text>
      <Sheet
        visible={menu !== null && !editing}
        onClose={() => setMenu(null)}
        title="Decidir e salvar na lista"
        subtitle={menu !== null ? items[menu]?.text : undefined}
      >
        {menu !== null ? (
          <View style={{ gap: 8, padding: 4 }}>
            <Btn
              label="Sim + whitelist"
              icon="checkmark-done-outline"
              disabled={!!items[menu].reason || !items[menu].suggestion}
              onPress={() => {
                setPattern(items[menu].suggestion)
                setEditing({ index: menu, list: 'allow' })
              }}
            />
            {items[menu].reason ? (
              <Text style={p.hint}>Este sub-comando nunca é liberado automaticamente.</Text>
            ) : null}
            <Btn
              label="Não + blacklist"
              icon="ban-outline"
              variant="danger"
              disabled={!items[menu].suggestion}
              onPress={() => {
                setPattern(items[menu].suggestion)
                setEditing({ index: menu, list: 'deny' })
              }}
            />
          </View>
        ) : null}
      </Sheet>
      <Sheet
        visible={!!editing}
        onClose={() => setEditing(null)}
        title={editing?.list === 'allow' ? 'Padrão da whitelist' : 'Padrão da blacklist'}
        subtitle="Vale para todos os chats do host (Configurações → Aprovações)."
        footer={
          <>
            <Btn label="Cancelar" flex onPress={() => setEditing(null)} />
            <Btn
              label={editing?.list === 'allow' ? 'Permitir e salvar' : 'Negar e salvar'}
              variant={editing?.list === 'allow' ? 'primary' : 'danger'}
              flex
              disabled={!pattern.trim()}
              onPress={() =>
                editing &&
                decide(editing.index, { allow: editing.list === 'allow', pattern: pattern.trim() })
              }
            />
          </>
        }
      >
        <TextInput
          value={pattern}
          onChangeText={setPattern}
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          style={p.input}
          placeholderTextColor={colors.faint}
        />
      </Sheet>
    </>
  )
}

// ---------------- questionário (ask_user) ----------------

/** Ícones lucide mais comuns → Ionicons (nome desconhecido = sem ícone, como no desktop). */
const LUCIDE: Record<string, IconName> = {
  check: 'checkmark',
  x: 'close',
  star: 'star-outline',
  heart: 'heart-outline',
  zap: 'flash-outline',
  rocket: 'rocket-outline',
  code: 'code-slash-outline',
  'code-2': 'code-slash-outline',
  terminal: 'terminal-outline',
  database: 'server-outline',
  server: 'server-outline',
  cloud: 'cloud-outline',
  globe: 'globe-outline',
  lock: 'lock-closed-outline',
  unlock: 'lock-open-outline',
  shield: 'shield-outline',
  'shield-check': 'shield-checkmark-outline',
  settings: 'settings-outline',
  wrench: 'construct-outline',
  hammer: 'hammer-outline',
  folder: 'folder-outline',
  file: 'document-outline',
  'file-text': 'document-text-outline',
  image: 'image-outline',
  camera: 'camera-outline',
  music: 'musical-notes-outline',
  video: 'videocam-outline',
  mail: 'mail-outline',
  phone: 'call-outline',
  smartphone: 'phone-portrait-outline',
  laptop: 'laptop-outline',
  monitor: 'desktop-outline',
  user: 'person-outline',
  users: 'people-outline',
  calendar: 'calendar-outline',
  clock: 'time-outline',
  search: 'search-outline',
  sparkles: 'sparkles-outline',
  lightbulb: 'bulb-outline',
  brain: 'bulb-outline',
  book: 'book-outline',
  'book-open': 'book-outline',
  pencil: 'pencil-outline',
  pen: 'pencil-outline',
  trash: 'trash-outline',
  'trash-2': 'trash-outline',
  download: 'download-outline',
  upload: 'cloud-upload-outline',
  play: 'play-outline',
  pause: 'pause-outline',
  'refresh-cw': 'refresh-outline',
  'git-branch': 'git-branch-outline',
  github: 'logo-github',
  package: 'cube-outline',
  box: 'cube-outline',
  layers: 'layers-outline',
  'bar-chart': 'bar-chart-outline',
  'chart-bar': 'bar-chart-outline',
  'trending-up': 'trending-up-outline',
  'dollar-sign': 'cash-outline',
  'shopping-cart': 'cart-outline',
  home: 'home-outline',
  map: 'map-outline',
  'map-pin': 'location-outline',
  sun: 'sunny-outline',
  moon: 'moon-outline',
  flag: 'flag-outline',
  bell: 'notifications-outline',
  'thumbs-up': 'thumbs-up-outline',
  'thumbs-down': 'thumbs-down-outline',
  'alert-triangle': 'warning-outline',
  info: 'information-circle-outline',
  'help-circle': 'help-circle-outline',
  palette: 'color-palette-outline',
  leaf: 'leaf-outline',
  coffee: 'cafe-outline',
  gamepad: 'game-controller-outline',
  'gamepad-2': 'game-controller-outline',
  cpu: 'hardware-chip-outline',
  wifi: 'wifi-outline',
  battery: 'battery-half-outline',
  key: 'key-outline',
  link: 'link-outline',
  list: 'list-outline',
  'message-square': 'chatbox-outline',
  'message-circle': 'chatbubble-outline'
}

function StoreImage({ url, size, style }: { url: string; size?: number; style?: object }) {
  const file = parseAttachmentUrl(url)
  const a = useAttachment(file, true)
  if (!a.uri)
    return (
      <View
        style={[
          { width: size, height: size, alignItems: 'center', justifyContent: 'center' },
          style
        ]}
      >
        {a.loading ? <ActivityIndicator size={10} color={colors.subtle} /> : null}
      </View>
    )
  return (
    <Image
      source={{ uri: a.uri }}
      style={[{ width: size, height: size }, style]}
      contentFit="contain"
    />
  )
}

function OptionIcon({ icon }: { icon?: AskUserIcon }) {
  if (!icon) return null
  if (icon.kind === 'lucide') {
    const n = LUCIDE[icon.name]
    return n ? <Ionicons name={n} size={19} color={colors.accentStrong} /> : null
  }
  if (icon.kind === 'text') return <Text style={{ fontSize: 17 }}>{icon.text}</Text>
  return <StoreImage url={icon.url} size={22} style={{ borderRadius: 4 }} />
}

interface QDraft {
  selected: number[]
  otherOn: boolean
  other: string
}
const answered = (d: QDraft): boolean => d.selected.length > 0 || (d.otherOn && !!d.other.trim())

export function QuestionPanel({
  request,
  onAnswer,
  onCancel
}: {
  request: QuestionRequest
  onAnswer: (answers: QuestionAnswer[]) => Promise<boolean>
  onCancel: () => Promise<boolean>
}) {
  const qs = request.questions
  const [step, setStep] = useState(0)
  const [drafts, setDrafts] = useState<QDraft[]>(() =>
    qs.map(() => ({ selected: [], otherOn: false, other: '' }))
  )
  const [sending, setSending] = useState<'send' | 'cancel' | null>(null)
  const [help, setHelp] = useState<AskUserHelp | null>(null)
  const [big, setBig] = useState<string | null>(null)
  const q = qs[Math.min(step, qs.length - 1)]
  const d = drafts[step] ?? { selected: [], otherOn: false, other: '' }
  const last = step >= qs.length - 1
  if (!q) return null
  const patch = (fn: (x: QDraft) => QDraft) =>
    setDrafts((all) => all.map((x, i) => (i === step ? fn(x) : x)))
  const toggle = (i: number) => {
    void Haptics.selectionAsync().catch(() => undefined)
    patch((x) =>
      q.multiple
        ? {
            ...x,
            selected: x.selected.includes(i)
              ? x.selected.filter((n) => n !== i)
              : [...x.selected, i].sort((a, b) => a - b)
          }
        : { ...x, selected: [i], otherOn: false }
    )
  }
  const toggleOther = () =>
    patch((x) =>
      q.multiple ? { ...x, otherOn: !x.otherOn } : { ...x, selected: [], otherOn: true }
    )
  const submit = async () => {
    if (sending || !drafts.every(answered)) return
    const answers: QuestionAnswer[] = drafts.map((x) => {
      const other = x.otherOn ? x.other.trim() : ''
      return other ? { selected: x.selected, other } : { selected: x.selected }
    })
    setSending('send')
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined)
    if (!(await onAnswer(answers))) setSending(null)
  }
  const cancel = async () => {
    setSending('cancel')
    if (!(await onCancel())) setSending(null)
  }
  const box = (checked: boolean) => (
    <View
      style={[
        p.box,
        q.multiple ? { borderRadius: 5 } : { borderRadius: 9 },
        checked && { backgroundColor: colors.accent, borderColor: colors.accent }
      ]}
    >
      {checked ? (
        q.multiple ? (
          <Ionicons name="checkmark" size={12} color="#fff" />
        ) : (
          <View style={p.dotIn} />
        )
      ) : null}
    </View>
  )
  return (
    <View style={[p.card, p.cardAccent]} testID="question-panel">
      <View style={p.row}>
        <Text style={[p.kicker, { color: colors.accentStrong }]}>Pergunta do agente</Text>
        {qs.length > 1 ? (
          <Text style={p.pagerText} testID="ask-step">
            {step + 1}/{qs.length}
          </Text>
        ) : null}
        <Text style={p.meta}>{q.multiple ? '· marque uma ou mais' : '· escolha uma'}</Text>
        <View style={{ flex: 1 }} />
        <Pressable
          hitSlop={8}
          onPress={() => void cancel()}
          disabled={!!sending}
          testID="ask-cancel"
          accessibilityLabel="Cancelar questionário"
          style={p.row}
        >
          {sending === 'cancel' ? (
            <ActivityIndicator size={12} color={colors.subtle} />
          ) : (
            <Ionicons name="close" size={14} color={colors.subtle} />
          )}
          <Text style={p.meta}>Cancelar</Text>
        </Pressable>
      </View>
      <Text style={p.qTitle}>{q.title}</Text>
      {q.description ? <Text style={p.qDesc}>{q.description}</Text> : null}
      <ScrollView
        style={{ maxHeight: 300 }}
        nestedScrollEnabled
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ gap: 6 }}>
          {q.options.map((o: AskUserOption, i) => {
            const checked = d.selected.includes(i)
            return (
              <Pressable
                key={`${step}-${i}`}
                onPress={() => toggle(i)}
                accessibilityRole={q.multiple ? 'checkbox' : 'radio'}
                accessibilityState={{ checked }}
                testID={`ask-option-${i}`}
                style={[p.option, checked && p.optionOn]}
              >
                {box(checked)}
                <OptionIcon icon={o.icon} />
                <View style={{ flex: 1 }}>
                  <Text style={p.optTitle}>{o.title}</Text>
                  {o.description ? <Text style={p.optDesc}>{o.description}</Text> : null}
                </View>
                {o.image ? (
                  <Pressable
                    onPress={() => setBig(o.image!)}
                    hitSlop={6}
                    accessibilityLabel="Ver imagem"
                  >
                    <StoreImage url={o.image} size={40} style={{ borderRadius: 6 }} />
                  </Pressable>
                ) : null}
                {o.help ? (
                  <Pressable
                    onPress={() => setHelp(o.help!)}
                    hitSlop={8}
                    accessibilityLabel="Ajuda sobre esta opção"
                    testID={`ask-help-${i}`}
                  >
                    <Ionicons name="help-circle-outline" size={20} color={colors.subtle} />
                  </Pressable>
                ) : null}
              </Pressable>
            )
          })}
          <Pressable
            onPress={() => {
              if (!d.otherOn || q.multiple) toggleOther()
            }}
            accessibilityRole={q.multiple ? 'checkbox' : 'radio'}
            accessibilityState={{ checked: d.otherOn }}
            testID="ask-other"
            style={[
              p.option,
              d.otherOn && p.optionOn,
              { flexDirection: 'column', alignItems: 'stretch' }
            ]}
          >
            <View style={[p.row, { gap: 10 }]}>
              {box(d.otherOn)}
              <Ionicons name="create-outline" size={18} color={colors.subtle} />
              <Text style={[p.optTitle, { flex: 1 }]}>Outro</Text>
            </View>
            {d.otherOn ? (
              <TextInput
                testID="ask-other-text"
                value={d.other}
                onChangeText={(v) => patch((x) => ({ ...x, other: v.slice(0, 4000) }))}
                placeholder="Escreva sua resposta (ou por que não quer responder)…"
                placeholderTextColor={colors.faint}
                multiline
                autoFocus
                style={[p.input, { marginTop: 8, minHeight: 60 }]}
              />
            ) : null}
          </Pressable>
        </View>
      </ScrollView>
      {request.notes?.length ? (
        <Text style={p.hint}>
          {request.notes.length === 1
            ? '1 imagem não pôde ser carregada.'
            : `${request.notes.length} imagens não puderam ser carregadas.`}
        </Text>
      ) : null}
      <View style={p.actions}>
        {step > 0 ? (
          <Btn
            label="Voltar"
            icon="chevron-back"
            variant="ghost"
            onPress={() => setStep((s) => s - 1)}
          />
        ) : null}
        <View style={{ flex: 1 }} />
        {last ? (
          <Btn
            label="Enviar respostas"
            icon="send"
            variant="primary"
            disabled={!drafts.every(answered) || sending === 'cancel'}
            loading={sending === 'send'}
            onPress={() => void submit()}
            testID="ask-submit"
          />
        ) : (
          <Btn
            label="Próximo"
            variant="primary"
            disabled={!answered(d)}
            onPress={() => setStep((s) => s + 1)}
            testID="ask-next"
          />
        )}
      </View>
      <Sheet visible={!!help} onClose={() => setHelp(null)} title="Ajuda">
        {help?.kind === 'image' ? (
          <StoreImage url={help.url} size={320} style={{ alignSelf: 'center', borderRadius: 8 }} />
        ) : help ? (
          <ScrollView horizontal>
            <Text style={[p.preText, { padding: 8 }]} selectable>
              {help.text}
            </Text>
          </ScrollView>
        ) : null}
      </Sheet>
      <Sheet visible={!!big} onClose={() => setBig(null)} title="Imagem da opção">
        {big ? (
          <StoreImage url={big} size={340} style={{ alignSelf: 'center', borderRadius: 8 }} />
        ) : null}
      </Sheet>
    </View>
  )
}

// ---------------- falha de conexão ----------------

export function RetryPanel({
  request,
  onDecide
}: {
  request: RetryRequest
  onDecide: (action: 'retry' | 'cancel') => Promise<boolean>
}) {
  const [busy, setBusy] = useState<'retry' | 'cancel' | null>(null)
  const go = async (a: 'retry' | 'cancel') => {
    setBusy(a)
    if (!(await onDecide(a))) setBusy(null)
  }
  return (
    <View style={[p.card, p.cardWarn]} testID="retry-panel">
      <View style={[p.row, { alignItems: 'flex-start', gap: 10 }]}>
        <Ionicons
          name="cloud-offline-outline"
          size={18}
          color={colors.warning}
          style={{ marginTop: 1 }}
        />
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={p.qTitle}>Falha de conexão com o provedor</Text>
          <Text style={p.preText} numberOfLines={3} testID="retry-error">
            {request.error}
          </Text>
          <Text style={p.hint}>
            {request.providerName ? `${request.providerName} · ` : ''}
            {request.model} · a resposta parcial foi descartada; tentar de novo repete a chamada do
            zero.
          </Text>
        </View>
      </View>
      <View style={p.actions}>
        <Btn
          label="Cancelar"
          icon="close"
          flex
          loading={busy === 'cancel'}
          disabled={!!busy}
          onPress={() => void go('cancel')}
          testID="retry-cancel"
        />
        <Btn
          label="Tentar de novo"
          icon="refresh"
          variant="primary"
          flex
          loading={busy === 'retry'}
          disabled={!!busy}
          onPress={() => void go('retry')}
          testID="retry-retry"
        />
      </View>
    </View>
  )
}

/** Faixa genérica acima do composer (subagentes, aviso, etc.). */
export function Strip({
  icon,
  tone = 'muted',
  children,
  action,
  testID
}: {
  icon: IconName
  tone?: 'muted' | 'warning' | 'danger' | 'accent'
  children: ReactNode
  action?: ReactNode
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
    <View style={p.strip} testID={testID}>
      <Ionicons name={icon} size={14} color={c} />
      <Text style={[p.stripText, { color: tone === 'muted' ? colors.muted : c }]} numberOfLines={2}>
        {children}
      </Text>
      {action}
    </View>
  )
}

const p = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  card: {
    marginHorizontal: 10,
    marginBottom: 8,
    borderRadius: radius.lg,
    borderWidth: 1,
    padding: 12,
    gap: 8,
    backgroundColor: colors.elevated
  },
  cardWarn: { borderColor: 'rgba(245,181,68,0.32)', backgroundColor: '#1a1712' },
  cardAccent: { borderColor: colors.accentBorder, backgroundColor: '#16131f' },
  kicker: { color: colors.warning, fontSize: 12, fontWeight: '600', flexShrink: 1 },
  pager: { flexDirection: 'row', alignItems: 'center', gap: 6, marginLeft: 'auto' },
  pagerText: { color: colors.subtle, fontSize: 12, fontVariant: ['tabular-nums'] },
  link: { color: colors.accentStrong, fontSize: 12.5, fontWeight: '500' },
  question: { color: colors.fg, fontSize: 15, lineHeight: 21, fontWeight: '500' },
  meta: { color: colors.subtle, fontSize: 11.5 },
  mono: { fontFamily: font.mono, color: colors.codeInline },
  pre: {
    borderRadius: 10,
    backgroundColor: colors.codeBg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 10,
    paddingVertical: 8
  },
  preText: { color: colors.fg, fontFamily: font.mono, fontSize: 12.5, lineHeight: 18 },
  note: { flex: 1, color: colors.muted, fontSize: 12, lineHeight: 17 },
  hint: { color: colors.faint, fontSize: 11.5, lineHeight: 16 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 2 },
  btn: {
    height: 44,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7
  },
  btnText: { fontSize: 14.5, fontWeight: '600' },
  smart: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: 'rgba(0,0,0,0.25)',
    padding: 9,
    gap: 3
  },
  smartHead: { fontSize: 12.5, fontWeight: '600', flexShrink: 1 },
  smartMeta: { color: colors.faint, fontSize: 11, fontFamily: font.mono },
  smartReason: { color: colors.muted, fontSize: 12.5, lineHeight: 18 },
  tag: { borderRadius: 5, paddingHorizontal: 6, paddingVertical: 1, backgroundColor: colors.hover },
  tagText: { color: colors.muted, fontSize: 10.5 },
  group: { color: colors.subtle, fontSize: 11, fontWeight: '500' },
  sub: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: 'rgba(0,0,0,0.25)',
    padding: 9,
    gap: 6
  },
  subCode: { color: colors.fg, fontFamily: font.mono, fontSize: 12.5 },
  subActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  more: {
    width: 44,
    height: 44,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center'
  },
  script: {
    color: colors.muted,
    fontFamily: font.mono,
    fontSize: 11,
    backgroundColor: colors.codeBg,
    padding: 6,
    borderRadius: 6
  },
  ok: { color: colors.success, fontSize: 12 },
  input: {
    color: colors.fg,
    fontSize: 15,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: colors.bg
  },
  qTitle: { color: colors.fg, fontSize: 15.5, fontWeight: '600', lineHeight: 21 },
  qDesc: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: 'rgba(0,0,0,0.2)',
    paddingHorizontal: 12,
    paddingVertical: 11,
    minHeight: 48
  },
  optionOn: { borderColor: 'rgba(139,92,246,0.6)', backgroundColor: 'rgba(139,92,246,0.12)' },
  optTitle: { color: colors.fg, fontSize: 14.5, lineHeight: 20 },
  optDesc: { color: colors.subtle, fontSize: 12.5, lineHeight: 17, marginTop: 1 },
  box: {
    width: 18,
    height: 18,
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center'
  },
  dotIn: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#fff' },
  strip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 10,
    marginBottom: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface
  },
  stripText: { flex: 1, fontSize: 12.5, lineHeight: 17 }
})
