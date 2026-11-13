// Construção da request no celular — adaptação de ClearChatDesktop/src/main/agent/request.ts (lá
// depende de os/shell/fs). Mesma montagem (system → histórico ativo sanitizado → tools → params
// filtrados pelo modelo → cache_control), com estas diferenças:
// - só as tools PORTÁVEIS vão (`MOBILE_TOOLS`): as só do computador (§4.3.6) ficam na lista do
//   chat, mas nunca são oferecidas ao modelo daqui (nem na request nem no texto das tools);
// - <environment> sem raiz/shell (o celular não executa tools locais): só o SO;
// - anexos: o leitor (base64) vem pronto do runner, que baixou os blobs antes (§14);
// - memória: fontes registráveis (índice congelado + help, tools pela config — como o desktop);
//   skills: nunca no celular; voz (fase 6): `end_call` nos turnos da chamada (fonte registrável,
//   como no desktop — `setVoiceCallSource`);
// - tools compactadas (protocolo 1.11.0, @shared/compactTools — = `toolsPlan` do desktop): o plano
//   parte das definições COMPLETAS como o celular as mandaria (as de localização deste aparelho e a
//   descrição do `browse_url` do celular inclusive); na versão local, compactas + `tool_search` no
//   fim + o prompt fixo no fim do system prompt, nos turnos normais, subagentes e chamada de voz;
// - busca nativa de tools (protocolo 1.12.0, @shared/toolSearch — = desktop): o modo de cada request
//   (Anthropic nativa, Messages API do OpenRouter, versão local ou sem compactação) sai do mesmo
//   resolvedor; nos nativos as mesmas tools vão completas e adiadas (com o prompt fixo nativo, que
//   nomeia a busca e lista as adiadas da request), os blocos do provedor das respostas anteriores são
//   reenviados (mesmo canal e ainda batendo com o texto) com as referências filtradas às tools que
//   ESTE aparelho manda (um chat do computador hospedado aqui, sem as tools dele, continua válido) e
//   uma adiada já usada sem a descoberta junto vai carregada.
// É o módulo que o shim `src/vendor/desktop/agent/request.ts` reexporta (BuiltRequest, maskRequest,
// modelInfoFor para llm.ts / smartApprove.ts vendorados).
import { DEFAULT_APP_SIGNATURE, resolveAppSignatureHeaders } from '@shared/appSignatures'
import { activeHistory, isDisplayOnly } from '@shared/context'
import { planTools, withCompactPrompt, type ToolsPlan } from '@shared/compactTools'
import {
  TOOL_SEARCH_MODE_LABEL,
  forceLoadedTools,
  isNativeMode,
  nativeToolSearchPrompt,
  nativeToolsArray,
  prepareNativeReplay,
  resolveToolSearchMode,
  sentMediaOf,
  wireToolName,
  type ToolSearchCaps,
  type ToolSearchFailure,
  type ToolSearchModeResult,
  type WireApi
} from '@shared/toolSearch'
import { defaultToolsPrompt } from '@shared/defaults'
import { paramSupport, type ParamSupport } from '@shared/modelParams'
import { providerKind, type ProviderKind } from '@shared/providerKinds'
import { isPhoneTool } from '@shared/deviceTools'
import {
  END_CALL_TOOL,
  MEMORY_TOOL_NAMES,
  TOOL_NAMES,
  toolDefinitionFor,
  type ToolDefinition
} from '@shared/tools'
import type { ResolvedVoiceCall } from '@shared/voice'
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
  ToolName,
  ToolSearchMode
} from '@shared/types'
import { adapterFor, buildHeaders, chatCompletionsUrl } from '@vendor/desktop/agent/adapters'
import {
  buildAnthropicBody,
  dropAudioParts,
  messagesUrl
} from '@vendor/desktop/agent/adapters/anthropic'
import { expandAttachments, hoistToolMedia, type AttachmentReader } from './attachments'
import { LOCATION_TOOLS } from '@/location/service'
import { cachedModelInfo } from './providers'

export interface BuiltRequest {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
  kind?: ProviderKind
  /**
   * Formato da request: 'messages' = Messages API (Anthropic nativa, ou o OpenRouter na busca
   * nativa de tools — o stream é o SSE nativo); 'chat' = Chat Completions. Ausente = pelo `kind`.
   */
  api?: WireApi
  notes?: string[]
  /** Busca de ferramentas desta request (protocolo 1.12.0 — @shared/toolSearch). */
  toolSearch?: RequestToolSearch
}

/** Como as tools foram nesta request (modo, motivo, adiadas/carregadas, reenvio de blocos). */
export interface RequestToolSearch {
  mode: ToolSearchMode
  reason?: string
  failure?: ToolSearchFailure
  /** Adiadas (`defer_loading`). */
  deferred: string[]
  /** Fora de `toolsFull`, mas carregadas por já terem sido usadas sem a busca no histórico enviado. */
  forceLoaded: string[]
  /** Respostas reenviadas com os blocos do provedor / que foram pela conversão normal. */
  replayed: number
  skipped: number
}

export { buildHeaders, chatCompletionsUrl }

/**
 * Tools que o celular executa (habilitáveis no chat): conversacionais, subagentes, entre chats,
 * read_history e as só do celular (localização). As de memória entram pela config de memória (não
 * por enabledTools). As só do computador (@shared/deviceTools — arquivos, shell, processos; skills
 * por `config.skills`) nunca: o celular hospeda esses chats sem elas (§4.3.6, §8.9).
 */
export const MOBILE_TOOLS: readonly ToolName[] = [
  'web_search',
  'browse_url',
  'list_models',
  'ask_user',
  'delegate_task',
  'check_subagents',
  'wait_subagents',
  'cancel_subagent',
  'message_subagent',
  'get_chat_info',
  'list_chats',
  'send_to_chat',
  'read_history',
  // data e hora do aparelho (protocolo 1.11.0; portátil, sem aprovação — @shared/datetime)
  'datetime',
  // só no celular (src/location; nomes em @shared/deviceTools): o desktop as preserva nas listas
  // e as mostra esmaecidas, mas não as executa
  ...LOCATION_TOOLS
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

/** Item do /models com fallback para o id sem `:variante` (OpenRouter: `x/y:free` → `x/y`). */
export function modelInfoLoose(providerId: string, model: string): ModelInfo | undefined {
  const info = modelInfoFor(providerId, model)
  if (info || !model.includes(':')) return info
  return modelInfoFor(providerId, model.replace(/:[^/:]*$/, ''))
}

// ---------------- busca nativa de tools (protocolo 1.12.0 — @shared/toolSearch) ----------------

/**
 * Falhas lembradas da busca nativa (`toolSearchCaps`, local DESTE aparelho — §4.4, nunca
 * sincronizado). O host registra (src/agent/toolSearchCaps.ts); sem registro = nenhuma.
 */
let capsSource: () => ToolSearchCaps = () => ({})
export function setToolSearchCapsSource(fn: () => ToolSearchCaps): void {
  capsSource = fn
}

/**
 * Hosts extras tratados como o host oficial (só testes: provedor FALSO local fazendo papel da
 * Anthropic/OpenRouter). Sem registro = nenhum.
 */
let nativeTestHosts: string[] = []
export function setNativeTestHosts(hosts: string[]): void {
  nativeTestHosts = hosts.map((h) => h.toLowerCase())
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
  /**
   * Leitor dos anexos (base64, já no aparelho). Vai junto do env quando a request é montada por um
   * módulo vendorado que só repassa `env` (compactação).
   */
  read?: AttachmentReader
}

let envSource: () => EnvInfo = () => ({ os: 'Android' })
/** O app registra o SO do aparelho (Platform.Version); testes usam o padrão. */
export function setEnvSource(fn: () => EnvInfo): void {
  envSource = fn
}

/** Env atual do aparelho (o runner acrescenta o leitor de anexos na request da compactação). */
export const currentEnv = (): EnvInfo => envSource()

/** <environment> no celular: só valores estáveis e sem raiz/shell (não há tools locais). */
export function environmentBlock(env: EnvInfo = envSource()): string {
  return `<environment>\nos: ${env.os}\nEste chat é executado num celular: não há shell nem acesso a arquivos locais.\n</environment>`
}

type SessionRef = Pick<Session, 'depth'> & { id?: string; parentSessionId?: string | null }

/** Tools que só fazem sentido com delegate_task disponível (subagentes da própria sessão). */
const SUBAGENT_TOOLS: ToolName[] = [
  'check_subagents',
  'wait_subagents',
  'cancel_subagent',
  'message_subagent'
]

/** Tools de subagentes que também valem entre irmãos (mesmo agente pai). */
const SIBLING_TOOLS: ToolName[] = ['check_subagents', 'message_subagent']

/** A sessão já chamou delegate_task (tem ou teve subagentes)? */
export function hasDelegated(history: StoredMessage[]): boolean {
  return history.some(
    (m) =>
      m.message.role === 'assistant' &&
      !!m.message.tool_calls?.some((t) => t.function.name === 'delegate_task')
  )
}

type SiblingsSource = (session: { id: string; parentSessionId: string }) => boolean
let siblingsSource: SiblingsSource = () => false
/** O runner registra (sessões do cache); sem registro = nunca há irmãos. */
export function setSiblingsSource(fn: SiblingsSource): void {
  siblingsSource = fn
}

function hasSiblings(session: SessionRef): boolean {
  return (
    session.depth > 0 &&
    !!session.id &&
    !!session.parentSessionId &&
    siblingsSource({ id: session.id, parentSessionId: session.parentSessionId })
  )
}

// ---------------- localização (fonte registrada pelo app; sem registro = sem as tools) ----------------

/** Tools de localização deste aparelho: as oferecidas agora e as definições (texto muda com a precisão). */
export interface LocationToolsSource {
  tools(): ToolName[]
  definition(name: string): ToolDefinition | undefined
}
let locationSource: LocationToolsSource | null = null
export function setLocationSource(src: LocationToolsSource | null): void {
  locationSource = src
}

// ---------------- memória (fontes registradas pelo app; sem registro = nada de memória) ----------------

/** Blocos de memória do system prompt (índice congelado + help). null = nada vai. */
export interface MemoryPromptBlocks {
  index: string | null
  help: string | null
}
type MemoryPromptSource = (
  chat: Chat,
  session: Pick<Session, 'depth'> & { id?: string }
) => MemoryPromptBlocks | null
type MemoryToolsSource = (chat: Chat, session: Pick<Session, 'depth'>) => ToolName[]
let memoryPromptSource: MemoryPromptSource = () => null
let memoryToolsSource: MemoryToolsSource = () => []
export function setMemorySources(src: {
  prompt: MemoryPromptSource
  tools: MemoryToolsSource
}): void {
  memoryPromptSource = src.prompt
  memoryToolsSource = src.tools
}

/**
 * Tools disponíveis para a sessão (= desktop, só as portáveis): habilitadas no chat, na ordem fixa
 * de TOOL_NAMES; delegate só se depth < 2; ask_user só na principal; check/wait/cancel/message só com
 * delegate_task disponível — num subagente (com histórico), só depois de ter delegado; um subagente
 * com irmãos recebe check_subagents + message_subagent. Memória pela config, sempre no fim.
 */
export function availableTools(
  chat: Chat,
  session: SessionRef,
  history?: StoredMessage[]
): ToolName[] {
  const enabled = new Set(chat.config.enabledTools ?? [])
  const portable = new Set(portableTools())
  const canDelegate =
    enabled.has('delegate_task') &&
    session.depth < 2 &&
    (!history || session.depth === 0 || hasDelegated(history))
  let siblings: boolean | undefined
  const siblingOk = (n: ToolName): boolean =>
    SIBLING_TOOLS.includes(n) && (siblings ??= hasSiblings(session))
  const base = TOOL_NAMES.filter(
    (n) =>
      enabled.has(n) &&
      portable.has(n) &&
      (n !== 'delegate_task' || session.depth < 2) &&
      (n !== 'ask_user' || session.depth === 0) &&
      (!SUBAGENT_TOOLS.includes(n) || canDelegate || siblingOk(n))
  )
  // localização: ligada no chat (enabledTools) e oferecida por este aparelho, depois das do desktop
  const location = (locationSource?.tools() ?? []).filter((n) => enabled.has(n))
  if (location.length) base.push(...location)
  const memory = memoryToolsSource(chat, session).filter((n) => !base.includes(n))
  // chamada de voz: `end_call` só nos turnos da chamada (sessão principal), salvo desligada em
  // "O agente pode encerrar a chamada" — independe de enabledTools/voice.tools (= desktop)
  const call =
    session.depth === 0 && session.id
      ? voiceCallContextFor(chat, { id: session.id, depth: session.depth })
      : null
  const voice: ToolName[] = call && call.endCall !== false ? [END_CALL_TOOL] : []
  return memory.length || voice.length ? [...base, ...memory, ...voice] : base
}

// ---------------- chamada de voz (= desktop: `setVoiceCallSource`) ----------------

/**
 * Overrides do modo voz no turno em andamento; null = turno de texto. O `VoiceCallManager`
 * vendorado registra a fonte (`src/voice/call.ts`); sem registro (testes) = nunca há chamada.
 */
export type VoiceCallContextSource = (
  chat: Pick<Chat, 'id' | 'config'>,
  session: Pick<Session, 'id' | 'depth'>
) => ResolvedVoiceCall | null
let voiceCallContextSource: VoiceCallContextSource = () => null
export function setVoiceCallSource(fn: VoiceCallContextSource): void {
  voiceCallContextSource = fn
}
export function voiceCallContextFor(
  chat: Pick<Chat, 'id' | 'config'>,
  session: Pick<Session, 'id' | 'depth'>
): ResolvedVoiceCall | null {
  return voiceCallContextSource(chat, session)
}

let providerNamesSource: () => string[] = () => []
export function setProviderNamesSource(fn: () => string[]): void {
  providerNamesSource = fn
}

/**
 * `browse_url` no celular: a implementação (`src/agent/tools/web.ts`) BAIXA o HTML com `fetch` e
 * extrai o texto — sem navegador nem JavaScript da página (a descrição do desktop fala de um
 * navegador oculto que executa o JavaScript; aqui ela seria falsa). Mesmos parâmetros + `offset`
 * (continuar uma página longa), que a implementação do celular aceita.
 */
export const MOBILE_BROWSE_URL_DESCRIPTION =
  'Baixa a página da URL (HTTP, sem navegador: o JavaScript da página NÃO é executado — conteúdo que só aparece via JavaScript não vem) e extrai do HTML o CONTEÚDO PRINCIPAL em Markdown compacto: título, URL, descrição, datas, dados estruturados (preço/produto/artigo, quando houver), títulos, parágrafos, listas, tabelas (com os números), blocos de código, citações e links absolutos [texto](url) — sem menus, cabeçalho, rodapé, barras laterais nem banners de cookies. Se o conteúdo principal não for identificado com segurança, devolve a página inteira sem menus e avisa. Página longa: use offset para continuar a partir de um caractere. mode="full" inclui menus/navegação/rodapé (ex.: para achar links do site); links=true acrescenta a lista "Links da página". Reler a mesma URL com outro mode/links/offset em até 5 min usa a página já baixada.'

function mobileBrowseUrl(providerNames: string[]): ToolDefinition {
  const base = toolDefinitionFor('browse_url', providerNames)
  const params = base.function.parameters
  return {
    ...base,
    function: {
      ...base.function,
      description: MOBILE_BROWSE_URL_DESCRIPTION,
      parameters: {
        ...params,
        properties: {
          ...(params.properties ?? {}),
          offset: {
            type: 'integer',
            description:
              'Continua a leitura do texto extraído a partir deste caractere (página longa). Padrão 0.'
          }
        }
      }
    }
  }
}

export function toolDefinitions(
  names: ToolName[],
  providerNames: string[] = providerNamesSource()
): ToolDefinition[] {
  return names.map(
    (n) =>
      locationSource?.definition(n) ??
      (n === 'browse_url' ? mobileBrowseUrl(providerNames) : toolDefinitionFor(n, providerNames))
  )
}

/**
 * Definição COMPLETA de uma tool como este celular a manda (o "</> definição" das telas de tools —
 * a mesma fonte da request: localização deste aparelho, `browse_url` do celular, provedores). null =
 * o celular não a manda (só do computador, ou localização sem o serviço deste aparelho).
 */
export function phoneToolDefinition(name: string): ToolDefinition | null {
  const n = name as ToolName
  if (!portableTools().includes(n) && !MEMORY_TOOL_NAMES.includes(n) && n !== END_CALL_TOOL)
    return null
  if (isPhoneTool(n) && !locationSource?.definition(n)) return null
  return toolDefinitions([n])[0] ?? null
}

/**
 * As definições chegam ao modelo? (campo `tools`, ou o texto das tools GERADO pelo app no system
 * prompt — um `toolsPromptText` escrito pelo usuário vai como está e não leva definições).
 */
function toolsReachModel(cfg: ChatConfig): boolean {
  return cfg.nativeTools || (cfg.toolsInPrompt && cfg.toolsPromptText == null)
}

/**
 * Tools da request com a compactação (protocolo 1.11.0 — @shared/compactTools; = desktop): as
 * disponíveis da sessão, completas como o celular as manda (`toolDefinitions`: localização deste
 * aparelho, `browse_url` do celular) → na versão local, compactas as que não estão em `toolsFull`
 * (com a compactação ligada), `tool_search` no fim e o prompt fixo, se alguma foi compacta; nos
 * modos de busca nativa (1.12.0), as mesmas vão completas e ADIADAS. Vale para os turnos normais,
 * subagentes e a chamada de voz (`end_call` sempre completa). Sem tools chegando ao modelo (sem
 * tools nativas e sem o texto gerado) → nada é compactado. Usado na request, na execução
 * (`tool_search`, erro de argumentos), na estimativa da compactação do histórico e nas telas.
 * `mode` padrão 'local' (o de 1.11.0) — quem monta a request passa o modo resolvido.
 */
export function toolsPlan(
  chat: Chat,
  session: SessionRef,
  history?: StoredMessage[],
  providerNames?: string[],
  mode: ToolSearchMode = 'local'
): ToolsPlan {
  const full = toolDefinitions(availableTools(chat, session, history), providerNames)
  if (!toolsReachModel(chat.config)) return planTools(full, chat.config, 'off')
  return planTools(full, chat.config, mode)
}

/** Mensagens que vão na request (fronteira em diante, sem as só de exibição). */
const sentMessages = (history: StoredMessage[]): StoredMessage[] =>
  activeHistory(history).filter((m) => !isDisplayOnly(m.meta))

/**
 * Modo de envio das tools para esta sessão/provedor/modelo (@shared/toolSearch →
 * resolveToolSearchMode; = desktop): o mesmo na request, na execução e nas telas de tools. A
 * compactação compara com as tools que ESTE aparelho manda; as falhas lembradas são as daqui.
 */
export function resolveToolMode(
  chat: Chat,
  session: SessionRef & { model: string },
  history: StoredMessage[] | undefined,
  provider: Pick<Provider, 'id' | 'baseUrl' | 'kind'>
): ToolSearchModeResult {
  const local = toolsPlan(chat, session, history, undefined, 'local')
  return resolveToolSearchMode({
    kind: providerKind(provider),
    baseUrl: provider.baseUrl,
    providerId: provider.id,
    model: session.model,
    info: modelInfoLoose(provider.id, session.model),
    cfg: chat.config,
    wouldCompact: local.compacted.length > 0,
    sent: history ? sentMediaOf(sentMessages(history).map((m) => m.message)) : null,
    caps: capsSource(),
    extraHosts: nativeTestHosts
  })
}

/**
 * System prompt → <environment> → memória (índice + help, só a principal) → texto das tools (o
 * gerado segue a compactação) → prompt fixo das tools compactadas (versão local com alguma
 * compacta) ou o prompt fixo NATIVO (busca nativa com alguma adiada) — = desktop.
 */
export function systemContent(
  chat: Chat,
  session: Pick<Session, 'depth'> & { id?: string },
  env: EnvInfo = envSource(),
  history?: StoredMessage[],
  mode: ToolSearchMode = 'local',
  /** Prompt fixo no lugar do do plano (buildRequest: o nativo com as adiadas efetivas). */
  promptOverride?: string | null
): string {
  const cfg = chat.config
  let s = session.depth === 0 ? (cfg.systemPrompt ?? '') : (cfg.subagentSystemPrompt ?? '')
  const add = (block: string): void => {
    if (!block) return
    s = s ? `${s}\n\n${block}` : block
  }
  if (cfg.envInPrompt) add(environmentBlock(env))
  const memory = memoryPromptSource(chat, session)
  if (memory) {
    add(memory.index ?? '')
    add(memory.help ?? '')
  }
  const plan = toolsPlan(chat, session, history, undefined, mode)
  if (cfg.toolsInPrompt) {
    add(
      cfg.toolsPromptText ??
        defaultToolsPrompt(plan.definitions, cfg.nativeTools, { subagent: session.depth > 0 })
    )
  }
  return withCompactPrompt(s, promptOverride === undefined ? plan : { prompt: promptOverride })
}

/** Reenvio de blocos nativos + adiadas efetivas de uma request nativa (ver nativeDeferral). */
export interface NativeDeferral {
  /** Histórico (sanitizado) com `native` só nas mensagens reenviadas. */
  messages: ApiMessage[]
  replayed: number
  skipped: number
  /** Fora de `toolsFull`, mas carregadas: usadas no histórico enviado sem a descoberta junto. */
  forceLoaded: string[]
  /** As que vão de fato com `defer_loading` (o prompt fixo nativo lista estas). */
  deferred: string[]
}

/**
 * Num modo nativo (= desktop): quais respostas vão com os blocos do provedor (mesmo canal, ainda
 * batendo com o texto; referências filtradas às tools da request — as que ESTE aparelho manda) e
 * quais adiadas vão carregadas por já terem sido usadas sem a descoberta junto. A mesma conta da
 * request serve as telas de tools (a "Definição" mostra o que vai).
 */
export function nativeDeferral(
  plan: Pick<ToolsPlan, 'mode' | 'full' | 'deferred'>,
  sanitized: ApiMessage[],
  channel: { providerId: string; model: string } | null
): NativeDeferral {
  if (!isNativeMode(plan.mode))
    return { messages: sanitized, replayed: 0, skipped: 0, forceLoaded: [], deferred: [] }
  const names = new Set(plan.full.map((d) => d.function.name))
  const r = prepareNativeReplay(sanitized, channel ? { mode: plan.mode, ...channel } : null, names)
  const forceLoaded = forceLoadedTools(r.messages, plan.deferred, r.discovered)
  return {
    messages: r.messages,
    replayed: r.replayed,
    skipped: r.skipped,
    forceLoaded,
    deferred: plan.deferred.filter((n) => !forceLoaded.includes(n))
  }
}

/** Histórico que vai na request (sanitizado; `noReplay` tira o `native` dessas mensagens). */
export function sentHistory(
  history: StoredMessage[],
  kind: ProviderKind,
  keepNative: boolean,
  noReplay?: ReadonlySet<string>
): ApiMessage[] {
  const stored = sentMessages(history).map((m) =>
    noReplay?.has(m.id) && m.message.role === 'assistant' && m.message.native
      ? { ...m, message: { ...m.message, native: undefined } }
      : m
  )
  return sanitizeHistory(
    stored.map((m) => m.message),
    kind === 'openrouter',
    keepNative
  )
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

/**
 * Igual ao desktop: tool órfã fora, tool_call sem resposta ganha placeholder, reasoning só no
 * OpenRouter; `native` (blocos do provedor, 1.12.0) só com `keepNative` (modo de busca nativa — quem
 * monta confere o reenvio em prepareNativeReplay), nunca para outro formato de API; chamadas antigas
 * de `search_tool` vão como `tool_search` (o nome novo — só na cópia; o histórico salvo não muda).
 */
export function sanitizeHistory(
  messages: ApiMessage[],
  keepReasoning: boolean,
  keepNative = false
): ApiMessage[] {
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
      if (!keepNative && 'native' in a) {
        const { native: _n, ...rest } = a
        void _n
        a = rest
      }
      if (a.tool_calls?.some((t) => wireToolName(t.function.name) !== t.function.name)) {
        a = {
          ...a,
          tool_calls: a.tool_calls.map((t) =>
            wireToolName(t.function.name) === t.function.name
              ? t
              : { ...t, function: { ...t.function, name: wireToolName(t.function.name) } }
          )
        }
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
  /** Força o modo (queda para a versão local; repetição da compactação sem tools) — = desktop. */
  modeOverride?: ToolSearchMode
  /** false = nenhum `native` reenviado (repetição depois de uma recusa do reenvio). */
  replay?: boolean
  /** Ids de mensagens cujo `native` não é mais reenviado nesta sessão (recusado antes). */
  noReplay?: ReadonlySet<string>
}

/**
 * Request EXATA da próxima chamada, no formato do adaptador do provedor (mesma lógica do desktop):
 * só o histórico desde a última compactação, sem mensagens só de exibição; params não aceitos pelo
 * modelo ficam de fora (notas em `notes`). Modo das tools (@shared/toolSearch): resolvido aqui (ou
 * `modeOverride`); nos nativos, as fora de `toolsFull` vão com `defer_loading` + a busca do servidor
 * por último, os blocos nativos das respostas anteriores são reenviados (mesmo canal e ainda batendo
 * com o texto) e uma adiada usada no histórico sem a descoberta junto vai carregada; o OpenRouter vai
 * para `{baseUrl}/messages` (Messages API, Bearer). `options` = as opções ou só o `env` (a
 * compactação vendorada repassa `env` e, depois, as opções da busca nativa em `more`).
 */
export function buildRequest(
  chat: Chat,
  session: Pick<Session, 'depth' | 'model'> & { id?: string },
  history: StoredMessage[],
  provider: Provider,
  options: BuildOptions | EnvInfo = {},
  more: BuildOptions = {}
): BuiltRequest {
  // a compactação (vendorada) repassa só `env` — o leitor dos anexos vem dentro dele
  const opts: BuildOptions = {
    ...('os' in options ? { env: options, read: options.read } : options),
    ...more
  }
  const cfg = chat.config
  const kind = providerKind(provider)
  const openRouter = kind === 'openrouter'
  const read = opts.read ?? opts.env?.read ?? noAttachments

  const resolved: ToolSearchModeResult = opts.modeOverride
    ? { mode: opts.modeOverride, api: kind === 'anthropic' ? 'messages' : 'chat' }
    : resolveToolMode(chat, session, history, provider)
  // as definições como vão (1.11.0: compactas + tool_search; 1.12.0: completas e adiadas nos
  // modos nativos). planTools rebaixa para 'off' quando não há o que compactar/adiar.
  const plan = toolsPlan(chat, session, history, undefined, resolved.mode)
  const mode = plan.mode
  const native = isNativeMode(mode)

  // reenvio dos blocos nativos (mesmo provedor/API/modelo, ainda batendo com o texto; referências
  // só às tools que ESTE aparelho manda) e as adiadas já usadas sem a descoberta → carregadas
  const nd = nativeDeferral(
    plan,
    sentHistory(history, kind, native, opts.noReplay),
    opts.replay === false ? null : { providerId: provider.id, model: session.model }
  )
  const hist = nd.messages
  // prompt fixo: o da versão local, ou o nativo com as adiadas EFETIVAS desta request
  const sys = systemContent(
    chat,
    session,
    opts.env ?? envSource(),
    history,
    mode,
    isNativeMode(mode) ? nativeToolSearchPrompt(nd.deferred, mode) : undefined
  )
  const toolSearch: RequestToolSearch = {
    mode,
    ...(resolved.reason && mode === 'local' ? { reason: resolved.reason } : {}),
    ...(resolved.failure && mode === 'local' ? { failure: resolved.failure } : {}),
    deferred: nd.deferred,
    forceLoaded: nd.forceLoaded,
    replayed: nd.replayed,
    skipped: nd.skipped
  }
  const messages: ApiMessage[] = []
  if (sys) messages.push({ role: 'system', content: sys })
  messages.push(...hist)

  const signature = resolveAppSignatureHeaders(
    cfg.appSignature ?? DEFAULT_APP_SIGNATURE,
    cfg.appSignatureCustom
  )
  const adapter = adapterFor(kind)
  const tools = plan.definitions
  const params = cfg.params ?? {}
  const extra = parseExtraBody(params.extraBody)
  const support = filterParams(params, kind, provider.id, session.model, extra)
  const notes = [...toolSearchNotes(toolSearch, plan.full.length), ...support.notes]
  const extras = { ...(notes.length ? { notes } : {}), toolSearch }

  if (native) {
    // Messages API: Anthropic nativa ou o /messages do OpenRouter (Bearer, assinatura de app)
    const sent = expandAttachments(dropAudioParts(messages), read)
    const toolsArray = cfg.nativeTools
      ? nativeToolsArray(plan.full, {
          deferred: new Set(toolSearch.deferred),
          entry: plan.searchEntry,
          cache: cfg.cacheEnabled
        })
      : undefined
    return {
      url: openRouter ? messagesUrl(provider.baseUrl) : adapter.chatUrl(provider.baseUrl),
      headers: openRouter
        ? buildHeaders(provider, signature)
        : adapter.headers(provider, signature),
      body: buildAnthropicBody({
        model: session.model,
        messages: sent,
        toolsArray,
        params: support.send,
        cacheEnabled: cfg.cacheEnabled,
        extra,
        flavor: openRouter ? 'openrouter' : 'anthropic',
        replayNative: true
      }),
      kind,
      api: 'messages',
      ...extras
    }
  }

  if (kind === 'anthropic') {
    const sent = expandAttachments(dropAudioParts(messages), read)
    return {
      url: adapter.chatUrl(provider.baseUrl),
      headers: adapter.headers(provider, signature),
      body: buildAnthropicBody({
        model: session.model,
        messages: sent,
        tools: cfg.nativeTools && tools.length ? tools : undefined,
        params: support.send,
        cacheEnabled: cfg.cacheEnabled,
        extra
      }),
      kind,
      api: 'messages',
      ...extras
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

  if (cfg.nativeTools && tools.length) body.tools = tools

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
    api: 'chat',
    ...extras
  }
}

/** Notas da request sobre a busca de ferramentas (só quando há o que dizer) — = desktop. */
function toolSearchNotes(t: RequestToolSearch, total: number): string[] {
  const out: string[] = []
  if (isNativeMode(t.mode)) {
    const loaded = total - t.deferred.length
    out.push(
      `Busca de ferramentas: ${TOOL_SEARCH_MODE_LABEL[t.mode]} — ${loaded} carregada${loaded === 1 ? '' : 's'}, ${t.deferred.length} adiada${t.deferred.length === 1 ? '' : 's'} (defer_loading).`
    )
    if (t.replayed || t.skipped)
      out.push(
        `${t.replayed} resposta${t.replayed === 1 ? '' : 's'} reenviada${t.replayed === 1 ? '' : 's'} com os blocos nativos do provedor${t.skipped ? `; ${t.skipped} pela conversão normal (outro provedor/modelo, editada ou reenvio recusado)` : ''}.`
      )
    if (t.forceLoaded.length)
      out.push(
        `Carregadas por já terem sido usadas sem a busca no histórico enviado: ${t.forceLoaded.join(', ')}.`
      )
  } else if (t.mode === 'local' && t.reason)
    out.push(`Busca de ferramentas: ${TOOL_SEARCH_MODE_LABEL.local} — ${t.reason}.`)
  return out
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
