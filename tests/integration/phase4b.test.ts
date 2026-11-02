// Fase 4b contra o servidor de sync REAL local, com o provedor LLM FALSO: o "celular" (os mesmos
// módulos do aparelho, no Node) hospeda chats com memória, subagentes e send_to_chat; "desktops"
// (dispositivos can_host no WebSocket real) conferem o que chega: memória escrita no celular
// visível (e editável) no PC, sessões de subagente sincronizadas, send_to_chat entregue a um chat
// executado no PC (comando `send` ao host, resposta lida dos registros) e a divergência criada pelo
// celular rodando sem servidor enquanto o PC assumiu e escreveu — resolvida mantendo a versão do
// celular num chat e a online no outro, com a versão perdedora apagada de verdade.
import { afterAll, describe, expect, it } from 'vitest'
import { AccountService } from '../../src/account/service'
import { MemoryKeyValueStore, MemorySecretStore } from '../../src/account/storage'
import { AttachmentStore, type AttachmentFs } from '../../src/data/attachments'
import { bindAccount } from '../../src/data/binding'
import { SyncEngine } from '../../src/data/engine'
import { LocalStore } from '../../src/data/store'
import { bindRemote } from '../../src/remote/binding'
import { RemoteController } from '../../src/remote/controller'
import { bindHost } from '../../src/host/binding'
import { createHostStack } from '../../src/host/stack'
import { setSearchBases } from '../../src/agent/tools/web'
import { DEFAULT_CHAT_CONFIG } from '../../src/vendor/shared/defaults'
import { MEMORY_CATEGORIES } from '../../src/vendor/shared/memory'
import { RealtimeClient } from '../../src/vendor/desktop/sync/ws'
import { SyncNetworkError } from '../../src/vendor/desktop/sync/http'
import { hex, openRecord, sealRecord, sha256 } from '../../src/crypto'
import type { Change } from '../../src/data/types'
import { openNodeSql } from '../nodeSql'
import { startFakeLlm } from '../fakes/fakeLlm'
import { FakeHost } from './fakeHost'
import {
  codeFor,
  enabled,
  logMark,
  randomEmail,
  rest,
  signupWeb,
  sleep,
  URL_,
  waitFor
} from './realServer'
import { item, loginDesktop, push, setupKeysWithDek, type Desktop } from './seed'

const PASSWORD = 'senha de integração da fase 4b'
const COL = 'col-perfil-4b'
const cleanup: (() => void | Promise<void>)[] = []
afterAll(async () => {
  for (const f of cleanup.reverse()) await f()
})

class MemoryFs implements AttachmentFs {
  files = new Map<string, Uint8Array>()
  exists = (f: string) => this.files.has(f)
  uri = (f: string) => `mem://${f}`
  write = (f: string, d: Uint8Array) => void this.files.set(f, d)
  clear = () => this.files.clear()
}

interface Rec {
  type: string
  id: string
  rev: number
  seq: number
  device: string
  deleted: boolean
  plain: Record<string, unknown> | null
}

/** Registros de um escopo (chat ou coleção) como o desktop os vê. */
async function serverScope(d: Desktop, scope: string, withDeleted = false): Promise<Rec[]> {
  const out: Rec[] = []
  let after = 0
  for (;;) {
    const r = await rest(
      'GET',
      `/api/v1/records?scope=${scope}&after=${after}&limit=500&payload=1`,
      undefined,
      d.token
    )
    for (const c of (r.records ?? []) as Change[]) {
      if (c.deleted && !withDeleted) continue
      out.push({
        type: c.type,
        id: c.id,
        rev: c.rev,
        seq: c.seq,
        device: c.device_id,
        deleted: !!c.deleted,
        plain: c.env ? await openRecord(d.sk.record, d.userId, c, c.env) : null
      })
    }
    if (!r.has_more || !r.records?.length) break
    after = r.next ?? r.records[r.records.length - 1].seq
  }
  return out
}

async function fetchRec(d: Desktop, type: string, id: string): Promise<Change | null> {
  const r = await rest('POST', '/api/v1/records/fetch', { items: [{ type, id }] }, d.token)
  return (r.records?.[0] as Change | undefined) ?? null
}

/** Regrava um registro LWW como o desktop (base = rev atual no servidor). */
async function putAs(
  d: Desktop,
  type: string,
  id: string,
  scope: string | null,
  plain: Record<string, unknown>
): Promise<void> {
  const base = (await fetchRec(d, type, id))?.rev ?? 0
  const env = await sealRecord(d.sk.record, d.userId, { type, id, scope, rev: base + 1 }, plain)
  await push(d, [
    { type, id, scope, base_rev: base, rev: base + 1, deleted: false, env, blobs: [] }
  ])
}

function deskWs(d: Desktop, events: Record<string, unknown>[]): RealtimeClient {
  const ws = new RealtimeClient({
    url: () => URL_.replace(/^http/, 'ws') + '/ws',
    hello: async () => ({
      access_token: d.token,
      cursor: 0,
      state_cursor: 0,
      active_windows: [],
      subscriptions: []
    }),
    onWelcome: () => undefined,
    onEvent: (f) => events.push(f),
    onState: () => undefined,
    onUnauthorized: async () => false,
    onFatal: () => undefined,
    timing: { backoffBaseMs: 100, backoffMaxMs: 500 }
  })
  ws.start()
  cleanup.push(() => ws.stop())
  return ws
}

const msgText = (r: Rec): string =>
  String(((r.plain?.message ?? {}) as { content?: unknown }).content ?? '')

describe.skipIf(!enabled)('fase 4b contra o servidor real (provedor falso)', () => {
  it('memória, subagentes, send_to_chat entre dispositivos e divergência resolvida nos dois sentidos', async () => {
    const llm = await startFakeLlm(0, { delay: 10 })
    cleanup.push(() => llm.close())
    setSearchBases({ ddg: `${llm.url}/ddg` })
    const email = randomEmail('fase4b')
    const web = await signupWeb(email)
    const { dek } = await setupKeysWithDek(web, PASSWORD)
    const desk = await loginDesktop(email, web.userId, dek)
    const desk2 = await loginDesktop(email, web.userId, dek)
    await push(desk, [
      await item(desk, 'provider', 'prov-falso', null, {
        sv: 1,
        name: 'LLM falso',
        kind: 'openai',
        baseUrl: `${llm.url}/v1`,
        apiKey: 'sk-falsa-nao-e-paga',
        headers: {},
        createdAt: Date.now()
      }),
      await item(desk, 'memory_collection', COL, null, {
        sv: 1,
        category: 'profile',
        name: 'Padrão',
        description: 'quem é o usuário',
        icon: null,
        createdAt: 1,
        updatedAt: 1
      })
    ])
    // chat executado no PC (host falso online) — destino do send_to_chat entre dispositivos
    const PC_CHAT = `pc-${crypto.randomUUID().slice(0, 8)}`
    const pcHost = new FakeHost(desk, PC_CHAT)
    await pcHost.seed()
    pcHost.start()
    cleanup.push(() => pcHost.stop())

    // ---- celular (rede controlável: REST do host cai junto com o WebSocket) ----
    const account = new AccountService({
      secrets: new MemorySecretStore(),
      kv: new MemoryKeyValueStore(),
      device: { defaultName: 'Pixel 4b', platform: 'android', appVersion: '0.1.0' },
      envUrl: URL_,
      wsTiming: { backoffBaseMs: 100, backoffMaxMs: 1000 }
    })
    cleanup.push(() => account.setForeground(false))
    await account.init()
    const n0 = logMark()
    await account.requestCode(email)
    await account.verifyCode(await codeFor(email, n0), 'Pixel 4b')
    const store = new LocalStore(openNodeSql())
    const keys = () => {
      const sk = account.subkeys
      const userId = account.accountUserId
      return sk && userId ? { userId, sk } : null
    }
    const engine = new SyncEngine({ store, http: account.http, keys })
    const fs = new MemoryFs()
    const attachments = new AttachmentStore({ fs, keys, fetchBlob: (id) => engine.fetchBlob(id) })
    bindAccount(account, engine, attachments)
    const remote = new RemoteController({
      ws: { request: (t, f, ms) => account.wsRequest(t, f, ms) },
      keys,
      deviceId: () => account.getState().device?.id ?? null,
      chatState: (id) => store.chatState(id),
      post: (path, json) => account.http.post(path, json),
      assistantIds: (id) => store.assistantIds(id),
      loadMessage: (id) => store.message(id)
    })
    bindRemote(account, engine, remote)
    const net = { down: false }
    const off = (): never => {
      throw new SyncNetworkError('sem rede (teste)')
    }
    const stack = createHostStack({
      store,
      engine,
      http: {
        get: (path) => (net.down ? Promise.reject(off()) : account.http.get(path)),
        post: (path, json) => (net.down ? Promise.reject(off()) : account.http.post(path, json)),
        putBlob: async (blobId, ct, sha) => {
          if (net.down) off()
          await account.http.req('PUT', `/api/v1/blobs/${encodeURIComponent(blobId)}`, {
            body: ct,
            headers: { 'Content-Type': 'application/octet-stream', 'X-Content-SHA256': sha }
          })
        }
      },
      keys,
      openMemorySql: () => openNodeSql(),
      remoteSend: (chatId, sessionId, text) => remote.send(chatId, sessionId, text, [], []),
      ws: { request: (t, f, ms) => account.wsRequest(t, f, ms) },
      deviceId: () => account.getState().device?.id ?? null,
      deviceName: () => account.getState().device?.name ?? 'Celular',
      files: {
        ensure: async (f) => void (await attachments.ensure(f)),
        readBase64: async (f) => Buffer.from(fs.files.get(f) ?? []).toString('base64'),
        readText: async (f) => new TextDecoder().decode(fs.files.get(f) ?? new Uint8Array()),
        size: (f) => fs.files.get(f)?.length ?? null,
        save: async (data, ext) => {
          const f = `${hex(await sha256(data))}.${ext}`
          attachments.put(f, data)
          return f
        },
        bytes: async (f) => fs.files.get(f) ?? null
      },
      interChatPollMs: 200
    })
    const { host, runner, repo, memory, divergence } = stack
    bindHost(account, host, runner)
    await account.unlock(PASSWORD, { remember: true })
    await waitFor(
      () => engine.getStatus().phase === 'idle' && !engine.getStatus().initial,
      'pull',
      60_000
    )
    await waitFor(() => stack.providers().length === 1, 'provedor sincronizado')
    await waitFor(() => remote.isConnected && host.isConnected, 'websocket do celular')
    await waitFor(() => store.chatState(PC_CHAT)?.host?.status === 'online', 'host do PC online')
    const phoneId = account.getState().device!.id

    const newChat = (extra: Record<string, unknown> = {}) =>
      repo.createChat({
        config: {
          ...DEFAULT_CHAT_CONFIG(''),
          providerId: 'prov-falso',
          model: 'fake/agent',
          enabledTools: ['delegate_task', 'send_to_chat', 'list_chats'] as never,
          ...extra
        }
      })
    const idle = (sid: string) => waitFor(() => !runner.isRunning(sid), 'turno terminar', 40_000)
    const synced = (chatId: string) =>
      waitFor(() => !stack.writer.pending(chatId), `outbox de ${chatId}`, 30_000)
    const memoryCfg = {
      enabled: true,
      collections: [COL],
      writeTo: { profile: COL },
      categories: [...MEMORY_CATEGORIES],
      helpPrompt: { enabled: false, text: null },
      extraction: { auto: false, prompt: null, providerId: null, model: null },
      subagents: false
    }

    // ---- 1. memória escrita no celular → o PC vê; o PC edita → o celular vê ----
    const { chat: cm, session: sm } = newChat({ memory: memoryCfg })
    await host.local(cm.id, 'send', {
      sessionId: sm.id,
      text: '/remember Cidade: mora em Curitiba'
    })
    await idle(sm.id)
    await waitFor(() => !memory.writer.pending(), 'outbox LWW da memória', 20_000)
    const mems = await serverScope(desk, COL)
    const mem = mems.find((r) => r.type === 'memory')!
    expect(mem.device).toBe(phoneId)
    expect(mem.plain).toMatchObject({
      collectionId: COL,
      category: 'profile',
      title: 'Cidade',
      facts: ['mora em Curitiba'],
      updatedBy: 'model',
      updatedByChatId: cm.id
    })
    await putAs(desk, 'memory', mem.id, COL, {
      ...mem.plain!,
      facts: ['mora em Curitiba', 'tem um gato chamado Pixel'],
      updatedBy: 'user',
      updatedAt: Date.now()
    })
    await waitFor(
      () =>
        memory.service.store
          .search('gato', { collectionIds: [COL] })
          .some((h) => h.memory.id === mem.id),
      'edição do PC no índice do celular',
      20_000
    )
    // sessão nova: o índice congelado já traz a memória
    const { chat: cm2, session: sm2 } = newChat({ memory: memoryCfg })
    await host.local(cm2.id, 'send', { sessionId: sm2.id, text: '/whoami' })
    await idle(sm2.id)
    expect(repo.path(sm2.id).at(-1)!.message.content).toBe('Pelo índice da memória: Cidade')

    // ---- 2. subagente em segundo plano: sessão sincronizada e o pai acordado pelo callback ----
    const { chat: cs, session: ss } = newChat()
    await host.local(cs.id, 'send', { sessionId: ss.id, text: '/delegate-bg /sleep 600 feito' })
    await waitFor(
      () => repo.path(ss.id).some((m) => m.meta.kind === 'subagent-callback'),
      'callback do subagente',
      30_000
    )
    await idle(ss.id)
    await synced(cs.id)
    const csRecs = await serverScope(desk, cs.id)
    const subRec = csRecs.find((r) => r.type === 'session' && r.plain?.depth === 1)!
    expect(subRec.device).toBe(phoneId)
    expect(subRec.plain).toMatchObject({ parentSessionId: ss.id, status: 'done' })
    expect(
      csRecs.some(
        (r) =>
          r.type === 'message' && r.plain?.sessionId === subRec.id && msgText(r) === 'ok: feito'
      )
    ).toBe(true)

    // ---- 3. send_to_chat para o chat executado no PC: comando `send`, resposta dos registros ----
    const { chat: ci, session: si } = newChat()
    await host.local(ci.id, 'send', {
      sessionId: si.id,
      text: `/ask-chat ${PC_CHAT} rode os testes`
    })
    await idle(si.id)
    const sendCmd = pcHost.received.find((c) => c.kind === 'send')!
    expect(String(sendCmd.payload.text)).toMatch(/^\[Mensagem do chat .*\]\nrode os testes$/)
    const tool = repo.path(si.id).find((m) => m.message.role === 'tool')!
    expect(tool.meta.targetChatId).toBe(PC_CHAT)
    expect(String(tool.message.content)).toMatch(/^Resposta do chat .*:\n\nok: \[Mensagem do chat/)

    // ---- 4. divergência: o celular roda sem servidor, o PC assume e escreve ----
    const dws = deskWs(desk2, [])
    const { chat: dA, session: sA } = newChat({ enabledTools: [] })
    const { chat: dB, session: sB } = newChat({ enabledTools: [] })
    for (const [c, s] of [
      [dA, sA],
      [dB, sB]
    ] as const) {
      await host.local(c.id, 'send', { sessionId: s.id, text: 'comum' })
      await idle(s.id)
      await synced(c.id)
    }
    await waitFor(() => !host.windowOpen(dA.id) && !host.windowOpen(dB.id), 'janelas fechadas')
    // turnos começam online e terminam com o servidor fora
    await host.local(dA.id, 'send', { sessionId: sA.id, text: '/sleep 1500 só no celular A' })
    await host.local(dB.id, 'send', { sessionId: sB.id, text: '/sleep 1500 só no celular B' })
    await sleep(300)
    const hook = account.beforeBackground
    account.beforeBackground = null
    net.down = true
    account.setForeground(false)
    await idle(sA.id)
    await idle(sB.id)
    expect(stack.writer.pending(dA.id)).toBe(true)
    // o PC assume os dois (host do celular em tolerância → concedido quando expira) e escreve
    for (const [c, s, tag] of [
      [dA, sA, 'A'],
      [dB, sB, 'B']
    ] as const) {
      await dws.request('host.takeover', { chat_id: c.id, mode: 'force', confirm_pinned: false })
      const st = await waitFor(
        async () =>
          (
            (await rest('GET', '/api/v1/chat-states?since=0', undefined, desk2.token))
              .chat_states as {
              chat_id: string
              host: { device_id: string } | null
              epoch: number
              head: number
            }[]
          ).find((x) => x.chat_id === c.id && x.host?.device_id === desk2.deviceId)!,
        `PC assumir ${tag}`,
        40_000
      )
      const ack = await dws.request('host.begin', {
        chat_id: c.id,
        epoch: st.epoch,
        purpose: 'run'
      })
      const online = await serverScope(desk2, c.id)
      const last = online
        .filter((r) => r.type === 'message')
        .sort((a, b) => Number(b.plain?.seq) - Number(a.plain?.seq))[0]
      const id = `pc-msg-${tag}`
      const env = await sealRecord(
        desk2.sk.record,
        desk2.userId,
        { type: 'message', id, scope: c.id, rev: 1 },
        {
          sv: 1,
          sessionId: s.id,
          seq: Number(last.plain?.seq) + 1,
          message: { role: 'user', content: `só no PC ${tag}` },
          meta: {},
          createdAt: Date.now(),
          parentId: last.id
        }
      )
      await rest(
        'POST',
        '/api/v1/sync/push',
        {
          push_id: crypto.randomUUID(),
          items: [
            {
              type: 'message',
              id,
              scope: c.id,
              base_rev: 0,
              rev: 1,
              deleted: false,
              env,
              blobs: []
            }
          ],
          chat_bases: { [c.id]: Number(ack.head) },
          host_epochs: { [c.id]: Number(ack.epoch) }
        },
        desk2.token
      )
      await dws.request('host.end', { chat_id: c.id, epoch: Number(ack.epoch) })
    }
    // o celular volta: o replay da outbox encontra a história do PC → divergência
    net.down = false
    account.beforeBackground = hook
    account.setForeground(true)
    for (const c of [dA, dB])
      await waitFor(
        () => divergence.isSelf(c.id),
        `divergência de ${c.id} com a versão do celular`,
        40_000
      )
    // §9.2: o conteúdo do PC não entrou na versão local
    expect(store.message('pc-msg-A')).toBeNull()
    const det = await divergence.details(dA.id)
    expect(
      Object.values(det.online.messages)
        .flat()
        .map((m) => m.message.content)
    ).toContain('só no PC A')
    expect(
      Object.values(det.local!.messages)
        .flat()
        .map((m) => m.message.content)
    ).toContain('ok: só no celular A')

    // A: manter a versão do celular → o PC recebe a do celular; a dele some
    await divergence.resolve(dA.id, 'local')
    const aRecs = await serverScope(desk, dA.id)
    expect(aRecs.some((r) => r.id === 'pc-msg-A')).toBe(false)
    expect((await fetchRec(desk, 'message', 'pc-msg-A'))?.deleted).toBe(true)
    expect(aRecs.some((r) => msgText(r) === 'ok: só no celular A')).toBe(true)
    await waitFor(async () => {
      const st = (
        (await rest('GET', '/api/v1/chat-states?since=0', undefined, desk.token)).chat_states as {
          chat_id: string
          diverged: unknown
        }[]
      ).find((x) => x.chat_id === dA.id)
      return st && !st.diverged
    }, 'divergência de A resolvida no servidor')

    // B: manter a online → a versão do celular é apagada aqui e nada dela fica no servidor
    const localOnly = repo.path(sB.id).find((m) => m.message.content === 'ok: só no celular B')!
    await divergence.resolve(dB.id, 'online')
    expect(store.getPlain('message', localOnly.id)).toBeNull()
    await waitFor(() => !!store.message('pc-msg-B'), 'versão online de B no celular', 20_000)
    const bRecs = await serverScope(desk, dB.id)
    expect(bRecs.some((r) => msgText(r) === 'ok: só no celular B')).toBe(false)
    expect(bRecs.some((r) => r.id === 'pc-msg-B')).toBe(true)
    expect(await fetchRec(desk, 'message', localOnly.id)).toBeNull()
    expect(store.outbox(dB.id).filter((r) => r.type !== 'chat')).toEqual([])
  }, 300_000)
})
