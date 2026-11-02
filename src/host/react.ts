// Ligações React do chat aberto: decide quem executa (este celular ou outro dispositivo — controle
// remoto) e entrega o mesmo modelo de tela (MirrorView) e as mesmas ações (`ChatDriver`) nos dois
// casos. O espelho local acompanha o runner deste aparelho.
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { ApprovalItemDecision } from '@shared/approvalPolicy'
import type { ApiMessage, AttachmentInfo, QuestionAnswer } from '@shared/types'
import type { ChatState } from '@/data/types'
import { store } from '@/data/native'
import type { MirrorView } from '@/remote/mirror'
import { remote } from '@/remote/native'
import type { CommandResult, HostMode } from '@/remote/types'
import { usesLocalTools } from './policy'
import { host, hostStack, onHostNotice } from './native'

/** Ações do chat aberto (os métodos do RemoteController, por kind do §8.6). */
export interface ChatDriver {
  send(
    chatId: string,
    sessionId: string,
    text: string,
    attachments: AttachmentInfo[],
    skills: string[],
    force?: boolean
  ): Promise<CommandResult>
  queueForce(chatId: string, sessionId: string, queuedId: string): Promise<CommandResult>
  queueRemove(chatId: string, sessionId: string, queuedId: string): Promise<CommandResult>
  stop(chatId: string, sessionId: string): Promise<CommandResult>
  stopSubagents(chatId: string): Promise<CommandResult>
  approve(
    chatId: string,
    requestId: string,
    decision: 'allow' | 'deny',
    items?: ApprovalItemDecision[]
  ): Promise<CommandResult>
  smartOverride(chatId: string, messageId: string): Promise<CommandResult>
  answer(chatId: string, requestId: string, answers: QuestionAnswer[]): Promise<CommandResult>
  cancelQuestion(chatId: string, requestId: string): Promise<CommandResult>
  retry(chatId: string, requestId: string, action: 'retry' | 'cancel'): Promise<CommandResult>
  regenerate(chatId: string, sessionId: string, messageId?: string): Promise<CommandResult>
  editMessage(chatId: string, messageId: string, message: ApiMessage): Promise<CommandResult>
  deleteMessage(chatId: string, messageId: string): Promise<CommandResult>
  compact(chatId: string, sessionId: string, opts?: { retry?: boolean }): Promise<CommandResult>
  extractMemory(chatId: string, sessionId: string): Promise<CommandResult>
  editBranch(chatId: string, messageId: string, message: ApiMessage): Promise<CommandResult>
  selectBranch(chatId: string, messageId: string): Promise<CommandResult>
}

/** Ações num chat executado neste celular (mesmo caminho das ações remotas, sem servidor). */
export const localDriver: ChatDriver = {
  send: (c, sessionId, text, attachments, _skills, force) =>
    host.local(c, force ? 'force' : 'send', { sessionId, text, attachments }),
  queueForce: (c, sessionId, queuedId) => host.local(c, 'queue.force', { sessionId, queuedId }),
  queueRemove: (c, sessionId, queuedId) => host.local(c, 'queue.remove', { sessionId, queuedId }),
  stop: (c, sessionId) => host.local(c, 'stop', { sessionId }),
  stopSubagents: (c) => host.local(c, 'stop_subagents', {}),
  approve: (c, requestId, decision, items) =>
    host.local(c, 'approval', { requestId, decision, ...(items?.length ? { items } : {}) }),
  smartOverride: (c, messageId) => host.local(c, 'smart_override', { messageId }),
  answer: (c, requestId, answers) => host.local(c, 'question', { requestId, answers }),
  cancelQuestion: (c, requestId) => host.local(c, 'question', { requestId, cancel: true }),
  retry: (c, requestId, action) => host.local(c, 'retry', { requestId, action }),
  regenerate: (c, sessionId, messageId) =>
    host.local(c, 'branch.regenerate', { sessionId, ...(messageId ? { messageId } : {}) }),
  editMessage: (c, messageId, message) => host.local(c, 'message.edit', { messageId, message }),
  deleteMessage: (c, messageId) => host.local(c, 'message.delete', { messageId }),
  compact: (c, sessionId, opts) =>
    host.local(c, 'compact', { sessionId, ...(opts?.retry ? { opts: { retry: true } } : {}) }),
  extractMemory: (c, sessionId) => host.local(c, 'memory.extract', { sessionId }),
  editBranch: (c, messageId, message) => host.local(c, 'branch.edit', { messageId, message }),
  selectBranch: (c, messageId) => host.local(c, 'branch.select', { messageId })
}

export interface ChatRuntime {
  mode: HostMode
  /** Este celular executa (ou vai executar, no 1º envio) o chat. */
  local: boolean
  /** O chat usa ferramentas locais (o celular não o executa). */
  localTools: boolean
  view: MirrorView | null
  driver: ChatDriver
  connected: boolean
}

/** Chat aberto: inscrição no stream (controle remoto) ou espelho local (executado aqui). */
export function useChatRuntime(
  chatId: string,
  state: ChatState | null,
  config: Record<string, unknown> | undefined
): ChatRuntime {
  useEffect(() => {
    remote.setActive(chatId)
    host.setActive(chatId)
    return () => {
      if (remote.activeChat === chatId) remote.setActive(null)
      host.setActive(null)
    }
  }, [chatId])
  const rv = useSyncExternalStore(remote.subscribe, remote.getVersion)
  const hv = useSyncExternalStore(host.subscribe, host.getVersion)
  // `rv`/`hv`/`state`/`config` são os gatilhos de releitura (o React Compiler memoiza chamadas a objetos externos)
  return useMemo(() => {
    const st = host.state(chatId) ?? state
    const mode = remote.mode(chatId)
    const localTools = usesLocalTools(
      config ?? (store.getPlain('chat', chatId)?.config as Record<string, unknown> | undefined)
    )
    const mine = !!st?.host && st.host.device_id === host.deviceId
    // sem servidor, um chat que este celular executa continua local: o turno em andamento termina
    // aqui (a outbox sobe depois); começar outro turno espera a conexão
    const local =
      !localTools &&
      (mode === 'local' || (mode === 'none' && !st?.host) || (mine && mode !== 'diverged'))
    return {
      mode: mine && mode !== 'diverged' ? 'local' : mode,
      local,
      localTools,
      view: local ? host.view(chatId) : remote.view(chatId),
      driver: local ? localDriver : remote,
      connected: remote.isConnected
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, state, config, rv, hv])
}

export { host, hostStack, onHostNotice }
