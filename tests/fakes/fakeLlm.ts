// Provedor LLM FALSO (OpenAI-compatible SSE + Anthropic /messages) e páginas falsas para os testes
// do host no celular — nunca gasta cota de API paga. Também roda sozinho para o E2E no emulador:
//   node tests/fakes/fakeLlm.ts [porta]          (Node ≥ 23: tira os tipos sozinho)
// O comportamento segue o texto da última mensagem do usuário:
//   "/search <q>"  → web_search;  "/browse <url>" → browse_url;  "/ask" → ask_user;
//   "/models" → list_models;  "/slow" → resposta longa e lenta (para Parar/⚡/segundo plano);
//   "/fail" → HTTP 400 do provedor;  "/cut" → corta a conexão na 1ª tentativa (card de retry);
//   fase 4b: "/remember <título>: <fato>" → memory_write (perfil);  "/recall <q>" → memory_search;
//   "/whoami" → responde com os títulos do índice <memory> do system prompt;
//   "/delegate <tarefa>" → delegate_task;  "/delegate-bg <tarefa>" → em segundo plano;
//   "/wait" → wait_subagents;  "/subs" → check_subagents;  "/sleep <ms> <texto>" → espera e responde;
//   "/tell <chat_id> <msg>" → send_to_chat;  "/ask-chat <chat_id> <msg>" → com wait_for_reply;
//   "/chats" → list_chats;  "/info" → get_chat_info;  "/history <q>" → read_history (todos os chats);
//   "/big" → resposta longa (enche o contexto para a compactação automática);
//   requests laterais: compactação (prompt de resumo) → <conversation_summary>…; título (prompt do
//   título) → "Título: <palavras>"; extração de memórias → memory_write com "meu nome é X" (ou "meu nome e X", sem acento: o adb não digita "é");
//   resto → "ok: <texto>" (com raciocínio e usage com custo).
// Depois de um resultado de tool → "Resultado recebido (<tool>): <início do resultado>".
// Rotas extras: GET /models, GET /ddg (HTML no formato do DuckDuckGo), GET /page/<nome> (HTML).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

type Msg = { role: string; content?: unknown; tool_calls?: unknown[]; tool_call_id?: string }

export interface FakeLlm {
  url: string
  port: number
  requests: { path: string; body: Record<string, unknown> }[]
  close(): Promise<void>
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const textOf = (c: unknown): string =>
  typeof c === 'string'
    ? c
    : Array.isArray(c)
      ? c
          .map((p) =>
            p && typeof p === 'object' && 'text' in p
              ? String((p as { text: unknown }).text ?? '')
              : ''
          )
          .join('')
      : ''

export const DDG_HTML = (q: string): string => `<html><body>
<div class="result results_links web-result"><a class="result__a" href="https://exemplo.com/um">Resultado um para ${q}</a>
<a class="result__snippet">Primeiro trecho sobre ${q}.</a></div>
<div class="result results_links web-result"><a class="result__a" href="https://exemplo.com/dois">Resultado dois</a>
<a class="result__snippet">Segundo trecho.</a></div>
</body></html>`

export const PAGE_HTML = (
  name: string
): string => `<!doctype html><html><head><title>Página ${name}</title></head>
<body><nav>menu menu menu</nav><main><article><h1>Título da página ${name}</h1>
<p>Este é o conteúdo principal da página falsa <b>${name}</b>, com texto suficiente para a extração.</p>
<p>Segundo parágrafo com <a href="/outra">um link</a>.</p></article></main><footer>rodapé</footer></body></html>`

export function startFakeLlm(port = 0, opts: { delay?: number } = {}): Promise<FakeLlm> {
  const requests: FakeLlm['requests'] = []
  const cutOnce = new Set<string>()
  const delay = opts.delay ?? 25

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let raw = ''
    for await (const c of req) raw += c
    const url = new URL(req.url ?? '/', 'http://x')
    const path = url.pathname
    if (req.method === 'GET' && path.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          data: [
            {
              id: 'fake/agent',
              name: 'Agente falso',
              context_length: 64000,
              pricing: { prompt: '0.000001', completion: '0.000002' },
              supported_parameters: ['tools', 'temperature', 'max_tokens']
            },
            {
              id: 'fake/no-temp',
              name: 'Sem temperature',
              supported_parameters: ['tools', 'max_tokens']
            }
          ]
        })
      )
      return
    }
    if (req.method === 'GET' && path.startsWith('/ddg')) {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(DDG_HTML(url.searchParams.get('q') ?? 'busca'))
      return
    }
    if (req.method === 'POST' && path.startsWith('/ddg')) {
      const q = new URLSearchParams(raw).get('q') ?? 'busca'
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(DDG_HTML(q))
      return
    }
    if (path.startsWith('/page/')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(PAGE_HTML(path.slice(6)))
      return
    }
    let body: Record<string, unknown> = {}
    try {
      body = JSON.parse(raw || '{}')
    } catch {
      /* corpo inválido */
    }
    requests.push({ path, body })
    const anthropic = path.endsWith('/messages')
    const msgs = (body.messages ?? []) as Msg[]
    const last = msgs[msgs.length - 1]
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user')
    const text = textOf(lastUser?.content).trim()
    const model = String(body.model ?? 'fake/agent')
    const system =
      textOf(msgs.find((m) => m.role === 'system')?.content) +
      (typeof body.system === 'string'
        ? body.system
        : Array.isArray(body.system)
          ? textOf(body.system)
          : '')

    if (text.startsWith('/fail') && last?.role === 'user') {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'modelo falso recusou o pedido' } }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })

    // ---------------- OpenAI-compatible ----------------
    const chunk = (delta: Record<string, unknown>, finish?: string): string =>
      `data: ${JSON.stringify({
        id: 'x',
        model,
        choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }],
        ...(finish
          ? {
              usage: {
                prompt_tokens: 120,
                completion_tokens: 40,
                prompt_tokens_details: { cached_tokens: 20 },
                cost: 0.00042
              }
            }
          : {})
      })}\n\n`
    // ---------------- Anthropic ----------------
    const ev = (type: string, data: Record<string, unknown>): string =>
      `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`

    const write = (s: string): boolean => (res.destroyed ? false : res.write(s))

    const streamText = async (content: string, reasoning = '', words?: string[]): Promise<void> => {
      const parts = words ?? content.split(/(?<= )/)
      if (anthropic) {
        write(
          ev('message_start', {
            message: { id: 'm', model, usage: { input_tokens: 100, output_tokens: 1 } }
          })
        )
        let i = 0
        if (reasoning) {
          write(
            ev('content_block_start', {
              index: i,
              content_block: { type: 'thinking', thinking: '' }
            })
          )
          write(
            ev('content_block_delta', {
              index: i,
              delta: { type: 'thinking_delta', thinking: reasoning }
            })
          )
          write(ev('content_block_stop', { index: i }))
          i++
        }
        write(ev('content_block_start', { index: i, content_block: { type: 'text', text: '' } }))
        for (const w of parts) {
          if (
            !write(ev('content_block_delta', { index: i, delta: { type: 'text_delta', text: w } }))
          )
            return
          await sleep(delay)
        }
        write(ev('content_block_stop', { index: i }))
        write(
          ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 40 } })
        )
        write(ev('message_stop', {}))
        res.end()
        return
      }
      write(chunk({ role: 'assistant' }))
      for (const r of reasoning ? reasoning.split(/(?<= )/) : []) {
        write(chunk({ reasoning: r }))
        await sleep(delay)
      }
      for (const w of parts) {
        if (res.destroyed) return
        write(chunk({ content: w }))
        await sleep(delay)
      }
      write(chunk({}, 'stop'))
      res.end('data: [DONE]\n\n')
    }

    const toolCall = async (
      name: string,
      args: Record<string, unknown>,
      lead = ''
    ): Promise<void> => {
      const a = JSON.stringify(args)
      const id = `call_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
      if (anthropic) {
        write(
          ev('message_start', {
            message: { id: 'm', model, usage: { input_tokens: 100, output_tokens: 1 } }
          })
        )
        let i = 0
        if (lead) {
          write(ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }))
          write(ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: lead } }))
          write(ev('content_block_stop', { index: 0 }))
          i = 1
        }
        write(
          ev('content_block_start', {
            index: i,
            content_block: { type: 'tool_use', id, name, input: {} }
          })
        )
        write(
          ev('content_block_delta', {
            index: i,
            delta: { type: 'input_json_delta', partial_json: a.slice(0, 5) }
          })
        )
        await sleep(delay)
        write(
          ev('content_block_delta', {
            index: i,
            delta: { type: 'input_json_delta', partial_json: a.slice(5) }
          })
        )
        write(ev('content_block_stop', { index: i }))
        write(
          ev('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } })
        )
        write(ev('message_stop', {}))
        res.end()
        return
      }
      write(chunk({ role: 'assistant', ...(lead ? { content: lead } : {}) }))
      await sleep(delay)
      write(
        chunk({
          tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: '' } }]
        })
      )
      write(chunk({ tool_calls: [{ index: 0, function: { arguments: a.slice(0, 5) } }] }))
      await sleep(delay)
      write(chunk({ tool_calls: [{ index: 0, function: { arguments: a.slice(5) } }] }))
      write(chunk({}, 'tool_calls'))
      res.end('data: [DONE]\n\n')
    }

    // depois de um resultado de tool: responde citando o resultado
    const toolResult = anthropic
      ? (() => {
          const c = last?.content
          if (last?.role !== 'user' || !Array.isArray(c)) return null
          const r = c.find(
            (p) => p && typeof p === 'object' && (p as { type?: string }).type === 'tool_result'
          ) as { content?: unknown } | undefined
          return r ? textOf(r.content) || String(r.content ?? '') : null
        })()
      : last?.role === 'tool'
        ? textOf(last.content)
        : null
    // ---------------- requests laterais (compactação, título, extração) ----------------
    if (text.startsWith('A conversa acima está ficando longa demais')) {
      const users = msgs
        .filter((m) => m.role === 'user')
        .map((m) => textOf(m.content).replace(/\s+/g, ' ').slice(0, 60))
        .filter((t) => t && !t.startsWith('A conversa acima'))
      await streamText(
        `<conversation_summary>Resumo falso: ${users.length} mensagens do usuário (${users.slice(-3).join(' | ')}).</conversation_summary>`
      )
      return
    }
    if (system.startsWith('Você dá nome a conversas')) {
      const msg = /<message>\n([\s\S]*?)\n<\/message>/.exec(text)?.[1] ?? text
      const words = msg
        .replace(/[^\p{L}\p{N} ]+/gu, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 2 && !w.startsWith('/'))
        .slice(0, 3)
      await streamText(
        `Título: ${words.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ') || 'Conversa'} (auto)`
      )
      return
    }
    if (system.startsWith('Você mantém a memória de longo prazo')) {
      if (last?.role === 'tool' || (anthropic && Array.isArray(last?.content))) {
        await streamText('nada mais a registrar')
        return
      }
      const m = /meu nome\s+(?:[ée]\s+)?([\p{L}]+)/iu.exec(text)
      if (!m) {
        await streamText('nada a registrar')
        return
      }
      return toolCall('memory_write', {
        category: 'profile',
        title: 'Nome do usuário',
        summary: `Chama-se ${m[1]}`,
        ops: [{ op: 'add', fact: `O usuário se chama ${m[1]}` }]
      })
    }

    if (toolResult !== null) {
      const name = (() => {
        for (let i = msgs.length - 1; i >= 0; i--) {
          const tc = msgs[i].tool_calls as { function?: { name?: string } }[] | undefined
          if (tc?.length) return tc[0].function?.name ?? 'tool'
          const c = msgs[i].content
          if (Array.isArray(c)) {
            const tu = c.find((p) => (p as { type?: string }).type === 'tool_use') as
              { name?: string } | undefined
            if (tu) return tu.name ?? 'tool'
          }
        }
        return 'tool'
      })()
      await streamText(
        `Resultado recebido (${name}): ${toolResult.replace(/\s+/g, ' ').slice(0, 120)}`
      )
      return
    }
    if (text.startsWith('/remember')) {
      const [title, fact] = text
        .slice(9)
        .split(':')
        .map((x) => x.trim())
      return toolCall(
        'memory_write',
        {
          category: 'profile',
          title: title || 'Fato',
          summary: fact ?? '',
          ops: [{ op: 'add', fact: fact || title || 'fato' }]
        },
        'Vou guardar. '
      )
    }
    if (text.startsWith('/recall'))
      return toolCall('memory_search', { query: text.slice(7).trim() || 'usuário' })
    if (text.startsWith('/whoami')) {
      const titles = [...system.matchAll(/^- (m[0-9a-z]+) · ([^\n—]+)/gm)].map((x) => x[2].trim())
      await streamText(
        titles.length ? `Pelo índice da memória: ${titles.join('; ')}` : 'Não vejo nada na memória.'
      )
      return
    }
    if (text.startsWith('/delegate-bg'))
      return toolCall('delegate_task', {
        task: text.slice(12).trim() || 'tarefa',
        title: 'Ajudante em segundo plano',
        background: true
      })
    if (text.startsWith('/delegate'))
      return toolCall('delegate_task', {
        task: text.slice(9).trim() || 'tarefa',
        title: 'Ajudante'
      })
    if (text.startsWith('/wait')) return toolCall('wait_subagents', { timeout_s: 30 })
    if (text.startsWith('/subs')) return toolCall('check_subagents', {})
    if (text.startsWith('/sleep')) {
      const [, ms, ...rest] = text.split(/\s+/)
      await sleep(Number(ms) || 500)
      await streamText(`ok: ${rest.join(' ') || 'acordei'}`)
      return
    }
    if (text.startsWith('/tell') || text.startsWith('/ask-chat')) {
      const wait = text.startsWith('/ask-chat')
      const [, id, ...rest] = text.split(/\s+/)
      return toolCall('send_to_chat', {
        chat_id: id,
        message: rest.join(' ') || 'olá',
        ...(wait ? { wait_for_reply: true, timeout_s: 60 } : {})
      })
    }
    if (text.startsWith('/chats')) return toolCall('list_chats', {})
    if (text.startsWith('/info')) return toolCall('get_chat_info', {})
    if (text.startsWith('/history'))
      return toolCall('read_history', { query: text.slice(8).trim() || 'ok', scope: 'all' })
    if (text.startsWith('/big'))
      return streamText(`ok: ${'texto longo para encher o contexto '.repeat(400)}`)
    if (text.startsWith('/search'))
      return toolCall('web_search', { query: text.slice(7).trim() || 'clima' }, 'Vou pesquisar. ')
    if (text.startsWith('/browse')) return toolCall('browse_url', { url: text.slice(7).trim() })
    if (text.startsWith('/models')) return toolCall('list_models', {})
    if (text.startsWith('/ask'))
      return toolCall('ask_user', {
        questions: [
          {
            title: 'Qual sabor?',
            options: [
              { title: 'Chocolate', icon: '🍫', description: 'clássico' },
              { title: 'Morango', icon: 'heart' }
            ]
          }
        ]
      })
    if (text.startsWith('/cut') && !cutOnce.has(text)) {
      cutOnce.add(text)
      write(chunk({ role: 'assistant' }))
      write(chunk({ content: 'parcial que vai ' }))
      await sleep(80)
      res.destroy()
      return
    }
    if (text.startsWith('/slow'))
      return streamText(
        '',
        'pensando devagar',
        Array.from({ length: 400 }, (_, i) => `palavra${i} `)
      )
    await streamText(`ok: ${text || 'de novo'}`, 'pensando no pedido')
  }

  const server: Server = createServer((req, res) => {
    handler(req, res).catch(() => res.destroy())
  })
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const p = (server.address() as { port: number }).port
      resolve({
        url: `http://127.0.0.1:${p}`,
        port: p,
        requests,
        close: () =>
          new Promise((r) => {
            server.closeAllConnections?.()
            server.close(() => r())
          })
      })
    })
  })
}

// execução direta (E2E): node tests/fakes/fakeLlm.ts 8790
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] ?? 8790)
  void startFakeLlm(port, { delay: Number(process.env.FAKE_LLM_DELAY ?? 60) }).then((s) =>
    console.log(`LLM falso em ${s.url}`)
  )
}
