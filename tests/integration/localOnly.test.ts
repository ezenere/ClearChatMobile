// Chat "Só neste aparelho" (protocolo 1.8.0, §23.2, §23.8, §23.10) contra o servidor de sync REAL
// local, com o provedor LLM FALSO: o celular cria um chat só local e roda um turno — nada chega ao
// servidor (nem registro, nem chat_states, nem host.begin); um chat online ao lado sincroniza como
// sempre. "Salvar online" depois sobe tudo em replay (chat_bases = 0): o celular vira o host e o
// "desktop" decifra o histórico inteiro.
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

describe.skipIf(!enabled)('chat só neste aparelho contra o servidor real (§23.10)', () => {
  it('nada vai ao servidor; Salvar online sobe tudo e o celular vira o host', async () => {
    const llm = await startFakeLlm(0, { delay: 15 })
    cleanup.push(() => llm.close())
    setSearchBases({ ddg: `${llm.url}/ddg` })
    const email = randomEmail('localonly')
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
      device: { defaultName: 'Pixel (local)', platform: 'android', appVersion: '0.1.0' },
      envUrl: URL_,
      wsTiming: { backoffBaseMs: 100, backoffMaxMs: 1000 }
    })
    cleanup.push(() => account.setForeground(false))
    await account.init()
    const n0 = logMark()
    await account.requestCode(email)
    await account.verifyCode(await codeFor(email, n0), 'Pixel (local)')
    const store = new LocalStore(openNodeSql())
    const begins: string[] = []
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
      ws: {
        request: (t, f, ms) => {
          if (t === 'host.begin') begins.push(String(f?.chat_id))
          return account.wsRequest(t, f, ms)
        }
      },
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

    const newChat = (storage: 'online' | 'live') =>
      repo.createChat({
        config: {
          ...DEFAULT_CHAT_CONFIG(''),
          providerId: 'prov-falso',
          model: 'fake/agent',
          enabledTools: [] as never
        },
        storage
      })
    const idle = (sid: string) => waitFor(() => !runner.isRunning(sid), 'turno terminar', 30_000)
    const states = async () =>
      (await rest('GET', '/api/v1/chat-states?since=0', undefined, desk.token)).chat_states as {
        chat_id: string
        host: { device_id: string } | null
      }[]

    // ---- só neste aparelho: turno sem janela, nada no servidor ----
    const { chat: local, session: ls } = newChat('live')
    expect(store.isLocalOnly(local.id)).toBe(true)
    await host.local(local.id, 'send', { sessionId: ls.id, text: 'segredo do celular' })
    await idle(ls.id)
    // ---- online ao lado: sincroniza como sempre ----
    const { chat: online, session: os } = newChat('online')
    await host.local(online.id, 'send', { sessionId: os.id, text: 'pode ir' })
    await idle(os.id)
    await waitFor(
      async () => (await serverChat(desk, online.id)).some((r) => r.type === 'message'),
      'chat online no servidor',
      20_000
    )
    expect(await serverChat(desk, local.id)).toEqual([])
    expect((await states()).some((s) => s.chat_id === local.id)).toBe(false)
    const one = await rest(
      'GET',
      '/api/v1/records?after=0&limit=1000&payload=0',
      undefined,
      desk.token
    )
    expect(
      ((one.records ?? []) as Change[]).some((c) => c.id === local.id || c.scope === local.id)
    ).toBe(false)
    expect(begins).not.toContain(local.id)
    expect(begins).toContain(online.id)

    // ---- Salvar online ----
    expect(stack.saveOnline(local.id)).toBeGreaterThan(2)
    await waitFor(
      async () =>
        !stack.writer.pending(local.id) &&
        (await serverChat(desk, local.id)).filter((r) => r.type === 'message').length === 2,
      'histórico subir',
      20_000
    )
    const recs = await serverChat(desk, local.id)
    const texts = recs
      .filter((r) => r.type === 'message')
      .sort((a, b) => Number(a.plain.seq) - Number(b.plain.seq))
      .map((m) => (m.plain.message as { content: string }).content)
    expect(texts).toEqual(['segredo do celular', 'ok: segredo do celular'])
    await waitFor(
      async () => (await states()).find((s) => s.chat_id === local.id)?.host?.device_id === phoneId,
      'celular host do chat salvo',
      10_000
    )
    expect(store.isLocalOnly(local.id)).toBe(false)
  }, 90_000)
})
