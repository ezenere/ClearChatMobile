// Host no celular: janelas (host.begin/host.end), revisões com chat_bases/host_epochs (§8.4),
// chats com ferramentas locais hospedados sem elas (§4.3.6, §8.9), comandos remotos recusados na hora (o celular não
// é controlado remotamente), troca de host pedida por outro dispositivo no meio do turno, segundo
// plano e o espelho local da tela.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CHAT_CONFIG } from '../src/vendor/shared/defaults'
import type { ChatConfig } from '../src/vendor/shared/types'
import { openResult, sealCommand, type Envelope } from '../src/remote/crypto'
import { REMOTE_REFUSAL } from '../src/host/host'
import { localToolsTakeoverText, usesLocalTools } from '../src/host/policy'
import { takeoverWarnsLocalTools } from '../src/vendor/shared/sync'
import { makeHarness, until, type Harness } from './hostHarness'

let h: Harness
beforeEach(async () => {
  h = await makeHarness()
})
afterEach(async () => {
  await h.close()
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
const idle = (sid: string) => until(() => !h.stack.runner.isRunning(sid), 10_000, 'turno terminar')
const closed = () => until(() => !h.ws.windowOpen && h.ws.count('host.end') > 0, 8000, 'host.end')

describe('janela e revisões (§8.3–8.5)', () => {
  it('chat novo: chat (LWW) antes; turno na janela com host_epochs e chat_bases = head; host.end ao ficar ocioso', async () => {
    const { chatId, sid } = newChat()
    await h.stack.writer.flush(chatId)
    expect(h.server.pushes[0].items.map((i) => i.type)).toEqual(['chat'])
    expect(h.server.pushes[0].chat_bases).toBeUndefined()
    await h.stack.host.local(chatId, 'send', { sessionId: sid, text: 'olá' })
    const begin = h.ws.requests.find((r) => r.t === 'host.begin')!
    expect(begin.fields).toEqual({ chat_id: chatId, epoch: null, purpose: 'run' })
    expect(h.stack.host.windowOpen(chatId)).toBe(true)
    await idle(sid)
    await closed()
    expect(h.stack.writer.pending(chatId)).toBe(false)
    const content = h.server.pushes.filter((p) => p.items.some((i) => i.type !== 'chat'))
    expect(content.length).toBeGreaterThan(0)
    // a sessão criada antes da janela subiu como replay (sem host_epochs) ou já na janela
    const inWindow = content.filter((x) => x.host_epochs)
    expect(inWindow.length).toBeGreaterThan(0)
    for (const p of inWindow) expect(p.host_epochs).toEqual({ [chatId]: 1 })
    expect(inWindow.some((p) => p.items.some((i) => i.type === 'message'))).toBe(true)
    // chat_bases nunca volta e é sempre o head que o aparelho tinha
    const bases = content.map((p) => p.chat_bases![chatId])
    expect([...bases].sort((a, b) => a - b)).toEqual(bases)
    expect(h.store.contentHead(chatId)).toBeGreaterThan(bases[bases.length - 1])
    // revisões: todas as mensagens subiram com parentId e a sessão com branchSel
    expect(h.store.outbox(chatId)).toEqual([])
    const sess = h.store.getPlain('session', sid)!
    expect(sess.branchSel).toEqual({})
    expect(sess.status).toBe('idle')
    // segundo turno reabre a janela com o epoch que o aparelho tem
    await h.stack.host.local(chatId, 'send', { sessionId: sid, text: 'de novo' })
    const begins = h.ws.requests.filter((r) => r.t === 'host.begin')
    expect(begins[begins.length - 1].fields.epoch).toBe(1)
    await idle(sid)
  })

  it('hospeda chats com ferramentas locais SEM elas (§4.3.6, §8.9) — só manda as que executa', async () => {
    expect(usesLocalTools({ enabledTools: ['web_search', 'bash'] })).toBe(true)
    expect(usesLocalTools({ enabledTools: ['web_search'], skills: { enabled: true } })).toBe(true)
    expect(usesLocalTools({ voice: { tools: { enabledTools: ['read_file'] } } })).toBe(true)
    expect(usesLocalTools({ enabledTools: ['web_search', 'ask_user'] })).toBe(false)
    // present_file também é "só no computador" (§8.9 desde 1.10.0); as do celular não contam
    expect(usesLocalTools({ enabledTools: ['present_file'] })).toBe(true)
    expect(usesLocalTools({ enabledTools: ['get_location', 'nearby_places'] })).toBe(false)
    // o aviso forte ao assumir só num chat que já rodou num computador (hostCwd)
    expect(takeoverWarnsLocalTools(true, { deviceId: 'pc', path: '/p' })).toBe(true)
    expect(takeoverWarnsLocalTools(true, null)).toBe(false)
    const { chatId, sid } = newChat({
      enabledTools: ['shell', 'web_search', 'read_file', 'present_file'],
      skills: {
        enabled: true,
        disabled: [],
        supportPrompt: { enabled: true, text: null },
        subagents: true
      },
      toolsInPrompt: true
    })
    await h.stack.host.local(chatId, 'send', { sessionId: sid, text: 'oi' })
    expect(h.ws.count('host.begin')).toBe(1)
    await idle(sid)
    const req = h.llm.requests.filter((r) => r.path.endsWith('/chat/completions')).pop()!
    const names = ((req.body.tools as { function: { name: string } }[]) ?? []).map(
      (t) => t.function.name
    )
    // (compactadas por padrão, 1.11.0: a tool_search automática vai no fim)
    expect(names).toEqual(['web_search', 'tool_search'])
    // nem no texto das tools no system prompt
    expect(JSON.stringify(req.body.messages)).not.toMatch(/read_file|present_file|skill_load/)
    // a lista do chat continua a mesma (nada vira próprio nem some por causa do aparelho)
    expect(h.stack.repo.chat(chatId)!.config.enabledTools).toEqual([
      'shell',
      'web_search',
      'read_file',
      'present_file'
    ])
    // o aviso forte ao assumir (§8.9)
    expect(localToolsTakeoverText({ deviceId: 'pc', path: '/home/ana/proj' }, 'PC da Ana')).toBe(
      'Este chat usa ferramentas locais (diretório raiz /home/ana/proj no PC da Ana); no celular ele roda sem elas.'
    )
    expect(localToolsTakeoverText(null, 'PC')).toBe(
      'Este chat usa ferramentas locais no PC; no celular ele roda sem elas.'
    )
  })

  it('sem conexão não executa; janela de outro dispositivo → espera; recusa do host.begin em pt-BR', async () => {
    const { chatId, sid } = newChat()
    h.stack.host.onConnection(false)
    await expect(
      h.stack.host.local(chatId, 'send', { sessionId: sid, text: 'oi' })
    ).rejects.toThrow(/online/)
    expect(await h.stack.host.pushMode(chatId)).toBeNull()
    h.stack.host.onConnection(true)
    h.store.upsertChatState({
      chat_id: chatId,
      ssq: 5,
      epoch: 3,
      head: 0,
      pinned: false,
      host: { device_id: 'dev-pc', name: 'PC', platform: 'linux', status: 'online' },
      window: { purpose: 'run', since: '' },
      handover: null,
      diverged: null
    })
    expect(await h.stack.host.pushMode(chatId)).toBeNull()
    await expect(
      h.stack.host.local(chatId, 'send', { sessionId: sid, text: 'oi' })
    ).rejects.toThrow('Este chat é executado em PC.')
  })
})

describe('controle remoto recusado', () => {
  it('remote.command → remote.result rejected com o texto pt-BR (sem executar nada)', async () => {
    const { chatId, sid } = newChat()
    const keys = { userId: h.server.userId, sk: h.desk.sk }
    for (const [kind, payload] of [
      ['send', { sessionId: sid, text: 'do PC', attachments: [], skills: [], createdAt: 1 }],
      ['fs.list', { chatId, path: '' }]
    ] as const) {
      const cmdId = `cmd-${kind}`
      const env = await sealCommand(keys.sk.stream, keys.userId, chatId, cmdId, {
        kind,
        ...payload
      })
      h.stack.host.onEvent({ t: 'remote.command', chat_id: chatId, cmd_id: cmdId, kind, env })
      await until(() =>
        h.ws.requests.some((r) => r.t === 'remote.result' && r.fields.cmd_id === cmdId)
      )
      const res = h.ws.requests.find((r) => r.t === 'remote.result' && r.fields.cmd_id === cmdId)!
      const r = await openResult(
        keys.sk.stream,
        keys.userId,
        chatId,
        cmdId,
        res.fields.env as Envelope
      )
      expect(r).toMatchObject({ sv: 1, status: 'rejected', error: REMOTE_REFUSAL })
      if (kind === 'fs.list') expect(r.code).toBe('denied')
    }
    expect(h.stack.repo.path(sid)).toEqual([])
    expect(h.ws.count('host.begin')).toBe(0)
  })
})

describe('fila repassada na troca de host (§8.8)', () => {
  /** Chat do PC (online) que este celular pede para assumir: troca pendente → concedida. */
  async function takeoverFromPc() {
    const { chatId, sid } = newChat()
    await h.stack.writer.flush(chatId)
    h.ws.host = 'dev-pc'
    const pc = {
      chat_id: chatId,
      ssq: 7,
      epoch: 4,
      head: 0,
      pinned: false,
      host: { device_id: 'dev-pc', name: 'PC', platform: 'linux', status: 'online' as const },
      window: null,
      handover: null,
      diverged: null
    }
    h.store.upsertChatState(pc)
    h.ws.takeoverPending = true
    expect(await h.stack.host.takeover(chatId, { mode: 'next_turn' })).toBe('pending')
    // o PC termina o turno e libera: o servidor concede (chat.state antes, como o broadcast) e
    // repassa a fila dele logo depois do host.granted
    h.ws.host = 'dev-mobile'
    h.ws.epoch = 5
    const mine = {
      ...pc,
      ssq: 8,
      epoch: 5,
      host: {
        device_id: 'dev-mobile',
        name: 'Pixel',
        platform: 'android',
        status: 'online' as const
      }
    }
    h.store.upsertChatState(mine)
    h.stack.host.onEvent({ t: 'chat.state', ...mine })
    h.stack.host.onEvent({ t: 'host.granted', chat_id: chatId, epoch: 5, head: 0 })
    return { chatId, sid }
  }
  const keys = () => ({ userId: h.server.userId, sk: h.desk.sk })
  /** Um `remote.command` como o servidor entrega (o env cifrado pelo host antigo). */
  async function command(
    chatId: string,
    cmdId: string,
    payload: Record<string, unknown>,
    o: { from?: string; kind?: string; envCmdId?: string } = {}
  ) {
    const env = await sealCommand(keys().sk.stream, keys().userId, chatId, o.envCmdId ?? cmdId, {
      sv: 1,
      kind: 'send',
      attachments: [],
      skills: [],
      createdAt: 1,
      ...payload
    })
    h.stack.host.onEvent({
      t: 'remote.command',
      chat_id: chatId,
      cmd_id: cmdId,
      kind: o.kind ?? 'send',
      env,
      from_device_id: o.from ?? 'dev-pc',
      created_at: '2026-11-14T00:00:00Z'
    })
  }
  async function resultOf(chatId: string, cmdId: string): Promise<Record<string, unknown>> {
    await until(
      () => h.ws.requests.some((r) => r.t === 'remote.result' && r.fields.cmd_id === cmdId),
      8000,
      `resultado de ${cmdId}`
    )
    const res = h.ws.requests.find((r) => r.t === 'remote.result' && r.fields.cmd_id === cmdId)!
    return openResult(keys().sk.stream, keys().userId, chatId, cmdId, res.fields.env as Envelope)
  }

  it('assumir com fila repassada: os itens rodam aqui em ordem; inválidos descartados com aviso', async () => {
    const { chatId, sid } = await takeoverFromPc()
    const other = newChat()
    const missing = `${'a'.repeat(64)}.png`
    await command(chatId, 'f1', {
      sessionId: sid,
      text: '/slow primeira da fila',
      meta: { openFile: { path: 'src/a.ts' } }
    })
    await command(chatId, 'f2', { sessionId: sid, text: 'ilegível' }, { envCmdId: 'outro' })
    await command(chatId, 'f3', { sessionId: other.sid, text: 'de outro chat' })
    await command(chatId, 'f4', {
      sessionId: sid,
      text: 'com anexo que não existe',
      attachments: [{ file: missing, kind: 'image', name: 'x.png', mime: 'image/png', size: 3 }]
    })
    await command(chatId, 'f5', {
      sessionId: sid,
      text: 'segunda da fila',
      meta: { openFile: { path: 'a\nb' } }
    })
    await command(chatId, 'f6', { sessionId: sid, text: '   ' })
    await command(chatId, 'f7', { sessionId: sid, text: 'terceira da fila', skills: ['deploy'] })
    expect(await resultOf(chatId, 'f1')).toMatchObject({ status: 'accepted', queued: false })
    expect(await resultOf(chatId, 'f2')).toMatchObject({ status: 'rejected' })
    expect(await resultOf(chatId, 'f3')).toMatchObject({
      status: 'rejected',
      error: 'Sessão não pertence a este chat.'
    })
    expect(await resultOf(chatId, 'f4')).toMatchObject({ status: 'rejected' })
    expect(await resultOf(chatId, 'f5')).toMatchObject({ status: 'accepted', queued: true })
    expect(await resultOf(chatId, 'f6')).toMatchObject({
      status: 'rejected',
      error: 'Mensagem vazia.'
    })
    expect(await resultOf(chatId, 'f7')).toMatchObject({ status: 'accepted', queued: true })
    await until(
      () =>
        !h.stack.runner.isRunning(sid) &&
        h.stack.repo.path(sid).some((m) => m.message.content === 'terceira da fila'),
      15_000,
      'fila rodar'
    )
    await idle(sid)
    const users = h.stack.repo.path(sid).filter((m) => m.message.role === 'user')
    expect(users.map((m) => m.message.content)).toEqual([
      '/slow primeira da fila',
      'segunda da fila',
      'terceira da fila'
    ])
    // validado como na tela: o arquivo selecionado válido fica; o inválido some
    expect(users[0].meta.openFile).toEqual({ path: 'src/a.ts' })
    expect(users[1].meta.openFile).toBeUndefined()
    // o turno rodou aqui, na janela deste celular
    expect(h.ws.count('host.begin')).toBeGreaterThan(0)
    expect(h.stack.repo.path(other.sid)).toEqual([])
    // os descartados viram aviso na tela
    expect(h.notices.filter((n) => /fila do outro dispositivo não veio/.test(n)).length).toBe(4)
  })

  it('fora da troca continua recusado: outro aparelho, outro kind, janela vencida, sem troca pedida', async () => {
    const { chatId, sid } = await takeoverFromPc()
    // de outro aparelho (não o host antigo) na janela → controle remoto comum
    await command(chatId, 'x1', { sessionId: sid, text: 'do notebook' }, { from: 'dev-notebook' })
    expect(await resultOf(chatId, 'x1')).toMatchObject({
      status: 'rejected',
      error: REMOTE_REFUSAL
    })
    // outro kind do host antigo → recusado
    await command(chatId, 'x2', { sessionId: sid }, { kind: 'stop' })
    expect(await resultOf(chatId, 'x2')).toMatchObject({
      status: 'rejected',
      error: REMOTE_REFUSAL
    })
    // janela vencida: o PC agora é um controle remoto comum
    const real = Date.now
    const env = await sealCommand(keys().sk.stream, keys().userId, chatId, 'x3', {
      sv: 1,
      kind: 'send',
      sessionId: sid,
      text: 'depois da troca',
      attachments: [],
      skills: [],
      createdAt: 1
    })
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => real() + 60_000)
    h.stack.host.onEvent({
      t: 'remote.command',
      chat_id: chatId,
      cmd_id: 'x3',
      kind: 'send',
      env,
      from_device_id: 'dev-pc'
    })
    spy.mockRestore()
    expect(await resultOf(chatId, 'x3')).toMatchObject({
      status: 'rejected',
      error: REMOTE_REFUSAL
    })
    // e a janela não volta
    await command(chatId, 'x4', { sessionId: sid, text: 'de novo' })
    expect(await resultOf(chatId, 'x4')).toMatchObject({
      status: 'rejected',
      error: REMOTE_REFUSAL
    })
    // chat sem troca pedida por aqui: `send` do host dele → recusado (como sempre)
    const c2 = newChat()
    await command(c2.chatId, 'x5', { sessionId: c2.sid, text: 'oi' })
    expect(await resultOf(c2.chatId, 'x5')).toMatchObject({
      status: 'rejected',
      error: REMOTE_REFUSAL
    })
    expect(h.stack.repo.path(sid)).toEqual([])
    expect(h.stack.repo.path(c2.sid)).toEqual([])
  })
})

describe('troca de host e segundo plano', () => {
  it('outro dispositivo assume no meio do turno: para (parcial interrupted), fecha a janela e libera com a fila', async () => {
    const { chatId, sid } = newChat()
    await h.stack.host.local(chatId, 'send', { sessionId: sid, text: '/slow' })
    await new Promise((r) => setTimeout(r, 250))
    await h.stack.host.local(chatId, 'send', { sessionId: sid, text: 'na fila' })
    expect(h.stack.runner.getQueue(sid).length).toBe(1)
    h.stack.host.onEvent({
      t: 'host.handover_request',
      chat_id: chatId,
      to_device_id: 'dev-pc',
      to_name: 'PC',
      mode: 'next_turn'
    })
    await until(() => h.ws.count('host.release') === 1, 8000, 'host.release')
    expect(h.stack.runner.isRunning(sid)).toBe(false)
    const p = h.stack.repo.path(sid)
    expect(p[p.length - 1].meta.interrupted).toBe(true)
    expect(h.stack.repo.session(sid)?.status).toBe('interrupted')
    expect(h.ws.count('host.end')).toBe(1)
    // a outbox foi enviada antes de liberar
    expect(h.store.outbox(chatId)).toEqual([])
    const rel = h.ws.requests.find((r) => r.t === 'host.release')!
    const fwd = rel.fields.forwarded as { cmd_id: string; env: Envelope }[]
    expect(fwd.length).toBe(1)
    const { openCommand } = await import('../src/remote/crypto')
    const cmd = await openCommand(
      h.desk.sk.stream,
      h.server.userId,
      chatId,
      fwd[0].cmd_id,
      fwd[0].env
    )
    expect(cmd).toMatchObject({ kind: 'send', text: 'na fila', sessionId: sid })
    // depois de liberar, o celular não abre janela nesse chat (o host agora é o PC)
    h.store.upsertChatState({
      chat_id: chatId,
      ssq: 99,
      epoch: 3,
      head: 0,
      pinned: false,
      host: { device_id: 'dev-pc', name: 'PC', platform: 'linux', status: 'online' },
      window: null,
      handover: null,
      diverged: null,
      event: { kind: 'host_changed' }
    })
    await expect(h.stack.host.local(chatId, 'send', { sessionId: sid, text: 'x' })).rejects.toThrow(
      /PC/
    )
  })

  it('takeover concedido com o celular desconectado: chat.state com outro host para o turno', async () => {
    const { chatId, sid } = newChat()
    await h.stack.host.local(chatId, 'send', { sessionId: sid, text: '/slow' })
    await new Promise((r) => setTimeout(r, 200))
    const st = {
      chat_id: chatId,
      ssq: 50,
      epoch: 2,
      head: 0,
      pinned: false,
      host: { device_id: 'dev-pc', name: 'PC', platform: 'linux', status: 'online' as const },
      window: null,
      handover: null,
      diverged: null,
      event: { kind: 'host_changed' }
    }
    h.store.upsertChatState(st)
    h.stack.host.onEvent({ t: 'chat.state', ...st })
    await idle(sid)
    expect(h.stack.repo.session(sid)?.status).toBe('interrupted')
    expect(h.stack.host.windowOpen(chatId)).toBe(false)
  })

  it('segundo plano no meio do turno: interrompido, outbox enviada, janela fechada; volta ao primeiro plano', async () => {
    const { chatId, sid } = newChat()
    await h.stack.host.local(chatId, 'send', { sessionId: sid, text: '/slow' })
    await new Promise((r) => setTimeout(r, 250))
    await h.stack.host.onBackground()
    expect(h.stack.runner.isRunning(sid)).toBe(false)
    expect(h.stack.repo.session(sid)?.status).toBe('interrupted')
    expect(h.stack.repo.path(sid).pop()!.meta.interrupted).toBe(true)
    expect(h.store.outbox(chatId)).toEqual([])
    expect(h.ws.windowOpen).toBe(false)
    await expect(h.stack.host.local(chatId, 'send', { sessionId: sid, text: 'x' })).rejects.toThrow(
      /segundo plano/
    )
    h.stack.host.onForeground()
    await h.stack.host.local(chatId, 'send', { sessionId: sid, text: 'voltei' })
    await idle(sid)
    expect(h.stack.repo.path(sid).pop()!.message.content).toBe('ok: voltei')
  })

  it('"Executar neste dispositivo" num chat do PC (com ferramentas locais: roda sem elas)', async () => {
    const { chatId } = newChat({ enabledTools: ['shell', 'web_search'] })
    await h.stack.writer.flush(chatId)
    h.ws.host = 'dev-pc'
    h.store.upsertChatState({
      chat_id: chatId,
      ssq: 7,
      epoch: 4,
      head: 0,
      pinned: true,
      host: { device_id: 'dev-pc', name: 'PC', platform: 'linux', status: 'offline' },
      window: null,
      handover: null,
      diverged: null
    })
    expect(await h.stack.host.takeover(chatId, { mode: 'next_turn', confirmPinned: true })).toBe(
      'granted'
    )
    expect(h.ws.requests.find((r) => r.t === 'host.takeover')!.fields).toEqual({
      chat_id: chatId,
      mode: 'next_turn',
      confirm_pinned: true
    })
    expect(h.stack.host.isHostHere(chatId)).toBe(true)
  })
})

describe('espelho local (a tela usa o modelo do controle remoto)', () => {
  it('draft ao vivo, status, aprovação pendente e o draft some com a mensagem persistida', async () => {
    const { chatId, sid } = newChat({ approvalModes: { search: 'lists' } })
    h.stack.host.setActive(chatId)
    await h.stack.host.local(chatId, 'send', { sessionId: sid, text: '/slow' })
    await until(
      () => (h.stack.host.view(chatId)?.drafts[sid]?.content.length ?? 0) > 20,
      8000,
      'draft'
    )
    expect(h.stack.host.view(chatId)?.status[sid]).toBe('running')
    await h.stack.host.local(chatId, 'stop', { sessionId: sid })
    await until(() => !h.stack.host.view(chatId)?.drafts[sid], 9000, 'draft some')
    await h.stack.host.local(chatId, 'send', { sessionId: sid, text: '/search x' })
    await until(
      () => (h.stack.host.view(chatId)?.approvals.length ?? 0) === 1,
      8000,
      'aprovação no espelho'
    )
    const req = h.stack.host.view(chatId)!.approvals[0]
    await h.stack.host.local(chatId, 'approval', { requestId: req.id, decision: 'allow' })
    await idle(sid)
    expect(h.stack.host.view(chatId)?.approvals).toEqual([])
    h.stack.host.setActive(null)
  })
})
