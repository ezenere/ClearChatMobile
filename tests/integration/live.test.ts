// Chats só ao vivo (protocolo 1.8.0, §23) contra o servidor de sync REAL local: um "desktop" falso
// (DevLiveHost sobre um RealtimeClient com `caps: ["live_chats"]`) anuncia os chats; o "celular"
// (AccountService + RemoteController + LiveService reais, com o cache SQLite ao lado) vê a lista, abre
// o histórico sob demanda, manda mensagem (resposta pelo `rec`), anexo por `attach.put`, renomeia
// por `chat.update`, e vê o host sair (`live.withdraw` → some; queda → reconectando → some). O
// cache do celular não recebe NADA desses chats. Pulado se o servidor não tiver `features.liveChats`.
import { afterAll, describe, expect, it } from 'vitest'
import { AccountService } from '../../src/account/service'
import { MemoryKeyValueStore, MemorySecretStore } from '../../src/account/storage'
import { bindAccount } from '../../src/data/binding'
import { SyncEngine } from '../../src/data/engine'
import { LocalStore } from '../../src/data/store'
import { bindRemote } from '../../src/remote/binding'
import { RemoteController } from '../../src/remote/controller'
import { RealtimeClient } from '../../src/vendor/desktop/sync/ws'
import { bindLive } from '../../src/live/binding'
import { DevLiveHost } from '../../src/live/devHost'
import { LiveService } from '../../src/live/service'
import { openNodeSql } from '../nodeSql'
import { codeFor, enabled, logMark, randomEmail, signupWeb, URL_, waitFor } from './realServer'
import { loginDesktop, setupKeysWithDek, type Desktop } from './seed'

const PASSWORD = 'senha de integração dos chats ao vivo'
const cleanup: (() => void)[] = []
afterAll(() => {
  for (const f of cleanup.reverse()) f()
})

const info = enabled
  ? await fetch(`${URL_}/api/info`)
      .then((r) => r.json() as Promise<{ features?: { liveChats?: boolean } }>)
      .catch(() => null)
  : null
const liveOn = info?.features?.liveChats === true

/** Desktop falso no WebSocket real: anuncia a cada welcome, responde comandos e resyncs. */
function startHost(d: Desktop): { dev: DevLiveHost; ws: RealtimeClient } {
  let ws!: RealtimeClient
  const dev = new DevLiveHost({
    userId: d.userId,
    deviceId: d.deviceId,
    sk: d.sk,
    replyMs: 50,
    emit: (f) => {
      const { t, ...fields } = f as { t: string } & Record<string, unknown>
      if (t === 'stream.event') ws.send(t, fields)
      else void ws.request(t, fields).catch(() => undefined)
    }
  })
  ws = new RealtimeClient({
    url: () => URL_.replace(/^http/, 'ws') + '/ws',
    hello: async () => ({
      access_token: d.token,
      cursor: 0,
      state_cursor: 0,
      active_windows: [],
      subscriptions: [],
      caps: ['live_chats']
    }),
    onWelcome: () => void dev.announce(true),
    onEvent: (f) => {
      if (f.t === 'remote.command') void dev.onCommand(f)
      else if (f.t === 'stream.resync_request') void dev.snapshot(String(f.chat_id))
      else if (f.t === 'live.refresh_request') void dev.announce(true)
    },
    onState: () => undefined,
    onUnauthorized: async () => false,
    onFatal: () => undefined,
    timing: { backoffBaseMs: 100, backoffMaxMs: 500 }
  })
  ws.start()
  return { dev, ws }
}

describe.skipIf(!enabled || !liveOn)('chats só ao vivo contra o servidor real (§23)', () => {
  it('lista, histórico, enviar, anexo, chat.update, saída do host — nada no cache do celular', async () => {
    const email = randomEmail('live')
    const web = await signupWeb(email)
    const { dek } = await setupKeysWithDek(web, PASSWORD)
    const desk = await loginDesktop(email, web.userId, dek)
    const { dev, ws: hostWs } = startHost(desk)
    cleanup.push(() => hostWs.stop())
    const chatId = crypto.randomUUID()
    dev.createChat({
      id: chatId,
      title: 'Plano da viagem',
      messages: Array.from({ length: 7 }, (_, i) => ({
        role: i % 2 ? ('assistant' as const) : ('user' as const),
        content: `mensagem ${i + 1}`
      })),
      hostCwd: '/home/ana/viagem'
    })
    await waitFor(() => hostWs.getState() === 'online', 'host online')

    // ---- celular ----
    const account = new AccountService({
      secrets: new MemorySecretStore(),
      kv: new MemoryKeyValueStore(),
      device: { defaultName: 'Pixel (ao vivo)', platform: 'android', appVersion: '0.1.0' },
      envUrl: URL_,
      wsTiming: { backoffBaseMs: 100, backoffMaxMs: 1000 }
    })
    cleanup.push(() => account.setForeground(false))
    await account.init()
    const n0 = logMark()
    await account.requestCode(email)
    await account.verifyCode(await codeFor(email, n0), 'Pixel (ao vivo)')
    const store = new LocalStore(openNodeSql())
    const keys = () => {
      const sk = account.subkeys
      const userId = account.accountUserId
      return sk && userId ? { userId, sk } : null
    }
    const engine = new SyncEngine({ store, http: account.http, keys })
    bindAccount(account, engine, null)
    let live!: LiveService
    const remote = new RemoteController({
      ws: { request: (t, f, ms) => account.wsRequest(t, f, ms) },
      keys,
      deviceId: () => account.getState().device?.id ?? null,
      chatState: (id) => store.chatState(id),
      post: (path, json) => account.http.post(path, json),
      assistantIds: (id) => store.assistantIds(id),
      loadMessage: (id) => store.message(id),
      live: () => live.hook
    })
    live = new LiveService({
      ws: { request: (t, f, ms) => account.wsRequest(t, f, ms) },
      remote,
      keys,
      deviceId: () => account.getState().device?.id ?? null,
      fetchFeature: async () => liveOn
    })
    bindRemote(account, engine, remote)
    bindLive(account, live)
    await account.unlock(PASSWORD, { remember: true })
    await waitFor(() => engine.getStatus().phase === 'idle', 'pull', 60_000)

    // ---- lista ----
    await waitFor(() => live.list.has(chatId), 'chat na lista ao vivo', 20_000)
    expect(live.supported).toBe(true)
    const e = live.list.get(chatId)!
    expect(e.host.name).toBe('PC de casa')
    expect(e.info.title).toBe('Plano da viagem')
    expect(remote.mode(chatId)).toBe('remote')

    // ---- histórico sob demanda ----
    live.open(chatId)
    await waitFor(() => live.history(chatId)?.phase === 'ready', 'histórico', 20_000)
    const main = `${chatId}-main`
    expect(live.history(chatId)!.loaded!.messages.get(main)!.length).toBe(7)
    await waitFor(() => remote.view(chatId)?.complete, 'snapshot')

    // ---- enviar → resposta pelo rec ----
    await remote.send(chatId, main, 'e o dia 2?', [], [])
    await waitFor(
      () =>
        (live.history(chatId)?.loaded?.messages.get(main) ?? []).some(
          (m) => m.message.content === 'ok: e o dia 2?'
        ),
      'resposta',
      20_000
    )

    // ---- anexo pelo attach.put (1,2 MiB → 3 pedaços) ----
    const png = new Uint8Array(1200 * 1024).map((_, i) => (i * 7) % 256)
    const up = await live.upload(chatId, png, 'mapa.png', 'image/png')
    const att = await up.handle.done
    expect(dev.received.filter((r) => r.kind === 'attach.put').length).toBe(3)
    await remote.send(chatId, main, 'veja o mapa', [att], [])
    await waitFor(
      () =>
        (live.history(chatId)?.loaded?.messages.get(main) ?? []).some(
          (m) => m.message.content === 'ok: veja o mapa (1 anexo)'
        ),
      'resposta com anexo',
      20_000
    )
    const back = await live.file(chatId, att.file)
    expect(back.bytes.length).toBe(png.length)

    // ---- chat.update ----
    await remote.chatUpdate(chatId, { title: 'Lisboa' })
    await waitFor(() => live.list.get(chatId)?.info.title === 'Lisboa', 'título novo')

    // ---- nada no cache do celular ----
    expect(store.listChats()).toEqual([])
    expect(store.recordMeta('chat', chatId)).toBeNull()
    expect(store.sql.get<{ n: number }>('SELECT COUNT(*) AS n FROM messages')!.n).toBe(0)

    // ---- o host sai (withdraw quit) → some na hora ----
    const removed: string[] = []
    live.onNotice((n) => n.kind === 'removed' && removed.push(n.reason))
    await hostWs.request('live.withdraw', { chat_ids: null, reason: 'quit' })
    await waitFor(() => !live.list.has(chatId), 'saiu da lista')
    expect(removed[0]).toBe('host_quit')
    expect(live.history(chatId)).toBeNull()

    // ---- volta e cai: reconectando… → some depois da tolerância ----
    await dev.announce(true)
    await waitFor(() => live.list.has(chatId), 'voltou', 10_000)
    hostWs.stop()
    await waitFor(() => live.list.get(chatId)?.host.status === 'grace', 'reconectando', 10_000)
    await waitFor(() => !live.list.has(chatId), 'tolerância expirou', 20_000)
  }, 120_000)
})
