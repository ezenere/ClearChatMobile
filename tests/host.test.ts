// Host no celular: janelas (host.begin/host.end), revisões com chat_bases/host_epochs (§8.4),
// chats com ferramentas locais hospedados sem elas (§4.3.6, §8.9), comandos remotos recusados na hora (o celular não
// é controlado remotamente), troca de host pedida por outro dispositivo no meio do turno, segundo
// plano e o espelho local da tela.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
