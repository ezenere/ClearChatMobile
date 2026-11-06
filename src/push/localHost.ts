// Avisos locais dos chats executados NESTE celular (SYNC_PROTOCOL.md §22.1, não normativo): sem
// servidor — o próprio app mostra aprovação/pergunta/nova tentativa/resposta/erro com o mesmo código
// de exibição dos avisos push, quando está em segundo plano. Hoje o host do celular para o turno ao
// ir para o segundo plano (fase 4a): o caso real é o aviso de "turno interrompido" (`onBackground`);
// os demais cobrem eventos que chegam com o app fora da tela antes da parada (e um futuro host em
// segundo plano).
import type { AgentEvent, SessionStatus } from '@shared/types'
import { approvalText, plainExcerpt, questionText, retryText } from '@shared/push'
import {
  buildNotification,
  type ContentKind,
  type PushPrefs,
  type ShownNotification
} from './model'

export interface LocalHostDeps {
  /** Eventos do runner do celular. */
  subscribe: (fn: (e: AgentEvent) => void) => () => void
  /** App fora da tela? */
  isBackground: () => boolean
  prefs: () => PushPrefs
  show: (n: ShownNotification) => void
  dismiss: (id: string) => void
  chatTitle: (chatId: string) => string
  hostName: () => string
}

const BUSY: SessionStatus[] = ['running', 'awaiting_approval', 'awaiting_input', 'awaiting_retry']

const CATEGORY: Record<ContentKind, keyof PushPrefs> = {
  approval: 'pending',
  question: 'pending',
  retry: 'pending',
  reply: 'reply',
  error: 'error'
}

/** Identificadores próprios (não colidem com as tags de 32 hex dos avisos push). */
const tagOf = (chatId: string, what: string): string => `local-${chatId}-${what}`

const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .map((p) =>
            p && typeof p === 'object' && (p as { type?: unknown }).type === 'text'
              ? String((p as { text?: unknown }).text ?? '')
              : ''
          )
          .join(' ')
      : ''

interface Pending {
  chatId: string
  kind: 'approval' | 'question' | 'retry'
  text: string
  shown: string | null
}

export class LocalHostNotifier {
  private pending = new Map<string, Pending>()
  private status = new Map<string, SessionStatus>()
  private main = new Map<string, string>()
  private lastReply = new Map<string, string>()
  private lastError = new Map<string, string>()
  private off: (() => void) | null = null
  /** Avisos locais na bandeja (somem quando o app volta à tela). */
  private shown = new Set<string>()

  constructor(private readonly d: LocalHostDeps) {}

  start(): void {
    if (!this.off) this.off = this.d.subscribe((e) => this.onEvent(e))
  }

  stop(): void {
    this.off?.()
    this.off = null
  }

  private notify(
    kind: ContentKind,
    chatId: string,
    text: string,
    tag: string,
    appText = false
  ): ShownNotification | null {
    const prefs = this.d.prefs()
    if (!prefs.enabled || !prefs[CATEGORY[kind]]) return null
    const n = buildNotification(
      tag,
      { kind, chatId, chatTitle: this.d.chatTitle(chatId), text, hostName: this.d.hostName() },
      prefs,
      appText
    )
    this.d.show(n)
    this.shown.add(n.id)
    return n
  }

  onEvent(e: AgentEvent): void {
    switch (e.type) {
      case 'approval-requested':
        this.addPending(e.request.id, e.request.chatId, 'approval', approvalText(e.request))
        return
      case 'question-requested':
        this.addPending(e.request.id, e.request.chatId, 'question', questionText(e.request))
        return
      case 'retry-requested':
        this.addPending(e.request.id, e.request.chatId, 'retry', retryText(e.request))
        return
      case 'approval-resolved':
      case 'question-resolved':
      case 'retry-resolved': {
        const p = this.pending.get(e.id)
        this.pending.delete(e.id)
        if (p?.shown) {
          this.d.dismiss(p.shown)
          this.shown.delete(p.shown)
        }
        return
      }
      case 'message-added': {
        const m = e.message.message
        if (m.role === 'assistant') {
          const t = plainExcerpt(textOf(m.content))
          if (t) this.lastReply.set(e.message.sessionId, t)
        }
        return
      }
      case 'error':
        this.lastError.set(e.sessionId, e.error)
        return
      case 'session-created':
      case 'session-updated': {
        const s = e.session
        if (s.parentSessionId !== null) return
        this.main.set(s.id, s.chatId)
        const prev = this.status.get(s.id)
        this.status.set(s.id, s.status)
        if (!prev || !BUSY.includes(prev) || BUSY.includes(s.status)) return
        if (s.status === 'running') return
        const reply = this.lastReply.get(s.id) ?? ''
        const error = this.lastError.get(s.id) ?? ''
        this.lastReply.delete(s.id)
        this.lastError.delete(s.id)
        if (!this.d.isBackground()) return
        if (s.status === 'idle' || s.status === 'done') {
          if (reply) this.notify('reply', s.chatId, reply, tagOf(s.chatId, 'turn'))
        } else if (s.status === 'error') {
          this.notify('error', s.chatId, error, tagOf(s.chatId, 'turn'))
        }
        return
      }
      default:
        return
    }
  }

  private addPending(id: string, chatId: string, kind: Pending['kind'], text: string): void {
    const p: Pending = { chatId, kind, text, shown: null }
    this.pending.set(id, p)
    if (this.d.isBackground())
      p.shown = this.notify(kind, chatId, text, tagOf(chatId, id))?.id ?? null
  }

  /**
   * O app foi para o segundo plano com turnos deste celular em andamento (o host vai pará-los):
   * um aviso por chat, para o usuário saber que precisa voltar. Chamar ANTES de parar os turnos.
   */
  onBackground(busyChats: Iterable<string>): void {
    for (const chatId of busyChats) {
      const waiting = [...this.pending.values()].find((p) => p.chatId === chatId)
      const why = waiting
        ? waiting.kind === 'approval'
          ? ' Havia uma aprovação esperando por você.'
          : waiting.kind === 'question'
            ? ' Havia uma pergunta esperando por você.'
            : ' Havia uma nova tentativa esperando por você.'
        : ''
      this.notify(
        'error',
        chatId,
        `O turno parou porque o app saiu da tela.${why} Toque para voltar ao chat.`,
        tagOf(chatId, 'turn'),
        true
      )
    }
  }

  /** App de volta à tela: os avisos locais perdem o sentido. */
  onForeground(): void {
    for (const id of this.shown) this.d.dismiss(id)
    this.shown.clear()
    for (const p of this.pending.values()) p.shown = null
  }
}
