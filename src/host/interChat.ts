// send_to_chat entre dispositivos (SYNC_PROTOCOL.md §8): decide onde entregar a mensagem pelo
// estado do chat de destino — executado (ou executável) neste celular → local, com a janela aberta
// antes; executado por outro dispositivo ONLINE → comando `send` ao host dele (§8.6), como faria o
// controle remoto; host offline/em tolerância, divergente ou chat com ferramentas locais sem host
// online → recusa com texto claro (não há fila guardada no servidor, §8.7). Com wait_for_reply a
// resposta é lida dos registros sincronizados depois que a janela do turno fecha. O `send` leva a
// origem (`meta`, protocolo ≥ 1.6.0): o host grava como mensagem entre chats e conta os saltos.
// Sem React Native.
import { contentText } from '@shared/attachments'
import { activePath } from '@shared/branches'
import { isDisplayOnly } from '@shared/context'
import type { InterChatSendMeta } from '@shared/interChat'
import type { LocalStore } from '@/data/store'
import type { ChatState } from '@/data/types'
import type { ChatListEntry } from '@/agent/tools/util'
import type { InterChatRoute, InterChatRouter } from '@/agent/runner'
import { divergedOf } from '@/remote/types'
import { usesLocalTools } from './policy'

export interface InterChatDeps {
  store: LocalStore
  me: () => string
  connected: () => boolean
  state: (chatId: string) => ChatState | null
  ensureWindow: (chatId: string) => Promise<void>
  /** Comando `send` ao host remoto (RemoteController). Ausente = só entrega local. */
  remoteSend?: (
    chatId: string,
    sessionId: string,
    text: string,
    meta: InterChatSendMeta
  ) => Promise<{ queued?: boolean }>
  pollMs?: number
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortErr())
    const t = setTimeout(() => {
      signal.removeEventListener('abort', on)
      resolve()
    }, ms)
    const on = (): void => {
      clearTimeout(t)
      reject(abortErr())
    }
    signal.addEventListener('abort', on, { once: true })
  })

function abortErr(): Error {
  const e = new Error('Aborted')
  e.name = 'AbortError'
  return e
}

export class InterChatBridge implements InterChatRouter {
  constructor(private readonly d: InterChatDeps) {}

  private title(chatId: string): string {
    const t = this.d.store.getPlain('chat', chatId)?.title
    return `"${(typeof t === 'string' && t.trim()) || 'Novo chat'}"`
  }

  route(chatId: string): InterChatRoute {
    const st = this.d.state(chatId)
    const name = this.title(chatId)
    if (divergedOf(st))
      return {
        kind: 'refuse',
        error: `o chat ${name} está divergente — resolva a divergência antes.`
      }
    const host = st?.host ?? null
    const mine = !host || host.device_id === this.d.me()
    const cfg = this.d.store.getPlain('chat', chatId)?.config as Record<string, unknown> | undefined
    if (mine) {
      if (usesLocalTools(cfg))
        return {
          kind: 'refuse',
          error: `o chat ${name} usa ferramentas locais e não tem um computador online executando-o — o celular não executa esse chat.`
        }
      return { kind: 'local' }
    }
    if (!this.d.connected())
      return {
        kind: 'refuse',
        error: 'sem conexão com o servidor para alcançar o outro dispositivo.'
      }
    if (host.status !== 'online')
      return {
        kind: 'refuse',
        error: `o chat ${name} é executado no ${host.name}, que está offline — não há como entregar agora.`
      }
    if (!this.d.remoteSend)
      return { kind: 'refuse', error: `o chat ${name} é executado no ${host.name}.` }
    return { kind: 'remote', hostName: host.name }
  }

  ensureLocal(chatId: string): Promise<void> {
    return this.d.ensureWindow(chatId)
  }

  async sendRemote(
    chatId: string,
    sessionId: string,
    text: string,
    meta: InterChatSendMeta
  ): Promise<{ queued: boolean }> {
    const r = await this.d.remoteSend!(chatId, sessionId, text, meta)
    return { queued: !!r.queued }
  }

  async waitRemote(
    chatId: string,
    sessionId: string,
    text: string,
    signal: AbortSignal,
    ms: number
  ): Promise<
    { kind: 'final'; text: string } | { kind: 'timeout' } | { kind: 'error'; error: string }
  > {
    const deadline = Date.now() + ms
    const poll = this.d.pollMs ?? 400
    let sawTurn = false
    for (;;) {
      const st = this.d.state(chatId)
      if (st?.window) sawTurn = true
      const reply = this.replyAfter(sessionId, text)
      if (reply && reply.done && !st?.window) return { kind: 'final', text: reply.text }
      if (sawTurn && !st?.window && reply?.error) return { kind: 'error', error: reply.error }
      if (st?.host && st.host.status === 'offline')
        return { kind: 'error', error: `o ${st.host.name} caiu antes de responder.` }
      if (Date.now() >= deadline) return { kind: 'timeout' }
      await sleep(Math.min(poll, Math.max(1, deadline - Date.now())), signal)
    }
  }

  /** Resposta à mensagem `text` no caminho ativo da sessão (registros já sincronizados). */
  private replyAfter(
    sessionId: string,
    text: string
  ): { done: boolean; text: string; error?: string } | null {
    const store = this.d.store
    const p = store.getPlain('session', sessionId)
    const sel =
      p?.branchSel && typeof p.branchSel === 'object'
        ? (p.branchSel as Record<string, string | null>)
        : {}
    const path = activePath(store.sessionMessages(sessionId), sel)
    let at = -1
    for (let i = path.length - 1; i >= 0; i--) {
      const m = path[i]
      if (m.message.role === 'user' && contentText(m.message.content) === text) {
        at = i
        break
      }
    }
    if (at === -1) return null
    let last = ''
    let error: string | undefined
    let done = false
    for (const m of path.slice(at + 1)) {
      if (m.meta.kind === 'error') error = m.meta.error ?? contentText(m.message.content as never)
      if (m.message.role !== 'assistant' || isDisplayOnly(m.meta)) continue
      last = m.message.content ?? ''
      done = !m.message.tool_calls?.length
    }
    return { done, text: last, ...(error ? { error } : {}) }
  }

  remoteStatus(chatId: string): ChatListEntry['status'] | null {
    const st = this.d.state(chatId)
    if (st?.window && st.host && st.host.device_id !== this.d.me()) return 'running'
    return null
  }
}
