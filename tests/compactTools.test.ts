// Tools compactadas e `datetime` no celular (protocolo 1.11.0, SYNC_PROTOCOL.md §4.3.6 — "Tools
// compactadas e `datetime`"): o plano da request sobre as tools que o CELULAR manda (as de
// localização deste aparelho e o `browse_url` do celular inclusive) na VERSÃO LOCAL (provedor
// genérico; a busca nativa de 1.12.0 em toolSearch.test.ts), a `tool_search` (antes `search_tool`)
// devolvendo exatamente as definições sem compactação, o erro de argumentos com a definição completa, o
// `datetime` (nomes em pt-BR, fuso America/Sao_Paulo), o turno de voz com `end_call` sempre completa
// e as unidades da herança (`toolsCompact`, `toolsFull.<tool>`). Runner contra o provedor falso.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  availableTools,
  buildRequest,
  MOBILE_BROWSE_URL_DESCRIPTION,
  MOBILE_TOOLS,
  setLocationSource,
  setMemorySources,
  setVoiceCallSource,
  systemContent,
  toolDefinitions,
  toolsPlan
} from '../src/agent/request'
import {
  COMPACT_TOOLS_PROMPT,
  COMPACTABLE_TOOL_NAMES,
  compactToolDefinition,
  invalidArgsText,
  planTools,
  runSearchTool,
  SEARCH_TOOL_DEFINITION,
  sendsCompact,
  sentToolDefinition,
  TOOL_SHORT_DESCRIPTIONS,
  validateToolArgs,
  withFullTool,
  wordCount
} from '../src/vendor/shared/compactTools'
import {
  DATETIME_CODES,
  formatDateTime,
  runDatetimeTool,
  zonedParts
} from '../src/vendor/shared/datetime'
import {
  applyChatEdit,
  effectiveChatConfig,
  newInheritingChatConfig,
  personaDefines,
  readUnit,
  revertToInherit,
  sameUnit,
  unitsOfKey,
  writeUnit,
  type InheritConfig,
  type InheritEnv
} from '../src/vendor/shared/chatInherit'
import { DEFAULT_CHAT_CONFIG } from '../src/vendor/shared/defaults'
import { APP_TOOL_NAMES, PHONE_TOOLS } from '../src/vendor/shared/deviceTools'
import { sanitizePresetConfig } from '../src/vendor/shared/presets'
import { MEMORY_TOOL_NAMES, TOOL_LABELS } from '../src/vendor/shared/tools'
import { toolPhraseCategory } from '../src/vendor/shared/voicePolicy'
import type { ResolvedVoiceCall } from '../src/vendor/shared/voice'
import type { Chat, ChatConfig, Provider, ToolName } from '../src/vendor/shared/types'
import { unitLabel, unitValueText } from '../src/chat/inheritUi'
import { finalizeNewChat, resolveNewChat } from '../src/host/newChat'
import { compactStatusText } from '../src/settings/compactUi'
import { toolIcon, toolSummary } from '../src/chat/toolSummary'
import { LocationService } from '../src/location/service'
import { DEFAULT_LOCATION_SETTINGS } from '../src/location/settings'
import { OsmGeocoder } from '../src/location/nominatim'
import { OverpassClient } from '../src/location/overpass'
import { FakeDevice, fakeFetch, osmRoutes } from './fakes/osm'
import { makeHarness, until, type Harness } from './hostHarness'

const UA = 'ClearChat/0.0.0-test (+https://clear.ezenere.com)'

/** OpenAI-compatible genérico: a VERSÃO LOCAL (a busca nativa de 1.12.0 em toolSearch.test.ts). */
const provider: Provider = {
  id: 'p',
  name: 'P',
  baseUrl: 'https://llm.example.com/v1',
  apiKey: 'k',
  headers: {},
  createdAt: 0
}

const chat = (cfg: Partial<ChatConfig> = {}, id = 'c'): Chat => ({
  id,
  title: '',
  config: { ...DEFAULT_CHAT_CONFIG(''), providerId: 'p', model: 'm', ...cfg },
  mainSessionId: 's',
  createdAt: 0,
  updatedAt: 0
})

function locationService(): LocationService {
  const net = fakeFetch(osmRoutes())
  return new LocationService({
    device: new FakeDevice(),
    settings: () => ({ ...DEFAULT_LOCATION_SETTINGS }),
    overpass: new OverpassClient({ fetch: net.fetch, userAgent: UA, minIntervalMs: 0 }),
    geocoder: new OsmGeocoder({ fetch: net.fetch, userAgent: UA, sleep: async () => undefined }),
    now: () => 30_000
  })
}

type Def = { type: string; function: { name: string; description: string; parameters: unknown } }
const namesOf = (tools: unknown): string[] => ((tools ?? []) as Def[]).map((t) => t.function.name)
const sysOf = (body: Record<string, unknown>): string => {
  const m = (body.messages as { role: string; content: unknown }[])[0]
  if (m?.role !== 'system') return ''
  return typeof m.content === 'string'
    ? m.content
    : (m.content as { text: string }[]).map((p) => p.text).join('')
}

// tudo que o app conhece ligado (o padrão de "Novos chats"): o celular só manda as portáveis
const ALL = { enabledTools: [...APP_TOOL_NAMES] }
const PHONE_SENT: string[] = [
  'web_search',
  'browse_url',
  'list_models',
  'delegate_task',
  'get_chat_info',
  'list_chats',
  'send_to_chat',
  'read_history',
  'check_subagents',
  'wait_subagents',
  'cancel_subagent',
  'message_subagent',
  'ask_user',
  'datetime',
  'get_location',
  'nearby_places'
]

describe('plano das tools do celular (request)', () => {
  beforeEach(() => setLocationSource(locationService()))
  afterEach(() => {
    setLocationSource(null)
    setVoiceCallSource(() => null)
    setMemorySources({ prompt: () => null, tools: () => [] })
  })

  it('datetime está no padrão do app e no que o celular executa (portátil)', () => {
    expect(APP_TOOL_NAMES).toContain('datetime')
    expect(DEFAULT_CHAT_CONFIG('').enabledTools).toContain('datetime')
    expect(MOBILE_TOOLS).toContain('datetime')
    expect(DEFAULT_CHAT_CONFIG('').toolsCompact).toBe(true)
    expect(DEFAULT_CHAT_CONFIG('').toolsFull).toEqual([])
    expect(TOOL_LABELS.datetime).toBe('Data e hora')
    // a tool_search (e o nome antigo search_tool) não é escolhível
    expect(APP_TOOL_NAMES).not.toContain('tool_search')
    expect(COMPACTABLE_TOOL_NAMES).not.toContain('tool_search')
    expect(APP_TOOL_NAMES).not.toContain('search_tool')
    expect(COMPACTABLE_TOOL_NAMES).not.toContain('search_tool')
    expect(COMPACTABLE_TOOL_NAMES).not.toContain('end_call')
    // descrição curta de 1 a 20 palavras para todas as do celular (localização inclusive)
    for (const t of [...MOBILE_TOOLS, ...MEMORY_TOOL_NAMES]) {
      const d = TOOL_SHORT_DESCRIPTIONS[t]
      expect(d, t).toBeTruthy()
      expect(wordCount(d)).toBeGreaterThanOrEqual(1)
      expect(wordCount(d)).toBeLessThanOrEqual(20)
    }
  })

  it('padrão (compactação ligada): compactas com esquema vazio, tool_search completa no fim e o prompt fixo no fim do system', () => {
    const c = chat({ ...ALL, systemPrompt: 'SYS' })
    const req = buildRequest(c, { depth: 0, model: 'm' }, [], provider)
    const tools = req.body.tools as Def[]
    expect(namesOf(tools)).toEqual([...PHONE_SENT, 'tool_search'])
    for (const t of tools.slice(0, -1)) {
      expect(t.function.parameters).toEqual({ type: 'object', properties: {} })
      expect(t.function.description).toBe(TOOL_SHORT_DESCRIPTIONS[t.function.name])
    }
    // as do celular com a descrição curta delas (PHONE_TOOL_SHORT)
    expect(tools.find((t) => t.function.name === 'get_location')!.function.description).toMatch(
      /^Localização atual do usuário pelo celular/
    )
    expect(tools.at(-1)).toEqual(SEARCH_TOOL_DEFINITION)
    // nada do computador (nem compacto)
    expect(JSON.stringify(tools)).not.toMatch(/"name":"(shell|read_file|present_file)"/)
    // prompt fixo: só no fim, depois do resto, separado por linha em branco
    const sys = sysOf(req.body)
    expect(sys.startsWith('SYS\n\n<environment>')).toBe(true)
    expect(sys.endsWith(`\n\n${COMPACT_TOOLS_PROMPT}`)).toBe(true)
    // determinístico (prefixo de cache estável)
    const again = buildRequest(c, { depth: 0, model: 'm' }, [], provider)
    expect(JSON.stringify(again.body)).toBe(JSON.stringify(req.body))
  })

  it('toolsFull: essas vão completas (as do celular como o celular as manda); todas completas → sem tool_search nem prompt', () => {
    const c = chat({ ...ALL, toolsFull: ['browse_url', 'get_location'] as ToolName[] })
    const tools = buildRequest(c, { depth: 0, model: 'm' }, [], provider).body.tools as Def[]
    const browse = tools.find((t) => t.function.name === 'browse_url')!
    expect(browse.function.description).toBe(MOBILE_BROWSE_URL_DESCRIPTION)
    expect(browse).toEqual(toolDefinitions(['browse_url'])[0])
    const loc = tools.find((t) => t.function.name === 'get_location')!
    expect(loc).toEqual(toolDefinitions(['get_location' as ToolName])[0])
    expect(tools.find((t) => t.function.name === 'nearby_places')!.function.parameters).toEqual({
      type: 'object',
      properties: {}
    })
    expect(namesOf(tools).at(-1)).toBe('tool_search')

    const allFull = chat({
      enabledTools: ['web_search', 'datetime'],
      toolsFull: ['web_search', 'datetime']
    })
    const r2 = buildRequest(allFull, { depth: 0, model: 'm' }, [], provider)
    expect(namesOf(r2.body.tools)).toEqual(['web_search', 'datetime'])
    expect(sysOf(r2.body)).not.toContain(COMPACT_TOOLS_PROMPT)
  })

  it('compactação desligada: as definições completas de antes, sem tool_search nem prompt', () => {
    const off = chat({ ...ALL, toolsCompact: false })
    const req = buildRequest(off, { depth: 0, model: 'm' }, [], provider)
    expect(req.body.tools).toEqual(toolDefinitions(availableTools(off, { depth: 0 })))
    expect(namesOf(req.body.tools)).toEqual(PHONE_SENT)
    expect(sysOf(req.body)).not.toContain(COMPACT_TOOLS_PROMPT)
  })

  it('sem tools chegando ao modelo nada é compactado; o texto GERADO segue a compactação; o do usuário vai como está', () => {
    // sem tools nativas e sem o texto: nada vai — nem tool_search nem o prompt
    const none = chat({ enabledTools: ['web_search'], nativeTools: false, toolsInPrompt: false })
    const r0 = buildRequest(none, { depth: 0, model: 'm' }, [], provider)
    expect(r0.body.tools).toBeUndefined()
    expect(sysOf(r0.body)).not.toContain(COMPACT_TOOLS_PROMPT)
    expect(toolsPlan(none, { depth: 0 }).compacted).toEqual([])
    // sem tools ligadas: nada a compactar
    const empty = chat({ enabledTools: [] })
    expect(buildRequest(empty, { depth: 0, model: 'm' }, [], provider).body.tools).toBeUndefined()
    expect(systemContent(empty, { depth: 0 })).not.toContain(COMPACT_TOOLS_PROMPT)
    // modo texto com o texto gerado: compactas com a descrição curta + a tool_search completa
    const text = chat({
      enabledTools: ['web_search', 'datetime'],
      nativeTools: false,
      toolsInPrompt: true
    })
    const sys = systemContent(text, { depth: 0 })
    expect(sys).toContain(`## web_search\n${TOOL_SHORT_DESCRIPTIONS.web_search}`)
    expect(sys).toContain('Parâmetros (JSON Schema): {"type":"object","properties":{}}')
    expect(sys).toContain(`## tool_search\n${SEARCH_TOOL_DEFINITION.function.description}`)
    expect(sys.endsWith(COMPACT_TOOLS_PROMPT)).toBe(true)
    // texto do usuário sem tools nativas: vai como está, nada compactado
    const custom = chat({
      enabledTools: ['web_search'],
      nativeTools: false,
      toolsInPrompt: true,
      toolsPromptText: 'MINHAS TOOLS'
    })
    expect(systemContent(custom, { depth: 0 })).not.toContain(COMPACT_TOOLS_PROMPT)
    expect(systemContent(custom, { depth: 0 })).toContain('MINHAS TOOLS')
  })

  it('subagentes e memória também vão compactos', () => {
    setMemorySources({ prompt: () => null, tools: () => [...MEMORY_TOOL_NAMES] })
    const c = chat({ enabledTools: ['web_search', 'delegate_task'] })
    const sub = buildRequest(c, { depth: 1, model: 'm' }, [], provider)
    expect(namesOf(sub.body.tools)).toEqual([
      'web_search',
      'delegate_task',
      ...MEMORY_TOOL_NAMES,
      'tool_search'
    ])
    const mem = (sub.body.tools as Def[]).find((t) => t.function.name === 'memory_write')!
    expect(mem.function.parameters).toEqual({ type: 'object', properties: {} })
    // memory_write completa por toolsFull
    const full = chat({ enabledTools: ['web_search'], toolsFull: ['memory_write'] as ToolName[] })
    const r = buildRequest(full, { depth: 0, model: 'm' }, [], provider)
    const mw = (r.body.tools as Def[]).find((t) => t.function.name === 'memory_write')!
    expect(mw).toEqual(toolDefinitions(['memory_write'])[0])
  })

  it('turno de voz: end_call sempre completa (depois das outras) e a tool_search depois dela', () => {
    const call = { endCall: true, tools: null, model: null } as unknown as ResolvedVoiceCall
    setVoiceCallSource((_c, s) => (s.id === 's1' ? call : null))
    const c = chat({ enabledTools: ['web_search', 'datetime'] })
    const req = buildRequest(c, { id: 's1', depth: 0, model: 'm' }, [], provider)
    const tools = req.body.tools as Def[]
    expect(namesOf(tools)).toEqual(['web_search', 'datetime', 'end_call', 'tool_search'])
    expect(tools[2]).toEqual(toolDefinitions(['end_call'])[0])
    expect(tools[0].function.parameters).toEqual({ type: 'object', properties: {} })
    expect(toolsPlan(c, { id: 's1', depth: 0 }).compacted).toEqual(['web_search', 'datetime'])
    // só end_call (as tools da chamada desligadas): nada compacto → sem tool_search nem prompt
    const only = chat({ enabledTools: [] })
    const r2 = buildRequest(only, { id: 's1', depth: 0, model: 'm' }, [], provider)
    expect(namesOf(r2.body.tools)).toEqual(['end_call'])
    expect(sysOf(r2.body)).not.toContain(COMPACT_TOOLS_PROMPT)
  })
})

describe('tool_search e argumentos inválidos (puro)', () => {
  beforeEach(() => setLocationSource(locationService()))
  afterEach(() => setLocationSource(null))

  it('tool_search devolve exatamente as definições sem compactação (localização e browse_url do celular)', () => {
    const c = chat(ALL)
    const plan = toolsPlan(c, { depth: 0 })
    const off = buildRequest(
      chat({ ...ALL, toolsCompact: false }),
      { depth: 0, model: 'm' },
      [],
      provider
    )
    const uncompacted = new Map((off.body.tools as Def[]).map((d) => [d.function.name, d.function]))
    const names = ['browse_url', 'get_location', 'nearby_places', 'datetime', 'web_search']
    const r = runSearchTool({ names }, plan.full)
    expect(r.status).toBe('ok')
    expect(JSON.parse(r.content)).toEqual(names.map((n) => uncompacted.get(n)))
    // e o texto é o JSON do `function` de cada uma, na ordem pedida
    expect(r.content).toBe(`[${names.map((n) => JSON.stringify(uncompacted.get(n))).join(',')}]`)
    // nome desconhecido (uma do computador não foi enviada daqui): erro com as disponíveis + as achadas
    const bad = runSearchTool({ names: ['shell', 'datetime'] }, plan.full)
    expect(bad.status).toBe('error')
    expect(bad.content).toContain('Erro: ferramenta desconhecida: shell.')
    expect(bad.content).toContain(`Disponíveis: ${PHONE_SENT.join(', ')}.`)
    expect(bad.content).toContain(JSON.stringify(uncompacted.get('datetime')))
  })

  it('argumentos inválidos de uma compacta → erro com a definição completa (do celular)', () => {
    const plan = toolsPlan(chat(ALL), { depth: 0 })
    const near = plan.full.find((d) => (d.function.name as string) === 'nearby_places')!
    const problems = validateToolArgs(near, { what: 5, radius_m: 'longe', foo: 1 })
    expect(problems.length).toBeGreaterThan(0)
    const text = invalidArgsText(near, problems)
    expect(text).toContain('Erro: argumentos inválidos para nearby_places:')
    expect(text).toContain(
      `A ferramenta nearby_places foi enviada compactada; a definição completa dela é:\n${JSON.stringify(near.function)}`
    )
    // números/booleanos em texto valem
    const web = plan.full.find((d) => d.function.name === 'web_search')!
    expect(validateToolArgs(web, { query: 42 })).toEqual([])
    expect(validateToolArgs(web, {})).toEqual(['falta "query" (obrigatório)'])
  })

  it('UI: a definição mostrada é a que vai (compacta ou completa)', () => {
    const [def] = toolDefinitions(['browse_url'])
    expect(sentToolDefinition(def, {})).toEqual(compactToolDefinition(def))
    expect(sentToolDefinition(def, { toolsCompact: false })).toBe(def)
    expect(sentToolDefinition(def, { toolsFull: ['browse_url'] })).toBe(def)
    expect(sendsCompact('end_call', {})).toBe(false)
    expect(withFullTool(['get_location', 'mcp_x'], 'web_search', true)).toEqual([
      'web_search',
      'get_location',
      'mcp_x'
    ])
    expect(planTools([def], {}).definitions.at(-1)).toEqual(SEARCH_TOOL_DEFINITION)
  })
})

describe('datetime (Intl com fuso)', () => {
  // 2026-11-13T17:05:09Z = 14:05:09 em São Paulo (UTC-03:00), sexta-feira
  const now = Date.UTC(2026, 10, 13, 17, 5, 9)
  const SP = { now, timeZone: 'America/Sao_Paulo' }

  it('sem format: ISO com deslocamento · dia da semana · fuso (exemplo do protocolo)', () => {
    expect(runDatetimeTool({}, SP)).toEqual({
      content: '2026-11-13T14:05:09-03:00 · sexta-feira · fuso America/Sao_Paulo (UTC-03:00)',
      status: 'ok'
    })
  })

  it('strftime com nomes em pt-BR', () => {
    const f = (format: string) => runDatetimeTool({ format }, SP).content
    expect(f('%A, %d de %B de %Y, %H:%M')).toBe('sexta-feira, 13 de novembro de 2026, 14:05')
    expect(f('%a %b %e %y %j %u %w')).toBe('sex nov 13 26 317 5 5')
    expect(f('%I:%M %p · %Z %z · %F %T · %D · %s · 100%%')).toBe(
      `02:05 PM · America/Sao_Paulo -0300 · 2026-11-13 14:05:09 · 11/13/26 · ${now / 1000} · 100%`
    )
    // sábado/março/meia-noite: "00" (nunca "24"); outros fusos
    const midnight = Date.UTC(2026, 2, 7, 3, 0, 0) // 00:00 em São Paulo
    expect(
      runDatetimeTool(
        { format: '%A %d %B %H:%M' },
        { now: midnight, timeZone: 'America/Sao_Paulo' }
      ).content
    ).toBe('sábado 07 março 00:00')
    expect(runDatetimeTool({ format: '%H:%M %z' }, { now, timeZone: 'Asia/Kolkata' }).content).toBe(
      '22:35 +0530'
    )
    expect(runDatetimeTool({ format: '%H %z %Z' }, { now, timeZone: 'UTC' }).content).toBe(
      '17 +0000 UTC'
    )
  })

  it('código desconhecido, % solto ou format não texto → erro com a lista', () => {
    const bad = runDatetimeTool({ format: '%Q' }, SP)
    expect(bad.status).toBe('error')
    expect(bad.content).toBe(
      `Erro: código de formato desconhecido: %Q. Aceitos: ${DATETIME_CODES.join(' ')}`
    )
    expect(runDatetimeTool({ format: 'x %' }, SP).status).toBe('error')
    expect(runDatetimeTool({ format: 5 }, SP).status).toBe('error')
    expect(formatDateTime(null, { now, timeZone: 'Nada/Disso' }).ok).toBe(false)
  })

  it('o fuso do aparelho por padrão (Intl)', () => {
    const p = zonedParts({ now })
    expect(p.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')
    expect(p.epochSeconds).toBe(now / 1000)
  })
})

describe('herança: toolsCompact e toolsFull.<tool>', () => {
  const env: InheritEnv = {
    defaults: { defaultProviderId: 'p', defaultModel: 'm' },
    providers: [{ id: 'p', baseUrl: 'https://openrouter.ai/api/v1' }]
  } as unknown as InheritEnv

  it('unidades: toolsCompact (ausente = true) e uma por tool em toolsFull (celular e memória inclusive)', () => {
    const units = unitsOfKey('toolsFull')
    for (const t of ['web_search', 'datetime', 'get_location', 'memory_write', ...PHONE_TOOLS])
      expect(units).toContain(`toolsFull.${t}`)
    expect(
      readUnit({ toolsFull: ['get_location'] as string[] as ToolName[] }, 'toolsFull.get_location')
    ).toBe(true)
    expect(readUnit({}, 'toolsFull.get_location')).toBeUndefined()
    expect(sameUnit('toolsCompact', undefined, true)).toBe(true)
    expect(sameUnit('toolsCompact', false, undefined)).toBe(false)
    expect(sameUnit('toolsFull.web_search', undefined, false)).toBe(true)
    const cfg: Partial<ChatConfig> = { toolsFull: ['mcp_x' as ToolName] }
    writeUnit(cfg, 'toolsFull.web_search', true)
    expect(cfg.toolsFull).toEqual(['web_search', 'mcp_x'])
    expect(personaDefines({ toolsFull: [] }, 'toolsFull.web_search')).toBe(true)
    expect(personaDefines({}, 'toolsCompact')).toBe(false)
    // persona: só booleano / lista de nomes (as desconhecidas ficam)
    expect(
      sanitizePresetConfig({ toolsCompact: 'x', toolsFull: ['web_search', 3, 'mcp_x'] })
    ).toEqual({
      toolsFull: ['web_search', 'mcp_x']
    })
    // rótulos da tela
    expect(unitLabel('toolsCompact')).toBe('Enviar tools compactadas')
    expect(unitLabel('toolsFull.get_location')).toBe('Tool Localização vai completa')
    expect(unitValueText('toolsFull.web_search', true)).toBe('completa')
    expect(unitValueText('toolsFull.web_search', undefined)).toBe('compacta')
    expect(unitValueText('toolsCompact', undefined)).toBe('ligado')
  })

  it('o chat herda da persona ao vivo; mudar aqui vira próprio por unidade; voltar a herdar', () => {
    const persona = { toolsCompact: false, toolsFull: ['web_search'] as ToolName[] }
    const record = {
      ...DEFAULT_CHAT_CONFIG(''),
      providerId: 'p',
      model: 'm',
      presetId: 'p1',
      overrides: {}
    } as InheritConfig
    const eff = effectiveChatConfig(record, persona, env)
    expect(eff.toolsCompact).toBe(false)
    expect(eff.toolsFull).toEqual(['web_search'])
    // persona sem os campos → padrão de "Novos chats" (true e [])
    const plain = effectiveChatConfig(record, { systemPrompt: 'x' }, env)
    expect(plain.toolsCompact).toBe(true)
    expect(plain.toolsFull).toEqual([])
    // ligar a compactação e marcar get_location completa neste chat: duas unidades próprias
    let ed = applyChatEdit(record, { toolsCompact: true }, persona, env)
    ed = applyChatEdit(
      ed,
      {
        toolsFull: withFullTool(
          effectiveChatConfig(ed, persona, env).toolsFull,
          'get_location',
          true
        )
      },
      persona,
      env
    )
    expect(ed.overrides).toEqual({ toolsCompact: true, 'toolsFull.get_location': true })
    // a persona muda as outras: o chat acompanha nelas
    const persona2 = { ...persona, toolsFull: ['web_search', 'datetime'] as ToolName[] }
    const eff2 = effectiveChatConfig(ed, persona2, env)
    expect(eff2.toolsCompact).toBe(true)
    expect(eff2.toolsFull).toEqual(['web_search', 'datetime', 'get_location'])
    // voltar a herdar a get_location
    const back = revertToInherit(ed, ['toolsFull.get_location'], persona2, env)
    expect(back.overrides).toEqual({ toolsCompact: true })
    expect(back.toolsFull).toEqual(['web_search', 'datetime'])
  })
})

describe('Novo chat e linha de estado', () => {
  it('Novo chat: a compactação da persona vem junto; só o que mudou na tela vira próprio', () => {
    const env = {
      defaults: {},
      providers: [{ id: 'p', baseUrl: 'https://openrouter.ai/api/v1' }]
    } as unknown as InheritEnv
    const providers = [provider]
    const persona = { toolsCompact: false, toolsFull: ['web_search'] as ToolName[] }
    const preset = {
      id: 'p1',
      name: 'P',
      description: '',
      icon: '',
      config: persona,
      createdAt: 0,
      updatedAt: 0
    }
    const base = resolveNewChat({}, providers, preset)
    expect(base.toolsCompact).toBe(false)
    expect(base.toolsFull).toEqual(['web_search'])
    const pick = {
      providerId: base.providerId,
      model: 'm',
      params: base.params ?? {},
      tools: base.enabledTools,
      presetId: 'p1'
    }
    const same = finalizeNewChat(
      base,
      { ...pick, toolsCompact: false, toolsFull: ['web_search'] },
      providers
    )
    const a = newInheritingChatConfig({ ...same, presetId: 'p1' }, persona, env)
    expect(Object.keys(a.overrides ?? {}).filter((u) => u.startsWith('tools'))).toEqual([])
    const changed = finalizeNewChat(
      base,
      { ...pick, toolsCompact: false, toolsFull: ['web_search', 'datetime'] },
      providers
    )
    const b = newInheritingChatConfig({ ...changed, presetId: 'p1' }, persona, env)
    expect(Object.keys(b.overrides ?? {}).filter((u) => u.startsWith('tools'))).toEqual([
      'toolsFull.datetime'
    ])
    // sem persona: o padrão do app (compactadas, nenhuma completa)
    const plain = resolveNewChat({}, providers, null)
    expect(plain.toolsCompact).toBe(true)
    expect(plain.toolsFull).toEqual([])
  })

  it('linha de estado da compactação', () => {
    expect(compactStatusText({}, ['web_search', 'datetime'])).toBe(
      '2 das ligadas vão compactas (+ tool_search e uma instrução curta no fim do system prompt).'
    )
    expect(compactStatusText({ toolsFull: ['web_search'] }, ['web_search', 'datetime'])).toMatch(
      /^1 das ligadas vai compacta/
    )
    expect(compactStatusText({ toolsFull: ['web_search'] }, ['web_search'])).toMatch(
      /^Todas as ligadas vão completas/
    )
    expect(compactStatusText({ toolsCompact: false }, ['web_search'])).toMatch(/^Desligado/)
  })
})

describe('cards e frases', () => {
  it('ícone e resumo de datetime/tool_search; sem frase de ferramenta na chamada', () => {
    expect(toolIcon('datetime')).toBe('calendar-outline')
    expect(toolIcon('tool_search')).toBe('book-outline')
    expect(toolSummary('datetime', { format: '%H:%M' })).toBe('%H:%M')
    expect(toolSummary('tool_search', { names: ['browse_url', 'get_location'] })).toBe(
      'browse_url, get_location'
    )
    // nome até 1.11.0 (chamadas antigas no histórico): mesmo ícone e resumo
    expect(toolIcon('search_tool')).toBe('book-outline')
    expect(toolSummary('search_tool', { names: ['web_search'] })).toBe('web_search')
    expect(toolPhraseCategory('datetime')).toBeNull()
    expect(toolPhraseCategory('tool_search')).toBeNull()
    expect(toolPhraseCategory('search_tool')).toBeNull()
  })
})

describe('runner (provedor falso): tool_search, argumentos inválidos e datetime', () => {
  let h: Harness
  afterEach(async () => {
    await h?.close()
    setLocationSource(null)
  })
  const newChat = (cfg: Partial<ChatConfig> = {}) => {
    const { chat: c, session } = h.stack.repo.createChat({
      config: {
        ...DEFAULT_CHAT_CONFIG(''),
        providerId: h.providerId,
        model: 'fake/agent',
        enabledTools: [
          'web_search',
          'browse_url',
          'datetime',
          ...(PHONE_TOOLS as ToolName[])
        ] as ToolName[],
        ...cfg
      },
      title: ''
    })
    return { chatId: c.id, sid: session.id }
  }
  const idle = (sid: string) => until(() => !h.stack.runner.isRunning(sid), 10_000, 'turno')
  const lastTool = (sid: string) =>
    h.stack.repo
      .path(sid)
      .filter((m) => m.message.role === 'tool')
      .pop()!

  it('tool_search → as definições completas como iriam sem compactação (as do celular inclusive)', async () => {
    const loc = locationService()
    h = await makeHarness({ location: loc })
    const { sid } = newChat()
    await h.stack.runner.send(sid, '/lookup browse_url nearby_places get_location')
    await idle(sid)
    const t = lastTool(sid)
    expect(t.meta.toolStatus).toBe('ok')
    const req = h.llm.requests.find((r) => Array.isArray(r.body.tools))!
    expect(namesOf(req.body.tools).at(-1)).toBe('tool_search')
    // o mesmo chat sem compactação: as definições que iriam
    const { sid: sid2 } = newChat({ toolsCompact: false })
    await h.stack.runner.send(sid2, 'oi')
    await idle(sid2)
    const full = h.llm.requests.filter((r) => Array.isArray(r.body.tools)).pop()!
    const byName = new Map((full.body.tools as Def[]).map((d) => [d.function.name, d.function]))
    expect(namesOf(full.body.tools)).not.toContain('tool_search')
    expect(JSON.parse(String(t.message.content))).toEqual(
      ['browse_url', 'nearby_places', 'get_location'].map((n) => byName.get(n))
    )
    expect(byName.get('browse_url')!.description).toBe(MOBILE_BROWSE_URL_DESCRIPTION)
  })

  it('argumentos fora do esquema numa compacta: a tool roda; se falhar, o erro dela + a definição completa; completa → erro normal da tool', async () => {
    h = await makeHarness()
    const { sid } = newChat()
    await h.stack.runner.send(sid, '/badargs')
    // nada barra antes: a chamada segue o caminho normal (web_search pede aprovação)
    await until(() => h.stack.runner.approvals.list().length === 1, 8000, 'aprovação')
    h.stack.runner.approve(h.stack.runner.approvals.list()[0].id, 'allow')
    await idle(sid)
    const t = lastTool(sid)
    expect(t.meta.toolStatus).toBe('error')
    const text = String(t.message.content)
    expect(text).toMatch(/^Erro: /)
    expect(text).toContain(
      'Os argumentos não seguem o esquema de web_search: falta "query" (obrigatório); parâmetro desconhecido: "q".'
    )
    const [web] = toolDefinitions(['web_search'])
    expect(text).toContain(
      `foi enviada compactada; a definição completa dela é:\n${JSON.stringify(web.function)}`
    )
    // web_search completa (toolsFull): o erro normal da tool, sem a definição
    const { sid: s2 } = newChat({ toolsFull: ['web_search'] })
    await h.stack.runner.send(s2, '/badargs')
    await until(() => h.stack.runner.approvals.list().length === 1, 8000, 'aprovação')
    h.stack.runner.approve(h.stack.runner.approvals.list()[0].id, 'allow')
    await idle(s2)
    const t2 = String(lastTool(s2).message.content)
    expect(t2).toContain('query')
    expect(t2).not.toContain('foi enviada compactada')
  })

  it('datetime roda sem aprovação, no fuso do aparelho; a tool_search sem compactação não existe', async () => {
    h = await makeHarness()
    const { sid } = newChat({ toolsCompact: false })
    await h.stack.runner.send(sid, '/now %Y-%m-%d')
    await idle(sid)
    expect(h.stack.runner.approvals.list()).toEqual([])
    const t = lastTool(sid)
    expect(t.meta.toolStatus).toBe('ok')
    expect(String(t.message.content)).toBe(runDatetimeTool({ format: '%Y-%m-%d' }).content)
    const reply = String(h.stack.repo.path(sid).pop()!.message.content)
    expect(reply).toContain('Resultado recebido (datetime)')
    await h.stack.runner.send(sid, '/lookup web_search')
    await idle(sid)
    expect(String(lastTool(sid).message.content)).toBe(
      'Erro: a ferramenta "tool_search" não está disponível nesta sessão.'
    )
  })
})
