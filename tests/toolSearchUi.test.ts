// Busca nativa de tools (protocolo 1.12.0, §4.3.6 — "A UI DEVE mostrar o modo efetivo do chat (e o
// motivo quando não é nativo)") nas telas de tools do celular: o modo calculado NESTE aparelho com o
// mesmo resolvedor da request (configurações do chat, persona, Novo chat, tools da chamada) — rótulo,
// linha de estado, motivo, o aviso da versão local, os chips "adiada"/"carregada", os itens exatos de
// `tools[]` (iguais aos da request) e a falha lembrada neste aparelho.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  ANTHROPIC_SEARCH_TOOL,
  TOOL_SEARCH_LOCAL_NOTICE,
  capsKey,
  nativeToolSearchPrompt,
  nativeTurnFrom
} from '../src/vendor/shared/toolSearch'
import { DEFAULT_CHAT_CONFIG } from '../src/vendor/shared/defaults'
import type {
  ApiMessage,
  ChatConfig,
  Provider,
  StoredMessage,
  ToolName
} from '../src/vendor/shared/types'
import {
  buildRequest,
  setModelInfoSource,
  setToolSearchCapsSource,
  toolDefinitions
} from '../src/agent/request'
import {
  nativeToolState,
  toolChipText,
  toolSearchLine,
  toolSearchViewOf
} from '../src/settings/toolSearchUi'
import { compactStatusText } from '../src/settings/compactUi'

const ENV = { os: 'Android 16' }
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
const cfgOf = (over: Partial<ChatConfig> = {}): ChatConfig => ({
  ...DEFAULT_CHAT_CONFIG('', { providerId: 'pa', model: 'claude-sonnet-5-5', systemPrompt: 'SYS' }),
  enabledTools: ['web_search', 'browse_url', 'datetime', 'shell', 'read_file'] as ToolName[],
  toolsFull: ['web_search'] as ToolName[],
  envInPrompt: false,
  cacheEnabled: true,
  ...over
})
const mkChat = (over: Partial<ChatConfig> = {}) => ({
  id: 'c1',
  title: '',
  mainSessionId: 's1',
  createdAt: 0,
  updatedAt: 0,
  config: cfgOf(over)
})
const sm = (message: ApiMessage): StoredMessage => ({
  id: 'm1',
  sessionId: 's1',
  seq: 1,
  message,
  meta: {},
  createdAt: 0
})
const S = { depth: 0 as const, model: 'claude-sonnet-5-5' }
const resetSources = (): void => {
  setToolSearchCapsSource(() => ({}))
  setModelInfoSource(() => undefined)
}

describe('(E) telas de tools: o modo efetivo calculado no aparelho', () => {
  beforeEach(resetSources)
  afterAll(resetSources)

  it('Anthropic oficial: rótulo, status, adiadas, itens exatos com defer_loading/cache e a entrada de busca', () => {
    const cfg = cfgOf()
    const view = toolSearchViewOf({ cfg, provider: ANTH, model: 'claude-sonnet-5-5' })
    expect(view.mode).toBe('native-anthropic')
    expect(view.label).toBe('Busca nativa da Anthropic')
    expect(view.deferred).toEqual(['browse_url', 'datetime'])
    expect(view.items.browse_url.defer_loading).toBe(true)
    expect(view.items.web_search.cache_control).toEqual({ type: 'ephemeral' })
    expect(view.items.shell).toBeUndefined()
    expect(view.searchEntry).toEqual(ANTHROPIC_SEARCH_TOOL)
    const line = toolSearchLine(view)!
    expect(line.label).toBe('Busca nativa da Anthropic')
    expect(line.status).toMatch(/^2 tools vão completas e adiadas \(defer_loading\)/)
    expect(line.notice).toBeUndefined()
    expect(toolChipText(true, false)).toBe('adiada')
    expect(toolChipText(true, true)).toBe('carregada')
    expect(toolChipText(false, false)).toBe('compacta')
    // a mesma request (o item exato que vai e o prompt fixo nativo exato)
    const req = buildRequest(mkChat(), S, [], ANTH, ENV).body as any
    expect(view.items.datetime).toEqual(req.tools.find((t: any) => t.name === 'datetime'))
    expect(view.prompt).toBe(nativeToolSearchPrompt(['browse_url', 'datetime'], 'native-anthropic'))
    expect(req.system[0].text).toBe(`SYS\n\n${view.prompt}`)
    expect(view.forceLoaded).toEqual([])
    // tool desligada: o item que iria pela config
    const [ask] = toolDefinitions(['ask_user'])
    expect(nativeToolState(view, 'ask_user', ask, true)).toMatchObject({
      deferred: true,
      forced: false,
      item: { name: 'ask_user', defer_loading: true }
    })
  })

  it('adiada já usada no histórico sem a busca: "carregada nesta request" e fora do prompt — a mesma conta da request; noReplay idem', () => {
    // resposta de OUTRO modelo com a busca (não reenviada) que chamou o datetime
    const native = nativeTurnFrom(
      [
        { type: 'text', text: 'Vou ver.' },
        { type: 'server_tool_use', id: 'srv', name: 'tool_search_tool_regex', input: {} },
        {
          type: 'tool_search_tool_result',
          tool_use_id: 'srv',
          content: {
            type: 'tool_search_tool_search_result',
            tool_references: [{ type: 'tool_reference', tool_name: 'datetime' }]
          }
        },
        { type: 'tool_use', id: 'tu', name: 'datetime', input: {} }
      ],
      { providerId: 'pa', kind: 'anthropic', model: 'claude-opus-5-5' }
    )!
    const history: StoredMessage[] = [
      { ...sm({ role: 'user', content: 'hora?' }), id: 'u1', seq: 1 },
      {
        ...sm({
          role: 'assistant',
          content: 'Vou ver.',
          tool_calls: [
            { id: 'tu', type: 'function', function: { name: 'datetime', arguments: '{}' } }
          ],
          native
        }),
        id: 'a1',
        seq: 2
      },
      { ...sm({ role: 'tool', tool_call_id: 'tu', content: '14:05' }), id: 't1', seq: 3 }
    ]
    const view = toolSearchViewOf({
      cfg: cfgOf(),
      provider: ANTH,
      model: 'claude-sonnet-5-5',
      history
    })
    expect(view.forceLoaded).toEqual(['datetime'])
    expect(view.deferred).toEqual(['browse_url'])
    expect(view.items.datetime.defer_loading).toBeUndefined()
    expect(view.prompt).toBe(nativeToolSearchPrompt(['browse_url'], 'native-anthropic'))
    const [dt] = toolDefinitions(['datetime'])
    expect(nativeToolState(view, 'datetime', dt, true)).toMatchObject({
      deferred: false,
      forced: true
    })
    const req = buildRequest(mkChat(), S, history, ANTH, ENV).body as any
    expect(req.system[0].text).toBe(`SYS\n\n${view.prompt}`)
    expect(req.tools.find((t: any) => t.name === 'datetime')).toEqual(view.items.datetime)
    // mesmo modelo: reenviada → datetime descoberta, continua adiada; com noReplay, carregada
    const same = { ...native, model: 'claude-sonnet-5-5' }
    const h2 = history.map((m) =>
      m.id === 'a1' ? { ...m, message: { ...m.message, native: same } as ApiMessage } : m
    )
    expect(
      toolSearchViewOf({ cfg: cfgOf(), provider: ANTH, model: 'claude-sonnet-5-5', history: h2 })
        .deferred
    ).toEqual(['browse_url', 'datetime'])
    expect(
      toolSearchViewOf({
        cfg: cfgOf(),
        provider: ANTH,
        model: 'claude-sonnet-5-5',
        history: h2,
        noReplay: new Set(['a1'])
      }).forceLoaded
    ).toEqual(['datetime'])
  })

  it('OpenRouter: Messages API; versão local num genérico com o motivo e o aviso; sem compactação; sem provedor', () => {
    const cfg = cfgOf({ providerId: 'po' })
    expect(toolSearchViewOf({ cfg, provider: ORP, model: 'openai/gpt-5.6-luna' }).label).toBe(
      'Busca nativa do OpenRouter (Messages API)'
    )
    const gen = toolSearchViewOf({
      cfg,
      provider: { ...ORP, kind: 'openai', baseUrl: 'https://llm.example.com/v1' },
      model: 'm'
    })
    expect(gen.mode).toBe('local')
    expect(gen.compacted).toEqual(['browse_url', 'datetime'])
    const line = toolSearchLine(gen)!
    expect(line.label).toBe('Versão local do app')
    expect(line.reason).toMatch(/^Motivo: provedor OpenAI-compatible genérico/)
    expect(line.notice).toBe(TOOL_SEARCH_LOCAL_NOTICE)
    // áudio no histórico da principal → Chat Completions (local)
    const audio = toolSearchViewOf({
      cfg,
      provider: ORP,
      model: 'openai/gpt-5.6-luna',
      history: [
        sm({
          role: 'user',
          content: [{ type: 'input_audio', input_audio: { data: 'x', format: 'wav' } }]
        })
      ]
    })
    expect(audio.mode).toBe('local')
    expect(audio.reason).toMatch(/áudio/)
    const off = toolSearchViewOf({
      cfg: { ...cfg, toolsCompact: false },
      provider: ORP,
      model: 'x'
    })
    expect(off.mode).toBe('off')
    expect(toolSearchLine(off)).toBeNull()
    const none = toolSearchViewOf({ cfg, provider: null, model: '' })
    expect(none.mode).toBe('local')
    expect(none.reason).toBe('sem provedor/modelo escolhido')
  })

  it('falha lembrada neste aparelho: a tela mostra a versão local com o motivo (a mesma da request)', () => {
    setToolSearchCapsSource(() => ({
      [capsKey('pa', 'claude-sonnet-5-5')]: {
        mode: 'native-anthropic',
        failedAt: Date.now() - 1000,
        error: 'HTTP 400: tool search is not supported'
      }
    }))
    const view = toolSearchViewOf({ cfg: cfgOf(), provider: ANTH, model: 'claude-sonnet-5-5' })
    expect(view.mode).toBe('local')
    expect(view.failure?.mode).toBe('native-anthropic')
    const line = toolSearchLine(view)!
    expect(line.reason).toMatch(
      /a busca nativa falhou com claude-sonnet-5-5 .*tool search is not supported.*24 h/
    )
    expect(line.notice).toBe(TOOL_SEARCH_LOCAL_NOTICE)
    expect(buildRequest(mkChat(), S, [], ANTH, ENV).toolSearch?.mode).toBe('local')
  })

  it('linha de estado sem o modo resolvido (versão local, nome novo)', () => {
    expect(compactStatusText({}, ['web_search', 'datetime'])).toBe(
      '2 das ligadas vão compactas (+ tool_search e uma instrução curta no fim do system prompt).'
    )
  })
})
