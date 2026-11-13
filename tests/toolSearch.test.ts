// Busca nativa de ferramentas no celular (protocolo 1.12.0 — SYNC_PROTOCOL.md §4.3.6 "Busca nativa
// de ferramentas", §4.3.8 "Blocos nativos do provedor", §4.4 `toolSearchCaps`), sem chamada paga —
// espelho de e2e/toolSearch.test.ts do desktop:
// (A) a lógica pura vendorada (@shared/toolSearch): tabela de modos, suporte por modelo, bloqueios da
//     Messages API, plano/itens do array tools, `native` só quando preciso, reenvio (canal,
//     consistência, filtro de referências, adiadas carregadas), falhas lembradas (24 h), renome;
// (B) a request do celular (buildRequest, pura): native-anthropic, native-openrouter (/messages com
//     Bearer), versão local por motivo (variante `:free` → id base), reenvio/descarte, compactação,
//     e o celular hospedando um chat do computador SEM as tools de lá (referências filtradas, nada do
//     computador no array tools);
// (C) o parse do SSE (formas documentadas) e o custo pelo GET /generation;
// (D) o runner real com provedores FALSOS locais (127.0.0.1 tratado como host oficial): ida e volta
//     com os blocos reenviados, OpenRouter /messages + custo, queda para a versão local lembrada no
//     KeyValueStore do aparelho, erro do pedido não lembrado, repetição sem reenvio, `pause_turn`,
//     `tool_search` indisponível nos nativos, edição que tira o `native`, chat do computador
//     hospedado aqui.
// As telas (o modo calculado no aparelho) ficam em toolSearchUi.test.ts.
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  ANTHROPIC_SEARCH_TOOL,
  OPENROUTER_SEARCH_TOOL,
  TOOL_SEARCH_CAPS_SETTING,
  TOOL_SEARCH_CAPS_TTL_MS,
  TOOL_SEARCH_LOCAL_NOTICE,
  activeFailure,
  anthropicToolSearchSupport,
  capsKey,
  discoveredByNative,
  filterToolReferences,
  forceLoadedTools,
  isNativeRejection,
  isRouterPreSearch,
  messagesBlockers,
  nativeConsistent,
  nativeSearchChip,
  nativeSearches,
  nativeToolSearchPrompt,
  nativeToolsArray,
  nativeTurnFrom,
  normalizeToolSearchCaps,
  prepareNativeReplay,
  replayableNative,
  resolveToolSearchMode,
  sentMediaOf,
  toolSearchMetaLabel,
  wireToolName,
  withFailure,
  withoutStaleNative,
  type ToolSearchModeInput
} from '../src/vendor/shared/toolSearch'
import { COMPACT_TOOLS_PROMPT, planTools } from '../src/vendor/shared/compactTools'
import {
  TOOL_ALIASES,
  type ApiMessage,
  type Chat,
  type ChatConfig,
  type Provider,
  type StoredMessage,
  type ToolName
} from '../src/vendor/shared/types'
import {
  TOOL_DEFINITIONS,
  toolDefinitionFor,
  type ToolDefinition
} from '../src/vendor/shared/tools'
import { DEFAULT_CHAT_CONFIG } from '../src/vendor/shared/defaults'
import { migrateMessageJson } from '../src/vendor/shared/toolRename'
import { buildCompactionRequest, compactionMeta } from '../src/vendor/desktop/agent/compaction'
import {
  applyAnthropicEvent,
  applyAnthropicMessage
} from '../src/vendor/desktop/agent/adapters/anthropic'
import { fetchGenerationCost, newAccumulator } from '../src/vendor/desktop/agent/llm'
import {
  buildRequest,
  sanitizeHistory,
  setLocationSource,
  setMemorySources,
  setModelInfoSource,
  setNativeTestHosts,
  setToolSearchCapsSource,
  setVoiceCallSource,
  toolDefinitions
} from '../src/agent/request'
import { mapModel } from '../src/agent/providers'
import { ToolSearchCapsStore } from '../src/agent/toolSearchCaps'
import { MemoryKeyValueStore } from '../src/account/storage'
import { toolIcon, toolSummary } from '../src/chat/toolSummary'
import { makeHarness, until, type Harness } from './hostHarness'

const ENV = { os: 'Android 16' }

/** Volta as fontes globais da request ao padrão (o harness as registra). */
function resetSources(): void {
  setMemorySources({ prompt: () => null, tools: () => [] })
  setLocationSource(null)
  setVoiceCallSource(() => null)
  setToolSearchCapsSource(() => ({}))
  setModelInfoSource(() => undefined)
  setNativeTestHosts([])
}

// ---------------- (A) lógica pura ----------------

const baseCfg = DEFAULT_CHAT_CONFIG('', { providerId: 'p', model: 'm', systemPrompt: 'S' })
const mi = (o: Partial<ToolSearchModeInput> = {}): ToolSearchModeInput => ({
  kind: 'anthropic',
  baseUrl: 'https://api.anthropic.com/v1',
  providerId: 'pa',
  model: 'claude-sonnet-5-5',
  cfg: baseCfg,
  wouldCompact: true,
  ...o
})

/** Blocos de uma resposta da busca nativa (docs "Tool search tool" da Anthropic). */
const SEARCH_BLOCKS = (): Record<string, unknown>[] => [
  { type: 'thinking', thinking: 'vejamos', signature: 'sig' },
  { type: 'text', text: 'Vou ver a hora.' },
  {
    type: 'server_tool_use',
    id: 'srvtoolu_01ABC',
    name: 'tool_search_tool_regex',
    input: { pattern: 'date|time|hora' }
  },
  {
    type: 'tool_search_tool_result',
    tool_use_id: 'srvtoolu_01ABC',
    content: {
      type: 'tool_search_tool_search_result',
      tool_references: [
        { type: 'tool_reference', tool_name: 'datetime' },
        { type: 'tool_reference', tool_name: 'shell' }
      ]
    }
  },
  { type: 'tool_use', id: 'toolu_01XYZ', name: 'datetime', input: { format: '%H:%M' } }
]
const ch = { providerId: 'pa', kind: 'anthropic' as const, model: 'claude-sonnet-5-5' }
const asst = (native = nativeTurnFrom(SEARCH_BLOCKS(), ch)!): ApiMessage => ({
  role: 'assistant',
  content: 'Vou ver a hora.',
  tool_calls: [
    {
      id: 'toolu_01XYZ',
      type: 'function',
      function: { name: 'datetime', arguments: '{"format":"%H:%M"}' }
    }
  ],
  native
})
const defs = (names: string[]): ToolDefinition[] =>
  names.map((n) => toolDefinitionFor(n as never, []))

describe('(A) lógica pura vendorada', () => {
  it('modo: tabela de resolução (tipo × host × modelo × endpoints × bloqueios × falha × config)', () => {
    const r = (o: Partial<ToolSearchModeInput>): string => resolveToolSearchMode(mi(o)).mode
    expect(resolveToolSearchMode(mi())).toEqual({ mode: 'native-anthropic', api: 'messages' })
    expect(r({ model: 'claude-haiku-4-5' })).toBe('native-anthropic')
    const old = resolveToolSearchMode(mi({ model: 'claude-opus-4-1' }))
    expect(old.mode).toBe('local')
    expect(old.reason).toMatch(/claude-opus-4-1 não tem a busca nativa/)
    // host de terceiros compatível com a Anthropic → local
    const third = resolveToolSearchMode(mi({ baseUrl: 'https://gateway.example.com/v1' }))
    expect(third.mode).toBe('local')
    expect(third.reason).toMatch(/não é a API oficial \(gateway\.example\.com\)/)
    expect(r({ baseUrl: 'http://127.0.0.1:9/v1', extraHosts: ['127.0.0.1'] })).toBe(
      'native-anthropic'
    )
    // OpenRouter oficial → Messages API; sem /messages nos endpoints, bloqueio ou proxy → local
    const or = { kind: 'openrouter' as const, baseUrl: 'https://openrouter.ai/api/v1' }
    expect(resolveToolSearchMode(mi({ ...or, model: 'openai/gpt-5.6-luna' }))).toEqual({
      mode: 'native-openrouter',
      api: 'messages'
    })
    expect(
      r({ ...or, info: { endpoints: ['/api/v1/chat/completions', '/api/v1/messages'] } })
    ).toBe('native-openrouter')
    const noMsg = resolveToolSearchMode(
      mi({ ...or, info: { endpoints: ['/api/v1/chat/completions'] } })
    )
    expect(noMsg).toMatchObject({ mode: 'local', api: 'chat' })
    expect(noMsg.reason).toMatch(/não é servido pela Messages API/)
    const audio = resolveToolSearchMode(mi({ ...or, sent: { audio: true } }))
    expect(audio.mode).toBe('local')
    expect(audio.reason).toMatch(/áudio/)
    expect(r({ ...or, baseUrl: 'https://proxy.example.com/api/v1' })).toBe('local')
    // genérico → local (só quatro modos: não há deferral na Chat Completions)
    const gen = resolveToolSearchMode(mi({ kind: 'openai', baseUrl: 'https://api.openai.com/v1' }))
    expect(gen.mode).toBe('local')
    expect(gen.reason).toMatch(/genérico/)
    // falha lembrada (< 24 h) → local; vencida → nativa de novo
    const now = 1_800_000_000_000
    const caps = {
      [capsKey('pa', 'claude-sonnet-5-5')]: {
        mode: 'native-anthropic' as const,
        failedAt: now - 1000,
        error: 'HTTP 400: x'
      }
    }
    const failed = resolveToolSearchMode(mi({ caps, now }))
    expect(failed.mode).toBe('local')
    expect(failed.reason).toMatch(/a busca nativa falhou com claude-sonnet-5-5 .*HTTP 400: x.*24 h/)
    expect(failed.failure?.error).toBe('HTTP 400: x')
    expect(r({ caps, now: now + TOOL_SEARCH_CAPS_TTL_MS })).toBe('native-anthropic')
    // config
    expect(r({ cfg: { ...baseCfg, toolsCompact: false } })).toBe('off')
    expect(r({ wouldCompact: false })).toBe('off')
    expect(r({ cfg: { ...baseCfg, nativeTools: false } })).toBe('off')
    expect(r({ cfg: { ...baseCfg, nativeTools: false, toolsInPrompt: true } })).toBe('local')
    expect(r({ cfg: { ...baseCfg, toolsInPrompt: true, toolsPromptText: 'meu' } })).toBe(
      'native-anthropic'
    )
  })

  it('suporte da Anthropic por modelo (Claude 4.5+)', () => {
    for (const m of [
      'claude-haiku-4-5',
      'claude-sonnet-4-5-20250929',
      'claude-opus-4-6',
      'claude-opus-5-5',
      'claude-haiku-5-5',
      'claude-fable-5-2',
      'claude-mythos-5-1',
      'anthropic/claude-haiku-4.5'
    ])
      expect(anthropicToolSearchSupport(m), m).toBe('yes')
    for (const m of [
      'claude-opus-4-1',
      'claude-opus-4-20250514',
      'claude-sonnet-4-0',
      'claude-3-5-sonnet-20241022'
    ])
      expect(anthropicToolSearchSupport(m), m).toBe('no')
    expect(anthropicToolSearchSupport('meu-alias')).toBe('unknown')
  })

  it('bloqueios da Messages API do OpenRouter (áudio, parâmetros, extraBody; PDF não bloqueia)', () => {
    const cfg = (params: Record<string, unknown>): any => ({ params })
    expect(messagesBlockers({ cfg: cfg({}) })).toEqual([])
    expect(messagesBlockers({ cfg: cfg({}), sent: { audio: true } })[0]).toMatch(/áudio/)
    expect(messagesBlockers({ cfg: cfg({ seed: 1, frequency_penalty: 0.2 }) })[0]).toMatch(
      /frequency_penalty, seed/
    )
    expect(messagesBlockers({ cfg: cfg({ extraBody: '{"reasoning":{"x":1}}' }) })[0]).toMatch(
      /extraBody .*reasoning/
    )
    expect(
      sentMediaOf([
        {
          role: 'user',
          content: [{ type: 'input_audio', input_audio: { data: 'x', format: 'wav' } }]
        },
        {
          role: 'tool',
          tool_call_id: 'c',
          content: [
            { type: 'file', file: { filename: 'a.pdf', file_data: 'clearchat-attachment://x' } }
          ]
        }
      ] as ApiMessage[])
    ).toEqual({ audio: true })
    // PDF (mesmo num modelo sem leitura nativa) não tira da Messages API — o OpenRouter converte
    const pdfChat = {
      role: 'user',
      content: [
        { type: 'file', file: { filename: 'a.pdf', file_data: 'data:application/pdf;base64,x' } }
      ]
    } as ApiMessage
    expect(sentMediaOf([pdfChat])).toEqual({})
    expect(
      resolveToolSearchMode(
        mi({
          kind: 'openrouter',
          baseUrl: 'https://openrouter.ai/api/v1',
          model: 'openai/gpt-5.1-codex-mini',
          info: { inputModalities: ['image', 'text'], endpoints: ['/api/v1/messages'] },
          sent: sentMediaOf([pdfChat])
        })
      ).mode
    ).toBe('native-openrouter')
  })

  it('prompt fixo nativo: nomeia a busca do modo e lista as adiadas na ordem dada; nenhuma → nada', () => {
    expect(nativeToolSearchPrompt([])).toBeNull()
    expect(nativeToolSearchPrompt(['web_search', 'datetime'], 'native-anthropic')).toBe(
      'Algumas ferramentas deste chat estão adiadas e só aparecem depois de buscadas: use tool_search_tool_regex antes de dizer que não tem uma ferramenta. Adiadas: web_search, datetime.'
    )
    expect(nativeToolSearchPrompt(['web_search'], 'native-openrouter')).toBe(
      'Algumas ferramentas deste chat estão adiadas e só aparecem depois de buscadas: use a busca de ferramentas (openrouter:tool_search) antes de dizer que não tem uma ferramenta. Adiadas: web_search.'
    )
  })

  it('plano: nativo completas e adiadas (sem tool_search, com o prompt fixo nativo); local renomeado; off', () => {
    const full = defs(['web_search', 'browse_url', 'datetime'])
    const cfg = { toolsFull: ['web_search' as const] }
    const nat = planTools([...full, TOOL_DEFINITIONS.end_call], cfg, 'native-anthropic')
    expect(nat.mode).toBe('native-anthropic')
    expect(nat.definitions.map((d) => d.function.name)).toEqual([
      'web_search',
      'browse_url',
      'datetime',
      'end_call'
    ])
    expect(nat.deferred).toEqual(['browse_url', 'datetime'])
    expect(nat.prompt).toBe(nativeToolSearchPrompt(['browse_url', 'datetime'], 'native-anthropic'))
    expect(nat.searchEntry).toEqual(ANTHROPIC_SEARCH_TOOL)
    expect(planTools(full, cfg, 'native-openrouter').searchEntry).toEqual(OPENROUTER_SEARCH_TOOL)
    expect(
      planTools(full, { toolsFull: ['web_search', 'browse_url', 'datetime'] }, 'native-anthropic')
        .mode
    ).toBe('off')
    const loc = planTools(full, cfg, 'local')
    expect(loc.definitions.at(-1)!.function.name).toBe('tool_search')
    expect(loc.prompt).toBe(COMPACT_TOOLS_PROMPT)
    expect(COMPACT_TOOLS_PROMPT).toContain('tool_search')
    expect(COMPACT_TOOLS_PROMPT).not.toContain('search_tool')
  })

  it('array tools nativo: completas, defer_loading, cache numa NÃO adiada, busca do servidor por último', () => {
    const arr = nativeToolsArray(defs(['web_search', 'browse_url', 'datetime']), {
      deferred: new Set(['web_search', 'datetime']),
      entry: { ...ANTHROPIC_SEARCH_TOOL },
      cache: true
    })
    expect(arr.map((t) => t.name)).toEqual([
      'web_search',
      'browse_url',
      'datetime',
      'tool_search_tool_regex'
    ])
    expect(arr[0].defer_loading).toBe(true)
    expect(arr[0].cache_control).toBeUndefined()
    expect(arr[1].cache_control).toEqual({ type: 'ephemeral' })
    expect(arr.at(-1)).toEqual(ANTHROPIC_SEARCH_TOOL)
    const all = nativeToolsArray(defs(['web_search']), {
      deferred: new Set(['web_search']),
      entry: { ...OPENROUTER_SEARCH_TOOL },
      cache: true
    })
    expect(all.every((t) => !t.cache_control)).toBe(true)
    expect(all.at(-1)).toEqual({ type: 'openrouter:tool_search' })
  })

  it('native: gravado só com blocos do servidor, sem pensamento, na ordem', () => {
    const n = nativeTurnFrom(SEARCH_BLOCKS(), ch)!
    expect(n).toMatchObject({ v: 1, api: 'anthropic-messages', providerId: 'pa' })
    expect(n.content.map((b) => b.type)).toEqual([
      'text',
      'server_tool_use',
      'tool_search_tool_result',
      'tool_use'
    ])
    expect(
      nativeTurnFrom(
        [
          { type: 'thinking', thinking: 'x' },
          { type: 'text', text: 'oi' },
          { type: 'tool_use', id: 't', name: 'x', input: {} }
        ],
        ch
      )
    ).toBeNull()
    expect(nativeTurnFrom(undefined, ch)).toBeNull()
  })

  it('reenvio: canal, consistência com o texto e as tool calls; edição tira o native', () => {
    const m = asst()
    const c = { mode: 'native-anthropic' as const, providerId: 'pa', model: 'claude-sonnet-5-5' }
    expect(nativeConsistent(m)).toBe(true)
    expect(replayableNative(m, c)).toBe(true)
    expect(replayableNative(m, { ...c, model: 'claude-opus-5-5' })).toBe(false)
    expect(replayableNative(m, { ...c, providerId: 'outro' })).toBe(false)
    expect(replayableNative(m, { ...c, mode: 'native-openrouter' })).toBe(false)
    expect(nativeConsistent({ ...m, content: 'Editado.' } as ApiMessage)).toBe(false)
    const fmt = {
      ...m,
      tool_calls: [
        {
          ...(m as any).tool_calls[0],
          function: { name: 'datetime', arguments: '{ "format" : "%H:%M" }' }
        }
      ]
    }
    expect(nativeConsistent(fmt as ApiMessage)).toBe(true)
    expect((withoutStaleNative({ ...m, content: 'x' } as ApiMessage) as any).native).toBeUndefined()
    expect((withoutStaleNative(m) as any).native).toBeTruthy()
  })

  it('reenvio: referências filtradas; descobertas; adiadas usadas sem descoberta vão carregadas', () => {
    const content = (asst() as any).native.content
    const filtered = filterToolReferences(content, new Set(['datetime']))
    const res = filtered.find((b) => b.type === 'tool_search_tool_result') as any
    expect(res.content.tool_references).toEqual([{ type: 'tool_reference', tool_name: 'datetime' }])
    expect(content[2].content.tool_references).toHaveLength(2)
    expect(discoveredByNative(content)).toEqual(['datetime', 'shell'])
    const hist: ApiMessage[] = [
      { role: 'user', content: 'que horas?' },
      asst(),
      { role: 'tool', tool_call_id: 'toolu_01XYZ', content: '14:05' }
    ]
    const c = { mode: 'native-anthropic' as const, providerId: 'pa', model: 'claude-sonnet-5-5' }
    const ok = prepareNativeReplay(hist, c, new Set(['datetime', 'web_search']))
    expect(ok.replayed).toBe(1)
    expect(ok.discovered).toEqual(['datetime'])
    expect(forceLoadedTools(ok.messages, ['datetime'], ok.discovered)).toEqual([])
    const other = prepareNativeReplay(hist, { ...c, model: 'claude-opus-5-5' }, new Set())
    expect(other).toMatchObject({ replayed: 0, skipped: 1 })
    expect((other.messages[1] as any).native).toBeUndefined()
    expect(forceLoadedTools(other.messages, ['datetime'], other.discovered)).toEqual(['datetime'])
  })

  it('falhas lembradas (toolSearchCaps): 24 h, vencidas saem, leitura tolerante; o que conta como recusa', () => {
    const now = 1_800_000_000_000
    let caps = withFailure(
      {},
      'p',
      'm',
      { mode: 'native-openrouter', failedAt: now, error: 'x'.repeat(500) },
      now
    )
    expect(caps[capsKey('p', 'm')].error).toHaveLength(300)
    expect(activeFailure(caps, 'p', 'm', now + TOOL_SEARCH_CAPS_TTL_MS - 1)).toBeTruthy()
    expect(activeFailure(caps, 'p', 'm', now + TOOL_SEARCH_CAPS_TTL_MS)).toBeNull()
    caps = withFailure(
      caps,
      'p',
      'n',
      { mode: 'native-anthropic', failedAt: now + TOOL_SEARCH_CAPS_TTL_MS, error: '' },
      now + TOOL_SEARCH_CAPS_TTL_MS
    )
    expect(Object.keys(caps)).toEqual([capsKey('p', 'n')])
    expect(normalizeToolSearchCaps('lixo')).toEqual({})
    expect(isNativeRejection(400, 'tool search not supported')).toBe(true)
    expect(isNativeRejection(404, 'No endpoints found')).toBe(true)
    expect(isNativeRejection(400, 'prompt is too long: 250000 tokens')).toBe(false)
    expect(isNativeRejection(401, 'unauthorized')).toBe(false)
    expect(isNativeRejection(500, 'x')).toBe(false)
  })

  it('caps no KeyValueStore do aparelho (local, nunca sincronizado): grava, lê, avisa as telas', () => {
    const kv = new MemoryKeyValueStore()
    let t = 1_800_000_000_000
    const store = new ToolSearchCapsStore(kv, () => t)
    let calls = 0
    const off = store.subscribe(() => calls++)
    expect(store.get()).toEqual({})
    store.markFailure('p', 'm', 'native-anthropic', 'HTTP 400: nope')
    expect(calls).toBe(1)
    expect(JSON.parse(kv.get(TOOL_SEARCH_CAPS_SETTING)!)).toEqual({
      [capsKey('p', 'm')]: { mode: 'native-anthropic', failedAt: t, error: 'HTTP 400: nope' }
    })
    expect(activeFailure(store.get(), 'p', 'm', t)).toBeTruthy()
    // a vencida sai na próxima gravação
    t += TOOL_SEARCH_CAPS_TTL_MS
    store.markFailure('p', 'n', 'native-openrouter', '')
    expect(Object.keys(store.get())).toEqual([capsKey('p', 'n')])
    off()
    kv.set(TOOL_SEARCH_CAPS_SETTING, '{não é json')
    expect(store.get()).toEqual({})
  })

  it('renome search_tool → tool_search: alias de leitura, troca só na cópia, migração não regrava', () => {
    expect(TOOL_ALIASES.search_tool).toBe('tool_search')
    expect(TOOL_ALIASES.bash).toBe('shell')
    expect(wireToolName('search_tool')).toBe('tool_search')
    expect(wireToolName('shell')).toBe('shell')
    expect(
      migrateMessageJson(
        JSON.stringify({
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'c', type: 'function', function: { name: 'search_tool', arguments: '{}' } }
          ]
        })
      )
    ).toBeNull()
    // a cópia enviada usa o nome novo; o histórico salvo não muda
    const saved: ApiMessage = {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'c', type: 'function', function: { name: 'search_tool', arguments: '{}' } }
      ]
    }
    const wire = sanitizeHistory([saved, { role: 'tool', tool_call_id: 'c', content: '[]' }], false)
    expect((wire[0] as any).tool_calls[0].function.name).toBe('tool_search')
    expect((saved as any).tool_calls[0].function.name).toBe('search_tool')
    // cards: os dois nomes com o mesmo resumo e ícone
    expect(toolIcon('search_tool')).toBe(toolIcon('tool_search'))
    expect(toolSummary('search_tool', { names: ['a', 'b'] })).toBe('a, b')
    expect(toolSummary('tool_search', { names: ['a', 'b'] })).toBe('a, b')
  })

  it('transcrição: chip "buscou tools" e rótulo do rodapé; aviso da versão local', () => {
    const s = nativeSearches((asst() as any).native)
    expect(s).toEqual([{ query: 'date|time|hora', tools: ['datetime', 'shell'], opaque: false }])
    expect(nativeSearchChip(s[0])).toBe('buscou tools: datetime, shell')
    const opaque = nativeSearches({
      v: 1,
      api: 'anthropic-messages',
      providerId: 'p',
      kind: 'openrouter',
      model: 'm',
      content: [
        { type: 'server_tool_use', id: 's', name: 'tool_search', input: { pattern: 'x' } },
        { type: 'openrouter_tool_search_result', tool_use_id: 's', content: { blob: 'opaco' } }
      ]
    })
    expect(nativeSearchChip(opaque[0])).toBe('buscou tools (resultado do OpenRouter)')
    // OpenRouter (forma vista no smoke do desktop): pré-busca do roteador (orpresearch…, input
    // vazio) fora do chip; a busca do modelo com tool_names
    const orNative = {
      v: 1 as const,
      api: 'anthropic-messages' as const,
      providerId: 'p',
      kind: 'openrouter' as const,
      model: 'm',
      content: [
        { type: 'server_tool_use', id: 'orpresearch_2', name: 'openrouter:tool_search', input: {} },
        {
          type: 'openrouter_tool_search_result',
          tool_use_id: 'orpresearch_2',
          content: {
            matches: [],
            tool_names: [],
            pattern: '{}',
            catalog_index: 'Tools: datetime, web_search.'
          }
        },
        {
          type: 'server_tool_use',
          id: 'call_UHW',
          name: 'openrouter:tool_search',
          input: { query: 'select:datetime' }
        },
        {
          type: 'openrouter_tool_search_result',
          tool_use_id: 'call_UHW',
          content: {
            matches: [
              {
                tool_id: 'datetime',
                schema_digest: 'x',
                definition: { type: 'function', name: 'datetime', parameters: {} }
              }
            ],
            tool_names: ['datetime']
          }
        },
        { type: 'tool_use', id: 'call_d', name: 'datetime', input: {} }
      ]
    }
    expect(isRouterPreSearch(orNative.content[0])).toBe(true)
    expect(isRouterPreSearch(orNative.content[2])).toBe(false)
    expect(nativeSearches(orNative)).toEqual([
      { query: 'select:datetime', tools: ['datetime'], opaque: false }
    ])
    expect(discoveredByNative(orNative.content)).toEqual(['datetime'])
    // o que o app grava de uma resposta do OpenRouter: sem redacted_thinking, pré-busca inclusa
    const gravado = nativeTurnFrom(
      [
        orNative.content[0],
        orNative.content[1],
        { type: 'redacted_thinking', data: 'x' },
        ...orNative.content.slice(2)
      ],
      { providerId: 'p', kind: 'openrouter', model: 'm' }
    )!
    expect(gravado.content).toEqual(orNative.content)
    expect(toolSearchMetaLabel({ mode: 'native-anthropic' })).toBe('busca nativa · Anthropic')
    expect(toolSearchMetaLabel({ mode: 'native-openrouter' })).toBe('busca nativa · OpenRouter')
    expect(toolSearchMetaLabel({ mode: 'local', fallbackFrom: 'native-openrouter' })).toBe(
      'tools: versão local (a busca nativa falhou)'
    )
    expect(toolSearchMetaLabel({ mode: 'off' })).toBeNull()
    expect(TOOL_SEARCH_LOCAL_NOTICE).toMatch(/versão local do app/)
  })
})

// ---------------- (B) request do celular ----------------

const ANTH: Provider = {
  id: 'pa',
  name: 'Anthropic',
  kind: 'anthropic',
  baseUrl: 'https://api.anthropic.com/v1',
  apiKey: 'sk-ant-k',
  headers: {},
  createdAt: 0
}
const ORP: Provider = {
  id: 'po',
  name: 'OR',
  kind: 'openrouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: 'sk-or-k',
  headers: {},
  createdAt: 0
}
/** Chat do computador: shell/read_file só lá; o celular manda web_search (carregada) e as outras. */
const mkChat = (over: Partial<ChatConfig> = {}): Chat => ({
  id: 'c1',
  title: '',
  mainSessionId: 's1',
  createdAt: 0,
  updatedAt: 0,
  config: {
    ...DEFAULT_CHAT_CONFIG('', {
      providerId: 'pa',
      model: 'claude-sonnet-5-5',
      systemPrompt: 'SYS'
    }),
    enabledTools: ['web_search', 'browse_url', 'datetime', 'shell', 'read_file'] as ToolName[],
    toolsFull: ['web_search'] as ToolName[],
    envInPrompt: false,
    cacheEnabled: true,
    ...over
  }
})
let seq = 0
const sm = (message: ApiMessage, meta: any = {}): StoredMessage => ({
  id: `m${++seq}`,
  sessionId: 's1',
  seq,
  message,
  meta,
  createdAt: 0
})
const S = { depth: 0 as const, model: 'claude-sonnet-5-5' }
const toolNames = (b: any): string[] => b.tools.map((t: any) => t.name ?? t.type)
/** Histórico de uma busca nativa já respondida (vinda do computador) + uma pergunta nova. */
const nativeHistory = (over: Partial<ApiMessage> = {}): StoredMessage[] => [
  sm({ role: 'user', content: 'Que horas são?' }),
  sm({ ...asst(), ...over } as ApiMessage),
  sm({ role: 'tool', tool_call_id: 'toolu_01XYZ', content: '14:05' }),
  sm({ role: 'assistant', content: 'São 14:05.' }),
  sm({ role: 'user', content: 'e agora?' })
]
const assistantBlocks = (b: any): any[] =>
  b.messages.filter((m: any) => m.role === 'assistant')[0].content

describe('(B) request do celular', () => {
  beforeEach(resetSources)

  it('native-anthropic: /messages, só as tools do celular, defer_loading, cache numa carregada, busca por último, sem prompt fixo', () => {
    const req = buildRequest(mkChat(), S, [sm({ role: 'user', content: 'oi' })], ANTH, ENV)
    const b = req.body as any
    expect(req.url).toBe('https://api.anthropic.com/v1/messages')
    expect(req.api).toBe('messages')
    expect(req.headers['x-api-key']).toBe('sk-ant-k')
    expect(req.toolSearch).toEqual({
      mode: 'native-anthropic',
      deferred: ['browse_url', 'datetime'],
      forceLoaded: [],
      replayed: 0,
      skipped: 0
    })
    // as do computador (shell, read_file) nunca vão daqui — nem adiadas
    expect(toolNames(b)).toEqual(['web_search', 'browse_url', 'datetime', 'tool_search_tool_regex'])
    expect(b.tools[0].cache_control).toEqual({ type: 'ephemeral' })
    expect(b.tools[1].defer_loading).toBe(true)
    // a definição completa como o celular a manda (browse_url do celular)
    expect(b.tools[1].input_schema).toEqual(toolDefinitions(['browse_url'])[0].function.parameters)
    expect(b.tools[1].description).toBe(toolDefinitions(['browse_url'])[0].function.description)
    expect(b.tools.at(-1)).toEqual(ANTHROPIC_SEARCH_TOOL)
    // o prompt fixo nativo no fim do system prompt, com as adiadas DESTA request (nunca o da local)
    expect(b.system[0].text).toBe(
      `SYS\n\n${nativeToolSearchPrompt(['browse_url', 'datetime'], 'native-anthropic')}`
    )
    expect(JSON.stringify(b)).not.toContain(COMPACT_TOOLS_PROMPT)
    expect(b.tools.some((t: any) => t.name === 'tool_search')).toBe(false)
    expect(req.notes![0]).toMatch(/Busca nativa da Anthropic — 1 carregada, 2 adiadas/)
    expect(JSON.stringify(b).split('"cache_control"').length - 1).toBeLessThanOrEqual(4)
  })

  it('native-openrouter: POST {base}/messages com Bearer, openrouter:tool_search, sem campos da Chat Completions; effort none → thinking disabled', () => {
    const chat = mkChat({ providerId: 'po', params: { reasoning_effort: 'none' } as any })
    const req = buildRequest(
      chat,
      { depth: 0, model: 'openai/gpt-5.6-luna' },
      [sm({ role: 'user', content: 'oi' })],
      ORP,
      ENV
    )
    const b = req.body as any
    expect(req.url).toBe('https://openrouter.ai/api/v1/messages')
    expect(req.kind).toBe('openrouter')
    expect(req.api).toBe('messages')
    expect(req.headers.Authorization).toBe('Bearer sk-or-k')
    expect(req.headers['x-api-key']).toBeUndefined()
    expect(b.tools.at(-1)).toEqual({ type: 'openrouter:tool_search' })
    expect(b.max_tokens).toBeUndefined()
    expect(b.usage).toBeUndefined()
    expect(b.stream_options).toBeUndefined()
    expect(b.stream).toBe(true)
    expect(b.thinking).toEqual({ type: 'disabled' })
    expect(b.system).toEqual([
      {
        type: 'text',
        text: `SYS\n\n${nativeToolSearchPrompt(['browse_url', 'datetime'], 'native-openrouter')}`,
        cache_control: { type: 'ephemeral' }
      }
    ])
    const mt = buildRequest(
      mkChat({ providerId: 'po', params: { max_tokens: 500 } }),
      { depth: 0, model: 'openai/gpt-5.6-luna' },
      [],
      ORP,
      ENV
    ).body as any
    expect(mt.max_tokens).toBe(500)
  })

  it('OpenRouter na versão local: bloqueio (seed) ou endpoints sem /messages (variante :free → id base) → Chat Completions com tool_search e o motivo', () => {
    const r = buildRequest(
      mkChat({ providerId: 'po', params: { seed: 7 } }),
      { depth: 0, model: 'x/y' },
      [],
      ORP,
      ENV
    )
    expect(r.url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(r.api).toBe('chat')
    expect(r.toolSearch?.mode).toBe('local')
    expect((r.body as any).tools.at(-1).function.name).toBe('tool_search')
    expect(r.notes![0]).toMatch(
      /Versão local do app — o chat precisa da Chat Completions do OpenRouter: parâmetros só da Chat Completions: seed/
    )
    // /models do OpenRouter com `endpoints` (mapModel guarda) e a variante caindo no id base
    const info = mapModel({ id: 'x/y', endpoints: ['/api/v1/chat/completions', 7] })!
    expect(info.endpoints).toEqual(['/api/v1/chat/completions'])
    setModelInfoSource((_p, m) => (m === 'x/y' ? info : undefined))
    const e = buildRequest(
      mkChat({ providerId: 'po' }),
      { depth: 0, model: 'x/y:free' },
      [],
      ORP,
      ENV
    )
    expect(e.toolSearch?.mode).toBe('local')
    expect(e.toolSearch!.reason).toMatch(/não é servido pela Messages API/)
  })

  it('Anthropic de terceiros e genérico → versão local com o motivo', () => {
    const third = buildRequest(
      mkChat(),
      S,
      [],
      { ...ANTH, baseUrl: 'https://gateway.example.com/v1' },
      ENV
    )
    expect(third.toolSearch?.mode).toBe('local')
    expect((third.body as any).tools.at(-1).name).toBe('tool_search')
    expect(third.notes![0]).toMatch(/não é a API oficial \(gateway\.example\.com\)/)
    const gen = buildRequest(
      mkChat(),
      S,
      [],
      { ...ORP, kind: 'openai', baseUrl: 'https://llm.example.com/v1' },
      ENV
    )
    expect(gen.toolSearch?.mode).toBe('local')
    expect(gen.notes![0]).toMatch(/genérico/)
  })

  it('celular hospedando um chat do computador: blocos reenviados com as referências só às tools DAQUI; nada do computador no array tools', () => {
    const req = buildRequest(mkChat(), S, nativeHistory(), ANTH, ENV)
    const b = req.body as any
    const blocks = assistantBlocks(b)
    expect(blocks.map((x: any) => x.type)).toEqual([
      'text',
      'server_tool_use',
      'tool_search_tool_result',
      'tool_use'
    ])
    // a referência a `shell` (só no computador) sai — a API recusa referência a tool ausente
    expect(blocks[2].content.tool_references).toEqual([
      { type: 'tool_reference', tool_name: 'datetime' }
    ])
    expect(blocks.some((x: any) => x.cache_control)).toBe(false)
    expect(req.toolSearch).toMatchObject({ replayed: 1, forceLoaded: [] })
    expect(toolNames(b)).not.toContain('shell')
    expect(b.tools.find((t: any) => t.name === 'datetime').defer_loading).toBe(true)
    expect(JSON.stringify(b.messages)).not.toContain('"tool_use_id":"srvtoolu_01ABC","content":"')
    // um shell chamado no computador (sem native) também não faz o shell ir — nem carregado
    const withShell = [
      sm({ role: 'user', content: 'liste' }),
      sm({
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'sh1', type: 'function', function: { name: 'shell', arguments: '{}' } }]
      }),
      sm({ role: 'tool', tool_call_id: 'sh1', content: 'a.txt' }),
      ...nativeHistory()
    ]
    const r2 = buildRequest(mkChat(), { depth: 0, model: 'claude-opus-5-5' }, withShell, ANTH, ENV)
    expect(r2.toolSearch!.forceLoaded).toEqual(['datetime'])
    expect(toolNames(r2.body)).toEqual([
      'web_search',
      'browse_url',
      'datetime',
      'tool_search_tool_regex'
    ])
  })

  it('reenvio: outro modelo/editado/outro provedor → conversão normal (+ usada carregada); local/off/CC → nada do servidor no fio', () => {
    const other = buildRequest(
      mkChat(),
      { depth: 0, model: 'claude-opus-5-5' },
      nativeHistory(),
      ANTH,
      ENV
    )
    const ob = other.body as any
    expect(assistantBlocks(ob).map((x: any) => x.type)).toEqual(['text', 'tool_use'])
    expect(other.toolSearch!.forceLoaded).toEqual(['datetime'])
    expect(ob.tools.find((t: any) => t.name === 'datetime').defer_loading).toBeUndefined()
    expect(other.notes!.join('\n')).toMatch(
      /Carregadas por já terem sido usadas sem a busca no histórico enviado: datetime/
    )
    // o prompt fixo nativo lista só as adiadas de fato (datetime foi carregada)
    expect(ob.system[0].text).toBe(
      `SYS\n\n${nativeToolSearchPrompt(['browse_url'], 'native-anthropic')}`
    )
    const edited = buildRequest(
      mkChat(),
      S,
      nativeHistory({ content: 'Editado.' } as any),
      ANTH,
      ENV
    )
    expect(assistantBlocks(edited.body).map((x: any) => x.type)).toEqual(['text', 'tool_use'])
    expect(edited.toolSearch!.skipped).toBe(1)
    const or = buildRequest(
      mkChat({ providerId: 'po' }),
      { depth: 0, model: 'claude-sonnet-5-5' },
      nativeHistory(),
      ORP,
      ENV
    )
    expect(assistantBlocks(or.body).map((x: any) => x.type)).toEqual(['text', 'tool_use'])
    const off = buildRequest(mkChat({ toolsCompact: false }), S, nativeHistory(), ANTH, ENV)
    expect(off.toolSearch!.mode).toBe('off')
    expect(JSON.stringify(off.body)).not.toContain('server_tool_use')
    expect(JSON.stringify(off.body)).not.toContain('defer_loading')
    const cc = buildRequest(
      mkChat({ providerId: 'po', params: { seed: 1 } }),
      S,
      nativeHistory(),
      ORP,
      ENV
    )
    expect(JSON.stringify(cc.body)).not.toContain('server_tool_use')
    expect(JSON.stringify(cc.body)).not.toContain('"native"')
    const loc = buildRequest(
      mkChat(),
      { depth: 0, model: 'claude-opus-4-1' },
      nativeHistory(),
      ANTH,
      ENV
    )
    expect(loc.toolSearch!.mode).toBe('local')
    expect(JSON.stringify(loc.body)).not.toContain('server_tool_use')
  })

  it('noReplay / replay:false e o modo forçado (queda) na request — opções no 5º ou no 6º argumento', () => {
    const h = nativeHistory()
    const nr = buildRequest(mkChat(), S, h, ANTH, { env: ENV, noReplay: new Set([h[1].id]) })
    expect(nr.toolSearch!.replayed).toBe(0)
    expect(nr.toolSearch!.forceLoaded).toEqual(['datetime'])
    const r0 = buildRequest(mkChat(), S, h, ANTH, ENV, { replay: false })
    expect(r0.toolSearch!.replayed).toBe(0)
    const loc = buildRequest(mkChat(), S, h, ANTH, ENV, { modeOverride: 'local' })
    expect(loc.toolSearch!.mode).toBe('local')
    expect((loc.body as any).tools.at(-1).name).toBe('tool_search')
    expect((loc.body as any).system[0].text.endsWith(COMPACT_TOOLS_PROMPT)).toBe(true)
  })

  it('falha lembrada neste aparelho (fonte registrada) → versão local com o motivo', () => {
    const now = Date.now()
    setToolSearchCapsSource(() => ({
      [capsKey('pa', 'claude-sonnet-5-5')]: {
        mode: 'native-anthropic',
        failedAt: now - 1000,
        error: 'HTTP 400: x'
      }
    }))
    const r = buildRequest(mkChat(), S, [], ANTH, ENV)
    expect(r.toolSearch!.mode).toBe('local')
    expect(r.toolSearch!.failure?.error).toBe('HTTP 400: x')
    expect(r.notes![0]).toMatch(/a busca nativa falhou com claude-sonnet-5-5/)
  })

  it('turno pausado: o assistente com native no fim vai como está; cache no último bloco cacheável', () => {
    const paused = nativeTurnFrom(
      [
        { type: 'text', text: 'Procurando…' },
        {
          type: 'server_tool_use',
          id: 'srvtoolu_P',
          name: 'tool_search_tool_regex',
          input: { pattern: 'x' }
        }
      ],
      ch
    )!
    const h = [
      sm({ role: 'user', content: 'oi' }),
      sm({ role: 'assistant', content: 'Procurando…', native: paused })
    ]
    const b = buildRequest(mkChat(), S, h, ANTH, ENV).body as any
    const last = b.messages.at(-1)
    expect(last.role).toBe('assistant')
    expect(last.content.at(-1).type).toBe('server_tool_use')
    expect(last.content.at(-1).cache_control).toBeUndefined()
    expect(last.content[0].cache_control).toEqual({ type: 'ephemeral' })
  })

  it('compactação vendorada: full reenvia; trimmed que encurta descarta; tool_choice none vai sem adiar nada; estimativa só com as carregadas', () => {
    const long = 'x'.repeat(9000)
    const h = [
      sm({ role: 'user', content: 'Que horas são?' }),
      sm({
        ...asst(nativeTurnFrom([{ type: 'text', text: long }, ...SEARCH_BLOCKS().slice(2)], ch)!),
        content: long
      } as ApiMessage),
      sm({ role: 'tool', tool_call_id: 'toolu_01XYZ', content: '14:05' }),
      sm({ role: 'assistant', content: 'São 14:05.' })
    ]
    const opts = { mode: 'full' as const, window: 200000 }
    const full = buildCompactionRequest(mkChat(), { id: 's1', ...S }, h, ANTH, 'Resuma.', opts, ENV)
    expect(full.toolSearch!.replayed).toBe(1)
    const trimmed = buildCompactionRequest(
      mkChat(),
      { id: 's1', ...S },
      h,
      ANTH,
      'Resuma.',
      { ...opts, mode: 'trimmed' },
      ENV
    )
    expect(trimmed.toolSearch).toMatchObject({ replayed: 0, skipped: 1 })
    const none = buildCompactionRequest(
      mkChat(),
      { id: 's1', ...S },
      h,
      ANTH,
      'Resuma.',
      { ...opts, toolChoiceNone: true },
      ENV
    )
    const nb = none.body as any
    expect(none.toolSearch!.mode).toBe('off')
    expect(nb.tool_choice).toEqual({ type: 'none' })
    expect(JSON.stringify(nb)).not.toContain('defer_loading')
    // a queda na compactação força a local
    const loc = buildCompactionRequest(
      mkChat(),
      { id: 's1', ...S },
      h,
      ANTH,
      'Resuma.',
      { ...opts, toolMode: 'local' },
      ENV
    )
    expect(loc.toolSearch!.mode).toBe('local')
    const nat = compactionMeta(mkChat(), { depth: 0 }, h, 'R', 5, ENV, 'native-anthropic')
    const plain = compactionMeta(
      mkChat({ toolsCompact: false }),
      { depth: 0 },
      h,
      'R',
      5,
      ENV,
      'off'
    )
    expect(nat.contextEstimate).toBeLessThan(plain.contextEstimate)
  })
})

// ---------------- (C) SSE e custo ----------------

/** Eventos do streaming da busca nativa (docs "Tool search tool" → Streaming; Messages API). */
function searchStream(opts: { cost?: number; orResult?: boolean } = {}): any[] {
  const result = opts.orResult
    ? {
        type: 'openrouter_tool_search_result',
        tool_use_id: 'srvtoolu_xyz789',
        content: { matches: [{ definition: { name: 'datetime' } }] }
      }
    : {
        type: 'tool_search_tool_result',
        tool_use_id: 'srvtoolu_xyz789',
        content: {
          type: 'tool_search_tool_search_result',
          tool_references: [{ type: 'tool_reference', tool_name: 'datetime' }]
        }
      }
  return [
    {
      type: 'message_start',
      message: { model: 'claude-haiku-4-5', usage: { input_tokens: 50, output_tokens: 1 } }
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Vou ' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ver.' } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: {
        type: 'server_tool_use',
        id: 'srvtoolu_xyz789',
        name: 'tool_search_tool_regex'
      }
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{"pattern":' }
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '"time"}' }
    },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: result },
    { type: 'content_block_stop', index: 2 },
    {
      type: 'content_block_start',
      index: 3,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'datetime', input: {} }
    },
    {
      type: 'content_block_delta',
      index: 3,
      delta: { type: 'input_json_delta', partial_json: '{"format":"%H"}' }
    },
    { type: 'content_block_stop', index: 3 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use' },
      usage: { output_tokens: 30, ...(opts.cost != null ? { cost: opts.cost } : {}) }
    },
    { type: 'message_stop' }
  ]
}

describe('(C) SSE e custo', () => {
  it('server_tool_use / tool_search_tool_result / tool_use → blocos completos; só o datetime vira tool call', () => {
    const acc = newAccumulator()
    for (const e of searchStream()) applyAnthropicEvent(acc, e)
    expect(acc.content).toBe('Vou ver.')
    expect(acc.toolCalls).toEqual([
      { id: 'toolu_1', name: 'datetime', arguments: '{"format":"%H"}' }
    ])
    expect(acc.blocks!.map((b) => b.type)).toEqual([
      'text',
      'server_tool_use',
      'tool_search_tool_result',
      'tool_use'
    ])
    expect(acc.blocks![0]).toEqual({ type: 'text', text: 'Vou ver.' })
    expect(acc.blocks![1].input).toEqual({ pattern: 'time' })
    expect(acc.blocks![3].input).toEqual({ format: '%H' })
    const m: ApiMessage = {
      role: 'assistant',
      content: acc.content,
      tool_calls: acc.toolCalls.map((t) => ({
        id: t.id,
        type: 'function',
        function: { name: t.name, arguments: t.arguments }
      })),
      native: nativeTurnFrom(acc.blocks, ch)!
    }
    expect(nativeConsistent(m)).toBe(true)
  })

  it('regressão: o input de um server_tool_use não vaza para a tool call anterior', () => {
    const acc = newAccumulator()
    const ev = [
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 't0', name: 'web_search', input: {} }
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"query":"x"}' }
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'server_tool_use', id: 'srv', name: 'tool_search_tool_regex' }
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"pattern":"y"}' }
      },
      { type: 'content_block_stop', index: 1 }
    ]
    for (const e of ev) applyAnthropicEvent(acc, e)
    expect(acc.toolCalls[0].arguments).toBe('{"query":"x"}')
  })

  it('OpenRouter Messages: resultado opaco e usage.cost; sem cost → sem custo; resposta não-stream', () => {
    const acc = newAccumulator()
    for (const e of searchStream({ cost: 0.0042, orResult: true })) applyAnthropicEvent(acc, e)
    expect(acc.usage!.cost).toBe(0.0042)
    expect(acc.blocks![2].content).toEqual({ matches: [{ definition: { name: 'datetime' } }] })
    const a2 = newAccumulator()
    for (const e of searchStream()) applyAnthropicEvent(a2, e)
    expect(a2.usage!.cost).toBeUndefined()
    const a3 = newAccumulator()
    applyAnthropicMessage(a3, {
      type: 'message',
      content: SEARCH_BLOCKS().slice(1),
      stop_reason: 'tool_use',
      usage: { input_tokens: 1, output_tokens: 2, cost: 0.1 }
    })
    expect(a3.blocks!.map((b) => b.type)).toEqual([
      'text',
      'server_tool_use',
      'tool_search_tool_result',
      'tool_use'
    ])
    expect(a3.usage!.cost).toBe(0.1)
  })

  it('custo pelo GET /generation: espera o 404 e o "ainda não fechou" (0 com 0 tokens), lê total_cost; erro → null', async () => {
    let calls = 0
    const fake = (async (url: string, init: any) => {
      calls++
      expect(url).toBe('https://openrouter.ai/api/v1/generation?id=gen-1')
      expect(init.headers.Authorization).toBe('Bearer k')
      if (calls === 1) return new Response('{}', { status: 404 })
      if (calls === 2)
        return new Response(
          JSON.stringify({ data: { total_cost: 0, tokens_prompt: 0, tokens_completion: 0 } }),
          { status: 200 }
        )
      return new Response(JSON.stringify({ data: { total_cost: 0.0123, tokens_prompt: 9 } }), {
        status: 200
      })
    }) as unknown as typeof fetch
    expect(
      await fetchGenerationCost(
        'https://openrouter.ai/api/v1/',
        { Authorization: 'Bearer k' },
        'gen-1',
        { waits: [0, 0, 0], fetchImpl: fake }
      )
    ).toBe(0.0123)
    expect(calls).toBe(3)
    // custo 0 de verdade (modelo grátis: tokens > 0) vale
    const free = (async () =>
      new Response(JSON.stringify({ data: { total_cost: 0, tokens_prompt: 5 } }), {
        status: 200
      })) as unknown as typeof fetch
    expect(await fetchGenerationCost('https://x', {}, 'g', { waits: [0], fetchImpl: free })).toBe(0)
    const bad = (async () => new Response('x', { status: 500 })) as unknown as typeof fetch
    expect(
      await fetchGenerationCost('https://x', {}, 'g', { waits: [0], fetchImpl: bad })
    ).toBeNull()
  })
})

// ---------------- (D) runner + provedores falsos ----------------

const sseOf = (events: any[]): string =>
  events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
const textOfContent = (c: any): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((p: any) => p.text ?? '').join('') : ''

function finalText(model: string, text: string, cost?: number): any[] {
  return [
    { type: 'message_start', message: { model, usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 3, ...(cost != null ? { cost } : {}) }
    },
    { type: 'message_stop' }
  ]
}
const toolUseEvents = (model: string, id: string, name: string, args: string): any[] => [
  { type: 'message_start', message: { model, usage: {} } },
  {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'tool_use', id, name, input: {} }
  },
  {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'input_json_delta', partial_json: args }
  },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } },
  { type: 'message_stop' }
]

describe('(D) runner com provedores falsos (Anthropic /v1/messages, OpenRouter /api/v1/messages)', () => {
  let server: Server
  let base = ''
  const hits: { url: string; auth: string; key: string; body: any }[] = []
  let genHits = 0
  let behavior: {
    rejectDefer?: boolean
    rejectAll?: boolean
    rejectReplay?: boolean
    noCost?: boolean
  } = {}
  let h: Harness
  let pseq = 0

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res) => {
      void (async () => {
        const url = req.url ?? ''
        if (req.method === 'GET' && url.includes('/generation')) {
          genHits++
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ data: { total_cost: 0.0077 } }))
          return
        }
        if (req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ data: [] }))
          return
        }
        let raw = ''
        for await (const c of req) raw += c
        const body = JSON.parse(raw || '{}')
        hits.push({
          url,
          auth: String(req.headers.authorization ?? ''),
          key: String(req.headers['x-api-key'] ?? ''),
          body
        })
        const err = (msg: string): void => {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify({
              type: 'error',
              error: { type: 'invalid_request_error', message: msg }
            })
          )
        }
        if (behavior.rejectAll) return err('extraBody inválido (simulado)')
        if (behavior.rejectDefer && raw.includes('defer_loading'))
          return err('tool search is not supported for this model (simulado)')
        if (
          behavior.rejectReplay &&
          (body.messages ?? []).some(
            (m: any) =>
              m.role === 'assistant' &&
              Array.isArray(m.content) &&
              m.content.some((c: any) => c.type === 'server_tool_use')
          )
        )
          return err('Tool reference not found (simulado)')
        const msgs: any[] = body.messages ?? []
        const last = msgs.at(-1)
        const isOr = url.startsWith('/api/v1/')
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          ...(isOr ? { 'x-generation-id': `gen-${hits.length}` } : {})
        })
        const cost = isOr && !behavior.noCost ? 0.001 : undefined
        if (last?.role === 'assistant')
          return void res.end(sseOf(finalText(body.model, 'RETOMADO', cost)))
        if (
          last?.role === 'user' &&
          Array.isArray(last.content) &&
          last.content.some((c: any) => c.type === 'tool_result')
        )
          return void res.end(sseOf(finalText(body.model, 'FIM', cost)))
        const lastText = textOfContent(last?.content)
        if (lastText === 'pausa')
          return void res.end(
            sseOf([
              { type: 'message_start', message: { model: body.model, usage: {} } },
              {
                type: 'content_block_start',
                index: 0,
                content_block: {
                  type: 'server_tool_use',
                  id: 'srvtoolu_P',
                  name: 'tool_search_tool_regex',
                  input: {}
                }
              },
              {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'input_json_delta', partial_json: '{"pattern":"x"}' }
              },
              { type: 'content_block_stop', index: 0 },
              {
                type: 'message_delta',
                delta: { stop_reason: 'pause_turn' },
                usage: { output_tokens: 2 }
              },
              { type: 'message_stop' }
            ])
          )
        if (lastText === 'busca-local')
          return void res.end(
            sseOf(toolUseEvents(body.model, 'toolu_ts', 'tool_search', '{"names":["datetime"]}'))
          )
        if (lastText === 'hora') {
          if (!raw.includes('defer_loading'))
            // versão local: chama o datetime direto (compacto)
            return void res.end(
              sseOf(
                toolUseEvents(body.model, `toolu_l${hits.length}`, 'datetime', '{"format":"%Y"}')
              )
            )
          const ev = searchStream({ cost, orResult: isOr && !body.model.startsWith('claude') }).map(
            (e) =>
              e.type === 'content_block_start' && e.content_block.type === 'tool_use'
                ? { ...e, content_block: { ...e.content_block, id: `toolu_${hits.length}` } }
                : e.type === 'content_block_delta' && e.index === 3
                  ? { ...e, delta: { type: 'input_json_delta', partial_json: '{"format":"%Y"}' } }
                  : e
          )
          return void res.end(sseOf(ev))
        }
        res.end(sseOf(finalText(body.model, 'ok', cost)))
      })()
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => {
    server?.close()
    resetSources()
  })
  beforeEach(async () => {
    behavior = {}
    h = await makeHarness({ generationWaits: [0, 0] })
    setNativeTestHosts(['127.0.0.1'])
  })
  afterEach(async () => {
    await h?.close()
    setNativeTestHosts([])
  })

  /** Provedor falso (registro sincronizado) + chat deste celular; devolve a sessão principal. */
  async function newChat(
    kind: 'anthropic' | 'openrouter',
    model: string,
    over: Partial<ChatConfig> = {}
  ): Promise<{ sid: string; chatId: string; providerId: string }> {
    const providerId = `prov-${kind}-${++pseq}`
    await h.desk.put('provider', providerId, null, {
      sv: 1,
      name: `Falso ${kind}`,
      kind,
      baseUrl: kind === 'anthropic' ? `${base}/v1` : `${base}/api/v1`,
      apiKey: kind === 'anthropic' ? 'sk-ant-falsa' : 'sk-or-falsa',
      headers: {},
      createdAt: 2
    })
    await h.engine.sync()
    const { chat, session } = h.stack.repo.createChat({
      config: {
        ...DEFAULT_CHAT_CONFIG(''),
        providerId,
        model,
        enabledTools: ['web_search', 'browse_url', 'datetime', 'shell', 'read_file'] as ToolName[],
        toolsFull: ['web_search'] as ToolName[],
        envInPrompt: false,
        ...over
      },
      title: ''
    })
    return { sid: session.id, chatId: chat.id, providerId }
  }
  async function turn(sid: string, text: string): Promise<StoredMessage[]> {
    await h.stack.runner.send(sid, text)
    await until(() => !h.stack.runner.isRunning(sid), 10_000, `fim do turno (${text})`)
    return h.stack.repo.path(sid)
  }
  const capsOf = (): Record<string, any> =>
    JSON.parse(h.store.getMeta(TOOL_SEARCH_CAPS_SETTING) ?? '{}')

  it('native-anthropic: busca do servidor, native gravado, 2ª request com os MESMOS tools e os blocos reenviados (sem tool_result do srvtoolu)', async () => {
    const { sid } = await newChat('anthropic', 'claude-haiku-4-5')
    const n0 = hits.length
    const msgs = await turn(sid, 'hora')
    const reqs = hits.slice(n0)
    expect(reqs).toHaveLength(2)
    expect(reqs[0].url).toBe('/v1/messages')
    expect(reqs[0].key).toBe('sk-ant-falsa')
    expect(reqs[0].body.tools.map((t: any) => t.name ?? t.type)).toEqual([
      'web_search',
      'browse_url',
      'datetime',
      'tool_search_tool_regex'
    ])
    expect(JSON.stringify(reqs[1].body.tools)).toBe(JSON.stringify(reqs[0].body.tools))
    const a = msgs.find((m) => m.message.role === 'assistant' && m.message.tool_calls)!
    const native = (a.message as any).native
    expect(native.content.map((b: any) => b.type)).toEqual([
      'text',
      'server_tool_use',
      'tool_search_tool_result',
      'tool_use'
    ])
    expect(a.meta.toolSearch).toEqual({ mode: 'native-anthropic' })
    const sentAsst = reqs[1].body.messages.find((m: any) => m.role === 'assistant')
    expect(sentAsst.content).toEqual(native.content)
    expect(JSON.stringify(reqs[1].body)).not.toContain(
      '"tool_use_id":"srvtoolu_xyz789","content":"'
    )
    const tool = msgs.find((m) => m.message.role === 'tool')!
    expect(tool.meta.toolStatus).toBe('ok')
    const fin = msgs.at(-1)!
    expect(fin.message.content).toBe('FIM')
    expect((fin.message as any).native).toBeUndefined()
    // o registro sincronizado leva o native (o computador reenvia ao assumir o chat)
    const plain = h.store.getPlain('message', a.id) as any
    expect(plain.message.native.content).toHaveLength(4)
  })

  it('native-openrouter: POST /api/v1/messages com Bearer; custo pelo /generation quando o stream não traz', async () => {
    behavior = { noCost: true }
    const { sid } = await newChat('openrouter', 'openai/gpt-5.6-luna')
    const n0 = hits.length
    const msgs = await turn(sid, 'hora')
    const r = hits[n0]
    expect(r.url).toBe('/api/v1/messages')
    expect(r.auth).toBe('Bearer sk-or-falsa')
    expect(r.body.tools.at(-1)).toEqual({ type: 'openrouter:tool_search' })
    const a = msgs.find((m) => m.message.role === 'assistant' && m.message.tool_calls)!
    const native = (a.message as any).native
    expect(native.kind).toBe('openrouter')
    expect(native.content.some((b: any) => b.type === 'openrouter_tool_search_result')).toBe(true)
    await until(
      () => h.stack.repo.get(a.id)?.meta.usage?.cost === 0.0077,
      8000,
      'custo do /generation'
    )
    // com usage.cost no stream: o custo de lá, sem GET /generation
    behavior = {}
    const g0 = genHits
    const after = await turn(sid, 'oi')
    expect(after.at(-1)!.meta.usage?.cost).toBe(0.001)
    expect(genHits).toBe(g0)
  })

  it('tool_search não existe nos modos nativos (chamada vinda do modelo → indisponível)', async () => {
    const { sid } = await newChat('anthropic', 'claude-haiku-4-5')
    await turn(sid, 'oi') // registra o modo da sessão
    const msgs = await turn(sid, 'busca-local')
    const tool = msgs.filter((m) => m.message.role === 'tool').at(-1)!
    expect(tool.meta.toolStatus).toBe('error')
    expect(textOfContent(tool.message.content)).toMatch(/"tool_search" não está disponível/)
  })

  it('queda: o provedor recusa o nativo → repetição local, falha lembrada 24 h no aparelho, meta com fallbackFrom; próximo turno direto na local', async () => {
    behavior = { rejectDefer: true }
    const { sid, providerId } = await newChat('anthropic', 'claude-sonnet-5-5')
    const n0 = hits.length
    const msgs = await turn(sid, 'hora')
    const reqs = hits.slice(n0)
    expect(JSON.stringify(reqs[0].body)).toContain('defer_loading')
    expect(JSON.stringify(reqs[1].body)).not.toContain('defer_loading')
    expect(reqs[1].body.tools.at(-1).name).toBe('tool_search')
    const a = msgs.find((m) => m.message.role === 'assistant' && m.message.tool_calls)!
    expect(a.meta.toolSearch).toMatchObject({ mode: 'local', fallbackFrom: 'native-anthropic' })
    expect(a.meta.toolSearch!.reason).toMatch(/recusada: HTTP 400/)
    expect((a.message as any).native).toBeUndefined()
    const f = capsOf()[capsKey(providerId, 'claude-sonnet-5-5')]
    expect(f.mode).toBe('native-anthropic')
    expect(f.error).toMatch(/tool search is not supported/)
    expect(h.stack.toolSearchCaps.get()[capsKey(providerId, 'claude-sonnet-5-5')]).toBeTruthy()
    const n1 = hits.length
    await turn(sid, 'oi de novo')
    expect(hits.slice(n1).every((x) => !JSON.stringify(x.body).includes('defer_loading'))).toBe(
      true
    )
  })

  it('erro que também acontece na local NÃO é lembrado (é do pedido)', async () => {
    behavior = { rejectAll: true }
    const { sid, providerId } = await newChat('anthropic', 'claude-opus-5-5')
    const msgs = await turn(sid, 'hora')
    expect(msgs.some((m) => m.meta.kind === 'error')).toBe(true)
    expect(capsOf()[capsKey(providerId, 'claude-opus-5-5')]).toBeUndefined()
  })

  it('reenvio recusado → repete sem reenviar (mesmo modo nativo, nada lembrado); a mensagem não é mais reenviada na sessão', async () => {
    const { sid, providerId } = await newChat('anthropic', 'claude-haiku-5-5')
    await turn(sid, 'hora') // grava native
    behavior = { rejectReplay: true }
    const n0 = hits.length
    const msgs = await turn(sid, 'e agora?')
    const reqs = hits.slice(n0)
    expect(reqs).toHaveLength(2)
    expect(JSON.stringify(reqs[0].body.messages)).toContain('server_tool_use')
    expect(JSON.stringify(reqs[1].body.messages)).not.toContain('server_tool_use')
    // continua nativa (browse_url adiada; datetime — usada sem a descoberta junto — carregada)
    expect(reqs[1].body.tools.find((t: any) => t.name === 'browse_url').defer_loading).toBe(true)
    expect(reqs[1].body.tools.find((t: any) => t.name === 'datetime').defer_loading).toBeUndefined()
    expect(msgs.at(-1)!.meta.toolSearch).toEqual({ mode: 'native-anthropic' })
    expect(capsOf()[capsKey(providerId, 'claude-haiku-5-5')]).toBeUndefined()
    behavior = {}
    const n1 = hits.length
    await turn(sid, 'mais uma')
    expect(JSON.stringify(hits[n1].body.messages)).not.toContain('server_tool_use')
  })

  it('pause_turn → nova request sem mensagem do usuário, terminando no assistente pausado', async () => {
    const { sid } = await newChat('anthropic', 'claude-haiku-4-5')
    const n0 = hits.length
    const msgs = await turn(sid, 'pausa')
    const reqs = hits.slice(n0)
    expect(reqs).toHaveLength(2)
    const last = reqs[1].body.messages.at(-1)
    expect(last.role).toBe('assistant')
    expect(last.content.at(-1).type).toBe('server_tool_use')
    expect(
      msgs.find((m) => m.message.role === 'assistant' && (m.message as any).native)
    ).toBeTruthy()
    expect(msgs.at(-1)!.message.content).toBe('RETOMADO')
  })

  it('editar a resposta tira o native que não bate mais (§4.3.8)', async () => {
    const { sid } = await newChat('anthropic', 'claude-haiku-4-5')
    const msgs = await turn(sid, 'hora')
    const a = msgs.find((m) => m.message.role === 'assistant' && (m.message as any).native)!
    const same = h.stack.runner.editMessage(a.id, a.message)
    expect((same.message as any).native).toBeTruthy()
    const edited = h.stack.runner.editMessage(a.id, {
      ...a.message,
      content: 'Outro texto.'
    } as any)
    expect((edited.message as any).native).toBeUndefined()
    expect((h.store.getPlain('message', a.id) as any).message.native).toBeUndefined()
  })

  it('chat do computador hospedado aqui: o native de lá é reenviado sem as referências às tools do computador e sem mandá-las', async () => {
    const { sid, providerId } = await newChat('anthropic', 'claude-haiku-4-5')
    // o que o computador gravou (busca achou datetime, shell e read_file; ele rodou shell antes)
    const desk = nativeTurnFrom(
      [
        { type: 'text', text: 'Vou ver.' },
        {
          type: 'server_tool_use',
          id: 'srv_D',
          name: 'tool_search_tool_regex',
          input: { pattern: '.' }
        },
        {
          type: 'tool_search_tool_result',
          tool_use_id: 'srv_D',
          content: {
            type: 'tool_search_tool_search_result',
            tool_references: ['datetime', 'shell', 'read_file'].map((n) => ({
              type: 'tool_reference',
              tool_name: n
            }))
          }
        },
        { type: 'tool_use', id: 'toolu_D', name: 'datetime', input: {} }
      ],
      { providerId, kind: 'anthropic', model: 'claude-haiku-4-5' }
    )!
    const repo = h.stack.repo
    repo.append(sid, { role: 'user', content: 'liste e veja a hora' })
    repo.append(sid, {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'sh1', type: 'function', function: { name: 'shell', arguments: '{}' } }]
    })
    repo.append(sid, { role: 'tool', tool_call_id: 'sh1', content: 'a.txt' })
    repo.append(sid, {
      role: 'assistant',
      content: 'Vou ver.',
      tool_calls: [
        { id: 'toolu_D', type: 'function', function: { name: 'datetime', arguments: '{}' } }
      ],
      native: desk
    })
    repo.append(sid, { role: 'tool', tool_call_id: 'toolu_D', content: '14:05' })
    repo.append(sid, { role: 'assistant', content: 'São 14:05.' })
    const n0 = hits.length
    await turn(sid, 'e agora?')
    const r = hits[n0].body
    expect(r.tools.map((t: any) => t.name ?? t.type)).toEqual([
      'web_search',
      'browse_url',
      'datetime',
      'tool_search_tool_regex'
    ])
    const replayed = r.messages.find(
      (m: any) => m.role === 'assistant' && m.content.some((c: any) => c.type === 'server_tool_use')
    )
    const res = replayed.content.find((c: any) => c.type === 'tool_search_tool_result')
    expect(res.content.tool_references).toEqual([{ type: 'tool_reference', tool_name: 'datetime' }])
    // datetime foi descoberta junto (vai adiada); shell nunca vai daqui
    expect(r.tools.find((t: any) => t.name === 'datetime').defer_loading).toBe(true)
    expect(JSON.stringify(r.tools)).not.toContain('"name":"shell"')
    // o histórico salvo não muda (a referência ao shell continua lá para o computador)
    const saved = repo.path(sid).find((m) => (m.message as any).native)!
    expect(JSON.stringify((saved.message as any).native)).toContain('"tool_name":"shell"')
  })
})

describe('(D) provedor falso padrão dos testes/E2E (fakeLlm na Messages API)', () => {
  let h: Harness
  afterEach(async () => {
    await h?.close()
    resetSources()
  })

  it('"/now" com tools adiadas: busca do servidor + datetime num turno; native e o chip "buscou tools"', async () => {
    h = await makeHarness({ kind: 'anthropic' })
    setNativeTestHosts(['127.0.0.1'])
    const { session } = h.stack.repo.createChat({
      config: {
        ...DEFAULT_CHAT_CONFIG(''),
        providerId: h.providerId,
        model: 'claude-haiku-4-5',
        enabledTools: ['web_search', 'datetime'] as ToolName[]
      },
      title: ''
    })
    await h.stack.runner.send(session.id, '/now %H:%M')
    await until(() => !h.stack.runner.isRunning(session.id), 10_000, 'turno')
    const msgs = h.stack.repo.path(session.id)
    const a = msgs.find((m) => (m.message as any).native)!
    expect(a.meta.toolSearch).toEqual({ mode: 'native-anthropic' })
    expect(nativeSearches((a.message as any).native).map(nativeSearchChip)).toEqual([
      'buscou tools: datetime'
    ])
    expect(msgs.filter((m) => m.message.role === 'tool').pop()!.meta.toolStatus).toBe('ok')
    expect(String(msgs.at(-1)!.message.content)).toContain('Resultado recebido (datetime)')
  })
})
