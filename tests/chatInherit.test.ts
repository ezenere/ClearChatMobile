// Herança ao vivo da persona no celular (protocolo 1.10.0, SYNC_PROTOCOL.md §4.3.6, §7.5, §7.7,
// §23.7): config efetiva no host do celular, Novo chat com `overrides` só do que mudou, voltar a
// herdar, trocar de persona e "Nenhuma", migração dos chats antigos depois do pull, congelamento
// antes do tombstone da persona (e ao recebê-lo) e o merge por unidade de `overrides` — no
// `rev_mismatch` do push e no pull com edição local pendente (a base guardada na outbox). Tools de
// um tipo de aparelho (§4.3.6): o Novo chat não marca nada por causa do aparelho, o celular roda o
// chat sem as tools do computador e a migração só as marca próprias se o chat rodou num computador.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyChatConfigPatch, withoutUnits, type InheritConfig } from '@shared/chatInherit'
import type { ToolName } from '@shared/types'
import { openRecord } from '../src/crypto'
import { mergeChat3, mergeChatRecord } from '../src/data/chatMerge'
import { effectiveConfigOf, followersByPreset, patchContextOf } from '../src/data/inherit'
import { finalizeNewChat, presetFromPlain, resolveNewChat } from '../src/host/newChat'
import { SettingsService } from '../src/settings/service'
import { personaPatch, revertPatch } from '../src/chat/inheritUi'
import { makeHarness, until, type Harness } from './hostHarness'

let h: Harness
beforeEach(async () => {
  h = await makeHarness()
})
afterEach(async () => {
  await h.close()
})

const preset = (id: string, name: string, config: Record<string, unknown>) =>
  h.desk.put('preset', id, null, {
    sv: 1,
    name,
    description: '',
    icon: 'sparkles',
    config,
    createdAt: 1,
    updatedAt: 1
  })

const serverPlain = async (type: string, id: string) => {
  const r = h.server.records.get(`${type}|${id}`)
  if (!r || r.deleted || !r.env) return null
  return openRecord(h.desk.sk.record, h.server.userId, r, r.env)
}

const P1 = () => ({
  providerId: h.providerId,
  model: 'fake/persona',
  systemPrompt: 'Seja breve.',
  enabledTools: ['web_search', 'ask_user', 'shell'] as ToolName[],
  params: { temperature: 0.3 }
})

/** Novo chat pela mesma lógica da tela (persona → form → finalize → repo). */
function newChatFromForm(
  presetId: string,
  pick: (base: ReturnType<typeof resolveNewChat>) => Partial<Parameters<typeof finalizeNewChat>[1]>
) {
  const p = presetFromPlain(presetId, h.store.getPlain('preset', presetId)!)
  const providers = h.stack.providers()
  const base = resolveNewChat(
    {
      defaultModel: h.store.setting('defaultModel') ?? null,
      defaultSystemPrompt: h.store.setting<string>('defaultSystemPrompt') ?? null
    },
    providers,
    p
  )
  const cfg = finalizeNewChat(
    base,
    {
      providerId: base.providerId,
      model: base.model,
      params: base.params ?? {},
      tools: base.enabledTools,
      presetId,
      ...pick(base)
    },
    providers
  )
  return h.stack.repo.createChat({ config: cfg })
}

const ownOf = (chatId: string) => Object.keys(h.stack.repo.record(chatId)!.overrides ?? {}).sort()
const flushChat = async (chatId: string) => {
  await h.stack.writer.flushNow(chatId)
  await until(() => !h.stack.writer.pending(chatId), 5000, 'outbox do chat')
}

describe('Novo chat, config efetiva no host, voltar a herdar, trocar de persona', () => {
  it('overrides só do que mudou no formulário (nada por causa do aparelho); a persona muda o chat ao vivo; o host roda com a efetiva sem as tools do computador', async () => {
    await preset('p1', 'Revisora', P1())
    await h.engine.sync()
    const { chat, session } = newChatFromForm('p1', (b) => ({
      params: { ...b.params, temperature: 0.7 }
    }))
    const rec = h.stack.repo.record(chat.id)!
    expect(rec.presetId).toBe('p1')
    // só a temperatura mudada no formulário; o resto herda — o shell da persona inclusive (§4.3.6)
    expect(ownOf(chat.id)).toEqual(['params.temperature'])
    expect(rec.voice).toBeUndefined()
    expect(h.store.getPlain('chat', chat.id)!.config).not.toHaveProperty('cwd')
    // cópia informativa completa
    expect(rec.systemPrompt).toBe('Seja breve.')
    expect(rec.model).toBe('fake/persona')

    // a persona muda (em outro dispositivo): os campos herdados acompanham, os próprios não
    await preset('p1', 'Revisora', {
      ...P1(),
      model: 'fake/persona-2',
      systemPrompt: 'Seja muito breve.',
      params: { temperature: 0.1, top_p: 0.5 }
    })
    await h.engine.sync()
    const eff = h.stack.repo.chat(chat.id)!.config
    expect(eff.model).toBe('fake/persona-2')
    expect(eff.systemPrompt).toBe('Seja muito breve.')
    expect(eff.params).toEqual({ temperature: 0.7, top_p: 0.5 })
    // a lista é a mesma em todo aparelho: o shell da persona continua nela (o celular só não o roda)
    expect(eff.enabledTools).toContain('shell')
    // a cópia não é regravada a cada edição da persona
    expect(h.stack.repo.record(chat.id)!.model).toBe('fake/persona')

    // o host do celular roda com a efetiva (modelo e system prompt da persona nova)
    await h.stack.host.local(chat.id, 'send', { sessionId: session.id, text: 'olá' })
    await until(() => !h.stack.runner.isRunning(session.id), 10_000, 'turno')
    const req = h.llm.requests.filter((r) => r.path.endsWith('/chat/completions')).pop()!
    expect(req.body.model).toBe('fake/persona-2')
    expect(JSON.stringify(req.body.messages)).toContain('Seja muito breve.')
    expect(req.body.temperature).toBe(0.7)
    // só as tools que o celular executa vão ao modelo (as do computador ficam de fora, §4.3.6)
    const sent = (r: { body: Record<string, unknown> }) =>
      ((r.body.tools as { function: { name: string } }[]) ?? []).map((t) => t.function.name)
    expect(sent(req)).toEqual(['web_search', 'ask_user'])
    // seguir a persona conta para "N chats seguem"
    expect(followersByPreset(h.store).get('p1')).toBe(1)

    // mais tools locais herdadas da persona: o celular continua hospedando o chat, sem elas
    await preset('p1', 'Revisora', {
      ...P1(),
      enabledTools: ['web_search', 'shell', 'read_file'] as ToolName[]
    })
    await h.engine.sync()
    await h.stack.host.local(chat.id, 'send', { sessionId: session.id, text: 'de novo' })
    await until(() => !h.stack.runner.isRunning(session.id), 10_000, 'turno 2')
    const req2 = h.llm.requests.filter((r) => r.path.endsWith('/chat/completions')).pop()!
    expect(sent(req2)).toEqual(['web_search'])
    expect(JSON.stringify(req2.body)).not.toMatch(/read_file|"shell"/)
    // nada virou próprio por causa do aparelho
    expect(ownOf(chat.id)).toEqual(['params.temperature'])
  })

  it('editar → própria; voltar a herdar → segue a persona (cópia atualizada); trocar de persona mantém as próprias; "Nenhuma" congela', async () => {
    await preset('p1', 'Revisora', P1())
    await preset('p2', 'Poeta', {
      providerId: h.providerId,
      model: 'fake/poeta',
      systemPrompt: 'Rime.',
      params: { temperature: 1.2 }
    })
    await h.engine.sync()
    const { chat } = newChatFromForm('p1', () => ({}))
    expect(ownOf(chat.id)).toEqual([])
    // edição na tela (sem `overrides`) → a unidade tocada vira própria
    h.stack.repo.updateChat(chat.id, { config: { systemPrompt: 'Meu prompt.' } })
    h.stack.repo.updateChat(chat.id, { config: { params: { temperature: 0.9 } } })
    expect(ownOf(chat.id)).toEqual(['params.temperature', 'systemPrompt'])
    expect(h.stack.repo.chat(chat.id)!.config.systemPrompt).toBe('Meu prompt.')

    // voltar a herdar (o patch que a tela/o controle remoto mandam)
    const rec = h.stack.repo.record(chat.id)!
    h.stack.repo.updateChat(chat.id, { config: revertPatch(rec, ['params.temperature']) })
    expect(ownOf(chat.id)).toEqual(['systemPrompt'])
    expect(h.stack.repo.record(chat.id)!.params).toEqual({ temperature: 0.3 })

    // trocar de persona: as próprias ficam; as herdadas seguem a nova
    h.stack.repo.updateChat(chat.id, { config: personaPatch('p2') })
    let eff = h.stack.repo.chat(chat.id)!.config
    expect(eff.presetId).toBe('p2')
    expect(ownOf(chat.id)).toEqual(['systemPrompt'])
    expect(eff.model).toBe('fake/poeta')
    expect(eff.params).toEqual({ temperature: 1.2 })
    expect(eff.systemPrompt).toBe('Meu prompt.')

    // "Nenhuma" = congelar: valores atuais gravados, sem presetId, overrides mantido
    h.stack.repo.updateChat(chat.id, { config: personaPatch(null) })
    const frozen = h.stack.repo.record(chat.id)!
    expect(frozen.presetId).toBeUndefined()
    expect(frozen.model).toBe('fake/poeta')
    expect(ownOf(chat.id)).toEqual(['systemPrompt'])
    await preset('p2', 'Poeta', { providerId: h.providerId, model: 'fake/outro' })
    await h.engine.sync()
    eff = h.stack.repo.chat(chat.id)!.config
    expect(eff.model).toBe('fake/poeta')
    // e sobe sem presetId
    await flushChat(chat.id)
    const sp = (await serverPlain('chat', chat.id))!
    expect((sp.config as InheritConfig).presetId).toBeUndefined()
    expect((sp.config as InheritConfig).overrides).toEqual({ systemPrompt: true })
  })

  it('padrões de "Novos chats" mudam os chats cuja persona não define o campo', async () => {
    await preset('p0', 'Sem modelo', { systemPrompt: 'Oi.' })
    await h.desk.put('setting', 'defaultModel', null, {
      sv: 1,
      value: { providerId: h.providerId, model: 'fake/padrao' }
    })
    await h.engine.sync()
    const { chat } = newChatFromForm('p0', () => ({}))
    expect(ownOf(chat.id)).not.toContain('model')
    // a persona não escolhe as tools: todas herdam o padrão do app (as do computador e as do
    // celular inclusive) — nenhuma vira própria por causa do aparelho (antes: ~15 "neste chat")
    expect(ownOf(chat.id)).toEqual([])
    const tools = h.stack.repo.chat(chat.id)!.config.enabledTools
    expect(tools).toEqual(expect.arrayContaining(['shell', 'read_file', 'get_location']))
    expect(h.stack.repo.chat(chat.id)!.config.model).toBe('fake/padrao')
    await h.desk.put('setting', 'defaultModel', null, {
      sv: 1,
      value: { providerId: h.providerId, model: 'fake/padrao-2' }
    })
    await h.engine.sync()
    expect(h.stack.repo.chat(chat.id)!.config.model).toBe('fake/padrao-2')
  })
})

describe('migração dos chats antigos (depois do pull completo)', () => {
  it('iguais à persona passam a herdar, diferentes ficam próprios; sobe o registro com overrides', async () => {
    await preset('p1', 'Revisora', {
      ...P1(),
      voice: { enabled: true, voicePrompt: 'Fale curto.', model: null, tools: null, fillers: null }
    })
    // chat de um app < 1.10.0: cópia da persona com o system prompt mudado
    await h.desk.put('chat', 'c-old', 'c-old', {
      sv: 1,
      title: 'Antigo',
      config: {
        ...P1(),
        systemPrompt: 'Mudado no chat.',
        presetId: 'p1',
        cacheEnabled: false,
        voice: {
          enabled: true,
          voicePrompt: 'Fale curto.',
          model: null,
          tools: null,
          fillers: null
        }
      },
      mainSessionId: 's-old',
      createdAt: 5,
      updatedAt: 5
    })
    await h.engine.sync()
    const rec = h.stack.repo.record('c-old')!
    expect(rec.overrides).toEqual({ systemPrompt: true })
    // na voz, campos iguais aos da persona → null (herdam)
    expect(rec.voice?.voicePrompt).toBeNull()
    expect(rec.voice?.enabled).toBeNull()
    await flushChat('c-old')
    const sp = (await serverPlain('chat', 'c-old'))!
    expect((sp.config as InheritConfig).overrides).toEqual({ systemPrompt: true })
    expect(sp.updatedAt).toBe(5) // a ordem da lista não muda
    // a migração é única: com `overrides` não roda de novo
    expect(h.stack.migrateInheritance()).toEqual([])
    // persona que não existe aqui: nada a migrar (vale a cópia)
    await h.desk.put('chat', 'c-orfao', 'c-orfao', {
      sv: 1,
      title: 'Órfão',
      config: { ...P1(), presetId: 'p-nao-existe' },
      mainSessionId: 's',
      createdAt: 6,
      updatedAt: 6
    })
    await h.engine.sync()
    expect(h.stack.repo.record('c-orfao')!.overrides).toBeUndefined()
    expect(h.stack.repo.chat('c-orfao')!.config.model).toBe('fake/persona')
  })
})

describe('migração: tools de um tipo de aparelho (§4.3.6)', () => {
  it('a diferença numa tool do computador só vira própria se o chat rodou num computador (hostCwd)', async () => {
    // persona sem tools: herda o padrão do app (todas, as do computador e as do celular)
    await preset('p0', 'Padrão', { providerId: h.providerId, model: 'fake/persona' })
    const old = (id: string, tools: string[], extra: Record<string, unknown> = {}) =>
      h.desk.put('chat', id, id, {
        sv: 1,
        title: id,
        config: {
          providerId: h.providerId,
          model: 'fake/persona',
          presetId: 'p0',
          cacheEnabled: false, // o herdado do provedor falso (openai)
          enabledTools: tools
        },
        mainSessionId: `s-${id}`,
        createdAt: 5,
        updatedAt: 5,
        ...extra
      })
    // chat de um celular antigo: só as tools que ele roda, com a localização desligada
    const phoneTools = ['web_search', 'browse_url', 'list_models', 'delegate_task', 'get_chat_info']
    await old('c-cel', [
      ...phoneTools,
      'list_chats',
      'send_to_chat',
      'read_history',
      'check_subagents',
      'wait_subagents',
      'cancel_subagent',
      'message_subagent',
      'ask_user',
      'nearby_places'
    ])
    // chat de um desktop antigo: rodou num computador (hostCwd), shell desligado, sem as do celular
    const deskTools = [
      'list_dir',
      'read_file',
      'search_files',
      'find_files',
      'present_file',
      'write_file',
      'edit_file',
      'process_start',
      'process_logs',
      'process_list',
      'process_stop',
      'web_search',
      'browse_url',
      'list_models',
      'delegate_task',
      'get_chat_info',
      'list_chats',
      'send_to_chat',
      'read_history',
      'check_subagents',
      'wait_subagents',
      'cancel_subagent',
      'message_subagent',
      'ask_user'
    ]
    await old('c-pc', deskTools, { hostCwd: { deviceId: 'pc', path: '/home/ana/proj' } })
    await h.engine.sync()
    // celular: as do computador passam a herdar (ele roda sem elas); a localização desligada fica
    expect(h.stack.repo.record('c-cel')!.overrides).toEqual({ 'enabledTools.get_location': true })
    const cel = h.stack.repo.chat('c-cel')!.config.enabledTools
    expect(cel).toEqual(expect.arrayContaining(['shell', 'read_file', 'nearby_places']))
    expect(cel).not.toContain('get_location')
    // computador: o shell desligado é escolha do chat; as do celular passam a herdar
    expect(h.stack.repo.record('c-pc')!.overrides).toEqual({ 'enabledTools.shell': true })
    const pc = h.stack.repo.chat('c-pc')!.config.enabledTools
    expect(pc).not.toContain('shell')
    expect(pc).toEqual(expect.arrayContaining(['get_location', 'nearby_places']))
    // "voltar a herdar tudo" no chat do celular: tudo herda e o celular continua hospedando
    const rec = h.stack.repo.record('c-cel')!
    h.stack.repo.updateChat('c-cel', { config: revertPatch(rec, ['enabledTools.get_location']) })
    expect(ownOf('c-cel')).toEqual([])
    expect(h.stack.repo.chat('c-cel')!.config.enabledTools).toContain('get_location')
  })
})

describe('limpeza única das tools marcadas por causa do aparelho (§4.3.6)', () => {
  it('depois do pull completo, uma vez: tira as marcas de tools de um tipo de aparelho em que o chat nunca rodou e envia', async () => {
    await preset('p0', 'Padrão', { providerId: h.providerId, model: 'fake/persona' })
    // chats como os builds de teste de 1.10.0 gravavam: as do computador desligadas e a
    // localização ligada como próprias por causa do aparelho
    const noisyCfg = {
      providerId: h.providerId,
      model: 'fake/persona',
      presetId: 'p0',
      cacheEnabled: false,
      enabledTools: ['web_search', 'ask_user', 'get_location', 'nearby_places'],
      overrides: {
        'enabledTools.shell': true,
        'enabledTools.read_file': true,
        'enabledTools.get_location': true,
        model: true
      }
    }
    const put = (id: string, extra: Record<string, unknown> = {}) =>
      h.desk.put('chat', id, id, {
        sv: 1,
        title: id,
        config: noisyCfg,
        mainSessionId: `s-${id}`,
        createdAt: 7,
        updatedAt: 7,
        ...extra
      })
    await put('c-cel') // sem hostCwd: só rodou no celular
    await put('c-pc', { hostCwd: { deviceId: 'pc', path: '/home/ana/proj' } })
    await h.engine.sync()
    // celular: as do computador saem (voltam a herdar); a do celular fica (ele rodou aqui)
    expect(ownOf('c-cel')).toEqual(['enabledTools.get_location', 'model'])
    expect(h.stack.repo.chat('c-cel')!.config.enabledTools).toEqual(
      expect.arrayContaining(['shell', 'read_file'])
    )
    // computador: a do celular sai; as do computador ficam (escolha de quem rodou lá)
    expect(ownOf('c-pc')).toEqual(['enabledTools.read_file', 'enabledTools.shell', 'model'])
    // sobe (sem mexer no updatedAt)
    await flushChat('c-cel')
    const sp = (await serverPlain('chat', 'c-cel'))!
    expect(Object.keys((sp.config as InheritConfig).overrides ?? {}).sort()).toEqual([
      'enabledTools.get_location',
      'model'
    ])
    expect(sp.updatedAt).toBe(7)
    // uma vez por aparelho: um chat marcado que chega depois fica como está
    await put('c-depois')
    await h.engine.sync()
    expect(ownOf('c-depois')).toEqual([
      'enabledTools.get_location',
      'enabledTools.read_file',
      'enabledTools.shell',
      'model'
    ])
    expect(h.stack.cleanupDeviceOverrides('account')).toEqual([])
    // o escopo sem conta (inicialização em "Usar sem conta") é outro: roda uma vez também
    expect(h.stack.cleanupDeviceOverrides('local')).toEqual(['c-depois'])
    expect(h.stack.cleanupDeviceOverrides('local')).toEqual([])
  })
})

describe('persona apagada: congelar antes do tombstone (§7.7)', () => {
  it('apagada aqui: os chats congelam e sobem ANTES do tombstone da persona', async () => {
    await preset('p1', 'Revisora', P1())
    await h.engine.sync()
    const { chat } = newChatFromForm('p1', () => ({}))
    await flushChat(chat.id)
    const s = new SettingsService({
      store: h.store,
      writer: h.stack.memory.writer,
      memory: h.stack.memory.index,
      freezePresetChats: (id) => void h.stack.freezePresetChats(id)
    })
    const before = h.server.pushes.length
    s.deletePreset('p1')
    const rec = h.stack.repo.record(chat.id)!
    expect(rec.presetId).toBeUndefined()
    expect(rec.systemPrompt).toBe('Seja breve.')
    expect(rec.overrides).toEqual({})
    expect(h.store.frozenPending('p1')).toEqual([chat.id])
    await until(
      () => !h.stack.memory.writer.pending() && !h.stack.writer.pending(chat.id),
      8000,
      'outboxes'
    )
    const pushes = h.server.pushes.slice(before)
    const chatAt = pushes.findIndex((p) =>
      p.items.some((i) => i.type === 'chat' && i.id === chat.id)
    )
    const tombAt = pushes.findIndex((p) =>
      p.items.some((i) => i.type === 'preset' && i.id === 'p1' && i.deleted)
    )
    expect(chatAt).toBeGreaterThanOrEqual(0)
    expect(tombAt).toBeGreaterThan(chatAt)
    expect(((await serverPlain('chat', chat.id))!.config as InheritConfig).presetId).toBeUndefined()
  })

  it('tombstone recebido: congela com a cópia local e reenvia o chat', async () => {
    await preset('p1', 'Revisora', P1())
    await h.engine.sync()
    const { chat } = newChatFromForm('p1', () => ({}))
    await flushChat(chat.id)
    await preset('p1', 'Revisora', { ...P1(), systemPrompt: 'Versão final.' })
    await h.engine.sync()
    h.desk.del('preset', 'p1', null)
    await h.engine.sync()
    const rec = h.stack.repo.record(chat.id)!
    expect(rec.presetId).toBeUndefined()
    expect(rec.systemPrompt).toBe('Versão final.')
    await flushChat(chat.id)
    const sp = (await serverPlain('chat', chat.id))!.config as InheritConfig
    expect(sp.presetId).toBeUndefined()
    expect(sp.systemPrompt).toBe('Versão final.')
  })
})

describe('merge por unidade (§7.5) — sem perder marcas nem sobrescrever valor próprio', () => {
  it('puro: overrides por unidade; cópia herdada não sobrescreve própria do servidor; voltar a herdar daqui vence', () => {
    const base = {
      title: 'x',
      config: {
        presetId: 'p1',
        model: 'm1',
        providerId: 'pv',
        systemPrompt: 'A',
        params: { temperature: 0.3 },
        overrides: { systemPrompt: true }
      }
    }
    // servidor: outro aparelho tornou o modelo próprio e mudou a temperatura (própria)
    const server = {
      title: 'x',
      config: {
        ...base.config,
        model: 'm-desk',
        params: { temperature: 0.9 },
        overrides: { systemPrompt: true, model: true, 'params.temperature': true }
      }
    }
    // local: trocou de persona (cópia das herdadas reescrita) e voltou a herdar o system prompt
    const local = {
      title: 'x',
      config: {
        presetId: 'p2',
        model: 'm2',
        providerId: 'pv',
        systemPrompt: 'P2',
        params: { temperature: 1.2 },
        overrides: {}
      }
    }
    const out = mergeChat3(server, base, local).config as InheritConfig
    expect(out.presetId).toBe('p2')
    expect(out.overrides).toEqual({ model: true, 'params.temperature': true })
    expect(out.model).toBe('m-desk') // própria do servidor, local herdava
    expect(out.params).toEqual({ temperature: 0.9 })
    expect(out.systemPrompt).toBe('P2') // o "voltar a herdar" daqui vence
    // linha antiga (sem base): merge pelos campos do patch
    expect(mergeChatRecord(server, { base: null, plain: local, patch: { title: 'y' } }).title).toBe(
      'y'
    )
  })

  it('rev_mismatch no push: as marcas dos dois aparelhos ficam', async () => {
    await preset('p1', 'Revisora', P1())
    await h.engine.sync()
    const { chat } = newChatFromForm('p1', () => ({}))
    await flushChat(chat.id)
    // outro aparelho torna o modelo próprio (o celular ainda não puxou)
    const cur = (await serverPlain('chat', chat.id))!
    const cfg = cur.config as InheritConfig
    await h.desk.put('chat', chat.id, chat.id, {
      ...cur,
      config: { ...cfg, model: 'fake/do-pc', overrides: { ...cfg.overrides, model: true } }
    })
    // o celular edita o system prompt na mesma hora
    h.stack.repo.updateChat(chat.id, { config: { systemPrompt: 'Do celular.' } })
    await flushChat(chat.id)
    const sp = (await serverPlain('chat', chat.id))!.config as InheritConfig
    expect(sp.overrides).toEqual({ model: true, systemPrompt: true })
    expect(sp.model).toBe('fake/do-pc')
    expect(sp.systemPrompt).toBe('Do celular.')
    await h.engine.sync()
    expect(h.stack.repo.chat(chat.id)!.config.model).toBe('fake/do-pc')
  })

  it('pull de uma revisão nova com edição local pendente: merge na hora, nada se perde', async () => {
    await preset('p1', 'Revisora', P1())
    await h.engine.sync()
    const { chat } = newChatFromForm('p1', () => ({}))
    await flushChat(chat.id)
    h.stack.writer.stop()
    h.stack.repo.updateChat(chat.id, { config: { params: { temperature: 0.8 } } })
    // duas revisões do PC enquanto isso (rev pula a local)
    for (const sys of ['PC 1', 'PC 2']) {
      const cur = (await serverPlain('chat', chat.id))!
      const cfg = cur.config as InheritConfig
      await h.desk.put('chat', chat.id, chat.id, {
        ...cur,
        config: { ...cfg, systemPrompt: sys, overrides: { ...cfg.overrides, systemPrompt: true } }
      })
    }
    await h.engine.sync()
    const eff = h.stack.repo.chat(chat.id)!.config
    expect(eff.systemPrompt).toBe('PC 2')
    expect(eff.params.temperature).toBe(0.8)
    expect(ownOf(chat.id)).toEqual(['params.temperature', 'systemPrompt'])
    h.stack.writer.resume()
    await flushChat(chat.id)
    const sp = (await serverPlain('chat', chat.id))!.config as InheritConfig
    expect(sp.systemPrompt).toBe('PC 2')
    expect(sp.params).toEqual({ temperature: 0.8 })
    expect(sp.overrides).toEqual({ 'params.temperature': true, systemPrompt: true })
  })
})

describe('chat.update de um chat só ao vivo (§23.7): os patches que o celular manda', () => {
  it('editar / voltar a herdar / trocar de persona / nenhuma — interpretados como o host faz', async () => {
    await preset('p1', 'Revisora', P1())
    await preset('p2', 'Poeta', { providerId: h.providerId, model: 'fake/poeta' })
    await h.engine.sync()
    const ctx = patchContextOf(h.store, null)
    // o registro como o host do PC manda no `rec` (próprios + cópia + overrides)
    let rec: InheritConfig = {
      ...effectiveConfigOf(h.store, { ...P1(), presetId: 'p1', overrides: {} }),
      cwd: ''
    }
    // trocar o modelo (patch sem overrides = edição)
    rec = applyChatConfigPatch(rec, { providerId: h.providerId, model: 'fake/outro' }, ctx)
    expect(rec.overrides).toEqual({ model: true })
    // voltar a herdar o modelo
    rec = applyChatConfigPatch(rec, revertPatch(rec, ['model']), ctx)
    expect(rec.overrides).toEqual({})
    expect(rec.model).toBe('fake/persona')
    expect(withoutUnits({ model: true, x: true }, ['model'])).toEqual({ x: true })
    // trocar de persona e "Nenhuma"
    rec = applyChatConfigPatch(rec, personaPatch('p2'), ctx)
    expect(effectiveConfigOf(h.store, rec).model).toBe('fake/poeta')
    rec = applyChatConfigPatch(rec, personaPatch(null), ctx)
    expect(rec.presetId).toBeUndefined()
    expect(rec.model).toBe('fake/poeta')
  })
})
