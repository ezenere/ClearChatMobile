// Herança ao vivo da persona (protocolo 1.10.0, §4.3.6/§7.5/§7.7) contra o servidor de sync REAL
// local, entre dois aparelhos: um "desktop" (cifra com a DEK e grava como o app) e o celular (conta,
// motor, host e Configurações reais). O chat antigo do desktop migra no celular depois do pull; o
// chat novo do celular sobe com `overrides` só do que mudou; a persona editada no desktop muda os
// chats no celular ao vivo; edições concorrentes em campos diferentes mantêm as duas marcas; a
// persona apagada no celular congela os chats e o tombstone chega ao servidor DEPOIS deles.
import { afterAll, describe, expect, it } from 'vitest'
import type { InheritConfig } from '@shared/chatInherit'
import { AccountService } from '../../src/account/service'
import { MemoryKeyValueStore, MemorySecretStore } from '../../src/account/storage'
import { bindAccount } from '../../src/data/binding'
import { SyncEngine } from '../../src/data/engine'
import { LocalStore } from '../../src/data/store'
import { createHostStack } from '../../src/host/stack'
import { finalizeNewChat, presetFromPlain, resolveNewChat } from '../../src/host/newChat'
import { SettingsService } from '../../src/settings/service'
import { openRecord, sealRecord } from '../../src/crypto'
import type { Change } from '../../src/data/types'
import { openNodeSql } from '../nodeSql'
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

const PASSWORD = 'senha de integração da herança da persona'
const cleanup: (() => void | Promise<void>)[] = []
afterAll(async () => {
  for (const f of cleanup.reverse()) await f()
})

async function fetchRec(d: Desktop, type: string, id: string): Promise<Change | null> {
  const r = await rest('POST', '/api/v1/records/fetch', { items: [{ type, id }] }, d.token)
  return (r.records?.[0] as Change | undefined) ?? null
}

async function plainOf(d: Desktop, type: string, id: string) {
  const c = await fetchRec(d, type, id)
  if (!c || c.deleted || !c.env) return null
  return { rev: c.rev, seq: c.seq, plain: await openRecord(d.sk.record, d.userId, c, c.env) }
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

const cfgOf = (p: Record<string, unknown> | undefined) => (p?.config ?? {}) as InheritConfig

describe.skipIf(!enabled)('herança ao vivo da persona contra o servidor real', () => {
  it('migração, chat novo, persona ao vivo, marcas concorrentes, persona apagada congela antes', async () => {
    const email = randomEmail('heranca')
    const web = await signupWeb(email)
    const { dek } = await setupKeysWithDek(web, PASSWORD)
    const desk = await loginDesktop(email, web.userId, dek)
    const persona = {
      providerId: 'prov-pc',
      model: 'modelo-da-persona',
      systemPrompt: 'Seja breve.',
      enabledTools: ['web_search', 'ask_user'],
      params: { temperature: 0.3 }
    }
    await push(desk, [
      await item(desk, 'provider', 'prov-pc', null, {
        sv: 1,
        name: 'OpenAI do PC',
        kind: 'openai',
        baseUrl: 'http://127.0.0.1:9/v1',
        apiKey: 'sk-falsa-nao-e-paga',
        headers: {},
        createdAt: 1
      }),
      await item(desk, 'preset', 'p-rev', null, {
        sv: 1,
        name: 'Revisora',
        description: '',
        icon: 'pen',
        config: persona,
        createdAt: 1,
        updatedAt: 1
      }),
      // chat de um app < 1.10.0: cópia da persona com o system prompt mudado no chat
      await item(desk, 'chat', 'c-antigo', 'c-antigo', {
        sv: 1,
        title: 'Antigo',
        config: {
          ...persona,
          systemPrompt: 'Mudado no chat.',
          presetId: 'p-rev',
          cacheEnabled: false
        },
        mainSessionId: 's-antigo',
        createdAt: 5,
        updatedAt: 5
      })
    ])

    // ---- celular ----
    const account = new AccountService({
      secrets: new MemorySecretStore(),
      kv: new MemoryKeyValueStore(),
      device: { defaultName: 'Pixel herança', platform: 'android', appVersion: '0.1.0' },
      envUrl: URL_,
      wsTiming: { backoffBaseMs: 100, backoffMaxMs: 1000 }
    })
    cleanup.push(() => account.setForeground(false))
    await account.init()
    const n0 = logMark()
    await account.requestCode(email)
    await account.verifyCode(await codeFor(email, n0), 'Pixel herança')
    const store = new LocalStore(openNodeSql())
    const keys = () => {
      const sk = account.subkeys
      const userId = account.accountUserId
      return sk && userId ? { userId, sk } : null
    }
    const engine = new SyncEngine({ store, http: account.http, keys })
    bindAccount(account, engine, null)
    const stack = createHostStack({
      store,
      engine,
      http: {
        get: (path) => account.http.get(path),
        post: (path, json) => account.http.post(path, json),
        putBlob: async () => undefined
      },
      keys,
      openMemorySql: () => openNodeSql(),
      remoteSend: () => Promise.reject(new Error('sem host remoto')),
      ws: { request: (t, f, ms) => account.wsRequest(t, f, ms) },
      deviceId: () => account.getState().device?.id ?? null,
      deviceName: () => 'Pixel herança',
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
    cleanup.push(() => stack.writer.stop())
    const s = new SettingsService({
      store,
      writer: stack.memory.writer,
      memory: stack.memory.index,
      notify: (list) => engine.notifySettings(list),
      freezePresetChats: (id) => void stack.freezePresetChats(id)
    })
    await account.unlock(PASSWORD, { remember: true })
    await waitFor(
      () => engine.getStatus().phase === 'idle' && !engine.getStatus().initial,
      'pull',
      60_000
    )
    stack.writer.resume()
    stack.memory.writer.resume()

    // ---- 1. chat antigo migra depois do pull (iguais herdam, diferentes ficam próprios) ----
    await waitFor(
      async () => !!cfgOf((await plainOf(desk, 'chat', 'c-antigo'))?.plain).overrides,
      'chat antigo migrado no servidor',
      20_000
    )
    const old = (await plainOf(desk, 'chat', 'c-antigo'))!.plain
    expect(cfgOf(old).overrides).toEqual({ systemPrompt: true })
    expect(old.updatedAt).toBe(5)

    // ---- 2. chat novo no celular: overrides só do que mudou no formulário ----
    const p = presetFromPlain('p-rev', store.getPlain('preset', 'p-rev')!)
    const providers = stack.providers()
    const base = resolveNewChat({}, providers, p)
    const { chat } = stack.repo.createChat({
      config: finalizeNewChat(
        base,
        {
          providerId: base.providerId,
          model: base.model,
          params: { ...base.params, temperature: 0.9 },
          tools: base.enabledTools,
          presetId: 'p-rev'
        },
        providers
      )
    })
    // (o conteúdo espera uma janela de host; aqui só o registro `chat` importa)
    const chatSent = (id: string) => !store.chatOutboxRow(id)
    await waitFor(() => chatSent(chat.id), 'chat novo enviado', 20_000)
    const novo = cfgOf((await plainOf(desk, 'chat', chat.id))!.plain)
    expect(novo.presetId).toBe('p-rev')
    expect(novo.overrides).toEqual({ 'params.temperature': true })
    expect(novo.systemPrompt).toBe('Seja breve.') // cópia informativa completa
    expect(novo).not.toHaveProperty('cwd')

    // ---- 3. o desktop muda a persona: os chats do celular acompanham ao vivo ----
    await putAs(desk, 'preset', 'p-rev', null, {
      sv: 1,
      name: 'Revisora',
      description: '',
      icon: 'pen',
      config: { ...persona, model: 'modelo-novo', systemPrompt: 'Seja muito breve.' },
      createdAt: 1,
      updatedAt: 2
    })
    await waitFor(
      () => stack.repo.chat(chat.id)?.config.model === 'modelo-novo',
      'persona ao vivo no celular'
    )
    expect(stack.repo.chat(chat.id)!.config.systemPrompt).toBe('Seja muito breve.')
    expect(stack.repo.chat(chat.id)!.config.params.temperature).toBe(0.9)
    expect(stack.repo.chat('c-antigo')!.config.systemPrompt).toBe('Mudado no chat.')
    expect(stack.repo.chat('c-antigo')!.config.model).toBe('modelo-novo')

    // ---- 4. edições concorrentes: o PC torna o modelo próprio, o celular (sem puxar) o prompt ----
    engine.stop()
    const cur = (await plainOf(desk, 'chat', chat.id))!.plain
    await putAs(desk, 'chat', chat.id, chat.id, {
      ...cur,
      config: {
        ...cfgOf(cur),
        model: 'modelo-do-pc',
        overrides: { ...cfgOf(cur).overrides, model: true }
      }
    })
    stack.repo.updateChat(chat.id, { config: { systemPrompt: 'Do celular.' } })
    await waitFor(() => chatSent(chat.id), 'merge enviado', 20_000)
    engine.start()
    const merged = cfgOf((await plainOf(desk, 'chat', chat.id))!.plain)
    expect(merged.overrides).toEqual({
      'params.temperature': true,
      model: true,
      systemPrompt: true
    })
    expect(merged.model).toBe('modelo-do-pc')
    expect(merged.systemPrompt).toBe('Do celular.')
    await waitFor(
      () => stack.repo.chat(chat.id)?.config.model === 'modelo-do-pc',
      'celular com o modelo do PC'
    )

    // ---- 5. persona apagada no celular: chats congelam e sobem ANTES do tombstone ----
    s.deletePreset('p-rev')
    await waitFor(
      () => chatSent(chat.id) && chatSent('c-antigo'),
      'chats congelados enviados',
      20_000
    )
    await waitFor(
      async () => (await fetchRec(desk, 'preset', 'p-rev'))?.deleted === true,
      'tombstone da persona',
      20_000
    )
    const tomb = (await fetchRec(desk, 'preset', 'p-rev'))!
    for (const id of [chat.id, 'c-antigo']) {
      const c = (await plainOf(desk, 'chat', id))!
      expect(cfgOf(c.plain).presetId).toBeUndefined()
      expect(c.seq).toBeLessThan(tomb.seq)
    }
    const frozen = cfgOf((await plainOf(desk, 'chat', chat.id))!.plain)
    expect(frozen.systemPrompt).toBe('Do celular.')
    expect(frozen.model).toBe('modelo-do-pc')
    expect(cfgOf((await plainOf(desk, 'chat', 'c-antigo'))!.plain).model).toBe('modelo-novo')
  }, 120_000)
})
