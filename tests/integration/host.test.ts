// Host no celular (fase 4a) contra o servidor de sync REAL local, com o provedor LLM FALSO: o
// "celular" (AccountService + SyncEngine + host reais — os mesmos módulos do aparelho) cria um chat,
// roda turnos dentro de janelas (host.begin/host.end, chat_bases + host_epochs) com web_search e
// aprovação; um "desktop" (dispositivo can_host no WebSocket real) vê os registros, recebe a recusa
// do controle remoto, não consegue nada com chats de tools locais e assume o chat do celular no meio
// de um turno (§8.8) continuando de onde parou. Segundo plano → turno interrompido e janela fechada.
import { afterAll, describe, expect, it } from 'vitest'
import { AccountService } from '../../src/account/service'
import { MemoryKeyValueStore, MemorySecretStore } from '../../src/account/storage'
import { AttachmentStore, type AttachmentFs } from '../../src/data/attachments'
import { bindAccount } from '../../src/data/binding'
import { SyncEngine } from '../../src/data/engine'
import { LocalStore } from '../../src/data/store'
import { bindRemote } from '../../src/remote/binding'
import { RemoteController } from '../../src/remote/controller'
import { openResult, sealCommand, type Envelope } from '../../src/remote/crypto'
import { bindHost } from '../../src/host/binding'
import { REMOTE_REFUSAL } from '../../src/host/host'
import { LOCAL_TOOLS_REFUSAL } from '../../src/host/policy'
import { createHostStack } from '../../src/host/stack'
import { setSearchBases } from '../../src/agent/tools/web'
import { DEFAULT_CHAT_CONFIG } from '../../src/vendor/shared/defaults'
import { RealtimeClient } from '../../src/vendor/desktop/sync/ws'
import { hex, openRecord, sha256 } from '../../src/crypto'
import type { Change } from '../../src/data/types'
import { openNodeSql } from '../nodeSql'
import { startFakeLlm } from '../fakes/fakeLlm'
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

const PASSWORD = 'senha de integração do host no celular'
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

/** Registros do chat no servidor, decifrados como o desktop faria. */
async function serverChat(d: Desktop, chatId: string) {
  const out: {
    type: string
    id: string
    rev: number
    device: string
    plain: Record<string, unknown>
  }[] = []
  let after = 0
  for (;;) {
    const r = await rest(
      'GET',
      `/api/v1/records?scope=${chatId}&after=${after}&limit=500&payload=1`,
      undefined,
      d.token
    )
    for (const c of (r.records ?? []) as Change[]) {
      if (c.deleted || !c.env) continue
      out.push({
        type: c.type,
        id: c.id,
        rev: c.rev,
        device: c.device_id,
        plain: await openRecord(d.sk.record, d.userId, c, c.env)
      })
    }
    if (!r.has_more || !r.records?.length) break
    after = r.next ?? r.records[r.records.length - 1].seq
  }
  return out
}

describe.skipIf(!enabled)('host no celular contra o servidor real (provedor falso)', () => {
  it('turnos com janelas e revisões, controle remoto recusado, tools locais recusadas, troca de host no meio do turno, segundo plano', async () => {
    const llm = await startFakeLlm(0, { delay: 15 })
    cleanup.push(() => llm.close())
    setSearchBases({ ddg: `${llm.url}/ddg` })
    const email = randomEmail('host')
    const web = await signupWeb(email)
    const { dek } = await setupKeysWithDek(web, PASSWORD)
    const desk = await loginDesktop(email, web.userId, dek)
    // provedor sincronizado (como o desktop grava), apontando para o LLM falso
    await push(desk, [
      await item(desk, 'provider', 'prov-falso', null, {
        sv: 1,
        name: 'LLM falso',
        kind: 'openai',
        baseUrl: `${llm.url}/v1`,
        apiKey: 'sk-falsa-nao-e-paga',
        headers: {},
        createdAt: Date.now()
      })
    ])

    // ---- desktop no WebSocket (para comandos e troca de host) ----
    const deskEvents: Record<string, unknown>[] = []
    const deskWs = new RealtimeClient({
      url: () => URL_.replace(/^http/, 'ws') + '/ws',
      hello: async () => ({
        access_token: desk.token,
        cursor: 0,
        state_cursor: 0,
        active_windows: [],
        subscriptions: []
      }),
      onWelcome: () => undefined,
      onEvent: (f) => deskEvents.push(f),
      onState: () => undefined,
      onUnauthorized: async () => false,
      onFatal: () => undefined,
      timing: { backoffBaseMs: 100, backoffMaxMs: 500 }
    })
    deskWs.start()
    cleanup.push(() => deskWs.stop())

    // ---- celular ----
    const account = new AccountService({
      secrets: new MemorySecretStore(),
      kv: new MemoryKeyValueStore(),
      device: { defaultName: 'Pixel (host)', platform: 'android', appVersion: '0.1.0' },
      envUrl: URL_,
      wsTiming: { backoffBaseMs: 100, backoffMaxMs: 1000 }
    })
    cleanup.push(() => account.setForeground(false))
    await account.init()
    const n0 = logMark()
    await account.requestCode(email)
    await account.verifyCode(await codeFor(email, n0), 'Pixel (host)')
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
    const stack = createHostStack({
      store,
      engine,
      http: {
        get: (path) => account.http.get(path),
        post: (path, json) => account.http.post(path, json),
        putBlob: async (blobId, ct, sha) => {
          await account.http.req('PUT', `/api/v1/blobs/${encodeURIComponent(blobId)}`, {
            body: ct,
            headers: { 'Content-Type': 'application/octet-stream', 'X-Content-SHA256': sha }
          })
        }
      },
      keys,
      openMemorySql: () => openNodeSql(),
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
      }
    })
    const notices: string[] = []
    const { host, runner, repo } = stack
    bindHost(account, host, runner)
    await account.unlock(PASSWORD, { remember: true })
    await waitFor(
      () => engine.getStatus().phase === 'idle' && !engine.getStatus().initial,
      'pull',
      60_000
    )
    await waitFor(() => stack.providers().length === 1, 'provedor sincronizado')
    await waitFor(() => remote.isConnected, 'websocket do celular')
    const phoneId = account.getState().device!.id

    const newChat = (tools: string[] = ['web_search', 'browse_url', 'ask_user'], extra = {}) =>
      repo.createChat({
        config: {
          ...DEFAULT_CHAT_CONFIG(''),
          providerId: 'prov-falso',
          model: 'fake/agent',
          enabledTools: tools as never,
          approvalModes: { search: 'lists' },
          ...extra
        }
      })
    const idle = (sid: string) => waitFor(() => !runner.isRunning(sid), 'turno terminar', 30_000)
    const serverState = async (chatId: string) =>
      (
        (await rest('GET', '/api/v1/chat-states?since=0', undefined, desk.token))
          .chat_states as Record<string, unknown>[]
      ).find((s) => s.chat_id === chatId) as
        | {
            host: { device_id: string; status: string } | null
            window: unknown
            epoch: number
            head: number
          }
        | undefined

    // ---- 1. chat novo no celular: turno com janela, registros no servidor ----
    const { chat: c1, session: s1 } = newChat()
    await stack.writer.whenIdle(c1.id)
    await host.local(c1.id, 'send', { sessionId: s1.id, text: 'olá do celular' })
    await idle(s1.id)
    await waitFor(
      async () => {
        const st = await serverState(c1.id)
        return st?.host?.device_id === phoneId && !st.window && !stack.writer.pending(c1.id)
      },
      'janela fechada e outbox vazia',
      20_000
    )
    let recs = await serverChat(desk, c1.id)
    const msgs = recs
      .filter((r) => r.type === 'message')
      .sort((a, b) => Number(a.plain.seq) - Number(b.plain.seq))
    expect(msgs.map((m) => (m.plain.message as { content: string }).content)).toEqual([
      'olá do celular',
      'ok: olá do celular'
    ])
    expect(msgs.every((m) => m.device === phoneId)).toBe(true)
    expect(msgs[1].plain.parentId).toBe(msgs[0].id)
    expect((msgs[1].plain.meta as { usage?: { cost?: number } }).usage?.cost).toBe(0.00042)
    const sess = recs.find((r) => r.type === 'session')!
    expect(sess.plain).toMatchObject({ status: 'idle', branchSel: {}, depth: 0 })
    const chatRec = recs.find((r) => r.type === 'chat')!
    expect(chatRec.plain.title).toBe('olá do celular')
    expect((chatRec.plain.config as { enabledTools: string[] }).enabledTools).toEqual([
      'web_search',
      'browse_url',
      'ask_user'
    ])

    // ---- 2. web_search com aprovação no celular ----
    await host.local(c1.id, 'send', { sessionId: s1.id, text: '/search cachorros' })
    await waitFor(() => runner.approvals.list().length === 1, 'aprovação')
    await host.local(c1.id, 'approval', {
      requestId: runner.approvals.list()[0].id,
      decision: 'allow'
    })
    await idle(s1.id)
    await waitFor(() => !stack.writer.pending(c1.id), 'outbox vazia')
    recs = await serverChat(desk, c1.id)
    const tool = recs.find(
      (r) => r.type === 'message' && (r.plain.message as { role: string }).role === 'tool'
    )!
    expect(String((tool.plain.message as { content: string }).content)).toContain(
      'Resultado um para cachorros'
    )
    expect(tool.plain.meta).toMatchObject({ toolStatus: 'ok', approval: { item: 'search' } })

    // ---- 3. controle remoto recusado (o desktop manda um send) ----
    const cmdId = crypto.randomUUID()
    const env = await sealCommand(desk.sk.stream, desk.userId, c1.id, cmdId, {
      kind: 'send',
      sessionId: s1.id,
      text: 'do PC',
      attachments: [],
      skills: [],
      createdAt: Date.now()
    })
    await deskWs.request('remote.send', { chat_id: c1.id, cmd_id: cmdId, kind: 'send', env })
    const res = await waitFor(
      () => deskEvents.find((e) => e.t === 'remote.result' && e.cmd_id === cmdId),
      'remote.result'
    )
    const r = await openResult(desk.sk.stream, desk.userId, c1.id, cmdId, res!.env as Envelope)
    expect(r).toMatchObject({ status: 'rejected', error: REMOTE_REFUSAL })
    expect(runner.isRunning(s1.id)).toBe(false)

    // ---- 4. chat com ferramentas locais: o celular recusa (nada no servidor) ----
    const { chat: cLocal, session: sLocal } = newChat(['shell', 'web_search'])
    await expect(
      host.local(cLocal.id, 'send', { sessionId: sLocal.id, text: 'rode ls' })
    ).rejects.toThrow(LOCAL_TOOLS_REFUSAL)
    await expect(host.takeover(cLocal.id, { mode: 'next_turn' })).rejects.toThrow(
      LOCAL_TOOLS_REFUSAL
    )
    expect((await serverState(cLocal.id))?.host ?? null).toBeNull()

    // ---- 5. o desktop assume o chat do celular no meio de um turno ----
    await host.local(c1.id, 'send', { sessionId: s1.id, text: '/slow' })
    await waitFor(() => runner.isRunning(s1.id), 'rodando')
    await sleep(500)
    const take = await deskWs.request('host.takeover', {
      chat_id: c1.id,
      mode: 'next_turn',
      confirm_pinned: false
    })
    expect(['pending', 'granted']).toContain(take.status)
    const granted = await waitFor(
      async () =>
        deskEvents.find((e) => e.t === 'host.granted' && e.chat_id === c1.id) ??
        ((await serverState(c1.id))?.host?.device_id === desk.deviceId
          ? { epoch: (await serverState(c1.id))!.epoch }
          : null),
      'host.granted no desktop',
      30_000
    )
    expect(runner.isRunning(s1.id)).toBe(false)
    const st5 = await serverState(c1.id)
    expect(st5?.host?.device_id).toBe(desk.deviceId)
    recs = await serverChat(desk, c1.id)
    const last = recs
      .filter((x) => x.type === 'message')
      .sort((a, b) => Number(b.plain.seq) - Number(a.plain.seq))[0]
    expect((last.plain.meta as { interrupted?: boolean }).interrupted).toBe(true)
    expect(recs.find((x) => x.type === 'session')!.plain.status).toBe('interrupted')
    // o celular agora é controle remoto desse chat
    await waitFor(
      () => remote.mode(c1.id) === 'remote' || remote.mode(c1.id) === 'host-offline',
      'modo remoto no celular',
      20_000
    )
    // e o desktop continua de onde parou: janela + mensagem nova com a base do head
    const begin = await deskWs.request('host.begin', {
      chat_id: c1.id,
      epoch: Number((granted as { epoch?: number }).epoch ?? st5!.epoch),
      purpose: 'run'
    })
    const sid = s1.id
    const ack = await rest(
      'POST',
      '/api/v1/sync/push',
      {
        push_id: crypto.randomUUID(),
        items: [
          await item(desk, 'message', 'msg-do-pc', c1.id, {
            sv: 1,
            sessionId: sid,
            seq: 999,
            parentId: last.id,
            message: { role: 'user', content: 'continuando no PC' },
            meta: {},
            createdAt: Date.now()
          })
        ],
        chat_bases: { [c1.id]: Number(begin.head) },
        host_epochs: { [c1.id]: Number(begin.epoch) }
      },
      desk.token
    )
    expect(ack.results[0].type).toBe('message')
    await deskWs.request('host.end', { chat_id: c1.id, epoch: Number(begin.epoch) })
    await waitFor(() => !!store.message('msg-do-pc'), 'mensagem do PC no celular', 20_000)
    await expect(host.local(c1.id, 'send', { sessionId: s1.id, text: 'x' })).rejects.toThrow(
      /executado em/
    )

    // ---- 6. segundo plano no meio do turno ----
    const { chat: c2, session: s2 } = newChat()
    await stack.writer.whenIdle(c2.id)
    await host.local(c2.id, 'send', { sessionId: s2.id, text: '/slow' })
    await waitFor(() => runner.isRunning(s2.id), 'rodando')
    await sleep(400)
    account.setForeground(false)
    await waitFor(
      async () => !runner.isRunning(s2.id) && !(await serverState(c2.id))?.window,
      'janela fechada no segundo plano',
      20_000
    )
    recs = await serverChat(desk, c2.id)
    expect(recs.find((x) => x.type === 'session')!.plain.status).toBe('interrupted')
    expect(
      recs.some(
        (x) => x.type === 'message' && (x.plain.meta as { interrupted?: boolean }).interrupted
      )
    ).toBe(true)
    account.setForeground(true)
    host.onForeground()
    await waitFor(() => remote.isConnected, 'reconectado', 20_000)
    await host.local(c2.id, 'send', { sessionId: s2.id, text: 'de volta' })
    await idle(s2.id)
    expect(repo.path(s2.id).pop()!.message.content).toBe('ok: de volta')
    void notices
  })
})
