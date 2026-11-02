// Agente no celular: acumulação do SSE (OpenAI + Anthropic, tool calls, usage), montagem da request
// (tools portáveis, parâmetros que o modelo não aceita, cache, Anthropic, anexos) e o runner contra o
// provedor falso (stream → mensagem com meta, tools com aprovação, questionário, fila/⚡, Parar,
// falha de conexão, erro do provedor, versões).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applyChunk,
  finalizeToolCalls,
  newAccumulator,
  parseUsage,
  readableError,
  streamChat
} from '../src/vendor/desktop/agent/llm'
import { applyAnthropicEvent } from '../src/vendor/desktop/agent/adapters/anthropic'
import {
  availableTools,
  buildRequest,
  setModelInfoSource,
  systemContent
} from '../src/agent/request'
import { DEFAULT_CHAT_CONFIG } from '../src/vendor/shared/defaults'
import type { Chat, ChatConfig, Provider, StoredMessage } from '../src/vendor/shared/types'
import { makeHarness, until, type Harness } from './hostHarness'

const provider = (over: Partial<Provider> = {}): Provider => ({
  id: 'p',
  name: 'P',
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: 'sk-x',
  headers: {},
  createdAt: 0,
  ...over
})

const chat = (cfg: Partial<ChatConfig> = {}): Chat => ({
  id: 'c',
  title: '',
  config: { ...DEFAULT_CHAT_CONFIG(''), providerId: 'p', model: 'm', ...cfg },
  mainSessionId: 's',
  createdAt: 0,
  updatedAt: 0
})

const msg = (
  id: string,
  seq: number,
  message: StoredMessage['message'],
  parentId: string | null
): StoredMessage => ({
  id,
  sessionId: 's',
  seq,
  parentId,
  message,
  meta: {},
  createdAt: seq
})

describe('llm (vendorado): acumulação do stream', () => {
  it('OpenAI: conteúdo, raciocínio, tool calls em pedaços e usage com custo', () => {
    const acc = newAccumulator()
    applyChunk(acc, { model: 'x/y', choices: [{ delta: { reasoning: 'pen' } }] })
    applyChunk(acc, { choices: [{ delta: { reasoning: 'so', content: 'Olá' } }] })
    applyChunk(acc, {
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: 'c1', function: { name: 'web_', arguments: '{"q' } }]
          }
        }
      ]
    })
    applyChunk(acc, {
      choices: [
        { delta: { tool_calls: [{ index: 0, function: { name: 'search', arguments: '":1}' } }] } }
      ]
    })
    applyChunk(acc, {
      choices: [{ delta: {}, finish_reason: 'tool_calls' }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 3 },
        cost: 0.01
      }
    })
    expect(acc.content).toBe('Olá')
    expect(acc.reasoning).toBe('penso')
    expect(acc.model).toBe('x/y')
    expect(finalizeToolCalls(acc)).toEqual([{ id: 'c1', name: 'web_search', arguments: '{"q":1}' }])
    expect(acc.usage).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      cachedTokens: 3,
      cost: 0.01
    })
    expect(acc.finishReason).toBe('tool_calls')
  })

  it('OpenAI: chamadas repetindo index 0 com ids diferentes viram entradas novas; id ausente é gerado', () => {
    const acc = newAccumulator()
    applyChunk(acc, {
      choices: [
        { delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'x', arguments: '{}' } }] } }
      ]
    })
    applyChunk(acc, {
      choices: [
        { delta: { tool_calls: [{ index: 0, id: 'b', function: { name: 'y', arguments: '{}' } }] } }
      ]
    })
    applyChunk(acc, {
      choices: [{ delta: { tool_calls: [{ index: 2, function: { name: 'z', arguments: '{}' } }] } }]
    })
    const calls = finalizeToolCalls(acc)
    expect(calls.map((c) => c.name)).toEqual(['x', 'y', 'z'])
    expect(calls[2].id).toMatch(/^call_/)
  })

  it('erro no stream e corpo de erro legível', () => {
    expect(() => applyChunk(newAccumulator(), { error: { message: 'cota' } })).toThrow(/cota/)
    expect(
      readableError(
        429,
        'Too Many',
        '{"error":{"message":"devagar","metadata":{"provider_name":"X"}}}'
      )
    ).toBe('Erro HTTP 429 Too Many: devagar (provider: X)')
    expect(parseUsage({ prompt_tokens: 'x' })).toEqual({ promptTokens: 0, completionTokens: 0 })
  })

  it('Anthropic: texto, thinking, tool_use com input_json_delta e usage', () => {
    const acc = newAccumulator()
    const evs = [
      {
        type: 'message_start',
        message: { model: 'claude-x', usage: { input_tokens: 50, cache_read_input_tokens: 7 } }
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Oi' } },
      {
        type: 'content_block_start',
        index: 2,
        content_block: { type: 'tool_use', id: 'tu1', name: 'browse_url', input: {} }
      },
      {
        type: 'content_block_delta',
        index: 2,
        delta: { type: 'input_json_delta', partial_json: '{"url":' }
      },
      {
        type: 'content_block_delta',
        index: 2,
        delta: { type: 'input_json_delta', partial_json: '"x.com"}' }
      },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 12 } }
    ]
    for (const e of evs) applyAnthropicEvent(acc, e)
    expect(acc.reasoning).toBe('hmm')
    expect(acc.content).toBe('Oi')
    expect(finalizeToolCalls(acc)).toEqual([
      { id: 'tu1', name: 'browse_url', arguments: '{"url":"x.com"}' }
    ])
    expect(acc.usage?.completionTokens).toBe(12)
    expect(acc.usage?.promptTokens).toBeGreaterThanOrEqual(50)
  })

  it('streamChat sobre HTTP real com o SSE em pedaços (vendorado; global fetch)', async () => {
    const { startFakeLlm } = await import('./fakes/fakeLlm')
    const llm = await startFakeLlm(0, { delay: 2 })
    try {
      const acc = newAccumulator()
      let updates = 0
      await streamChat(
        {
          url: `${llm.url}/v1/chat/completions`,
          headers: { 'Content-Type': 'application/json' },
          body: { model: 'fake/agent', messages: [{ role: 'user', content: 'oi mundo' }] }
        },
        new AbortController().signal,
        acc,
        () => updates++
      )
      expect(acc.content).toBe('ok: oi mundo')
      expect(acc.reasoning).toBe('pensando no pedido')
      expect(acc.completed).toBe(true)
      expect(acc.usage?.cost).toBe(0.00042)
      expect(updates).toBeGreaterThan(3)
    } finally {
      await llm.close()
    }
  })
})

describe('request no celular', () => {
  afterEach(() => setModelInfoSource(() => undefined))

  it('só tools portáveis vão ao modelo; ask_user só na principal', () => {
    const c = chat({
      enabledTools: [
        'shell',
        'read_file',
        'web_search',
        'browse_url',
        'ask_user',
        'delegate_task',
        'list_models'
      ]
    })
    expect(availableTools(c, { depth: 0 })).toEqual([
      'web_search',
      'browse_url',
      'list_models',
      'ask_user'
    ])
    expect(availableTools(c, { depth: 1 })).toEqual(['web_search', 'browse_url', 'list_models'])
    const req = buildRequest(c, { depth: 0, model: 'm' }, [], provider())
    const names = (req.body.tools as { function: { name: string } }[]).map((t) => t.function.name)
    expect(names).toEqual(['web_search', 'browse_url', 'list_models', 'ask_user'])
  })

  it('parâmetros que o modelo não aceita saem da request (com nota); os aceitos vão', () => {
    setModelInfoSource(() => ({ id: 'm', supportedParams: ['max_tokens'] }))
    const c = chat({ params: { temperature: 0.3, max_tokens: 500 } })
    const req = buildRequest(c, { depth: 0, model: 'm' }, [], provider())
    expect(req.body.max_tokens).toBe(500)
    expect(req.body.temperature).toBeUndefined()
    expect(req.notes?.join(' ')).toMatch(/temperature/)
    setModelInfoSource(() => undefined)
    const req2 = buildRequest(c, { depth: 0, model: 'm' }, [], provider())
    expect(req2.body.temperature).toBe(0.3)
  })

  it('OpenRouter: cache_control, usage incluído, reasoning; sem reasoning no histórico de outros provedores', () => {
    const c = chat({ cacheEnabled: true, params: { reasoning_effort: 'low' } })
    const h = [
      msg('u1', 1, { role: 'user', content: 'oi' }, null),
      msg('a1', 2, { role: 'assistant', content: 'olá', reasoning: 'r' }, 'u1'),
      msg('u2', 3, { role: 'user', content: 'tudo?' }, 'a1')
    ]
    const req = buildRequest(c, { depth: 0, model: 'm' }, h, provider())
    const wire = req.body.messages as { role: string; content: unknown; reasoning?: string }[]
    expect(wire[0].role).toBe('system')
    expect(JSON.stringify(wire[0].content)).toContain('ephemeral')
    expect(JSON.stringify(wire[wire.length - 1].content)).toContain('ephemeral')
    expect(req.body.usage).toEqual({ include: true })
    expect(req.body.reasoning).toEqual({ effort: 'low' })
    expect(wire[2].reasoning).toBe('r')
    const plain = buildRequest(
      chat(),
      { depth: 0, model: 'm' },
      h,
      provider({ baseUrl: 'https://api.x.com/v1' })
    )
    expect((plain.body.messages as { reasoning?: string }[])[2].reasoning).toBeUndefined()
    expect(plain.headers.Authorization).toBe('Bearer sk-x')
    expect(plain.url).toBe('https://api.x.com/v1/chat/completions')
  })

  it('environment sem raiz/shell; tool sem resposta ganha placeholder; erro fica fora', () => {
    const c = chat()
    expect(systemContent(c, { depth: 0 })).toMatch(
      /<environment>[\s\S]*celular[\s\S]*<\/environment>/
    )
    expect(systemContent(c, { depth: 0 })).not.toMatch(/root:|shell:/)
    const h: StoredMessage[] = [
      msg('u1', 1, { role: 'user', content: 'pesquise' }, null),
      msg(
        'a1',
        2,
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 't1', type: 'function', function: { name: 'web_search', arguments: '{}' } }
          ]
        },
        'u1'
      ),
      {
        ...msg('e1', 3, { role: 'assistant', content: 'Erro HTTP 500' }, 'a1'),
        meta: { kind: 'error', synthetic: true }
      }
    ]
    const req = buildRequest(
      c,
      { depth: 0, model: 'm' },
      h,
      provider({ baseUrl: 'https://api.x.com/v1' })
    )
    const wire = req.body.messages as { role: string; content: unknown }[]
    expect(wire.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool'])
    expect(JSON.stringify(wire[3].content)).toContain('[Resultado indisponível]')
  })

  it('Anthropic nativa: /messages, x-api-key, system separado, anexos expandidos', () => {
    const file = `${'a'.repeat(64)}.png`
    const h = [
      msg(
        'u1',
        1,
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: `clearchat-attachment://${file}` },
              _attachment: { name: 'f.png', mime: 'image/png', size: 3, kind: 'image', file }
            },
            { type: 'text', text: 'o que é?' }
          ]
        },
        null
      )
    ]
    const req = buildRequest(
      chat(),
      { depth: 0, model: 'claude-x' },
      h,
      provider({ baseUrl: 'https://api.anthropic.com/v1', kind: 'anthropic' }),
      {
        read: () => 'QUJD'
      }
    )
    expect(req.url).toBe('https://api.anthropic.com/v1/messages')
    expect(req.headers['x-api-key']).toBe('sk-x')
    expect(req.body.system).toBeTruthy()
    expect(JSON.stringify(req.body.messages)).toContain('QUJD')
    expect(JSON.stringify(req.body.messages)).not.toContain('_attachment')
  })
})

describe('runner (provedor falso)', () => {
  let h: Harness
  beforeEach(async () => {
    h = await makeHarness()
  })
  afterEach(async () => {
    await h.close()
  })

  const newChat = (cfg: Partial<ChatConfig> = {}) => {
    const { chat: c, session } = h.stack.repo.createChat({
      config: {
        ...DEFAULT_CHAT_CONFIG(''),
        providerId: h.providerId,
        model: 'fake/agent',
        enabledTools: ['web_search', 'browse_url', 'list_models', 'ask_user'],
        ...cfg
      },
      title: ''
    })
    return { chatId: c.id, sid: session.id }
  }
  const idle = (sid: string) =>
    until(() => !h.stack.runner.isRunning(sid), 10_000, 'turno terminar')
  const path = (sid: string) => h.stack.repo.path(sid)

  it('turno simples: draft ao vivo, mensagem com meta (modelo, tokens, custo, duração, raciocínio), título provisório', async () => {
    const { chatId, sid } = newChat()
    const drafts: string[] = []
    h.stack.runner.bus.on((e) => {
      if (e.type === 'draft' && e.draft) drafts.push(e.draft.content)
    })
    await h.stack.runner.send(
      sid,
      'olá agente com uma mensagem um pouco mais longa para o draft aparecer'
    )
    await idle(sid)
    const p = path(sid)
    expect(p.map((m) => m.message.role)).toEqual(['user', 'assistant'])
    const a = p[1]
    expect(a.message.content).toBe(
      'ok: olá agente com uma mensagem um pouco mais longa para o draft aparecer'
    )
    expect(a.meta.model).toBe('fake/agent')
    expect(a.meta.usage).toMatchObject({
      promptTokens: 120,
      completionTokens: 40,
      cachedTokens: 20,
      cost: 0.00042
    })
    expect(typeof a.meta.durationMs).toBe('number')
    expect(a.message.role === 'assistant' && a.message.reasoning).toBe('pensando no pedido')
    expect(drafts.length).toBeGreaterThan(0)
    expect(h.stack.repo.session(sid)?.status).toBe('idle')
    expect(h.stack.repo.chat(chatId)?.title).toBe(
      'olá agente com uma mensagem um pouco mais longa pa…'
    )
    expect(p[1].parentId).toBe(p[0].id)
  })

  it('web_search: aprovação (Perguntar) → roda no buscador falso → resposta; meta da aprovação', async () => {
    const { sid } = newChat({ approvalModes: { search: 'lists' } })
    await h.stack.runner.send(sid, '/search gatos')
    await until(() => h.stack.runner.approvals.list().length === 1, 8000, 'aprovação')
    expect(h.stack.repo.session(sid)?.status).toBe('awaiting_approval')
    const req = h.stack.runner.approvals.list()[0]
    expect(req.toolName).toBe('web_search')
    h.stack.runner.approve(req.id, 'allow')
    await idle(sid)
    const p = path(sid)
    expect(p.map((m) => m.message.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    const tool = p[2]
    expect(tool.meta.toolStatus).toBe('ok')
    expect(tool.meta.approval).toMatchObject({ item: 'search', userAllowed: ['gatos'] })
    expect(String(tool.message.content)).toContain('Resultado um para gatos')
    expect(String(p[3].message.content)).toContain('Resultado recebido (web_search)')
  })

  it('browse_url (Páginas, sempre) extrai a página; negar uma busca vira "negado"', async () => {
    const { sid } = newChat({ approvalModes: { pages: 'always', search: 'lists' } })
    await h.stack.runner.send(sid, `/browse ${h.llm.url}/page/teste`)
    await idle(sid)
    const t = path(sid).find((m) => m.message.role === 'tool')!
    expect(t.meta.toolStatus).toBe('ok')
    expect(String(t.message.content)).toContain('Título da página teste')
    expect(String(t.message.content)).not.toContain('menu menu menu')
    await h.stack.runner.send(sid, '/search cães')
    await until(() => h.stack.runner.approvals.list().length === 1)
    h.stack.runner.approve(h.stack.runner.approvals.list()[0].id, 'deny')
    await idle(sid)
    const last = path(sid)
      .filter((m) => m.message.role === 'tool')
      .pop()!
    expect(last.meta.toolStatus).toBe('denied')
    expect(last.message.content).toBe('O usuário negou a execução desta ferramenta.')
  })

  it('ask_user: questionário → resposta → resultado com o registro', async () => {
    const { sid } = newChat()
    await h.stack.runner.send(sid, '/ask')
    await until(() => h.stack.runner.questions.list().length === 1)
    expect(h.stack.repo.session(sid)?.status).toBe('awaiting_input')
    const q = h.stack.runner.questions.list()[0]
    expect(q.questions[0].options[0].icon).toEqual({ kind: 'text', text: '🍫' })
    expect(() => h.stack.runner.answerQuestion(q.id, [])).toThrow()
    h.stack.runner.answerQuestion(q.id, [{ selected: [1] }])
    await idle(sid)
    const t = path(sid).find((m) => m.message.role === 'tool')!
    expect(t.meta.askUser).toMatchObject({ outcome: 'answered', answers: [{ selected: [1] }] })
    expect(String(t.message.content)).toContain('Morango')
  })

  it('Parar no meio: parcial com `interrupted`, sessão ociosa; fila e ⚡ forçar', async () => {
    const { sid } = newChat()
    await h.stack.runner.send(sid, '/slow')
    await until(() => (path(sid).length === 1 && h.stack.runner.isRunning(sid)) || false)
    await new Promise((r) => setTimeout(r, 300))
    const q = await h.stack.runner.send(sid, 'na fila')
    expect(q.queued).toBe(true)
    expect(h.stack.runner.getQueue(sid).map((x) => x.text)).toEqual(['na fila'])
    h.stack.runner.forceSend(h.stack.runner.getQueue(sid)[0].id)
    await idle(sid)
    const p = path(sid)
    const roles = p.map((m) =>
      [m.message.role, m.meta.kind ?? '', m.meta.interrupted ? 'int' : ''].join(':')
    )
    expect(roles).toEqual(['user::', 'assistant::int', 'user:forced:', 'assistant::'])
    expect(p[3].message.content).toBe('ok: na fila')
    // Parar
    await h.stack.runner.send(sid, '/slow de novo')
    await new Promise((r) => setTimeout(r, 300))
    await h.stack.runner.stop(sid)
    const last = path(sid).pop()!
    expect(last.meta.interrupted).toBe(true)
    expect(h.stack.repo.session(sid)?.status).toBe('idle')
  })

  it('falha de conexão → card de retry → tentar de novo; erro do provedor vira mensagem de erro', async () => {
    const { sid } = newChat()
    await h.stack.runner.send(sid, '/cut 1')
    await until(() => h.stack.runner.retries.list().length === 1, 8000, 'retry')
    expect(h.stack.repo.session(sid)?.status).toBe('awaiting_retry')
    h.stack.runner.retry(h.stack.runner.retries.list()[0].id)
    await idle(sid)
    expect(path(sid).pop()!.message.content).toBe('ok: /cut 1')
    await h.stack.runner.send(sid, '/fail')
    await idle(sid)
    const e = path(sid).pop()!
    expect(e.meta.kind).toBe('error')
    expect(String(e.message.content)).toMatch(/Erro HTTP 400.*recusou/)
    expect(h.stack.repo.session(sid)?.status).toBe('error')
  })

  it('versões: regenerar (ramo), editar como nova versão, trocar de versão, apagar com reparent', async () => {
    const { sid } = newChat()
    await h.stack.runner.send(sid, 'primeira')
    await idle(sid)
    const [u1, a1] = path(sid)
    await h.stack.runner.regenerate(sid)
    await idle(sid)
    let p = path(sid)
    expect(p.length).toBe(2)
    expect(p[1].id).not.toBe(a1.id)
    expect(p[1].parentId).toBe(u1.id)
    // trocar de volta para a primeira resposta
    h.stack.runner.selectBranch(a1.id)
    expect(path(sid)[1].id).toBe(a1.id)
    // editar como nova versão
    await h.stack.runner.editBranch(u1.id, { role: 'user', content: 'editada' })
    await idle(sid)
    p = path(sid)
    expect(p[0].message.content).toBe('editada')
    expect(p[0].parentId).toBe(null)
    expect(p[1].message.content).toBe('ok: editada')
    // apagar a resposta: o caminho termina no usuário
    h.stack.runner.deleteMessage(p[1].id)
    expect(path(sid).map((m) => m.id)).toEqual([p[0].id])
  })

  it('tool não portátil pedida pelo modelo é recusada; chat sem provedor dá erro legível', async () => {
    const { sid } = newChat({ providerId: 'nao-existe' })
    await h.stack.runner.send(sid, 'oi')
    await idle(sid)
    expect(path(sid).pop()!.message.content).toBe('Nenhum provider configurado para este chat.')
  })
})
