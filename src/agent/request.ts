// Construção da request no celular — adaptação de ClearChatDesktop/src/main/agent/request.ts (lá
// depende de os/shell/fs). Mesma montagem (system → histórico ativo sanitizado → tools → params
// filtrados pelo modelo → cache_control), com estas diferenças:
// - só as tools PORTÁVEIS vão (`MOBILE_TOOLS`): o resto nunca é oferecido ao modelo;
// - <environment> sem raiz/shell (o celular não executa tools locais): só o SO;
// - anexos: o leitor (base64) vem pronto do runner, que baixou os blobs antes (§14);
// - memória/skills/voz: fontes registráveis (fase 4b), padrão = nada.
// É o módulo que o shim `src/vendor/desktop/agent/request.ts` reexporta (BuiltRequest, maskRequest,
// modelInfoFor para llm.ts / smartApprove.ts vendorados).
import { DEFAULT_APP_SIGNATURE, resolveAppSignatureHeaders } from '@shared/appSignatures'
import { activeHistory, isDisplayOnly } from '@shared/context'
import { defaultToolsPrompt } from '@shared/defaults'
import { paramSupport, type ParamSupport } from '@shared/modelParams'
import { providerKind, type ProviderKind } from '@shared/providerKinds'
import { TOOL_NAMES, toolDefinitionFor, type ToolDefinition } from '@shared/tools'
import type {
  ApiMessage,
  Chat,
  ChatConfig,
  ChatParams,
  ContentPart,
  ModelInfo,
  Provider,
  Session,
  StoredMessage,
  ToolCall,
  ToolName
} from '@shared/types'
import { adapterFor, buildHeaders, chatCompletionsUrl } from '@vendor/desktop/agent/adapters'
import { buildAnthropicBody, dropAudioParts } from '@vendor/desktop/agent/adapters/anthropic'
import { expandAttachments, hoistToolMedia, type AttachmentReader } from './attachments'
import { cachedModelInfo } from './providers'

export interface BuiltRequest {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
  kind?: ProviderKind
  notes?: string[]
}

export { buildHeaders, chatCompletionsUrl }

/**
 * Tools que o celular executa (fase 4a). Memória, subagentes, entre chats e read_history chegam na
 * 4b (registrar em `setExtraTools`). Tools locais nunca: o celular recusa hospedar esses chats.
 */
export const MOBILE_TOOLS: readonly ToolName[] = [
  'web_search',
  'browse_url',
  'list_models',
  'ask_user'
]

let extraTools: readonly ToolName[] = []
/** Fase 4b: tools portáveis extras (memória, subagentes, entre chats…). */
export function setExtraTools(names: readonly ToolName[]): void {
  extraTools = names
}
export const portableTools = (): ToolName[] => [...MOBILE_TOOLS, ...extraTools]

let modelInfoSource: (providerId: string, model: string) => ModelInfo | undefined = cachedModelInfo
export function setModelInfoSource(
  fn: (providerId: string, model: string) => ModelInfo | undefined
): void {
  modelInfoSource = fn
}
export function modelInfoFor(providerId: string, model: string): ModelInfo | undefined {
  return modelInfoSource(providerId, model)
}

export function filterParams(
  params: ChatParams,
  kind: ProviderKind,
  providerId: string,
  model: string,
  extra: Record<string, unknown> | null
): ParamSupport {
  return paramSupport({ kind, model, info: modelInfoFor(providerId, model), extra, params })
}

export interface EnvInfo {
  os: string
}

let envSource: () => EnvInfo = () => ({ os: 'Android' })
/** O app registra o SO do aparelho (Platform.Version); testes usam o padrão. */
export function setEnvSource(fn: () => EnvInfo): void {
  envSource = fn
}

/** <environment> no celular: só valores estáveis e sem raiz/shell (não há tools locais). */
export function environmentBlock(env: EnvInfo = envSource()): string {
  return `<environment>\nos: ${env.os}\nEste chat é executado num celular: não há shell nem acesso a arquivos locais.\n</environment>`
}

type SessionRef = Pick<Session, 'depth'> & { id?: string; parentSessionId?: string | null }

/**
 * Tools disponíveis para a sessão: habilitadas no chat ∩ portáveis, na ordem fixa de TOOL_NAMES;
 * ask_user só na principal. (Subagentes/memória/skills: 4b.)
 */
export function availableTools(
  chat: Pick<Chat, 'config'>,
  session: SessionRef,
  _history?: StoredMessage[]
): ToolName[] {
  const enabled = new Set(chat.config.enabledTools ?? [])
  const portable = new Set(portableTools())
  return TOOL_NAMES.filter(
    (n) => enabled.has(n) && portable.has(n) && (n !== 'ask_user' || session.depth === 0)
  )
}

let providerNamesSource: () => string[] = () => []
export function setProviderNamesSource(fn: () => string[]): void {
  providerNamesSource = fn
}

export function toolDefinitions(
  names: ToolName[],
  providerNames: string[] = providerNamesSource()
): ToolDefinition[] {
  return names.map((n) => toolDefinitionFor(n, providerNames))
}

/** System prompt → <environment> → (memória/skills: 4b) → texto das tools (modo texto). */
export function systemContent(
  chat: Chat,
  session: Pick<Session, 'depth'> & { id?: string },
  env: EnvInfo = envSource(),
  history?: StoredMessage[]
): string {
  const cfg = chat.config
  let s = session.depth === 0 ? (cfg.systemPrompt ?? '') : (cfg.subagentSystemPrompt ?? '')
  const add = (block: string): void => {
    if (!block) return
    s = s ? `${s}\n\n${block}` : block
  }
  if (cfg.envInPrompt) add(environmentBlock(env))
  if (cfg.toolsInPrompt) {
    const defs = toolDefinitions(availableTools(chat, session, history))
    add(
      cfg.toolsPromptText ??
        defaultToolsPrompt(defs, cfg.nativeTools, { subagent: session.depth > 0 })
    )
  }
  return s
}

export function parseExtraBody(extra: string | undefined): Record<string, unknown> | null {
  if (extra == null || !extra.trim()) return null
  let v: unknown
  try {
    v = JSON.parse(extra)
  } catch (e) {
    throw new Error(`extraBody não é um JSON válido: ${(e as Error).message}`, { cause: e })
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    throw new Error('extraBody deve ser um objeto JSON (ex.: {"chave": "valor"}).')
  }
  return v as Record<string, unknown>
}

/** Igual ao desktop: tool órfã fora, tool_call sem resposta ganha placeholder, reasoning só no OpenRouter. */
export function sanitizeHistory(messages: ApiMessage[], keepReasoning: boolean): ApiMessage[] {
  const out: ApiMessage[] = []
  let pending: string[] = []
  const flush = (): void => {
    for (const id of pending) {
      out.push({ role: 'tool', tool_call_id: id, content: '[Resultado indisponível]' })
    }
    pending = []
  }
  for (const m of messages) {
    if (m.role === 'tool') {
      const i = pending.indexOf(m.tool_call_id)
      if (i === -1) continue
      pending.splice(i, 1)
      out.push(m)
      continue
    }
    flush()
    if (m.role === 'assistant') {
      let a = m
      if (!keepReasoning && 'reasoning' in a) {
        const { reasoning: _r, ...rest } = a
        void _r
        a = rest
      }
      if (a.tool_calls && a.tool_calls.length === 0) {
        const { tool_calls: _t, ...rest } = a
        void _t
        a = rest
      }
      out.push(a)
      pending = (a.tool_calls ?? []).map((t) => t.id)
    } else {
      out.push(m)
    }
  }
  flush()
  return out
}

export type WireMessage =
  | ApiMessage
  | { role: 'assistant'; content: ContentPart[]; tool_calls?: ToolCall[]; reasoning?: string }
  | { role: 'tool'; tool_call_id: string; content: ContentPart[] }

function withCacheControl(content: string | ContentPart[]): ContentPart[] {
  const parts: ContentPart[] =
    typeof content === 'string' ? [{ type: 'text', text: content }] : content.map((p) => ({ ...p }))
  let i = parts.length - 1
  while (i >= 0 && parts[i].type !== 'text') i--
  if (i < 0) i = parts.length - 1
  if (i >= 0) parts[i] = { ...parts[i], cache_control: { type: 'ephemeral' } }
  return parts
}

function markMessage(m: ApiMessage): WireMessage | null {
  const c = m.content
  if (c == null || (typeof c === 'string' && c === '')) return null
  if (Array.isArray(c) && !c.length) return null
  return { ...m, content: withCacheControl(c) } as WireMessage
}

/** Até 3 breakpoints `cache_control` (system, última mensagem marcável, último user) — na cópia. */
export function applyCacheBreakpoints(messages: ApiMessage[]): WireMessage[] {
  const out: WireMessage[] = [...messages]
  if (out.length && messages[0].role === 'system') {
    out[0] = { role: 'system', content: withCacheControl(messages[0].content) }
  }
  const start = messages[0]?.role === 'system' ? 1 : 0
  let lastMarked = -1
  for (let i = messages.length - 1; i >= start; i--) {
    const marked = markMessage(messages[i])
    if (marked) {
      out[i] = marked
      lastMarked = i
      break
    }
  }
  for (let i = messages.length - 1; i >= start; i--) {
    if (messages[i].role !== 'user') continue
    if (i !== lastMarked) {
      const marked = markMessage(messages[i])
      if (marked) out[i] = marked
    }
    break
  }
  return out
}

const noAttachments: AttachmentReader = (file, name) => {
  throw new Error(`Anexo não carregado: "${name ?? file}".`)
}

export interface BuildOptions {
  env?: EnvInfo
  /** base64 dos anexos citados (já no aparelho). */
  read?: AttachmentReader
}

/**
 * Request EXATA da próxima chamada, no formato do adaptador do provedor (mesma lógica do desktop):
 * só o histórico desde a última compactação, sem mensagens só de exibição; params não aceitos pelo
 * modelo ficam de fora (notas em `notes`).
 */
export function buildRequest(
  chat: Chat,
  session: Pick<Session, 'depth' | 'model'> & { id?: string },
  history: StoredMessage[],
  provider: Provider,
  opts: BuildOptions = {}
): BuiltRequest {
  const cfg = chat.config
  const kind = providerKind(provider)
  const openRouter = kind === 'openrouter'
  const read = opts.read ?? noAttachments

  const sys = systemContent(chat, session, opts.env ?? envSource(), history)
  const hist = sanitizeHistory(
    activeHistory(history)
      .filter((m) => !isDisplayOnly(m.meta))
      .map((m) => m.message),
    openRouter
  )
  const messages: ApiMessage[] = []
  if (sys) messages.push({ role: 'system', content: sys })
  messages.push(...hist)

  const signature = resolveAppSignatureHeaders(
    cfg.appSignature ?? DEFAULT_APP_SIGNATURE,
    cfg.appSignatureCustom
  )
  const adapter = adapterFor(kind)
  const tools = availableTools(chat, session, history)
  const params = cfg.params ?? {}
  const extra = parseExtraBody(params.extraBody)
  const support = filterParams(params, kind, provider.id, session.model, extra)
  const notes = support.notes.length ? { notes: support.notes } : {}

  if (kind === 'anthropic') {
    const sent = expandAttachments(dropAudioParts(messages), read)
    return {
      url: adapter.chatUrl(provider.baseUrl),
      headers: adapter.headers(provider, signature),
      body: buildAnthropicBody({
        model: session.model,
        messages: sent,
        tools: cfg.nativeTools && tools.length ? toolDefinitions(tools) : undefined,
        params: support.send,
        cacheEnabled: cfg.cacheEnabled,
        extra
      }),
      kind,
      ...notes
    }
  }

  const sent = expandAttachments(hoistToolMedia(messages), read)
  const wire: WireMessage[] = cfg.cacheEnabled ? applyCacheBreakpoints(sent) : sent

  const body: Record<string, unknown> = {
    model: session.model,
    messages: wire,
    stream: true,
    stream_options: { include_usage: true }
  }

  if (cfg.nativeTools && tools.length) body.tools = toolDefinitions(tools)

  const { reasoning_effort: effort, ...sampling } = support.send
  Object.assign(body, sampling)
  if (effort) {
    if (openRouter) body.reasoning = { effort }
    else body.reasoning_effort = effort
  }
  if (openRouter) body.usage = { include: true }

  if (extra) Object.assign(body, extra)

  return {
    url: adapter.chatUrl(provider.baseUrl),
    headers: adapter.headers(provider, signature),
    body,
    kind,
    ...notes
  }
}

/** `sk-or-v1-abc…a3b9` → `sk-or-…a3b9`. */
export function maskKey(key: string): string {
  if (!key) return ''
  if (key.length <= 12) return '…' + key.slice(-2)
  return `${key.slice(0, 6)}…${key.slice(-4)}`
}

export function maskRequest(req: BuiltRequest, apiKey: string): BuiltRequest {
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(req.headers)) {
    headers[k] = apiKey && v.includes(apiKey) ? v.split(apiKey).join(maskKey(apiKey)) : v
  }
  return { ...req, headers }
}

export type { ChatConfig }
