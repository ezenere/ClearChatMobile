// Fase 4b no celular (Node, servidor falso + provedor LLM falso): memória (tools com a semântica do
// desktop, índice local, outbox LWW, índice congelado por sessão, extração), subagentes (bloqueante,
// segundo plano com callback que acorda o pai, parar), entre chats (local e roteado ao host remoto),
// read_history, compactação (pedida e automática), título automático, divergência com versão local
// (§9: manter a local / manter a online), fila guardada no segundo plano e turno terminado sem
// servidor com replay da outbox.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_CHAT_CONFIG } from '../src/vendor/shared/defaults'
import { MEMORY_CATEGORIES } from '../src/vendor/shared/memory'
import type { ChatConfig } from '../src/vendor/shared/types'
import type { ChatState } from '../src/data/types'
import { applyOps, parseOps } from '../src/vendor/desktop/tools/memory'
import { mergeLww } from '../src/data/lww'
import { slugSuffix } from '../src/memory/memoryIndex'
import { changedFields } from '../src/memory/system'
import { canonical } from '../src/host/divergence'
import { availableTools, buildRequest } from '../src/agent/request'
import { makeHarness, until, type Harness } from './hostHarness'
import type { InterChatSendMeta } from '@shared/interChat'

let h: Harness
beforeEach(async () => {
  h = await makeHarness()
})
afterEach(async () => {
  await h.close()
})

const COL = 'col-perfil'
const memoryOn = (extra: Record<string, unknown> = {}) => ({
  enabled: true,
  collections: [COL],
  writeTo: { profile: COL },
  categories: [...MEMORY_CATEGORIES],
  helpPrompt: { enabled: false, text: null },
  extraction: { auto: false, prompt: null, providerId: null, model: null },
  subagents: false,
  ...extra
})

const newChat = (cfg: Partial<ChatConfig> = {}) => {
  const { chat, session } = h.stack.repo.createChat({
    config: {
      ...DEFAULT_CHAT_CONFIG(''),
      providerId: h.providerId,
      model: 'fake/agent',
      enabledTools: ['web_search', 'ask_user'],
      ...cfg
    }
  })
  return { chatId: chat.id, sid: session.id }
}
const idle = (sid: string, ms = 10_000) =>
  until(() => !h.stack.runner.isRunning(sid), ms, 'turno terminar')
const send = (chatId: string, sid: string, text: string) =>
  h.stack.host.local(chatId, 'send', { sessionId: sid, text })
const path = (sid: string) => h.stack.repo.path(sid)
const texts = (sid: string) =>
  path(sid).map((m) =>
    typeof m.message.content === 'string' ? m.message.content : JSON.stringify(m.message.content)
  )
const lastAssistant = (sid: string) =>
  [...path(sid)].reverse().find((m) => m.message.role === 'assistant')?.message.content ?? ''

async function seedCollection(): Promise<void> {
  await h.desk.put('memory_collection', COL, null, {
    sv: 1,
    category: 'profile',
    name: 'Padrão',
    description: 'quem é o usuário',
    icon: null,
    createdAt: 1,
    updatedAt: 1
  })
  await h.engine.sync()
}

const systemOf = (i: number): string => {
  const body = h.llm.requests[i].body
  const msgs = body.messages as { role: string; content: unknown }[]
  const c = msgs.find((m) => m.role === 'system')?.content
  return typeof c === 'string' ? c : JSON.stringify(c ?? '')
}
const chatRequests = () =>
  h.llm.requests
    .map((r, i) => ({ ...r, i }))
    .filter((r) => {
      const msgs = (r.body.messages ?? []) as { role: string; content: unknown }[]
      const sys = msgs.find((m) => m.role === 'system')
      return !(
        typeof sys?.content === 'string' && /^Você (dá nome|mantém a memória)/.test(sys.content)
      )
    })

describe('memória', () => {
  it('partes puras do desktop: ops, merge LWW, campos sujos, sufixo de slug, JSON canônico', () => {
    expect(applyOps(['a', 'b'], parseOps([{ op: 'replace', fact: '#2', with: 'c' }]))).toEqual([
      'a',
      'c'
    ])
    expect(() => parseOps([{ op: 'replace', fact: 'x' }])).toThrow(/with/)
    expect(
      mergeLww({ title: 'S', facts: ['x'], updatedAt: 5 }, { title: 'L', updatedAt: 3 })
    ).toEqual({ title: 'L', facts: ['x'], updatedAt: 5 })
    expect(changedFields({ a: 1, b: [1] }, { a: 1, b: [1, 2], c: 3 })).toEqual({ b: [1, 2], c: 3 })
    expect(slugSuffix('nome', 'mAb-c12_3x')).toBe('nome-123x')
    expect(canonical({ b: 1, a: [{ d: 2, c: 1 }] })).toBe('{"a":[{"c":1,"d":2}],"b":1}')
  })

  it('memory_write grava no índice e sobe memória + coleção (LWW); o PC vê; o índice segue o PC', async () => {
    await seedCollection()
    const { chatId, sid } = newChat({ memory: memoryOn() })
    await send(chatId, sid, '/remember Cidade: O usuário mora em Curitiba')
    await idle(sid)
    const tool = path(sid).find((m) => m.message.role === 'tool')!
    expect(tool.meta.memoryChanges?.[0]).toMatchObject({
      op: 'create',
      title: 'Cidade',
      collectionId: COL
    })
    await until(() => !h.stack.memory.writer.pending(), 5000, 'outbox LWW')
    const rec = [...h.server.records.values()].find((r) => r.type === 'memory')!
    expect(rec.scope).toBe(COL)
    expect(rec.device_id).toBe('dev-mobile')
    const plain = h.store.getPlain('memory', rec.id)!
    expect(plain).toMatchObject({
      sv: 1,
      collectionId: COL,
      category: 'profile',
      title: 'Cidade',
      facts: ['O usuário mora em Curitiba'],
      updatedBy: 'model',
      updatedByChatId: chatId,
      supersedesId: null
    })
    // a coleção (updatedAt mudou, como no desktop) também subiu
    expect(h.server.records.get(`memory_collection|${COL}`)!.rev).toBe(2)
    // o PC edita a memória → o índice local acompanha (busca FTS acha o tópico novo)
    await h.desk.put('memory', rec.id, COL, {
      ...plain,
      facts: ['O usuário mora em Curitiba', 'Gosta de pinhão'],
      updatedBy: 'user',
      updatedAt: Date.now()
    })
    await h.engine.sync()
    const hits = h.stack.memory.service.store.search('pinhao', { collectionIds: [COL] })
    expect(hits.map((x) => x.memory.id)).toEqual([rec.id])
  })

  it('índice congelado por sessão: snapshot no 1º request (registro session), estável no meio; memória desligada → nada vai', async () => {
    await seedCollection()
    await h.desk.put('memory', 'mprimeira0', COL, {
      sv: 1,
      collectionId: COL,
      category: 'profile',
      title: 'Profissão',
      slug: 'profissao',
      summary: 'engenheira',
      facts: [],
      pinned: false,
      createdAt: 1,
      updatedAt: 1,
      updatedByChatId: null,
      updatedBy: 'user',
      supersedesId: null
    })
    await h.engine.sync()
    const { chatId, sid } = newChat({ memory: memoryOn() })
    await send(chatId, sid, '/remember Time: torce para o Coritiba')
    await idle(sid)
    const reqs = chatRequests()
    expect(reqs.length).toBeGreaterThanOrEqual(2)
    const first = systemOf(reqs[0].i)
    expect(first).toContain('<memory>')
    expect(first).toContain('Profissão')
    expect(first).not.toContain('Time')
    // a memória nova (gravada no meio da sessão) não muda o prefixo: o índice está congelado
    expect(systemOf(reqs[reqs.length - 1].i)).toBe(first)
    const snap = (h.store.getPlain('session', sid)!.memory as { snapshot: { index: string } })
      .snapshot
    expect(snap.index).toContain('Profissão')
    const tools = (h.llm.requests[reqs[0].i].body.tools as { function: { name: string } }[]).map(
      (t) => t.function.name
    )
    expect(tools).toEqual(expect.arrayContaining(['memory_search', 'memory_write']))
    // memória desligada: nada de memória na request
    const off = h.stack.repo.chat(newChat({ memory: { ...memoryOn(), enabled: false } }).chatId)!
    const req = buildRequest(off, { depth: 0, model: 'fake/agent' }, [], {
      id: h.providerId,
      name: 'x',
      baseUrl: h.llm.url + '/v1',
      apiKey: 'k',
      headers: {},
      createdAt: 0
    })
    expect(JSON.stringify(req.body)).not.toMatch(/<memory>|memory_/)
    expect(availableTools(off, { depth: 0 })).toEqual(['web_search', 'ask_user'])
  })

  it('extração ("Extrair memórias"): memory_write com updatedBy extraction e o card no chat', async () => {
    await seedCollection()
    const { chatId, sid } = newChat({ memory: memoryOn() })
    await send(chatId, sid, 'oi, meu nome é Ana')
    await idle(sid)
    await h.stack.host.local(chatId, 'memory.extract', { sessionId: sid })
    const card = path(sid).find((m) => m.meta.kind === 'memory-extraction')!
    expect(card.meta.memoryExtraction).toMatchObject({ created: 1, trigger: 'manual' })
    const mem = h.store.plainsOf('memory').find((m) => m.plain.title === 'Nome do usuário')!
    expect(mem.plain.updatedBy).toBe('extraction')
    expect(
      (h.store.getPlain('session', sid)!.memory as { lastExtractedSeq: number }).lastExtractedSeq
    ).toBeGreaterThan(0)
    // de novo sem nada novo → erro legível, sem request
    await expect(h.stack.host.local(chatId, 'memory.extract', { sessionId: sid })).rejects.toThrow(
      /Nada novo/
    )
  })

  it('colisão de slug (§4.3.5): a mais nova ganha o sufixo e este aparelho envia a revisão', async () => {
    await seedCollection()
    const base = {
      sv: 1,
      collectionId: COL,
      category: 'profile',
      summary: '',
      facts: [],
      pinned: false,
      updatedAt: 1,
      updatedByChatId: null,
      updatedBy: 'user',
      supersedesId: null
    }
    h.stack.memory.index.ensure()
    await h.desk.put('memory', 'mvelha0001', COL, {
      ...base,
      title: 'Pet',
      slug: 'pet',
      createdAt: 1
    })
    await h.desk.put('memory', 'mnova00002', COL, {
      ...base,
      title: 'Pet',
      slug: 'pet',
      createdAt: 2
    })
    await h.engine.sync()
    await until(
      () => h.server.records.get('memory|mnova00002')?.device_id === 'dev-mobile',
      5000,
      'revisão com o slug novo'
    )
    expect(h.store.getPlain('memory', 'mnova00002')!.slug).toBe('pet-0002')
    expect(h.store.getPlain('memory', 'mvelha0001')!.slug).toBe('pet')
  })
})

describe('subagentes', () => {
  it('bloqueante: subsessão como registro (depth 1, modelo/provedor), resultado no tool; o PC vê a sessão', async () => {
    const { chatId, sid } = newChat({ enabledTools: ['delegate_task'] })
    await send(chatId, sid, '/delegate resuma o dia')
    await idle(sid)
    const subs = h.stack.repo.sessions(chatId).filter((s) => s.depth === 1)
    expect(subs).toHaveLength(1)
    expect(subs[0]).toMatchObject({ parentSessionId: sid, task: 'resuma o dia', status: 'done' })
    const tool = path(sid).find((m) => m.message.role === 'tool')!
    expect(tool.meta.subSessionId).toBe(subs[0].id)
    expect(tool.message.content).toContain('ok: resuma o dia')
    await until(() => !h.stack.writer.pending(chatId), 5000, 'outbox')
    expect(h.server.records.get(`session|${subs[0].id}`)?.scope).toBe(chatId)
  })

  it('segundo plano: o pai termina, o subagente roda em paralelo e o callback acorda o pai', async () => {
    const { chatId, sid } = newChat({ enabledTools: ['delegate_task'] })
    await send(chatId, sid, '/delegate-bg /sleep 400 pronto')
    await until(
      () => path(sid).some((m) => m.message.role === 'tool' && m.meta.background),
      8000,
      'delegate em segundo plano'
    )
    const sub = h.stack.repo.sessions(chatId).find((s) => s.depth === 1)!
    expect(h.stack.runner.isRunning(sub.id)).toBe(true)
    await until(
      () => path(sid).some((m) => m.meta.kind === 'subagent-callback'),
      10_000,
      'callback no pai'
    )
    await idle(sid)
    await idle(sub.id)
    const cb = path(sid).find((m) => m.meta.kind === 'subagent-callback')!
    expect(cb.message.content).toMatch(/concluiu\]\nok: pronto/)
    // o pai acordou: respondeu depois do callback
    const after = path(sid).slice(path(sid).indexOf(cb) + 1)
    expect(after.some((m) => m.message.role === 'assistant')).toBe(true)
  })

  it('"Parar subagentes" para os de segundo plano; a principal continua', async () => {
    const { chatId, sid } = newChat({ enabledTools: ['delegate_task'] })
    await send(chatId, sid, '/delegate-bg /slow')
    await until(() => h.stack.repo.sessions(chatId).some((s) => s.depth === 1), 8000, 'sub')
    const sub = h.stack.repo.sessions(chatId).find((s) => s.depth === 1)!
    await until(() => h.stack.runner.isRunning(sub.id), 5000, 'sub rodando')
    await h.stack.host.local(chatId, 'stop_subagents', {})
    expect(h.stack.runner.isRunning(sub.id)).toBe(false)
    expect(h.stack.repo.session(sub.id)!.status).toBe('interrupted')
    await until(
      () => path(sid).some((m) => m.meta.kind === 'subagent-callback'),
      8000,
      'callback de cancelado'
    )
    expect(path(sid).find((m) => m.meta.kind === 'subagent-callback')!.message.content).toMatch(
      /foi cancelado/
    )
    await idle(sid)
  })
})

describe('entre chats e read_history', () => {
  it('send_to_chat local: entrega com cabeçalho/meta inter-chat e o destino roda; list_chats e read_history acham o outro chat', async () => {
    const b = newChat({ enabledTools: ['send_to_chat'] })
    await send(b.chatId, b.sid, 'girafa azul no telhado')
    await idle(b.sid)
    const a = newChat({ enabledTools: ['send_to_chat', 'list_chats', 'read_history'] })
    await send(a.chatId, a.sid, `/ask-chat ${b.chatId} qual a cor?`)
    await idle(a.sid)
    await idle(b.sid)
    const got = path(b.sid).find((m) => m.meta.kind === 'inter-chat')!
    expect(got.meta).toMatchObject({ fromChatId: a.chatId, interChatHops: 1 })
    expect(String(got.message.content)).toMatch(/^\[Mensagem do chat .* — o remetente aguarda/)
    const tool = path(a.sid).find((m) => m.message.role === 'tool')!
    expect(tool.meta.targetChatId).toBe(b.chatId)
    expect(tool.message.content).toMatch(/^Resposta do chat/)
    await send(a.chatId, a.sid, '/chats')
    await idle(a.sid)
    expect(texts(a.sid).join('\n')).toContain(b.chatId)
    await send(a.chatId, a.sid, '/history girafa')
    await idle(a.sid)
    const hist = path(a.sid)
      .filter((m) => m.message.role === 'tool')
      .at(-1)!
    expect(hist.message.content).toMatch(/busca em .*girafa/)
    expect(hist.message.content).toContain(b.chatId)
  })

  it('destino executado no PC online → comando `send` ao host; PC offline → recusa clara', async () => {
    const pcChat = 'chat-do-pc'
    await h.desk.put('chat', pcChat, pcChat, {
      sv: 1,
      title: 'Chat do PC',
      config: { model: 'm', enabledTools: ['shell'] },
      mainSessionId: 'sess-pc',
      createdAt: 1,
      updatedAt: 2
    })
    await h.desk.put('session', 'sess-pc', pcChat, {
      sv: 1,
      chatId: pcChat,
      parentSessionId: null,
      parentToolCallId: null,
      depth: 0,
      model: 'm',
      providerId: null,
      title: 'Principal',
      task: null,
      status: 'idle',
      createdAt: 1,
      memory: null,
      branchSel: {}
    })
    await h.engine.sync()
    const state = (status: 'online' | 'offline'): ChatState => ({
      chat_id: pcChat,
      ssq: 9,
      epoch: 2,
      head: 0,
      pinned: false,
      host: { device_id: 'dev-pc', name: 'PC', platform: 'linux', status },
      window: null,
      handover: null,
      diverged: null
    })
    h.store.upsertChatState(state('online'))
    const sent: { chatId: string; text: string; meta: InterChatSendMeta }[] = []
    h.remoteSend = async (chatId, _sid, text, meta) => {
      sent.push({ chatId, text, meta })
      return { queued: false }
    }
    const a = newChat({ enabledTools: ['send_to_chat'] })
    await send(a.chatId, a.sid, `/tell ${pcChat} rode os testes`)
    await idle(a.sid)
    expect(sent).toHaveLength(1)
    expect(sent[0].text).toMatch(/^\[Mensagem do chat .*\]\nrode os testes$/)
    // sem a dica de responder por send_to_chat: o PC não alcança chats do celular
    expect(sent[0].text).not.toMatch(/use send_to_chat/)
    // protocolo 1.6.0: a origem vai no `meta` do comando `send`
    expect(sent[0].meta).toEqual({
      kind: 'inter-chat',
      fromChatId: a.chatId,
      fromSessionId: a.sid,
      fromChatTitle: expect.any(String),
      interChatHops: 1
    })
    expect(path(a.sid).find((m) => m.message.role === 'tool')!.message.content).toMatch(
      /executado no PC/
    )
    h.store.upsertChatState(state('offline'))
    await send(a.chatId, a.sid, `/tell ${pcChat} de novo`)
    await idle(a.sid)
    const t2 = path(a.sid)
      .filter((m) => m.message.role === 'tool')
      .at(-1)!
    expect(t2.meta.toolStatus).toBe('error')
    expect(t2.message.content).toMatch(/offline.*NÃO foi enviada/)
    expect(sent).toHaveLength(1)
  })
})

describe('compactação e título', () => {
  it('manual: fronteira kind compaction com o resumo; snapshot de memória renovado', async () => {
    const { chatId, sid } = newChat()
    await send(chatId, sid, 'primeira')
    await idle(sid)
    await send(chatId, sid, 'segunda')
    await idle(sid)
    await h.stack.host.local(chatId, 'compact', { sessionId: sid })
    await idle(sid)
    const b = path(sid).find((m) => m.meta.kind === 'compaction')!
    expect(String(b.message.content)).toContain('Resumo falso: 2 mensagens do usuário')
    expect(b.meta.summaryOf).toEqual({ fromSeq: 1, toSeq: 4 })
    await send(chatId, sid, 'depois')
    await idle(sid)
    const last = h.llm.requests.at(-1)!.body.messages as { role: string; content: unknown }[]
    // depois da fronteira: só o resumo + a mensagem nova vão ao modelo
    expect(last.filter((m) => m.role === 'user')).toHaveLength(2)
  })

  it('automática pelo limite de contexto (janela pequena + autoCompact)', async () => {
    const { chatId, sid } = newChat({
      autoCompact: true,
      contextWindow: 150,
      compactThreshold: 0.5
    })
    await send(chatId, sid, 'um')
    await idle(sid)
    await send(chatId, sid, 'dois')
    await idle(sid)
    expect(path(sid).some((m) => m.meta.kind === 'compaction')).toBe(true)
  })

  it('título automático pelo modelo do título (setting autoTitle) e "Gerar título"', async () => {
    await h.desk.put('setting', 'autoTitle', null, {
      sv: 1,
      value: {
        providerId: h.providerId,
        model: 'fake/agent',
        useMemory: false,
        maxTokens: 50,
        prompt: null
      }
    })
    await h.engine.sync()
    const { chatId, sid } = newChat()
    await send(chatId, sid, 'receita de bolo de cenoura')
    await idle(sid)
    await until(
      () => h.stack.repo.chat(chatId)!.title === 'Receita Bolo Cenoura (auto)',
      5000,
      'título automático'
    )
    const first = path(sid).find((m) => m.message.role === 'user')!
    expect(h.stack.repo.get(first.id)!.meta.autoTitle).toMatchObject({
      applied: true,
      trigger: 'auto'
    })
    h.stack.repo.updateChat(chatId, { title: 'Meu nome' })
    expect(await h.stack.runner.generateTitle(chatId)).toBe('Receita Bolo Cenoura (auto)')
  })
})

describe('conectividade, fila e divergência', () => {
  it('servidor cai no meio do turno: termina aqui e a outbox sobe depois (replay na janela)', async () => {
    const { chatId, sid } = newChat()
    await send(chatId, sid, 'antes')
    await idle(sid)
    await until(() => !h.stack.writer.pending(chatId), 5000, 'outbox')
    await send(chatId, sid, '/sleep 300 terminou sem servidor')
    h.server.offline = true
    h.stack.host.onConnection(false)
    await idle(sid)
    expect(lastAssistant(sid)).toBe('ok: terminou sem servidor')
    expect(h.stack.writer.pending(chatId)).toBe(true)
    h.server.offline = false
    h.stack.host.onConnection(true)
    h.stack.writer.resume()
    await until(() => !h.stack.writer.pending(chatId), 8000, 'replay da outbox')
    const ids = path(sid).map((m) => m.id)
    for (const id of ids) expect(h.server.records.get(`message|${id}`)).toBeTruthy()
  })

  it('segundo plano: a fila não injetada fica guardada e volta no primeiro plano (sem rodar sozinha)', async () => {
    const { chatId, sid } = newChat()
    await send(chatId, sid, '/slow')
    await until(() => h.stack.runner.isRunning(sid), 5000, 'rodando')
    await send(chatId, sid, 'na fila 1')
    await send(chatId, sid, 'na fila 2')
    expect(h.stack.runner.getQueue(sid)).toHaveLength(2)
    await h.stack.host.onBackground()
    expect(h.stack.runner.isRunning(sid)).toBe(false)
    expect(h.stack.runner.getQueue(sid)).toHaveLength(0)
    const n0 = h.notices.length
    h.stack.host.onForeground()
    expect(h.stack.runner.getQueue(sid).map((q) => q.text)).toEqual(['na fila 1', 'na fila 2'])
    expect(h.notices.slice(n0).join(' ')).toMatch(/2 mensagens da fila ficaram guardadas/)
    expect(h.stack.runner.isRunning(sid)).toBe(false)
  })

  async function divergedChat(): Promise<{ chatId: string; sid: string; pcMsg: string }> {
    const { chatId, sid } = newChat()
    await send(chatId, sid, 'comum')
    await idle(sid)
    await until(() => !h.stack.writer.pending(chatId), 5000, 'outbox')
    // o celular roda sem servidor…
    h.server.offline = true
    h.stack.host.onConnection(false)
    h.stack.host.onConnection(true) // o WebSocket falso volta logo; o REST continua fora
    await send(chatId, sid, 'só no celular')
    await idle(sid)
    // …enquanto o PC assume e grava a versão dele
    const parent = path(sid).at(-3)!.id
    const pcMsg = 'msg-do-pc'
    h.server.offline = false
    await h.desk.put('message', pcMsg, chatId, {
      sv: 1,
      sessionId: sid,
      seq: 50,
      message: { role: 'user', content: 'só no PC' },
      meta: {},
      createdAt: Date.now(),
      parentId: parent
    })
    h.store.upsertChatState({
      chat_id: chatId,
      ssq: 50,
      epoch: 7,
      head: h.server.seq,
      pinned: false,
      host: { device_id: 'dev-desktop', name: 'PC', platform: 'linux', status: 'online' },
      window: null,
      handover: null,
      diverged: null
    })
    await h.engine.sync()
    // §9.2: o conteúdo do PC não entrou na versão local (só marcou "precisa rebaixar")
    expect(h.store.message(pcMsg)).toBeNull()
    expect(h.store.refetchChats()).toContain(chatId)
    h.stack.writer.resume()
    await until(() => h.server.diverged.has(chatId), 8000, 'divergência no servidor')
    const d = h.server.diverged.get(chatId)!
    h.store.upsertChatState({
      ...h.store.chatState(chatId)!,
      ssq: 51,
      diverged: {
        divergence_id: d.divergence_id,
        device_id: d.device_id,
        device_name: 'Pixel de teste',
        base: d.base,
        head: d.head,
        since: ''
      }
    })
    return { chatId, sid, pcMsg }
  }

  it('divergência: as duas versões; "manter a deste celular" grava a local e descarta a do PC', async () => {
    const { chatId, sid, pcMsg } = await divergedChat()
    const det = await h.stack.divergence.details(chatId)
    expect(det.local).not.toBeNull()
    const onl = Object.values(det.online.messages)
      .flat()
      .map((m) => m.message.content)
    const loc = Object.values(det.local!.messages)
      .flat()
      .map((m) => m.message.content)
    expect(onl).toContain('só no PC')
    expect(loc).toContain('só no celular')
    expect(loc).not.toContain('só no PC')
    expect(det.onlyOnline.count).toBe(1)
    expect(det.onlyLocal.count).toBeGreaterThanOrEqual(2)
    await h.stack.divergence.resolve(chatId, 'local')
    expect(h.server.diverged.has(chatId)).toBe(false)
    expect(h.server.records.get(`message|${pcMsg}`)?.deleted).toBe(true)
    const localOnly = path(sid).find((m) => m.message.content === 'só no celular')!
    expect(h.server.records.get(`message|${localOnly.id}`)?.deleted).toBe(false)
    expect(h.store.outbox(chatId).filter((r) => r.type !== 'chat')).toEqual([])
  })

  it('divergência: "manter a online" apaga de verdade a versão local e baixa a do PC', async () => {
    const { chatId, sid, pcMsg } = await divergedChat()
    const localOnly = path(sid).find((m) => m.message.content === 'só no celular')!
    await h.stack.divergence.resolve(chatId, 'online')
    expect(h.server.discards.size).toBe(1)
    expect(h.store.message(localOnly.id)).toBeNull()
    expect(h.store.getPlain('message', localOnly.id)).toBeNull()
    expect(h.store.message(pcMsg)).toBeTruthy()
    expect(h.store.outbox(chatId).filter((r) => r.type !== 'chat')).toEqual([])
    expect(h.store.refetchChats()).not.toContain(chatId)
  })
})
