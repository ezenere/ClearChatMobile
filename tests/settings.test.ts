// Fase 5 (Node, servidor falso): Configurações no celular — formulário do provedor (porta do
// desktop), patch LWW por campo com `config` da persona chave a chave (inclusive chaves removidas),
// buscadores do web_search (= webSearchConfig do desktop) e o SettingsService gravando provedores,
// personas, settings e memórias pela outbox LWW: o "desktop" vê, edições concorrentes se mesclam
// (§7.5), a exclusão vence, offline fica na outbox e sobe depois.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mergeLww } from '../src/data/lww'
import { openRecord } from '../src/crypto'
import {
  draftToInput,
  draftWithBaseUrl,
  draftWithKind,
  engineStates,
  enginesValue,
  lwwPatch,
  maskApiKey,
  parseHeaders,
  presetPlain,
  providerDraft,
  providerPlain,
  withEngineKey
} from '../src/settings/records'
import { SettingsService } from '../src/settings/service'
import { DEFAULT_ENGINES } from '../src/vendor/shared/webSearchSettings'
import { makeHarness, until, type Harness } from './hostHarness'

describe('registros das Configurações (puro)', () => {
  it('formulário do provedor: tipo ↔ URL/nome padrão, headers, validação', () => {
    const d = providerDraft()
    expect(d).toMatchObject({ kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' })
    const a = draftWithKind(d, 'anthropic')
    expect(a).toMatchObject({
      kind: 'anthropic',
      name: 'Anthropic',
      baseUrl: 'https://api.anthropic.com/v1'
    })
    // URL própria não é trocada pelo tipo; sem tipo escolhido, a URL sugere o tipo
    const custom = draftWithKind({ ...a, baseUrl: 'http://10.0.0.2:8080/v1' }, 'openai')
    expect(custom.baseUrl).toBe('http://10.0.0.2:8080/v1')
    expect(
      draftWithBaseUrl({ ...d, kindTouched: false }, 'https://api.anthropic.com/v1').kind
    ).toBe('anthropic')
    expect(parseHeaders('{"X-A":"1"}')).toEqual({ 'X-A': '1' })
    expect(parseHeaders('[1]')).toBe('Deve ser um objeto JSON')
    expect(parseHeaders('{"a":1}')).toMatch(/string/)
    expect(draftToInput({ ...d, baseUrl: 'ftp://x' })).toMatch(/http/)
    expect(draftToInput({ ...d, name: ' ' })).toMatch(/nome/)
    expect(draftToInput({ ...d, apiKey: 'sk a' })).toMatch(/espaços/)
    expect(draftToInput({ ...d, baseUrl: 'https://x.dev/v1///', apiKey: ' sk-1 ' })).toMatchObject({
      baseUrl: 'https://x.dev/v1',
      apiKey: 'sk-1'
    })
    expect(maskApiKey('sk-or-v1-abcdef123456')).toBe('•••• 3456')
    expect(maskApiKey('')).toBeNull()
  })

  it('plaintext do provedor preserva campos desconhecidos e o createdAt', () => {
    const prev = { sv: 1, name: 'A', futuro: 'x', createdAt: 5 }
    const p = providerPlain(
      { name: 'B', kind: 'openai', baseUrl: 'https://x/v1/', apiKey: 'k', headers: {} },
      prev,
      99
    )
    expect(p).toEqual({
      sv: 1,
      name: 'B',
      futuro: 'x',
      kind: 'openai',
      baseUrl: 'https://x/v1',
      apiKey: 'k',
      headers: {},
      createdAt: 5
    })
  })

  it('patch LWW: config chave a chave, chaves removidas acumuladas e o merge sobre o servidor', () => {
    const prev = presetPlain(
      { name: 'P', description: '', icon: 'bot', config: { model: 'm1', providerId: 'p1' } },
      null,
      1
    )
    // "Usar o padrão": tira provedor/modelo
    const next = { ...prev, config: {}, updatedAt: 2 }
    const p1 = lwwPatch(prev, next, null)
    expect(p1).toEqual({ updatedAt: 2, __configUnset: ['model', 'providerId'] })
    // depois (ainda sem enviar) liga o system prompt e volta a definir o modelo
    const next2 = { ...next, config: { systemPrompt: 'oi', model: 'm2' }, updatedAt: 3 }
    const p2 = lwwPatch(next, next2, p1)
    expect(p2).toEqual({
      updatedAt: 3,
      config: { systemPrompt: 'oi', model: 'm2' },
      __configUnset: ['providerId']
    })
    // o servidor mudou outra chave e o nome no meio: os dois lados ficam
    const server = {
      ...prev,
      name: 'Do PC',
      config: { ...(prev.config as object), params: { top_p: 1 } }
    }
    expect(mergeLww(server, p2)).toEqual({
      ...server,
      updatedAt: 3,
      config: { model: 'm2', params: { top_p: 1 }, systemPrompt: 'oi' }
    })
    // registro novo: a config inteira vai no patch
    expect(lwwPatch(null, prev, null).config).toEqual(prev.config)
  })

  it('persona: config sanitizada e sem cwd (§4.4)', () => {
    const p = presetPlain(
      {
        name: '  Revisor ',
        description: ' d ',
        icon: 'code',
        config: { cwd: '/home/x', model: 'm', presetId: 'x', bogus: 1 } as never
      },
      null,
      7
    )
    expect(p).toMatchObject({ name: 'Revisor', description: 'd', createdAt: 7, updatedAt: 7 })
    expect(p.config).toEqual({ model: 'm' })
  })

  it('buscadores: chave obrigatória para ligar API, sem chave → desligado', () => {
    const list = engineStates(undefined, undefined)
    expect(list.map((e) => e.id)).toEqual(DEFAULT_ENGINES.map((e) => e.id))
    expect(list.find((e) => e.id === 'brave-site')!.desktopOnly).toBe(true)
    const on = list.map((e) => (e.id === 'tavily' ? { ...e, enabled: true } : e))
    expect(enginesValue(on, {})).toMatch(/chave de API para habilitar o Tavily/)
    const withKey = withEngineKey('tavily', ' tvly-123456789 ', {}, on)
    if (typeof withKey === 'string') throw new Error(withKey)
    expect(withKey.keys).toEqual({ tavily: 'tvly-123456789' })
    const v = enginesValue(on, withKey.keys)
    if (typeof v === 'string') throw new Error(v)
    expect(v.find((e) => e.id === 'tavily')!.enabled).toBe(true)
    expect(engineStates(v, withKey.keys).find((e) => e.id === 'tavily')!.keyMask).toBe('tvly-…6789')
    // apagar a chave desliga o buscador e remove o setting
    const cleared = withEngineKey('tavily', '', withKey.keys, v)
    if (typeof cleared === 'string') throw new Error(cleared)
    expect(cleared.keys).toBeNull()
    expect(cleared.engines.find((e) => e.id === 'tavily')!.enabled).toBe(false)
    expect(withEngineKey('ddg', 'x', {}, v)).toMatch(/não usa chave/)
    expect(withEngineKey('exa', 'a b', {}, v)).toMatch(/espaços/)
  })
})

describe('SettingsService (servidor falso)', () => {
  let h: Harness
  let s: SettingsService
  let ids = 0
  beforeEach(async () => {
    h = await makeHarness()
    s = new SettingsService({
      store: h.store,
      writer: h.stack.memory.writer,
      memory: h.stack.memory.index,
      uuid: () => `id-${++ids}`
    })
  })
  afterEach(async () => {
    await h.close()
  })

  const flushed = () => until(() => !h.stack.memory.writer.pending(), 5000, 'outbox LWW')
  const serverPlain = async (type: string, id: string) => {
    const r = h.server.records.get(`${type}|${id}`)
    if (!r || r.deleted || !r.env) return null
    return openRecord(h.desk.sk.record, h.server.userId, r, r.env)
  }

  it('provedor: cria, edita, mescla com o PC e apaga', async () => {
    const id = s.saveProvider({
      name: 'Meu OpenAI',
      kind: 'openai',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'sk-test-0001',
      headers: { 'X-A': '1' }
    })
    expect(s.providers().map((p) => p.name)).toContain('Meu OpenAI')
    await flushed()
    expect(await serverPlain('provider', id)).toMatchObject({
      sv: 1,
      name: 'Meu OpenAI',
      kind: 'openai',
      apiKey: 'sk-test-0001',
      headers: { 'X-A': '1' }
    })
    // o PC troca a URL; o celular, sem ter puxado, troca o nome → os dois campos ficam (§7.5)
    const cur = (await serverPlain('provider', id))!
    await h.desk.put('provider', id, null, { ...cur, baseUrl: 'http://127.0.0.1:10/v1' })
    s.saveProvider(
      {
        name: 'Renomeado',
        kind: 'openai',
        baseUrl: 'http://127.0.0.1:9/v1',
        apiKey: 'sk-test-0001',
        headers: { 'X-A': '1' }
      },
      id
    )
    await flushed()
    expect(await serverPlain('provider', id)).toMatchObject({
      name: 'Renomeado',
      baseUrl: 'http://127.0.0.1:10/v1'
    })
    expect(h.store.getPlain('provider', id)).toMatchObject({ baseUrl: 'http://127.0.0.1:10/v1' })
    s.deleteProvider(id)
    expect(s.provider(id)).toBeNull()
    await flushed()
    expect(h.server.records.get(`provider|${id}`)?.deleted).toBe(true)
  })

  it('persona: criar, "usar o padrão" offline enquanto o PC muda o prompt, duplicar e apagar a padrão', async () => {
    const p = s.savePreset({
      name: 'Revisor',
      description: 'revisa',
      icon: 'code',
      config: { providerId: h.providerId, model: 'fake/a', systemPrompt: 'v1' }
    })
    s.setSetting('defaultPresetId', p.id)
    await flushed()
    expect(await serverPlain('setting', 'defaultPresetId')).toEqual({ sv: 1, value: p.id })
    // o PC muda o system prompt
    const cur = (await serverPlain('preset', p.id))!
    await h.desk.put('preset', p.id, null, {
      ...cur,
      config: { ...(cur.config as object), systemPrompt: 'do PC' },
      updatedAt: Date.now()
    })
    // o celular, offline, tira o modelo próprio
    h.server.offline = true
    const { providerId: _p, model: _m, ...rest } = p.config
    s.savePreset({ name: p.name, description: p.description, icon: p.icon, config: rest }, p.id)
    expect(s.preset(p.id)!.config.model).toBeUndefined()
    await new Promise((r) => setTimeout(r, 80))
    expect(h.stack.memory.writer.pending()).toBe(true)
    h.server.offline = false
    h.stack.memory.writer.resume()
    await flushed()
    const merged = (await serverPlain('preset', p.id))!
    expect(merged.config).toEqual({ systemPrompt: 'do PC' })
    // duplicar → nome "(cópia)"; apagar a padrão → defaultPresetId volta a null
    const copy = s.duplicatePreset(p.id)
    expect(copy.name).toBe('Revisor (cópia)')
    s.deletePreset(p.id)
    await flushed()
    expect(h.server.records.get(`preset|${p.id}`)?.deleted).toBe(true)
    expect(await serverPlain('setting', 'defaultPresetId')).toEqual({ sv: 1, value: null })
    expect(s.presets().map((x) => x.name)).toContain('Revisor (cópia)')
  })

  it('setting: LWW inteiro (a escrita do celular, que chega depois, vence)', async () => {
    await h.desk.put('setting', 'autoTitle', null, {
      sv: 1,
      value: { providerId: 'x', model: 'pc', useMemory: true, maxTokens: 30, prompt: null }
    })
    // o celular grava sem ter puxado a do PC
    s.setSetting('autoTitle', {
      providerId: h.providerId,
      model: 'cel',
      useMemory: false,
      maxTokens: 40,
      prompt: null
    })
    await flushed()
    expect((await serverPlain('setting', 'autoTitle'))!.value).toMatchObject({
      model: 'cel',
      useMemory: false
    })
    // valor igual não gera revisão
    const rev = h.server.records.get('setting|autoTitle')!.rev
    s.setSetting('autoTitle', s.setting('autoTitle'))
    await flushed()
    expect(h.server.records.get('setting|autoTitle')!.rev).toBe(rev)
  })

  it('pesquisa na web: chave e lista sobem como os dois settings do desktop', async () => {
    expect(() =>
      s.setEngines(s.engines().map((e) => (e.id === 'exa' ? { ...e, enabled: true } : e)))
    ).toThrow(/chave de API/)
    s.setEngineKey('exa', 'exa-key-12345')
    s.setEngines(s.engines().map((e) => (e.id === 'exa' ? { ...e, enabled: true } : e)))
    s.setSearchInterval(2.25)
    await flushed()
    expect((await serverPlain('setting', 'webSearchApiKeys'))!.value).toEqual({
      exa: 'exa-key-12345'
    })
    const engines = (await serverPlain('setting', 'webSearchEngines'))!.value as {
      id: string
      enabled: boolean
    }[]
    expect(engines.find((e) => e.id === 'exa')!.enabled).toBe(true)
    expect((await serverPlain('setting', 'webSearchMinIntervalSec'))!.value).toBe(2.3)
    s.setEngineKey('exa', null)
    await flushed()
    expect((await serverPlain('setting', 'webSearchApiKeys'))!.value).toBeNull()
    expect(s.engines().find((e) => e.id === 'exa')!.enabled).toBe(false)
  })

  it('memórias à mão: coleção + memória sobem; editar; apagar a coleção leva as memórias', async () => {
    const col = s.createCollection({ category: 'people', name: 'Família', description: 'gente' })
    const m = s.createMemory({ collectionId: col.id, title: 'Rex', summary: 'o cachorro' })
    expect(s.memories(col.id).map((x) => x.title)).toEqual(['Rex'])
    await flushed()
    expect(await serverPlain('memory_collection', col.id)).toMatchObject({
      category: 'people',
      name: 'Família'
    })
    expect(await serverPlain('memory', m.id)).toMatchObject({
      collectionId: col.id,
      title: 'Rex',
      slug: 'rex',
      updatedBy: 'user'
    })
    s.updateMemory(m.id, { facts: ['Late para o carteiro'], pinned: true })
    await flushed()
    expect(await serverPlain('memory', m.id)).toMatchObject({
      facts: ['Late para o carteiro'],
      pinned: true
    })
    expect(() => s.createMemory({ collectionId: col.id, title: '' })).toThrow()
    expect(s.searchMemories('carteiro').map((x) => x.id)).toEqual([m.id])
    s.deleteCollection(col.id)
    expect(s.collections().find((c) => c.id === col.id)).toBeUndefined()
    expect(s.memory(m.id)).toBeNull()
    await flushed()
    expect(h.server.records.get(`memory_collection|${col.id}`)?.deleted).toBe(true)
  })
})
