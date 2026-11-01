// Controle remoto (fase 3): envelopes do stream/comandos nos vetores do protocolo, espelho ao vivo
// (snapshot, deltas, buracos, drafts encerrados), cliente de comandos (resultado, recusa, timeout,
// queda do host, desconexão), fs.list/fs.read, leitura em pedaços e anexos (CCB1 + upload).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WsRequestError } from '../src/vendor/desktop/sync/ws'
import realtime from '../src/vendor/protocol/test-vectors/realtime.json'
import {
  decryptBlob,
  deriveSubkeys,
  fromHex,
  fromUtf8,
  hex,
  randomBytes,
  sha256,
  utf8,
  type Subkeys
} from '../src/crypto'
import type { StoredMessage } from '../src/vendor/shared/types'
import { openCommand, openJson, sealJson, sealResult, sealStream } from '../src/remote/crypto'
import { LiveMirror, ENDED_DRAFT_HOLD_MS, liveStatus } from '../src/remote/mirror'
import { RemoteController, RemoteError, rejectText, wireKind } from '../src/remote/controller'
import { fetchRange, FILE_CHANGED, splitUtf8 } from '../src/remote/files'
import { prepareAttachment, storeExt, uploadAttachments } from '../src/remote/upload'
import type { ChatState } from '../src/data/types'

// ---------------- vetores (realtime.json) ----------------

describe('envelopes do stream e dos comandos (vetores)', () => {
  const key = fromHex(realtime.stream_key_hex)
  for (const c of realtime.cases)
    it(`${c.name}: cifra byte a byte e decifra`, async () => {
      const aad = utf8(c.aad_utf8)
      const env = await sealJson(key, aad, JSON.parse(c.json), fromHex(c.nonce_hex))
      expect(env).toEqual(c.envelope)
      expect(await openJson(key, aad, c.envelope)).toEqual(JSON.parse(c.json))
    })
  it('AAD errada não abre', async () => {
    const c = realtime.cases[1]
    await expect(openJson(key, utf8(c.aad_utf8 + 'x'), c.envelope)).rejects.toThrow()
  })
  it('JSON grande vai comprimido e volta igual', async () => {
    const big = { sv: 1, kind: 'snapshot', text: 'abc '.repeat(5000) }
    const env = await sealJson(key, utf8('a'), big)
    expect(env.c.length).toBeLessThan(2000)
    expect(await openJson(key, utf8('a'), env)).toEqual(big)
  })
})

// ---------------- espelho ----------------

const draftDelta = (
  n: number,
  sid: string,
  streamId: string,
  off: [number, number],
  content = '',
  reasoning = '',
  toolCalls?: unknown[]
) => ({
  n,
  p: {
    kind: 'draft.delta',
    sessionId: sid,
    streamId,
    off: { content: off[0], reasoning: off[1] },
    append: { ...(content ? { content } : {}), ...(reasoning ? { reasoning } : {}) },
    ...(toolCalls ? { toolCalls } : {})
  }
})

function msg(
  id: string,
  sid: string,
  content: string,
  extra: Partial<StoredMessage['meta']> = {}
): StoredMessage {
  return {
    id,
    sessionId: sid,
    seq: 1,
    parentId: null,
    message: { role: 'assistant', content },
    meta: { ...extra },
    createdAt: 0
  } as StoredMessage
}

describe('LiveMirror', () => {
  let resyncs = 0
  let changes = 0
  let m: LiveMirror
  beforeEach(() => {
    vi.useFakeTimers()
    resyncs = 0
    changes = 0
    m = new LiveMirror(7, { resync: () => resyncs++, changed: () => changes++ })
  })
  afterEach(() => vi.useRealTimers())

  const snapshot = (n: number, extra: Record<string, unknown> = {}) =>
    m.onEvent(n, {
      kind: 'snapshot',
      sessions: {
        s1: { status: 'running', draft: null, tools: {}, compaction: null }
      },
      queues: {},
      approvals: [],
      questions: [],
      retries: [],
      processes: [],
      skills: [{ name: 'deploy', description: 'Publica' }],
      ...extra
    })

  it('snapshot completo + deltas na ordem montam o draft', () => {
    snapshot(1)
    expect(m.view.complete).toBe(true)
    expect(m.view.status.s1).toBe('running')
    expect(m.view.skills.map((s) => s.name)).toEqual(['deploy'])
    for (const d of [
      draftDelta(2, 's1', 'A', [0, 0], '', 'pensando'),
      draftDelta(3, 's1', 'A', [0, 8], 'Olá', ''),
      draftDelta(4, 's1', 'A', [3, 8], ' mundo', '', [
        { index: 0, id: 't1', name: 'shell', argsAppend: '{"command":' }
      ]),
      draftDelta(5, 's1', 'A', [9, 8], '', '', [{ index: 0, argsAppend: '"ls"}' }])
    ])
      m.onEvent(d.n, d.p)
    expect(m.view.drafts.s1).toEqual({
      content: 'Olá mundo',
      reasoning: 'pensando',
      toolCalls: [{ id: 't1', name: 'shell', arguments: '{"command":"ls"}' }]
    })
    expect(resyncs).toBe(0)
    expect(changes).toBe(5)
  })

  it('buraco em n pede resync; repetido é ignorado; delta com off errado pede resync', () => {
    snapshot(1)
    m.onEvent(2, draftDelta(2, 's1', 'A', [0, 0], 'a').p)
    m.onEvent(2, draftDelta(2, 's1', 'A', [0, 0], 'a').p)
    expect(m.view.drafts.s1.content).toBe('a')
    m.onEvent(4, {
      kind: 'queue',
      sessionId: 's1',
      queue: [{ id: 'q1', sessionId: 's1', text: 'x', createdAt: 1 }]
    })
    expect(resyncs).toBe(1)
    expect(m.view.queues.s1).toHaveLength(1)
    m.onEvent(5, draftDelta(5, 's1', 'A', [99, 0], 'zz').p)
    expect(resyncs).toBe(2)
    expect(m.view.drafts.s1.content).toBe('a')
    // novo snapshot zera a sequência (resposta do resync)
    snapshot(9, {
      sessions: {
        s1: {
          status: 'running',
          draft: { content: 'abc', reasoning: '', toolCalls: [] },
          tools: {}
        }
      }
    })
    expect(m.view.drafts.s1.content).toBe('abc')
    expect(m.view.queues.s1).toBeUndefined()
  })

  it('sem snapshot ainda: aplica e pede o estado completo', () => {
    m.onEvent(3, {
      kind: 'approval.requested',
      request: {
        id: 'ap1',
        chatId: 'c',
        sessionId: 's1',
        toolCallId: 't',
        toolName: 'shell',
        args: {},
        createdAt: 1
      }
    })
    expect(resyncs).toBe(1)
    expect(m.view.approvals.map((a) => a.id)).toEqual(['ap1'])
    expect(m.view.complete).toBe(false)
  })

  it('draft encerrado fica na tela até a mensagem persistida (ou o teto de espera)', () => {
    snapshot(1)
    m.onEvent(2, draftDelta(2, 's1', 'A', [0, 0], 'resposta').p)
    m.onEvent(3, { kind: 'draft.end', sessionId: 's1', streamId: 'A' })
    expect(m.view.drafts.s1.content).toBe('resposta')
    // nova resposta começa: o encerrado continua sendo o mostrado
    m.onEvent(4, draftDelta(4, 's1', 'B', [0, 0], 'segunda').p)
    expect(m.view.drafts.s1.content).toBe('resposta')
    m.onPersistedAssistant(msg('m1', 's1', 'resposta completa'))
    expect(m.view.drafts.s1.content).toBe('segunda')
    m.onEvent(5, { kind: 'draft.end', sessionId: 's1', streamId: 'B' })
    expect(m.view.drafts.s1.content).toBe('segunda')
    vi.advanceTimersByTime(ENDED_DRAFT_HOLD_MS + 10)
    expect(m.view.drafts.s1).toBeUndefined()
  })

  it('mensagem de outra resposta não apaga o draft ao vivo; sintética apaga', () => {
    snapshot(1)
    m.onEvent(2, draftDelta(2, 's1', 'A', [0, 0], 'abc').p)
    m.onPersistedAssistant(msg('m0', 's1', 'xyz'))
    expect(m.view.drafts.s1.content).toBe('abc')
    m.onPersistedAssistant(msg('m1', 's1', '', { synthetic: true }))
    expect(m.view.drafts.s1).toBeUndefined()
  })

  it('retry descarta o parcial encerrado; resolved remove; snapshot substitui pedidos', () => {
    snapshot(1)
    m.onEvent(2, draftDelta(2, 's1', 'A', [0, 0], 'parcial').p)
    m.onEvent(3, { kind: 'draft.end', sessionId: 's1', streamId: 'A' })
    m.onEvent(4, {
      kind: 'retry.requested',
      request: {
        id: 'r1',
        chatId: 'c',
        sessionId: 's1',
        error: 'ECONNRESET',
        model: 'm',
        createdAt: 2
      }
    })
    expect(m.view.drafts.s1).toBeUndefined()
    expect(m.view.retries).toHaveLength(1)
    m.onEvent(5, { kind: 'retry.resolved', id: 'r1' })
    expect(m.view.retries).toHaveLength(0)
    m.onEvent(6, {
      kind: 'question.requested',
      request: {
        id: 'q1',
        chatId: 'c',
        sessionId: 's1',
        toolCallId: 't',
        questions: [],
        createdAt: 3
      }
    })
    snapshot(7, { questions: [] })
    expect(m.view.questions).toHaveLength(0)
  })

  it('tools ao vivo, Smart-Approve avaliando, compactação, processos, erro e sessão', () => {
    snapshot(1)
    m.onEvent(2, { kind: 'tool', sessionId: 's1', toolCallId: 't1', running: true, judging: true })
    expect(m.view.tools.s1.t1).toEqual({ running: false, judging: true })
    m.onEvent(3, {
      kind: 'tool',
      sessionId: 's1',
      toolCallId: 't1',
      running: true,
      output: 'linha'
    })
    expect(m.view.tools.s1.t1).toEqual({ running: true, output: 'linha' })
    m.onEvent(4, { kind: 'tool', sessionId: 's1', toolCallId: 't1', running: false })
    expect(m.view.tools.s1).toBeUndefined()
    m.onEvent(5, { kind: 'compaction', sessionId: 's1', state: 'running', text: 'resumo' })
    expect(m.view.compaction.s1).toEqual({ state: 'running', text: 'resumo' })
    m.onEvent(6, { kind: 'compaction', sessionId: 's1', state: null })
    expect(m.view.compaction.s1).toBeUndefined()
    m.onEvent(7, { kind: 'processes', processes: [{ id: 'p1' }] })
    expect(m.view.processes).toHaveLength(1)
    m.onEvent(8, { kind: 'error', sessionId: 's1', error: 'falhou' })
    expect(m.view.errors.s1).toBe('falhou')
    m.onEvent(9, {
      kind: 'session',
      session: { id: 's1', status: 'awaiting_approval', branchSel: { root: 'u2' } }
    })
    expect(m.view.status.s1).toBe('awaiting_approval')
    expect(m.view.branchSel.s1).toEqual({ root: 'u2' })
    m.endTurn()
    expect(m.view.status.s1).toBeUndefined()
    expect(m.view.tools).toEqual({})
  })

  it('liveStatus: espelho → transitório com janela → interrompido sem janela', () => {
    const s = { id: 's1', status: 'running' } as never
    expect(liveStatus(s, null, true)).toBe('running')
    expect(liveStatus(s, null, false)).toBe('interrupted')
    snapshot(1, { sessions: { s1: { status: 'awaiting_input', draft: null, tools: {} } } })
    expect(liveStatus(s, m.view, false)).toBe('awaiting_input')
  })
})

// ---------------- controlador ----------------

const USER = 'u-1'
const CHAT = 'c-1'

interface Sent {
  t: string
  fields: Record<string, unknown>
}

class FakeWs {
  sent: Sent[] = []
  replies: ((s: Sent) => Promise<Record<string, unknown>> | Record<string, unknown>)[] = []
  fail: ((s: Sent) => Error | null) | null = null
  async request(t: string, fields: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const s = { t, fields }
    this.sent.push(s)
    const e = this.fail?.(s)
    if (e) throw e
    return t === 'remote.send' ? { status: 'delivered' } : {}
  }
  of(t: string): Sent[] {
    return this.sent.filter((s) => s.t === t)
  }
}

describe('RemoteController', () => {
  let sk: Subkeys
  let ws: FakeWs
  let state: ChatState
  let rc: RemoteController
  let assistant: StoredMessage[]

  beforeEach(async () => {
    sk = await deriveSubkeys(randomBytes(32))
    ws = new FakeWs()
    assistant = []
    state = {
      chat_id: CHAT,
      ssq: 1,
      epoch: 3,
      head: 10,
      pinned: false,
      host: { device_id: 'pc', name: 'PC de casa', platform: 'linux', status: 'online' },
      window: null,
      handover: null,
      diverged: null
    }
    rc = new RemoteController({
      ws,
      keys: () => ({ userId: USER, sk }),
      deviceId: () => 'phone',
      chatState: (id) => (id === CHAT ? state : null),
      post: async () => ({}),
      assistantIds: () => assistant.map((m) => m.id),
      loadMessage: (id) => assistant.find((m) => m.id === id) ?? null,
      timing: { commandMs: 200, fsMs: 200, resyncGapMs: 0 }
    })
    rc.onWelcome({})
  })

  /** Host falso: decifra o último remote.send e responde. */
  async function hostReply(
    result: Record<string, unknown>,
    delay = 0
  ): Promise<Record<string, unknown>> {
    for (let i = 0; i < 50 && !ws.of('remote.send').length; i++)
      await new Promise((r) => setTimeout(r, 2))
    const s = ws.of('remote.send').at(-1)!
    const cmd = await openCommand(
      sk.stream,
      USER,
      CHAT,
      String(s.fields.cmd_id),
      s.fields.env as never
    )
    const env = await sealResult(sk.stream, USER, CHAT, String(s.fields.cmd_id), result)
    setTimeout(
      () => rc.onEvent({ t: 'remote.result', chat_id: CHAT, cmd_id: s.fields.cmd_id, env }),
      delay
    )
    return cmd
  }

  it('modo do host pelo chat_state', () => {
    expect(rc.mode(CHAT)).toBe('remote')
    state = { ...state, host: { ...state.host!, status: 'grace' } }
    expect(rc.mode(CHAT)).toBe('host-offline')
    state = { ...state, host: null }
    expect(rc.mode(CHAT)).toBe('none')
    state = { ...state, diverged: { divergence_id: 'd' } }
    expect(rc.mode(CHAT)).toBe('diverged')
    rc.onConnection(false)
    state = { ...state, diverged: null }
    expect(rc.mode(CHAT)).toBe('offline')
  })

  it('send cifra com a AAD do comando e devolve o resultado (queued)', async () => {
    const p = rc.send(CHAT, 's1', 'olá', [], ['deploy'], false)
    const cmd = await hostReply({ status: 'accepted', queued: true })
    expect(cmd).toMatchObject({
      sv: 1,
      kind: 'send',
      sessionId: 's1',
      text: 'olá',
      attachments: [],
      skills: ['deploy']
    })
    expect(typeof cmd.createdAt).toBe('number')
    expect(await p).toMatchObject({ status: 'accepted', queued: true })
    expect(ws.of('remote.send')[0].fields.kind).toBe('send')
  })

  it.each([
    ['force', () => rc.send(CHAT, 's1', 'já', [], [], true), { kind: 'force' }],
    ['queue.force', () => rc.queueForce(CHAT, 's1', 'q1'), { queuedId: 'q1' }],
    ['queue.remove', () => rc.queueRemove(CHAT, 's1', 'q1'), { queuedId: 'q1' }],
    ['stop', () => rc.stop(CHAT, 's1'), { sessionId: 's1' }],
    ['stop_subagents', () => rc.stopSubagents(CHAT), {}],
    [
      'approval',
      () => rc.approve(CHAT, 'a1', 'allow', [{ index: 0, allow: true, pattern: 'git *' }]),
      { requestId: 'a1', decision: 'allow', items: [{ index: 0, allow: true, pattern: 'git *' }] }
    ],
    ['smart_override', () => rc.smartOverride(CHAT, 'm1'), { messageId: 'm1' }],
    [
      'question',
      () => rc.answer(CHAT, 'q1', [{ selected: [1], other: 'x' }]),
      { requestId: 'q1', answers: [{ selected: [1], other: 'x' }] }
    ],
    ['question', () => rc.cancelQuestion(CHAT, 'q1'), { requestId: 'q1', cancel: true }],
    ['retry', () => rc.retry(CHAT, 'r1', 'cancel'), { requestId: 'r1', action: 'cancel' }],
    [
      'branch.regenerate',
      () => rc.regenerate(CHAT, 's1', 'm2'),
      { sessionId: 's1', messageId: 'm2' }
    ],
    [
      'message.edit',
      () => rc.editMessage(CHAT, 'm1', { role: 'assistant', content: 'novo' }),
      { messageId: 'm1', message: { role: 'assistant', content: 'novo' } }
    ],
    ['message.delete', () => rc.deleteMessage(CHAT, 'm1'), { messageId: 'm1' }],
    [
      'compact',
      () => rc.compact(CHAT, 's1', { retry: true }),
      { sessionId: 's1', opts: { retry: true } }
    ],
    ['memory.extract', () => rc.extractMemory(CHAT, 's1'), { sessionId: 's1' }],
    [
      'branch.edit',
      () => rc.editBranch(CHAT, 'u1', { role: 'user', content: 'v2' }),
      { messageId: 'u1', message: { role: 'user', content: 'v2' } }
    ],
    ['branch.select', () => rc.selectBranch(CHAT, 'u1'), { messageId: 'u1' }]
  ])('%s chega ao host com o plaintext do §8.6', async (kind, call, fields) => {
    const p = (call as () => Promise<unknown>)()
    const cmd = await hostReply({ status: 'accepted' })
    await p
    expect(ws.of('remote.send')[0].fields.kind).toBe((fields as { kind?: string }).kind ?? kind)
    expect(cmd).toMatchObject({ sv: 1, ...(fields as object) })
  })

  it('regenerate antigo nunca vai pelo fio (vira branch.regenerate)', async () => {
    expect(wireKind('regenerate')).toBe('branch.regenerate')
    const p = rc.command(CHAT, 'regenerate', { sessionId: 's1' })
    const cmd = await hostReply({ status: 'duplicate' })
    expect(await p).toMatchObject({ status: 'duplicate' })
    expect(cmd.kind).toBe('branch.regenerate')
    await expect(rc.command(CHAT, 'nope' as never, {})).rejects.toThrow(/desconhecido/)
  })

  it('recusas do host em pt-BR', async () => {
    const cases: [string, RegExp][] = [
      ['attachment_missing', /não conseguiu baixar um dos anexos/],
      ['chat_busy', /ocupado/],
      ['not_host', /não é mais o host/],
      ['comando desconhecido: branch.select', /versão antiga/],
      [
        'Editar uma mensagem sua agora cria uma nova versão da conversa — atualize',
        /Editar como nova versão/
      ],
      ['Não dá para trocar de versão com a sessão ocupada.', /trocar de versão/]
    ]
    for (const [error, re] of cases) {
      ws.sent = []
      const p = rc.selectBranch(CHAT, 'u1')
      await hostReply({ status: 'rejected', error })
      await expect(p).rejects.toThrow(re)
    }
    expect(rejectText(undefined, 'PC')).toMatch(/recusou/)
  })

  it('erros do remote.send: host offline, sem host, divergente, sem conexão', async () => {
    const codes: [string, RegExp][] = [
      ['host_offline', /está offline/],
      ['no_host', /não tem host/],
      ['chat_diverged', /divergente/],
      ['disconnected', /Sem conexão/],
      ['invalid_request', /recusou o comando/]
    ]
    for (const [code, re] of codes) {
      ws.fail = (s) => (s.t === 'remote.send' ? new WsRequestError('x', code) : null)
      const e = await rc.stop(CHAT, 's1').catch((x: unknown) => x)
      expect(e).toBeInstanceOf(RemoteError)
      expect((e as Error).message).toMatch(re)
    }
  })

  it('remote.failed, timeout e queda da conexão', async () => {
    const p1 = rc.stop(CHAT, 's1')
    await new Promise((r) => setTimeout(r, 5))
    rc.onEvent({
      t: 'remote.failed',
      chat_id: CHAT,
      cmd_id: ws.of('remote.send')[0].fields.cmd_id,
      code: 'host_offline'
    })
    await expect(p1).rejects.toThrow(/caiu antes de confirmar/)
    const p2 = rc.stop(CHAT, 's1')
    await expect(p2).rejects.toThrow(/não respondeu a tempo/)
    const p3 = rc.stop(CHAT, 's1')
    await new Promise((r) => setTimeout(r, 5))
    rc.onConnection(false)
    await expect(p3).rejects.toThrow(/Conexão com o servidor perdida/)
    await expect(rc.stop(CHAT, 's1')).rejects.toThrow(/Sem conexão/)
  })

  it('fs.list valida os nomes; fs.read decodifica o base64; recusa vira falha legível', async () => {
    const pl = rc.fsList(CHAT, '')
    const cmd = await hostReply({
      status: 'accepted',
      dir: '/home/u/proj',
      root: '/home/u/proj',
      confine: true,
      truncated: false,
      entries: [
        { name: 'src', kind: 'dir', mtime: 5 },
        { name: 'a.txt', kind: 'file', size: 3 },
        { name: '../x', kind: 'file' },
        { name: '..', kind: 'dir' }
      ]
    })
    expect(cmd).toMatchObject({ kind: 'fs.list', chatId: CHAT, path: '' })
    const l = await pl
    expect(l.ok && l.entries.map((e) => e.name)).toEqual(['src', 'a.txt'])
    ws.sent = []
    const pr = rc.fsRead(CHAT, '/home/u/proj/a.txt', 0, 10)
    await hostReply({
      status: 'accepted',
      size: 3,
      mtime: 9,
      mime: 'text/plain',
      offset: 0,
      data: 'b2zDoQ=='
    })
    const r = await pr
    expect(r.ok && fromUtf8(r.data)).toBe('olá')
    ws.sent = []
    const pd = rc.fsRead(CHAT, '/etc/passwd', 0, 10)
    await hostReply({ status: 'rejected', error: 'Fora da raiz do chat.', code: 'denied' })
    expect(await pd).toMatchObject({
      ok: false,
      reason: 'denied',
      message: 'Fora da raiz do chat.'
    })
    state = { ...state, host: { ...state.host!, status: 'offline' } }
    expect(await rc.fsList(CHAT, '')).toMatchObject({ ok: false, reason: 'host-offline' })
  })

  it('stream: inscreve ao abrir, decifra na ordem, troca o draft pela mensagem e cancela ao sair', async () => {
    rc.setActive(CHAT)
    expect(ws.of('stream.subscribe')[0].fields).toEqual({ chat_ids: [CHAT] })
    expect(rc.subscriptions()).toEqual([CHAT])
    const ev = async (n: number, p: Record<string, unknown>) => ({
      t: 'stream.event',
      chat_id: CHAT,
      epoch: 3,
      n,
      env: await sealStream(sk.stream, USER, CHAT, 3, n, p),
      device_id: 'pc'
    })
    const frames = [
      await ev(1, {
        kind: 'snapshot',
        sessions: { s1: { status: 'running', draft: null, tools: {} } },
        queues: {},
        approvals: [],
        questions: [],
        retries: [],
        processes: [],
        skills: []
      }),
      await ev(2, draftDelta(2, 's1', 'A', [0, 0], 'oi').p),
      await ev(3, { kind: 'draft.end', sessionId: 's1', streamId: 'A' })
    ]
    for (const f of frames) rc.onEvent(f)
    await vi.waitFor(() => expect(rc.view(CHAT)?.drafts.s1?.content).toBe('oi'))
    expect(ws.of('stream.resync')).toHaveLength(0)
    assistant.push(msg('m9', 's1', 'oi tudo bem'))
    rc.onChatData(CHAT)
    expect(rc.view(CHAT)?.drafts.s1).toBeUndefined()
    // fim da janela: some o ao vivo
    rc.onEvent({ t: 'chat.state', ...state, window: null, event: { kind: 'turn_ended' } })
    rc.setActive(null)
    expect(ws.of('stream.unsubscribe')[0].fields).toEqual({ chat_ids: [CHAT] })
    expect(rc.view(CHAT)).toBeNull()
  })

  it('reconexão pede resync do chat aberto; host_dropped e host_back viram avisos', async () => {
    rc.setActive(CHAT)
    const notes: string[] = []
    rc.onNotice((n) => notes.push(n.text))
    rc.onConnection(false)
    rc.onWelcome({})
    expect(ws.of('stream.resync').map((s) => s.fields.chat_id)).toEqual([CHAT])
    state = { ...state, host: { ...state.host!, status: 'offline' } }
    rc.onEvent({ t: 'chat.state', ...state, event: { kind: 'host_dropped' } })
    state = { ...state, host: { ...state.host!, status: 'online' } }
    rc.onEvent({ t: 'chat.state', ...state, event: { kind: 'host_back' } })
    expect(notes).toEqual([
      'O dispositivo remoto (PC de casa) caiu.',
      'PC de casa voltou a ficar online.'
    ])
  })

  it('evento de stream com AAD de outro epoch é descartado', async () => {
    rc.setActive(CHAT)
    rc.onEvent({
      t: 'stream.event',
      chat_id: CHAT,
      epoch: 3,
      n: 1,
      env: await sealStream(sk.stream, USER, CHAT, 4, 1, { kind: 'snapshot' })
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(rc.view(CHAT)).toBeNull()
  })

  it('pin e descartar versão divergente', async () => {
    await rc.setPinned(CHAT, true)
    expect(ws.of('host.pin')[0].fields).toEqual({ chat_id: CHAT, pinned: true })
    await expect(rc.discardDivergentVersion(CHAT)).rejects.toThrow(/não está divergente/)
  })
})

// ---------------- leitura em pedaços / UTF-8 ----------------

describe('fetchRange / splitUtf8', () => {
  const file = utf8('ação '.repeat(3000))
  const reader = (mtime = () => 1) => {
    let inflight = 0
    let peak = 0
    const read = async (offset: number, length: number) => {
      inflight++
      peak = Math.max(peak, inflight)
      await new Promise((r) => setTimeout(r, 1))
      inflight--
      return {
        ok: true as const,
        size: file.length,
        mtime: mtime(),
        offset,
        data: file.subarray(offset, offset + length)
      }
    }
    return { read, peak: () => peak }
  }
  it('junta os pedaços na ordem com até 3 em voo', async () => {
    const r = reader()
    const f = await fetchRange(r.read, { maxBytes: file.length, chunkBytes: 1000 })
    expect(hex(f.bytes)).toBe(hex(file))
    expect(f.complete).toBe(true)
    expect(r.peak()).toBeLessThanOrEqual(3)
  })
  it('mtime mudou no meio → erro', async () => {
    let n = 0
    const r = reader(() => (n++ > 2 ? 2 : 1))
    await expect(fetchRange(r.read, { maxBytes: file.length, chunkBytes: 1000 })).rejects.toThrow(
      FILE_CHANGED
    )
  })
  it('página parcial + corte de UTF-8', async () => {
    const r = reader()
    const f = await fetchRange(r.read, { maxBytes: 1001, chunkBytes: 1000 })
    expect(f.complete).toBe(false)
    const [ok, rest] = splitUtf8(utf8('aç'))
    expect([ok.length, rest.length]).toEqual([3, 0])
    const cut = utf8('aç').subarray(0, 2)
    const [ok2, rest2] = splitUtf8(cut)
    expect([fromUtf8(ok2), rest2.length]).toEqual(['a', 1])
  })
})

// ---------------- anexos ----------------

describe('anexos (§14)', () => {
  it('classifica, grava, sobe só os ausentes e o CCB1 decifra igual', async () => {
    const sk = await deriveSubkeys(randomBytes(32))
    const put = new Map<string, Uint8Array>()
    const blobs = new Map<string, { ct: Uint8Array; sha: string }>()
    const deps = {
      keys: () => ({ userId: USER, sk }),
      put: (f: string, d: Uint8Array) => void put.set(f, d),
      post: async <T>(path: string, json: unknown): Promise<T> => {
        expect(path).toBe('/api/v1/blobs/check')
        const ids = (json as { ids: string[] }).ids
        return { present: [], missing: ids.filter((i) => !blobs.has(i)) } as T
      },
      putBlob: async (id: string, ct: Uint8Array, sha: string) => void blobs.set(id, { ct, sha })
    }
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    const a = await prepareAttachment(deps, png, 'foto.PNG', 'image/png')
    expect(a.info).toMatchObject({ name: 'foto.PNG', kind: 'image', mime: 'image/png', size: 7 })
    expect(a.info.file).toBe(`${hex(await sha256(png))}.png`)
    expect(put.get(a.info.file)).toEqual(png)
    await uploadAttachments(deps, [a])
    const b = blobs.get(a.blobId)!
    expect(b.sha).toBe(hex(await sha256(b.ct)))
    expect(await decryptBlob(sk, USER, a.blobId, b.ct)).toEqual(png)
    blobs.set(a.blobId, { ct: new Uint8Array(0), sha: 'mantido' })
    await uploadAttachments(deps, [a])
    expect(blobs.get(a.blobId)!.sha).toBe('mantido')
    const t = await prepareAttachment(deps, utf8('# oi'), 'LEIAME', undefined)
    expect(t.info.kind).toBe('text')
    expect(t.info.file.endsWith('.txt')).toBe(true)
    await expect(
      prepareAttachment(deps, new Uint8Array([0xff, 0xfe, 0x00]), 'x.bin', undefined)
    ).rejects.toThrow(/não suportado/)
    expect(storeExt('a.tar.gz', 'application/gzip', 'text')).toBe('gz')
  })
})
