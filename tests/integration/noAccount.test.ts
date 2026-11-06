// "Usar sem conta" contra o servidor de sync REAL local, com o provedor LLM FALSO: o celular (os
// mesmos módulos do aparelho — AccountService, binding, motor, host, Configurações) começa sem conta,
// cria provedor, persona, memória e um chat com turno sem falar com o servidor; depois entra numa
// conta (código por e-mail + senha de criptografia definida no "site") e o merge do primeiro login
// (§12) sobe tudo. Um segundo cliente (o "desktop", com a DEK) decifra e vê os dados. Um segundo
// celular sem conta entra na mesma conta (agora com dados): pergunta → "Priorizar online", o provedor
// igual é deduplicado (id do online) e o chat dele sobe.
import { afterAll, describe, expect, it } from 'vitest'
import { AccountService } from '../../src/account/service'
import { MemoryKeyValueStore, MemorySecretStore } from '../../src/account/storage'
import { bindAccount, syncAllowed } from '../../src/data/binding'
import { SyncEngine } from '../../src/data/engine'
import { LocalStore } from '../../src/data/store'
import { bindHost } from '../../src/host/binding'
import { createHostStack } from '../../src/host/stack'
import { SettingsService } from '../../src/settings/service'
import { setSearchBases } from '../../src/agent/tools/web'
import { invalidateModels } from '../../src/agent/providers'
import { DEFAULT_CHAT_CONFIG } from '../../src/vendor/shared/defaults'
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
import { loginDesktop, setupKeysWithDek, type Desktop } from './seed'

const PASSWORD = 'senha de integração do modo sem conta'
const cleanup: (() => void | Promise<void>)[] = []
afterAll(async () => {
  for (const f of cleanup.reverse()) await f()
})

/** Todos os registros vivos da conta, decifrados como o desktop faria. */
async function allRecords(d: Desktop) {
  const out: { type: string; id: string; scope: string | null; plain: Record<string, unknown> }[] =
    []
  let after = 0
  for (;;) {
    const r = await rest(
      'GET',
      `/api/v1/records?after=${after}&limit=500&payload=1`,
      undefined,
      d.token
    )
    for (const c of (r.records ?? []) as Change[]) {
      if (c.deleted || !c.env) continue
      out.push({
        type: c.type,
        id: c.id,
        scope: c.scope,
        plain: await openRecord(d.sk.record, d.userId, c, c.env)
      })
    }
    if (!r.has_more || !r.records?.length) break
    after = r.next ?? r.records[r.records.length - 1].seq
  }
  return out
}

/** Um celular novo, sem conta (mesma montagem do aparelho). */
async function phone(name: string) {
  const account = new AccountService({
    secrets: new MemorySecretStore(),
    kv: new MemoryKeyValueStore(),
    device: { defaultName: name, platform: 'android', appVersion: '0.1.0' },
    envUrl: URL_,
    wsTiming: { backoffBaseMs: 100, backoffMaxMs: 1000 }
  })
  cleanup.push(() => account.setForeground(false))
  await account.init()
  account.useWithoutAccount()
  const store = new LocalStore(openNodeSql())
  const keys = () => {
    const sk = account.subkeys
    const userId = account.accountUserId
    return sk && userId && syncAllowed(store) ? { userId, sk } : null
  }
  const engine = new SyncEngine({ store, http: account.http, keys })
  const files = new Map<string, Uint8Array>()
  const local = () => account.getState().phase === 'local'
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
    deviceName: () => account.getState().device?.name ?? name,
    files: {
      ensure: async (f) => {
        if (!files.has(f)) throw new Error('ausente')
      },
      readBase64: async (f) => Buffer.from(files.get(f) ?? []).toString('base64'),
      readText: async (f) => new TextDecoder().decode(files.get(f) ?? new Uint8Array()),
      size: (f) => files.get(f)?.length ?? null,
      save: async (data, ext) => {
        const f = `${hex(await sha256(data))}.${ext}`
        files.set(f, data)
        return f
      },
      bytes: async (f) => files.get(f) ?? null
    },
    localOnly: local
  })
  const settings = new SettingsService({
    store,
    writer: stack.memory.writer,
    memory: stack.memory.index,
    notify: (list) => engine.notifySettings(list)
  })
  const binding = bindAccount(account, engine, null, {
    afterMerge: () => {
      stack.writer.resume()
      stack.memory.writer.resume()
    }
  })
  bindHost(account, stack.host, stack.runner)
  cleanup.push(() => {
    binding.unbind()
    stack.host.stop()
    stack.memory.writer.stop()
  })
  await waitFor(() => store.getMeta('owner') === 'local', 'dono local')
  const newChat = (providerId: string) =>
    stack.repo.createChat({
      config: {
        ...DEFAULT_CHAT_CONFIG(''),
        providerId,
        model: 'fake/agent',
        enabledTools: ['web_search']
      }
    })
  /** Entrar na conta: login por código e desbloqueio (o binding faz o merge). */
  const signIn = async (email: string) => {
    account.beginSignIn()
    const n0 = logMark()
    await account.requestCode(email)
    await account.verifyCode(await codeFor(email, n0), name)
    await account.unlock(PASSWORD, { remember: true })
  }
  return { account, store, engine, stack, settings, binding, files, newChat, signIn, local }
}

describe.skipIf(!enabled)('sem conta → entrar → merge (servidor real)', () => {
  it('cria tudo sem conta, entra, sobe tudo; outro cliente vê; um 2º celular une com prioridade online', async () => {
    const llm = await startFakeLlm(0, { delay: 5 })
    cleanup.push(() => llm.close())
    setSearchBases({ ddg: `${llm.url}/ddg` })
    invalidateModels()

    // ---- 1. celular sem conta ----
    const a = await phone('Pixel sem conta')
    expect(a.account.getState().phase).toBe('local')
    const pid = a.settings.saveProvider({
      name: 'LLM falso',
      kind: 'openai',
      baseUrl: `${llm.url}/v1`,
      apiKey: 'sk-falsa-nao-e-paga',
      headers: {}
    })
    const persona = a.settings.savePreset({
      name: 'Revisor',
      description: 'revisa textos',
      icon: 'code',
      config: { providerId: pid, model: 'fake/agent', systemPrompt: 'seja breve' }
    })
    a.settings.setSetting('defaultModel', { providerId: pid, model: 'fake/agent' })
    const col = a.settings.createCollection({ category: 'people', name: 'Família' })
    const mem = a.settings.createMemory({ collectionId: col.id, title: 'Rex', summary: 'o cão' })
    const { chat, session } = a.newChat(pid)
    await a.stack.host.local(chat.id, 'send', { sessionId: session.id, text: 'olá sem conta' })
    await waitFor(() => !a.stack.runner.isRunning(session.id), 'turno terminar', 30_000)
    const texts = [...a.store.loadChat(chat.id)!.messages.values()]
      .flat()
      .map((m) => m.message.content)
    expect(texts).toEqual(['olá sem conta', 'ok: olá sem conta'])

    // ---- 2. conta nova (site) e login no celular: merge sem pergunta (online vazio) ----
    const email = randomEmail('semconta')
    const web = await signupWeb(email)
    const { dek } = await setupKeysWithDek(web, PASSWORD)
    await a.signIn(email)
    await waitFor(
      () => a.binding.merge.getState().phase === 'idle' && a.store.getMeta('owner') !== 'local',
      'merge',
      30_000
    )
    expect(a.account.localModeChosen).toBe(false)
    await waitFor(
      () => !a.stack.writer.pending(chat.id) && !a.stack.memory.writer.pending(),
      'outboxes subirem',
      30_000
    )

    // ---- 3. segundo cliente (desktop com a DEK) vê tudo ----
    const desk = await loginDesktop(email, web.userId, dek)
    const recs = await allRecords(desk)
    const of = (t: string) => recs.filter((r) => r.type === t)
    expect(of('provider').map((r) => [r.id, r.plain.name, r.plain.apiKey])).toEqual([
      [pid, 'LLM falso', 'sk-falsa-nao-e-paga']
    ])
    expect(of('preset').map((r) => [r.id, r.plain.name])).toEqual([[persona.id, 'Revisor']])
    expect(of('memory').map((r) => [r.id, r.plain.title, r.plain.collectionId])).toEqual([
      [mem.id, 'Rex', col.id]
    ])
    expect(of('setting').find((r) => r.id === 'defaultModel')?.plain.value).toEqual({
      providerId: pid,
      model: 'fake/agent'
    })
    expect(of('chat').map((r) => r.id)).toEqual([chat.id])
    const msgs = of('message')
      .filter((r) => r.scope === chat.id)
      .sort((x, y) => Number(x.plain.seq) - Number(y.plain.seq))
      .map((r) => (r.plain.message as { content: string }).content)
    expect(msgs).toEqual(['olá sem conta', 'ok: olá sem conta'])
    const states = (await rest('GET', '/api/v1/chat-states?since=0', undefined, desk.token))
      .chat_states as { chat_id: string; host: { device_id: string } | null }[]
    expect(states.find((s) => s.chat_id === chat.id)?.host?.device_id).toBe(
      a.account.getState().device!.id
    )

    // ---- 4. depois do merge: sync normal (turno com janela sobe sozinho) ----
    await a.stack.host.local(chat.id, 'send', { sessionId: session.id, text: 'agora com conta' })
    await waitFor(() => !a.stack.runner.isRunning(session.id), 'turno 2', 30_000)
    await waitFor(
      async () =>
        (await allRecords(desk)).some(
          (r) =>
            r.type === 'message' &&
            (r.plain.message as { content?: string }).content === 'ok: agora com conta'
        ),
      'turno 2 no servidor',
      30_000
    )

    // ---- 5. outro celular sem conta, com o MESMO provedor (outro id) e um chat próprio ----
    const b = await phone('Outro sem conta')
    const pidB = b.settings.saveProvider({
      name: 'llm falso',
      kind: 'openai',
      baseUrl: `${llm.url}/v1/`,
      apiKey: 'sk-outra',
      headers: {}
    })
    const cb = b.newChat(pidB)
    await b.stack.host.local(cb.chat.id, 'send', { sessionId: cb.session.id, text: 'do outro' })
    await waitFor(() => !b.stack.runner.isRunning(cb.session.id), 'turno do outro', 30_000)
    await b.signIn(email)
    await waitFor(() => b.binding.merge.getState().phase === 'ask', 'pergunta do merge', 30_000)
    const st = b.binding.merge.getState()
    if (st.phase !== 'ask') throw new Error('sem pergunta')
    expect(st.info.local).toMatchObject({ providers: 1, chats: 1 })
    expect(st.info.online).toMatchObject({ providers: 1, chats: 1, presets: 1, memories: 1 })
    await b.binding.merge.resolve('online')
    await waitFor(() => b.store.getMeta('owner') !== 'local', 'merge do outro')
    // deduplicado: o provedor do outro celular virou o online (chave online venceu)
    expect(b.store.getPlain('provider', pidB)).toBeNull()
    expect(b.store.getPlain('provider', pid)!.apiKey).toBe('sk-falsa-nao-e-paga')
    expect(b.store.getPlain('chat', cb.chat.id)!.config).toMatchObject({ providerId: pid })
    expect(
      b.store
        .listChats()
        .map((c) => c.id)
        .sort()
    ).toEqual([chat.id, cb.chat.id].sort())
    await waitFor(
      () => !b.stack.writer.pending(cb.chat.id) && !b.stack.memory.writer.pending(),
      'outboxes do outro',
      30_000
    )
    const recs2 = await allRecords(desk)
    expect(recs2.filter((r) => r.type === 'provider').map((r) => r.id)).toEqual([pid])
    const chat2 = recs2.find((r) => r.type === 'chat' && r.id === cb.chat.id)!
    expect((chat2.plain.config as { providerId: string }).providerId).toBe(pid)
    expect(
      recs2
        .filter((r) => r.type === 'message' && r.scope === cb.chat.id)
        .map((r) => (r.plain.message as { content: string }).content)
        .sort()
    ).toEqual(['do outro', 'ok: do outro'])
    // e o primeiro celular recebe o chat do segundo pelo sync normal
    await waitFor(() => !!a.store.getPlain('chat', cb.chat.id), 'chat do outro no primeiro', 30_000)
  })
})
