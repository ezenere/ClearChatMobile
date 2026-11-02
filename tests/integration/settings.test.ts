// Fase 5 contra o servidor de sync REAL local: as Configurações do celular (SettingsService sobre a
// outbox LWW, mesmos módulos do aparelho) e um "desktop" (dispositivo can_host com a DEK) conferindo
// o que chega — provedor com a chave, persona, settings (título automático, buscadores e chave de
// API), coleção + memória escritas à mão; o que o desktop muda chega ao celular ao vivo; edições
// concorrentes na mesma persona se mesclam (§7.5); gravação offline sobe ao reconectar; lista de
// dispositivos, renomear e desconectar outro (a sessão do site); troca da senha de criptografia (a DEK não muda).
import { afterAll, describe, expect, it } from 'vitest'
import { AccountService } from '../../src/account/service'
import { MemoryKeyValueStore, MemorySecretStore } from '../../src/account/storage'
import { bindAccount } from '../../src/data/binding'
import { SyncEngine } from '../../src/data/engine'
import { LocalStore } from '../../src/data/store'
import { createHostStack } from '../../src/host/stack'
import { SettingsService } from '../../src/settings/service'
import { SyncNetworkError } from '../../src/vendor/desktop/sync/http'
import { openRecord, sealRecord, unlockWithPassword, type KeysResponse } from '../../src/crypto'
import type { Change } from '../../src/data/types'
import { openNodeSql } from '../nodeSql'
import {
  codeFor,
  enabled,
  logMark,
  randomEmail,
  rest,
  RestError,
  signupWeb,
  URL_,
  waitFor
} from './realServer'
import { item, loginDesktop, push, setupKeysWithDek, type Desktop } from './seed'

const PASSWORD = 'senha de integração da fase 5'
const NEW_PASSWORD = 'outra senha bem comprida da fase 5'
const cleanup: (() => void | Promise<void>)[] = []
afterAll(async () => {
  for (const f of cleanup.reverse()) await f()
})

async function fetchRec(d: Desktop, type: string, id: string): Promise<Change | null> {
  const r = await rest('POST', '/api/v1/records/fetch', { items: [{ type, id }] }, d.token)
  return (r.records?.[0] as Change | undefined) ?? null
}

/** Plaintext atual no servidor, decifrado como o desktop decifraria. */
async function plainOf(d: Desktop, type: string, id: string) {
  const c = await fetchRec(d, type, id)
  if (!c || c.deleted || !c.env) return null
  return {
    rev: c.rev,
    device: c.device_id,
    plain: await openRecord(d.sk.record, d.userId, c, c.env)
  }
}

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

describe.skipIf(!enabled)('fase 5 contra o servidor real', () => {
  it('Configurações: celular ↔ desktop, conflito mesclado, offline, dispositivos e troca de senha', async () => {
    const email = randomEmail('fase5')
    const web = await signupWeb(email)
    const { dek } = await setupKeysWithDek(web, PASSWORD)
    const desk = await loginDesktop(email, web.userId, dek)
    await push(desk, [
      await item(desk, 'provider', 'prov-pc', null, {
        sv: 1,
        name: 'OpenRouter do PC',
        kind: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: 'sk-or-falsa-nao-e-paga',
        headers: {},
        createdAt: 1
      }),
      await item(desk, 'preset', 'preset-padrao', null, {
        sv: 1,
        name: 'Padrão',
        description: 'Configuração padrão do app',
        icon: 'sparkles',
        config: {},
        createdAt: 1,
        updatedAt: 1
      }),
      await item(desk, 'setting', 'defaultPresetId', null, { sv: 1, value: 'preset-padrao' })
    ])

    // ---- celular ----
    const account = new AccountService({
      secrets: new MemorySecretStore(),
      kv: new MemoryKeyValueStore(),
      device: { defaultName: 'Pixel fase 5', platform: 'android', appVersion: '0.1.0' },
      envUrl: URL_,
      wsTiming: { backoffBaseMs: 100, backoffMaxMs: 1000 }
    })
    cleanup.push(() => account.setForeground(false))
    await account.init()
    const n0 = logMark()
    await account.requestCode(email)
    await account.verifyCode(await codeFor(email, n0), 'Pixel fase 5')
    const store = new LocalStore(openNodeSql())
    const keys = () => {
      const sk = account.subkeys
      const userId = account.accountUserId
      return sk && userId ? { userId, sk } : null
    }
    const engine = new SyncEngine({ store, http: account.http, keys })
    bindAccount(account, engine, null)
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
        putBlob: async () => undefined
      },
      keys,
      openMemorySql: () => openNodeSql(),
      remoteSend: () => Promise.reject(new Error('sem host remoto')),
      ws: { request: (t, f, ms) => account.wsRequest(t, f, ms) },
      deviceId: () => account.getState().device?.id ?? null,
      deviceName: () => 'Pixel fase 5',
      files: {
        ensure: async () => undefined,
        readBase64: async () => '',
        readText: async () => '',
        size: () => null,
        save: async () => 'x',
        bytes: async () => null
      },
      writerTiming: { debounceMs: 20, retryMs: 100 }
    })
    const settingsEvents: unknown[] = []
    engine.subscribe((e) => e.kind === 'data' && e.settings && settingsEvents.push(e))
    const s = new SettingsService({
      store,
      writer: stack.memory.writer,
      memory: stack.memory.index,
      notify: (list) => engine.notifySettings(list)
    })
    const flushed = () => waitFor(() => !stack.memory.writer.pending(), 'outbox LWW', 20_000)
    await account.unlock(PASSWORD, { remember: true })
    await waitFor(
      () => engine.getStatus().phase === 'idle' && !engine.getStatus().initial,
      'pull',
      60_000
    )
    expect(s.providers().map((p) => p.name)).toEqual(['OpenRouter do PC'])
    expect(s.setting('defaultPresetId')).toBe('preset-padrao')

    // ---- celular grava; o desktop decifra com o esquema do §4.3 ----
    const provId = s.saveProvider({
      name: 'Anthropic do celular',
      kind: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'sk-ant-falsa-nao-e-paga',
      headers: {}
    })
    const persona = s.savePreset({
      name: 'Revisor',
      description: 'revisa textos',
      icon: 'pen',
      config: { providerId: provId, model: 'claude-falso', systemPrompt: 'Revise.' }
    })
    s.setSetting('autoTitle', {
      providerId: provId,
      model: 'claude-falso',
      useMemory: true,
      maxTokens: 48,
      prompt: null
    })
    s.setEngineKey('tavily', 'tvly-falsa-1234567890')
    s.setEngines(s.engines().map((e) => (e.id === 'tavily' ? { ...e, enabled: true } : e)))
    const col = s.createCollection({ category: 'people', name: 'Família', description: 'gente' })
    const mem = s.createMemory({ collectionId: col.id, title: 'Rex', summary: 'o cachorro' })
    s.updateMemory(mem.id, { facts: ['Late para o carteiro'] })
    await flushed()
    expect((await plainOf(desk, 'provider', provId))?.plain).toMatchObject({
      sv: 1,
      name: 'Anthropic do celular',
      kind: 'anthropic',
      apiKey: 'sk-ant-falsa-nao-e-paga',
      headers: {}
    })
    expect((await plainOf(desk, 'preset', persona.id))?.plain).toMatchObject({
      name: 'Revisor',
      icon: 'pen',
      config: { providerId: provId, model: 'claude-falso', systemPrompt: 'Revise.' }
    })
    expect((await plainOf(desk, 'setting', 'autoTitle'))?.plain).toMatchObject({
      sv: 1,
      value: { model: 'claude-falso', useMemory: true, maxTokens: 48 }
    })
    expect((await plainOf(desk, 'setting', 'webSearchApiKeys'))?.plain.value).toEqual({
      tavily: 'tvly-falsa-1234567890'
    })
    const engines = (await plainOf(desk, 'setting', 'webSearchEngines'))?.plain.value as {
      id: string
      enabled: boolean
    }[]
    expect(engines.find((e) => e.id === 'tavily')?.enabled).toBe(true)
    expect((await plainOf(desk, 'memory_collection', col.id))?.plain).toMatchObject({
      category: 'people',
      name: 'Família'
    })
    const memRec = await fetchRec(desk, 'memory', mem.id)
    expect(memRec?.scope).toBe(col.id)
    expect((await plainOf(desk, 'memory', mem.id))?.plain).toMatchObject({
      collectionId: col.id,
      title: 'Rex',
      facts: ['Late para o carteiro'],
      updatedBy: 'user'
    })

    // ---- o desktop muda; o celular recebe ao vivo (sync.changes) e as telas recarregam ----
    const before = settingsEvents.length
    await putAs(desk, 'setting', 'defaultSystemPrompt', null, { sv: 1, value: 'Prompt do PC' })
    await waitFor(() => s.setting('defaultSystemPrompt') === 'Prompt do PC', 'setting ao vivo')
    expect(settingsEvents.length).toBeGreaterThan(before)

    // ---- conflito: o PC muda o system prompt da persona; o celular (sem ter puxado) muda o nome
    // e tira o modelo próprio → os dois lados ficam ----
    const cur = (await plainOf(desk, 'preset', persona.id))!.plain
    engine.stop()
    await putAs(desk, 'preset', persona.id, null, {
      ...cur,
      config: { ...(cur.config as object), systemPrompt: 'Revise com carinho.' },
      updatedAt: Date.now()
    })
    const base = {
      name: persona.name,
      description: persona.description,
      icon: persona.icon,
      config: persona.config
    }
    s.savePreset(
      {
        ...base,
        name: 'Revisor de textos',
        config: { systemPrompt: 'Revise.' }
      },
      persona.id,
      base
    )
    await flushed()
    engine.start()
    expect((await plainOf(desk, 'preset', persona.id))?.plain).toMatchObject({
      name: 'Revisor de textos',
      config: { systemPrompt: 'Revise com carinho.' }
    })
    expect(
      ((await plainOf(desk, 'preset', persona.id))?.plain.config as Record<string, unknown>).model
    ).toBeUndefined()

    // ---- offline: grava, fica na outbox; volta a rede → sobe ----
    net.down = true
    s.setSearchInterval(9)
    await new Promise((r) => setTimeout(r, 300))
    expect(stack.memory.writer.pending()).toBe(true)
    expect((await plainOf(desk, 'setting', 'webSearchMinIntervalSec'))?.plain.value).toBeUndefined()
    net.down = false
    stack.memory.writer.resume()
    await flushed()
    expect((await plainOf(desk, 'setting', 'webSearchMinIntervalSec'))?.plain.value).toBe(9)

    // ---- apagar coleção leva as memórias; apagar persona padrão zera a padrão ----
    s.deleteCollection(col.id)
    s.setSetting('defaultPresetId', persona.id)
    s.deletePreset(persona.id)
    await flushed()
    expect((await fetchRec(desk, 'memory_collection', col.id))?.deleted).toBe(true)
    expect(await plainOf(desk, 'memory', mem.id)).toBeNull()
    expect((await plainOf(desk, 'setting', 'defaultPresetId'))?.plain.value).toBeNull()

    // ---- dispositivos: lista, renomeia o PC, desconecta o site ----
    const list = await account.devices()
    expect(list.find((d) => d.current)?.id).toBe(account.getState().device!.id)
    expect(list.map((d) => d.id)).toEqual(expect.arrayContaining([desk.deviceId, web.deviceId]))
    await account.renameDevice('PC do escritório', desk.deviceId)
    expect((await account.devices()).find((d) => d.id === desk.deviceId)?.name).toBe(
      'PC do escritório'
    )
    // desconecta a sessão do "site" (outro dispositivo da conta)
    await account.revokeDevice(web.deviceId)
    const gone = await rest('GET', '/api/v1/keys', undefined, web.token).catch((e: unknown) => e)
    expect(gone).toBeInstanceOf(RestError)
    expect((gone as RestError).status).toBe(401)

    // ---- troca de senha: só a wrap muda; a DEK (e o desktop) seguem iguais ----
    const k0 = (await rest('GET', '/api/v1/keys', undefined, desk.token)) as KeysResponse
    await expect(
      account.changePasswordWithCurrent('errada errada errada', NEW_PASSWORD)
    ).rejects.toBeTruthy()
    await account.changePasswordWithCurrent(PASSWORD, NEW_PASSWORD)
    const k1 = (await rest('GET', '/api/v1/keys', undefined, desk.token)) as KeysResponse
    expect(k1.keys_rev).toBe(k0.keys_rev + 1)
    const dek2 = await unlockWithPassword(web.userId, k1, NEW_PASSWORD)
    expect(Buffer.from(dek2).equals(Buffer.from(dek))).toBe(true)
    await expect(unlockWithPassword(web.userId, k1, PASSWORD)).rejects.toBeTruthy()
    // o desktop continua lendo (mesma DEK)
    expect((await plainOf(desk, 'provider', provId))?.plain.name).toBe('Anthropic do celular')
  })
})
