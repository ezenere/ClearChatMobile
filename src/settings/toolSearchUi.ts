// Busca nativa de tools (protocolo 1.12.0, §4.3.6 — @shared/toolSearch) nas telas de tools do
// celular — a parte pura (sem React Native): o modo efetivo de envio das tools de um chat/persona,
// calculado NESTE aparelho com o mesmo resolvedor da request (`resolveToolMode` + `toolsPlan` +
// `nativeDeferral` + `toolSearchView`; = IPC `agent.toolSearchMode` do desktop): modo, rótulo,
// motivo, adiadas EFETIVAS (sem as carregadas pelo histórico), compactas, o prompt fixo exato e os
// itens EXATOS de `tools[]` nos modos nativos. As tools são as que este celular manda; as falhas
// lembradas, as daqui.
import { providerKind } from '@shared/providerKinds'
import {
  TOOL_SEARCH_LOCAL_NOTICE,
  isNativeMode,
  messagesApiTool,
  nativeToolSearchPrompt,
  toolSearchStatus,
  toolSearchView,
  type ToolSearchModeResult,
  type ToolSearchModeView
} from '@shared/toolSearch'
import type { ToolDefinition } from '@shared/tools'
import type { Chat, ChatConfig, ModelInfo, Provider, StoredMessage } from '@shared/types'
import { nativeDeferral, resolveToolMode, sentHistory, toolsPlan } from '@/agent/request'

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
  /**
   * Histórico da principal: o áudio enviado decide a Messages API do OpenRouter e, nos nativos, as
   * adiadas já usadas sem a descoberta junto vão carregadas (o prompt fixo nativo não as lista).
   */
  history?: StoredMessage[]
  /** Respostas da principal cujo `native` o provedor recusou nesta sessão (runner). */
  noReplay?: ReadonlySet<string>
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
  if (!i.provider || !isNativeMode(plan.mode))
    return toolSearchView(r, plan, kind, i.cfg.cacheEnabled)
  // nos nativos, as adiadas EFETIVAS (sem as carregadas pelo histórico) e o prompt exato da request
  const nd = nativeDeferral(plan, sentHistory(i.history ?? [], kind, true, i.noReplay), {
    providerId: i.provider.id,
    model
  })
  return toolSearchView(
    r,
    {
      ...plan,
      deferred: nd.deferred,
      forceLoaded: nd.forceLoaded,
      prompt: nativeToolSearchPrompt(nd.deferred, plan.mode)
    },
    kind,
    i.cfg.cacheEnabled
  )
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
 * Estado de uma tool num modo nativo, NESTA request (= `NativeToolDefInfo` do desktop): adiada ou
 * carregada (uma adiada já usada no histórico sem a busca vai carregada — `forced`) e o item EXATO
 * do array `tools` (com `defer_loading` e o `cache_control` se for o ponto de cache); uma tool fora
 * da request (desligada) → o item que iria pela config.
 */
export function nativeToolState(
  view: ToolSearchModeView,
  name: string,
  fullDef: ToolDefinition,
  configDeferred: boolean
): { deferred: boolean; forced: boolean; item: Record<string, unknown> } {
  const forced = view.forceLoaded.includes(name)
  const deferred = view.items[name] ? view.deferred.includes(name) : configDeferred
  return { deferred, forced, item: view.items[name] ?? messagesApiTool(fullDef, deferred) }
}
