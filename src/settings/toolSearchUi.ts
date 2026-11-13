// Busca nativa de tools (protocolo 1.12.0, §4.3.6 — @shared/toolSearch) nas telas de tools do
// celular — a parte pura (sem React Native): o modo efetivo de envio das tools de um chat/persona,
// calculado NESTE aparelho com o mesmo resolvedor da request (`resolveToolMode` + `toolsPlan` +
// `toolSearchView`; = IPC `agent.toolSearchMode` do desktop): modo, rótulo, motivo, adiadas/compactas
// e os itens EXATOS de `tools[]` nos modos nativos. As tools são as que este celular manda; as falhas
// lembradas, as daqui.
import { providerKind } from '@shared/providerKinds'
import {
  TOOL_SEARCH_LOCAL_NOTICE,
  isNativeMode,
  messagesApiTool,
  toolSearchStatus,
  toolSearchView,
  type ToolSearchModeResult,
  type ToolSearchModeView
} from '@shared/toolSearch'
import type { ToolDefinition } from '@shared/tools'
import type { Chat, ChatConfig, ModelInfo, Provider, StoredMessage } from '@shared/types'
import { resolveToolMode, toolsPlan } from '@/agent/request'

export type { ToolSearchModeView }
export { TOOL_SEARCH_LOCAL_NOTICE }

export interface ToolSearchViewInput {
  /** A config efetiva mostrada (chat, persona resolvida ou o formulário do Novo chat). */
  cfg: ChatConfig
  /** Provedor e modelo do chat/persona (sem eles: a versão local, com o motivo). */
  provider: Provider | null
  model: string
  /** Chat existente: o id e a sessão principal (chamada de voz em andamento, tools da sessão). */
  chatId?: string
  sessionId?: string
  /** Histórico da principal (mídia enviada: áudio/PDF decidem a Messages API do OpenRouter). */
  history?: StoredMessage[]
  /**
   * O catálogo do provedor, quando a tela já o carregou: só para a tela recalcular quando ele chega
   * (o resolvedor lê o cache de /models — `endpoints` do OpenRouter).
   */
  models?: readonly ModelInfo[] | null
}

/** O modo efetivo de envio das tools (o MESMO da request) e o que a aba Tools mostra. */
export function toolSearchViewOf(i: ToolSearchViewInput): ToolSearchModeView {
  const chat: Chat = {
    id: i.chatId ?? '',
    title: '',
    mainSessionId: i.sessionId ?? '',
    createdAt: 0,
    updatedAt: 0,
    config: i.cfg
  }
  const model = i.model.trim()
  const sref = { depth: 0 as const, ...(i.sessionId ? { id: i.sessionId } : {}), model }
  const kind = i.provider ? providerKind(i.provider) : 'openai'
  const r: ToolSearchModeResult =
    i.provider && model
      ? resolveToolMode(chat, sref, i.history, i.provider)
      : { mode: 'local', api: 'chat', reason: 'sem provedor/modelo escolhido' }
  const plan = toolsPlan(chat, sref, i.history, undefined, r.mode)
  return toolSearchView(r, plan, kind, i.cfg.cacheEnabled)
}

/**
 * Linha de estado de "Enviar tools compactadas" num modo resolvido (= `ToolSearchModeLine` do
 * desktop): o rótulo do modo, o que vai e, na versão local, o motivo e o aviso exigido pelo
 * protocolo (§4.3.6). null = sem compactação (todas completas).
 */
export function toolSearchLine(
  view: ToolSearchModeView
): { label: string; status: string; reason?: string; notice?: string } | null {
  if (view.mode === 'off') return null
  const native = isNativeMode(view.mode)
  return {
    label: view.label,
    status: toolSearchStatus(view.mode, native ? view.deferred.length : view.compacted.length),
    ...(!native && view.reason ? { reason: `Motivo: ${view.reason}.` } : {}),
    ...(!native ? { notice: TOOL_SEARCH_LOCAL_NOTICE } : {})
  }
}

/** Texto do chip de uma tool: "adiada"/"carregada" nos modos nativos, "compacta"/"completa" na local. */
export function toolChipText(native: boolean, full: boolean): string {
  return native ? (full ? 'carregada' : 'adiada') : full ? 'completa' : 'compacta'
}

/**
 * Item EXATO do array `tools` de uma tool num modo nativo (o da request, com `defer_loading` e o
 * `cache_control` se for o ponto de cache); uma tool fora da request (desligada) → o item que iria.
 */
export function nativeToolItem(
  view: ToolSearchModeView,
  name: string,
  fullDef: ToolDefinition,
  deferred: boolean
): Record<string, unknown> {
  return view.items[name] ?? messagesApiTool(fullDef, deferred)
}
