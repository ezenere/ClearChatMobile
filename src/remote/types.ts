// Tipos do controle remoto (SYNC_PROTOCOL.md §8.2, §8.6).
import type { ChatState } from '@/data/types'

/**
 * Como o celular trata o chat (§8):
 * - none: chat sem host (executar no celular chega na fase 4)
 * - local: este aparelho é o host (fase 4)
 * - remote: outro dispositivo online é o host → controle remoto
 * - host-offline: o host é outro dispositivo e está offline/caiu (ou reconectando)
 * - offline: sem conexão com o servidor
 * - diverged: versões divergentes (§9)
 */
export type HostMode = 'none' | 'local' | 'remote' | 'host-offline' | 'offline' | 'diverged'

export interface Handover {
  to_device_id: string
  to_name: string
  mode: 'next_turn' | 'force'
  requested_at?: string
}

export interface Diverged {
  divergence_id: string
  device_id: string
  device_name: string
  base: number
  head: number
  since: string
}

export const handoverOf = (s: ChatState | null): Handover | null =>
  (s?.handover as Handover | null | undefined) ?? null

export const divergedOf = (s: ChatState | null): Diverged | null =>
  (s?.diverged as Diverged | null | undefined) ?? null

/** Kinds de comando do §8.6 (o servidor recusa qualquer outro com `invalid_request`). */
export const COMMAND_KINDS = [
  'send',
  'force',
  'queue.force',
  'queue.remove',
  'stop',
  'stop_subagents',
  'approval',
  'smart_override',
  'question',
  'retry',
  'regenerate',
  'message.edit',
  'message.delete',
  'compact',
  'memory.extract',
  'branch.edit',
  'branch.regenerate',
  'branch.select',
  'fs.list',
  'fs.read'
] as const
export type CommandKind = (typeof COMMAND_KINDS)[number]

export interface CommandResult {
  status: 'accepted' | 'duplicate'
  queued?: boolean
  [k: string]: unknown
}

export interface RemoteNotice {
  chatId: string
  tone: 'info' | 'danger' | 'success'
  text: string
}
