// Arquivo selecionado (protocolo 1.13.0 — SYNC_PROTOCOL.md §4.3.8 "Arquivo selecionado", §8.6
// `send`/`force` com `meta.openFile`) e menções `@caminho` no celular — espelho de
// e2e/openFile.test.ts e e2e/pathMentions.test.ts do desktop, sem chamada paga:
// (A) peças puras da tela: linha "Arquivo selecionado" com o texto exato, `@caminho` fora de
//     código, pasta-mãe, chip do composer, listagem pasta a pasta do popup, seleção por chat;
// (B) a request do celular como HOST (buildRequest, pura): turno OpenAI-compatível com e sem cache,
//     Anthropic, busca nativa, subagente, turno de voz, compactação (full/trimmed/tail), extração
//     de memórias, meta inválido — o histórico salvo nunca muda;
// (C) o host real com o provedor falso: `meta.openFile` do `send`/`force` validado e guardado como
//     veio (o celular não tem raiz), o texto na request de todos os turnos seguintes, a fila, o
//     repasse na troca de host e a "nova versão" que mantém o arquivo;
// (D) tocar num caminho citado num chat de outro dispositivo: confere pela listagem do host antes
//     de abrir (arquivo → visualizador, pasta → aba Arquivos, ausente/host fora → aviso).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  OPEN_FILE_PATH_MAX,
  openFileText,
  sendMetaOpenFile,
  withOpenFiles
} from '../src/vendor/shared/openFile'
import { applyMention, filterMentionIndex } from '../src/vendor/shared/pathMentions'
import type {
  ApiMessage,
  Chat,
  ChatConfig,
  MessageMeta,
  Provider,
  StoredMessage,
  ToolName
} from '../src/vendor/shared/types'
import type { RemoteDirResult } from '../src/vendor/shared/remoteFs'
import type { ResolvedVoiceCall } from '../src/vendor/shared/voice'
import { DEFAULT_CHAT_CONFIG } from '../src/vendor/shared/defaults'
import { buildCompactionRequest } from '../src/vendor/desktop/agent/compaction'
import { extractionConversation } from '../src/vendor/desktop/memory/extraction'
import {
  buildRequest,
  setLocationSource,
  setMemorySources,
  setModelInfoSource,
  setNativeTestHosts,
  setToolSearchCapsSource,
  setVoiceCallSource
} from '../src/agent/request'
import {
  checkHostPath,
  mentionDirPart,
  mentionEntries,
  mentionSegments,
  openFileChipOf,
  openFileLineOf,
  openHostPath,
  parentDir,
  type HostPathRoute
} from '../src/chat/chatPaths'
import { openFileStore } from '../src/chat/openFileStore'
import { hostOpenFile, PHONE_CHAT_ROOT } from '../src/host/host'
import { openCommand, type Envelope } from '../src/remote/crypto'
import { makeHarness, until, type Harness } from './hostHarness'

const LINE = openFileText

// ---------------- (A) peças puras da tela ----------------

describe('(A) tela: linha, @caminho, chip, popup', () => {
  it('linha "Arquivo selecionado": caminho + texto EXATO do modelo; inválido/assistente → nada', () => {
    expect(LINE('src/a.ts')).toBe(
      'O usuário está com o arquivo src/a.ts selecionado; ele pode ou não estar relacionado a esta mensagem.'
    )
    expect(openFileLineOf({ openFile: { path: 'src/a.ts' } }, 'user')).toEqual({
      path: 'src/a.ts',
      label: 'Arquivo selecionado: src/a.ts',
      modelText: LINE('src/a.ts')
    })
    // o mesmo critério da request: inválido não vai ao modelo, então não aparece
    expect(openFileLineOf({ openFile: { path: 'a\nb' } }, 'user')).toBeNull()
    expect(openFileLineOf({ openFile: 'x' as never }, 'user')).toBeNull()
    expect(openFileLineOf({ openFile: { path: 'x'.repeat(OPEN_FILE_PATH_MAX + 1) } }, 'user')).toBe(
      null
    )
    expect(openFileLineOf({ openFile: { path: 'a.ts' } }, 'assistant')).toBeNull()
    expect(openFileLineOf({}, 'user')).toBeNull()
    expect(openFileLineOf(undefined, 'user')).toBeNull()
  })

  it('@caminho: destacado fora de código; e-mail, palavra solta e aspas abertas não', () => {
    expect(mentionSegments('sem nada')).toBeNull()
    expect(mentionSegments('fale com a@b.com ou @fulano')).toBeNull()
    const s = mentionSegments('veja @src/app.ts, e @"docs/meu arquivo.md" e @src/')!
    expect(
      s.filter((p) => 'mention' in p).map((p) => ('mention' in p ? p.mention.path : ''))
    ).toEqual(['src/app.ts', 'docs/meu arquivo.md', 'src/'])
    // o texto é preservado inteiro (a pontuação final fica fora do token)
    expect(s.map((p) => p.text).join('')).toBe('veja @src/app.ts, e @"docs/meu arquivo.md" e @src/')
    expect(s[1]).toMatchObject({ text: '@src/app.ts' })
    // dentro de crase / cerca nada é menção
    expect(mentionSegments('rode `cat @src/a.ts`')).toBeNull()
    expect(mentionSegments('```\n@src/a.ts\n```')).toBeNull()
    expect(mentionSegments('@"aberto sem fechar')).toBeNull()
    // começo do texto e depois de parêntese valem
    const p = mentionSegments('(@a/b.md)')!
    expect(p.find((x) => 'mention' in x)).toMatchObject({ text: '@a/b.md' })
  })

  it('pasta-mãe POSIX/Windows/relativa', () => {
    expect(parentDir('/home/u/p/a.ts')).toBe('/home/u/p')
    expect(parentDir('/a.ts')).toBe('/')
    expect(parentDir('src/a.ts')).toBe('src')
    expect(parentDir('a.ts')).toBe('')
    expect(parentDir('C:\\p\\a.ts')).toBe('C:\\p')
    expect(parentDir('C:\\a.ts')).toBe('C:\\')
    expect(parentDir('src\\a.ts')).toBe('src')
  })

  it('chip do composer: nome, caminho como vai ficar (raiz do host) e o texto exato', () => {
    expect(openFileChipOf(null)).toBeNull()
    expect(openFileChipOf({ path: '/home/u/p/src/a.ts', root: '/home/u/p' })).toEqual({
      name: 'a.ts',
      display: 'src/a.ts',
      modelText: LINE('src/a.ts')
    })
    // fora da raiz: absoluto; Windows com o separador do host
    expect(openFileChipOf({ path: '/etc/hosts', root: '/home/u/p' })?.display).toBe('/etc/hosts')
    expect(openFileChipOf({ path: 'C:\\p\\src\\b.ts', root: 'C:\\p' })).toMatchObject({
      name: 'b.ts',
      display: 'src\\b.ts'
    })
    // raiz desconhecida: como veio
    expect(openFileChipOf({ path: '/home/u/p/a.ts' })?.display).toBe('/home/u/p/a.ts')
    // inválido (controle) → sem chip
    expect(openFileChipOf({ path: '/a\u0000b' })).toBeNull()
  })

  it('popup de @: pasta do token, entradas relativas com / e o filtro vendorado; aceitar', () => {
    expect(mentionDirPart('')).toBe('')
    expect(mentionDirPart('ap')).toBe('')
    expect(mentionDirPart('src/comp')).toBe('src/')
    const r: RemoteDirResult = {
      ok: true,
      dir: '/home/u/p/src',
      root: '/home/u/p',
      confine: true,
      truncated: false,
      entries: [
        { name: 'components', kind: 'dir' },
        { name: 'app.ts', kind: 'file' },
        { name: 'compose.ts', kind: 'file' }
      ]
    }
    const entries = mentionEntries('src/', r)
    expect(entries).toEqual(['src/components/', 'src/app.ts', 'src/compose.ts'])
    expect(mentionEntries('', { ok: false, reason: 'denied', message: 'x' })).toEqual([])
    // pastas primeiro, prefixo antes de contém
    expect(filterMentionIndex(entries, 'src/comp').map((c) => c.path)).toEqual([
      'src/components/',
      'src/compose.ts'
    ])
    // pasta → `@src/components/` e o popup continua; arquivo → token + espaço
    const t = 'veja @src/comp'
    const q = { start: 5, end: t.length, query: 'src/comp', quoted: false }
    expect(applyMention(t, q, { path: 'src/components/', dir: true })).toEqual({
      text: 'veja @src/components/',
      caret: 21
    })
    expect(applyMention(t, q, { path: 'src/compose.ts', dir: false })).toEqual({
      text: 'veja @src/compose.ts ',
      caret: 21
    })
  })

  it('seleção por chat (o último aberto no visualizador do host): abrir, ×, avisar a tela', () => {
    let calls = 0
    const off = openFileStore.subscribe(() => calls++)
    expect(openFileStore.get('c1')).toBeNull()
    openFileStore.open('c1', { path: '/h/p/a.ts', root: '/h/p' })
    expect(openFileStore.get('c1')).toEqual({ path: '/h/p/a.ts', root: '/h/p' })
    // o mesmo arquivo de novo não muda nada (mesma referência)
    const ref = openFileStore.get('c1')
    openFileStore.open('c1', { path: '/h/p/a.ts', root: '/h/p' })
    expect(openFileStore.get('c1')).toBe(ref)
    expect(calls).toBe(1)
    openFileStore.open('c2', { path: '/x/b.ts' })
    expect(openFileStore.get('c2')).toEqual({ path: '/x/b.ts' })
    openFileStore.clear('c1')
    expect(openFileStore.get('c1')).toBeNull()
    expect(openFileStore.get('c2')).not.toBeNull()
    openFileStore.clear('c1')
    expect(calls).toBe(3)
    openFileStore.clear('c2')
    off()
  })
})

// ---------------- (B) request do celular como host ----------------

const GEN: Provider = {
  id: 'p1',
  name: 'Genérico',
  kind: 'openai',
  baseUrl: 'https://llm.example.com/v1',
  apiKey: 'k',
  headers: {},
  createdAt: 0
}
const ORP: Provider = {
  ...GEN,
  id: 'po',
  name: 'OR',
  kind: 'openrouter',
  baseUrl: 'https://openrouter.ai/api/v1'
}
const ANTH: Provider = {
  ...GEN,
  id: 'pa',
  name: 'Anthropic',
  kind: 'anthropic',
  baseUrl: 'https://api.anthropic.com/v1',
  apiKey: 'sk-ant-k'
}
const mkChat = (over: Partial<ChatConfig> = {}): Chat => ({
  id: 'c1',
  title: '',
  mainSessionId: 's1',
  createdAt: 0,
  updatedAt: 0,
  config: {
    ...DEFAULT_CHAT_CONFIG('', { providerId: 'p1', model: 'm', systemPrompt: 'SYS' }),
    enabledTools: [],
    envInPrompt: false,
    ...over
  }
})
let seq = 0
const sm = (message: ApiMessage, meta: MessageMeta = {}): StoredMessage => ({
  id: `m${++seq}`,
  sessionId: 's1',
  seq,
  message,
  meta,
  createdAt: 0
})
const ENV = { os: 'Android 16' }
/** Histórico de um chat do computador hospedado aqui (o arquivo veio de lá, já normalizado). */
const history = (): StoredMessage[] => [
  sm({ role: 'user', content: 'primeira' }, { openFile: { path: 'src/a.ts' } }),
  sm({ role: 'assistant', content: 'resposta' }),
  sm({ role: 'user', content: 'segunda sem arquivo' }),
  sm({ role: 'assistant', content: 'ok' }),
  sm(
    { role: 'user', content: [{ type: 'text', text: 'terceira' }] },
    { openFile: { path: '/etc/hosts' } }
  )
]
const userTexts = (msgs: any[]): string[] =>
  msgs
    .filter((m) => m.role === 'user')
    .map((m) =>
      typeof m.content === 'string'
        ? m.content
        : m.content
            .filter((p: any) => p.type === 'text')
            .map((p: any) => p.text)
            .join('|')
    )
const EXPECTED = [
  `primeira\n\n${LINE('src/a.ts')}`,
  'segunda sem arquivo',
  `terceira|${LINE('/etc/hosts')}`
]

function resetSources(): void {
  setMemorySources({ prompt: () => null, tools: () => [] })
  setLocationSource(null)
  setVoiceCallSource(() => null)
  setToolSearchCapsSource(() => ({}))
  setModelInfoSource(() => undefined)
  setNativeTestHosts([])
}

describe('(B) request do celular (host)', () => {
  beforeEach(resetSources)
  afterEach(resetSources)

  it('turno OpenAI-compatível: texto fixo só na cópia; o histórico salvo não muda', () => {
    const h = history()
    const snap = JSON.stringify(h)
    const req = buildRequest(mkChat(), { depth: 0, model: 'm' }, h, GEN, ENV)
    expect(userTexts((req.body as any).messages)).toEqual(EXPECTED)
    expect(JSON.stringify(h)).toBe(snap)
    // sem nenhum arquivo: a mesma referência (nada copiado)
    const plain = [sm({ role: 'user', content: 'x' })]
    expect(withOpenFiles(plain)).toBe(plain)
  })

  it('OpenRouter com cache: parte separada e o cache_control na última parte de texto', () => {
    const req = buildRequest(
      mkChat({ providerId: 'po', cacheEnabled: true }),
      { depth: 0, model: 'openai/gpt-x' },
      history(),
      ORP,
      ENV
    )
    const msgs = (req.body as any).messages
    const last = msgs[msgs.length - 1]
    expect(last.content[0]).toMatchObject({ type: 'text', text: 'terceira' })
    expect(last.content[1].text).toBe(LINE('/etc/hosts'))
    expect(last.content[1].cache_control).toEqual({ type: 'ephemeral' })
  })

  it('Anthropic (Messages API, sem tools): o texto fixo no conteúdo do usuário', () => {
    const req = buildRequest(
      mkChat({ providerId: 'pa' }),
      { depth: 0, model: 'claude-x' },
      history(),
      ANTH,
      ENV
    )
    expect(req.url).toBe('https://api.anthropic.com/v1/messages')
    const json = JSON.stringify((req.body as any).messages)
    expect(json).toContain(JSON.stringify(`primeira\n\n${LINE('src/a.ts')}`).slice(1, -1))
    expect(json).toContain(LINE('/etc/hosts'))
  })

  it('busca nativa de tools (1.12.0): o histórico enviado também leva o texto fixo', () => {
    const req = buildRequest(
      mkChat({
        providerId: 'pa',
        enabledTools: ['web_search', 'browse_url', 'datetime', 'shell'] as ToolName[],
        toolsFull: ['web_search'] as ToolName[]
      }),
      { depth: 0, model: 'claude-sonnet-5-5' },
      history(),
      ANTH,
      ENV
    )
    expect(req.toolSearch?.mode).toBe('native-anthropic')
    const msgs = (req.body as any).messages
    expect(JSON.stringify(msgs)).toContain(LINE('src/a.ts'))
    expect(JSON.stringify(msgs)).toContain(LINE('/etc/hosts'))
  })

  it('subagente: o histórico dele também passa pela injeção', () => {
    const h = [sm({ role: 'user', content: 'tarefa' }, { openFile: { path: 'b.md' } })]
    const req = buildRequest(mkChat(), { depth: 1, model: 'm' }, h, GEN, ENV)
    expect(userTexts((req.body as any).messages)).toEqual([`tarefa\n\n${LINE('b.md')}`])
  })

  it('turno de voz (chamada neste aparelho): mesmo histórico com o texto fixo + end_call', () => {
    const call = {
      enabled: true,
      model: null,
      tools: null,
      voicePrompt: null,
      promptMode: 'append',
      endCall: true,
      toolPhrases: false,
      audioTags: false,
      audioTagsPrompt: ''
    } as unknown as ResolvedVoiceCall
    setVoiceCallSource(() => call)
    const req = buildRequest(mkChat(), { id: 's1', depth: 0, model: 'm' }, history(), GEN, ENV)
    const b = req.body as any
    expect(userTexts(b.messages)).toEqual(EXPECTED)
    expect(JSON.stringify(b.tools)).toContain('end_call')
  })

  it('compactação (full, trimmed, tail): o resumo vê o texto fixo; o prompt de resumo não', () => {
    for (const mode of ['full', 'trimmed', 'tail'] as const) {
      const req = buildCompactionRequest(
        mkChat(),
        { id: 's1', depth: 0, model: 'm' },
        history(),
        GEN,
        'RESUMA',
        { mode, window: 100_000 },
        ENV
      )
      const u = userTexts((req.body as any).messages)
      expect(u, mode).toContain(`primeira\n\n${LINE('src/a.ts')}`)
      expect(u[u.length - 1], mode).toBe('RESUMA')
    }
  })

  it('extração de memórias (vendorada): a conversa mostra o que o modelo viu', () => {
    const c = extractionConversation(history(), 0, 'manual')
    expect(c.text).toContain(`Usuário: primeira\n\n${LINE('src/a.ts')}`)
    expect(c.text).toContain('Usuário: segunda sem arquivo')
  })

  it('meta inválido no histórico (sincronizado de fora) não vai ao modelo', () => {
    const h = [
      sm({ role: 'user', content: 'x' }, { openFile: { path: 'a\u0000b' } }),
      sm({ role: 'user', content: 'y' }, { openFile: 'nada' as never }),
      sm({ role: 'assistant', content: 'z' }, { openFile: { path: 'a.ts' } })
    ]
    const req = buildRequest(mkChat(), { depth: 0, model: 'm' }, h, GEN, ENV)
    const msgs = (req.body as any).messages
    expect(userTexts(msgs)).toEqual(['x', 'y'])
    expect(JSON.stringify(msgs)).not.toContain('selecionado')
  })
})

// ---------------- (C) host real com o provedor falso ----------------

describe('(C) host: send/force com meta.openFile', () => {
  let h: Harness
  beforeEach(async () => {
    h = await makeHarness()
  })
  afterEach(async () => {
    await h.close()
  })

  const newChat = () => {
    const { chat, session } = h.stack.repo.createChat({
      config: {
        ...DEFAULT_CHAT_CONFIG(''),
        providerId: h.providerId,
        model: 'fake/agent',
        enabledTools: ['web_search']
      }
    })
    return { chatId: chat.id, sid: session.id }
  }
  const idle = (sid: string) =>
    until(() => !h.stack.runner.isRunning(sid), 10_000, 'turno terminar')
  /** Textos das mensagens do usuário na última request (partes de texto juntadas com `|`). */
  const lastUserTexts = (): string[] => {
    const req = h.llm.requests.filter((r) => r.path.endsWith('/chat/completions')).at(-1)!
    return userTexts(req.body.messages as unknown[])
  }

  it('validação do meta: string ≤ 1024 sem controle, em qualquer meta; senão a mensagem segue sem', () => {
    expect(sendMetaOpenFile({ openFile: { path: '/home/u/p/a.ts' } })).toEqual({
      path: '/home/u/p/a.ts'
    })
    // com `kind` (inter-chat) também é lido — quem decide usar é o host
    expect(sendMetaOpenFile({ kind: 'inter-chat', openFile: { path: 'a.ts' } })).toEqual({
      path: 'a.ts'
    })
    for (const bad of [
      null,
      'x',
      [],
      {},
      { openFile: null },
      { openFile: 'a.ts' },
      { openFile: ['a.ts'] },
      { openFile: { path: '' } },
      { openFile: { path: '   ' } },
      { openFile: { path: 7 } },
      { openFile: { path: 'a\nb' } },
      { openFile: { path: 'a\u0000b' } },
      { openFile: { path: 'x'.repeat(OPEN_FILE_PATH_MAX + 1) } }
    ])
      expect(sendMetaOpenFile(bad), JSON.stringify(bad)).toBeNull()
    expect(sendMetaOpenFile({ openFile: { path: 'x'.repeat(OPEN_FILE_PATH_MAX) } })).not.toBeNull()
    // o celular não tem raiz: o caminho fica COMO VEIO (absoluto e relativo), só validado
    expect(PHONE_CHAT_ROOT).toBeNull()
    expect(hostOpenFile({ openFile: { path: '/home/ana/proj/src/a.ts' } })).toEqual({
      path: '/home/ana/proj/src/a.ts'
    })
    expect(hostOpenFile({ openFile: { path: 'src/../b.ts' } })).toEqual({ path: 'src/../b.ts' })
    expect(hostOpenFile({ openFile: { path: 'C:\\p\\a.ts' } })).toEqual({ path: 'C:\\p\\a.ts' })
    expect(hostOpenFile({ openFile: { path: 'a\tb' } })).toBeNull()
  })

  it('send com meta.openFile: gravado como veio; o texto vai na request deste e dos próximos turnos', async () => {
    const { chatId, sid } = newChat()
    await h.stack.host.local(chatId, 'send', {
      sessionId: sid,
      text: 'o que esse arquivo faz?',
      meta: { openFile: { path: '/home/ana/proj/src/a.ts' } }
    })
    await idle(sid)
    const user = h.stack.repo.path(sid).find((m) => m.message.role === 'user')!
    // o content salvo continua só o texto do usuário
    expect(user.message.content).toBe('o que esse arquivo faz?')
    expect(user.meta.openFile).toEqual({ path: '/home/ana/proj/src/a.ts' })
    expect(lastUserTexts()).toEqual([
      `o que esse arquivo faz?\n\n${LINE('/home/ana/proj/src/a.ts')}`
    ])
    // registro sincronizado: o meta sobe com a mensagem (o computador mostra a linha)
    await h.stack.writer.flush(chatId)
    await until(() => !h.stack.writer.pending(chatId), 8000, 'outbox')
    const rec = h.store.getPlain('message', user.id) as { meta?: MessageMeta }
    expect(rec.meta?.openFile).toEqual({ path: '/home/ana/proj/src/a.ts' })
    // 2º turno sem arquivo: o 1º continua com o texto (histórico), o 2º não
    await h.stack.host.local(chatId, 'send', { sessionId: sid, text: 'e agora?' })
    await idle(sid)
    expect(lastUserTexts()).toEqual([
      `o que esse arquivo faz?\n\n${LINE('/home/ana/proj/src/a.ts')}`,
      'e agora?'
    ])
  })

  it('meta inválido → a mensagem segue sem o arquivo (nunca recusada); voz + arquivo juntos', async () => {
    const { chatId, sid } = newChat()
    await h.stack.host.local(chatId, 'send', {
      sessionId: sid,
      text: 'um',
      meta: { openFile: { path: 'a\nb' } }
    })
    await idle(sid)
    const one = h.stack.repo.path(sid).find((m) => m.message.content === 'um')!
    expect(one.meta.openFile).toBeUndefined()
    expect(lastUserTexts()).toEqual(['um'])
    await h.stack.host.local(chatId, 'force', {
      sessionId: sid,
      text: 'dois',
      voice: { source: 'dictation' },
      meta: { openFile: { path: 'notas.md' } }
    })
    await idle(sid)
    const two = h.stack.repo.path(sid).find((m) => m.message.content === 'dois')!
    expect(two.meta.voice).toEqual({ source: 'dictation' })
    expect(two.meta.openFile).toEqual({ path: 'notas.md' })
  })

  it('fila: o arquivo vai junto (enfileirada e repassada na troca de host, §8.8)', async () => {
    const { chatId, sid } = newChat()
    await h.stack.host.local(chatId, 'send', { sessionId: sid, text: '/slow' })
    await new Promise((r) => setTimeout(r, 250))
    await h.stack.host.local(chatId, 'send', {
      sessionId: sid,
      text: 'na fila',
      meta: { openFile: { path: 'src/b.ts' } }
    })
    const q = h.stack.runner.getQueue(sid)
    expect(q.length).toBe(1)
    expect(q[0].meta?.openFile).toEqual({ path: 'src/b.ts' })
    // troca de host: o repasse leva `meta: { openFile }` (§8.8 + 1.13.0)
    h.stack.host.onEvent({
      t: 'host.handover_request',
      chat_id: chatId,
      to_device_id: 'dev-pc',
      to_name: 'PC',
      mode: 'next_turn'
    })
    await until(() => h.ws.count('host.release') === 1, 8000, 'host.release')
    const rel = h.ws.requests.find((r) => r.t === 'host.release')!
    const fwd = rel.fields.forwarded as { cmd_id: string; env: Envelope }[]
    expect(fwd.length).toBe(1)
    const cmd = await openCommand(
      h.desk.sk.stream,
      h.server.userId,
      chatId,
      fwd[0].cmd_id,
      fwd[0].env
    )
    expect(cmd).toMatchObject({
      kind: 'send',
      text: 'na fila',
      meta: { openFile: { path: 'src/b.ts' } }
    })
  })

  it('"nova versão" (branch.edit) mantém o arquivo selecionado da original', async () => {
    const { chatId, sid } = newChat()
    await h.stack.host.local(chatId, 'send', {
      sessionId: sid,
      text: 'versão 1',
      meta: { openFile: { path: 'src/c.ts' } }
    })
    await idle(sid)
    const orig = h.stack.repo.path(sid).find((m) => m.message.role === 'user')!
    await h.stack.host.local(chatId, 'branch.edit', {
      messageId: orig.id,
      message: { role: 'user', content: 'versão 2' }
    })
    await idle(sid)
    const v2 = h.stack.repo.path(sid).find((m) => m.message.role === 'user')!
    expect(v2.id).not.toBe(orig.id)
    expect(v2.message.content).toBe('versão 2')
    expect(v2.meta.openFile).toEqual({ path: 'src/c.ts' })
    expect(lastUserTexts()).toEqual([`versão 2\n\n${LINE('src/c.ts')}`])
  })
})

// ---------------- (D) tocar num caminho citado (chat de outro dispositivo) ----------------

describe('(D) abrir caminho citado: confere no host antes', () => {
  const listing =
    (tree: Record<string, { name: string; kind: 'file' | 'dir' }[]>, root = '/home/u/p') =>
    async (dir: string): Promise<RemoteDirResult> => {
      const abs = !dir ? root : dir.startsWith('/') ? dir : `${root}/${dir}`
      const entries = tree[abs]
      if (!entries) return { ok: false, reason: 'missing', message: 'Pasta não encontrada.' }
      return { ok: true, dir: abs, root, confine: true, truncated: false, entries }
    }
  const TREE = {
    '/home/u/p': [
      { name: 'src', kind: 'dir' as const },
      { name: 'README.md', kind: 'file' as const }
    ],
    '/home/u/p/src': [{ name: 'app.ts', kind: 'file' as const }]
  }

  const run = async (path: string, list = listing(TREE)) => {
    const asked: string[] = []
    const opened: HostPathRoute[] = []
    const notices: string[] = []
    const ok = await openHostPath('c1', path, {
      list: (d) => {
        asked.push(d)
        return list(d)
      },
      open: (r) => opened.push(r),
      notice: (t) => notices.push(t)
    })
    return { ok, asked, opened, notices }
  }

  it('relativo (arquivo selecionado ou @caminho): lista a pasta-mãe no host e abre o visualizador', async () => {
    const r = await run('src/app.ts')
    expect(r.asked).toEqual(['src'])
    expect(r.ok).toBe(true)
    expect(r.opened).toEqual([
      {
        pathname: '/file/[chat]',
        params: { chat: 'c1', path: '/home/u/p/src/app.ts', name: 'app.ts', root: '/home/u/p' }
      }
    ])
    // na raiz: lista '' (= a raiz do chat no host)
    expect((await run('README.md')).asked).toEqual([''])
  })

  it('pasta (`@src/`) → aba Arquivos nela; absoluto também', async () => {
    const r = await run('src/')
    expect(r.opened).toEqual([
      { pathname: '/files/[chat]', params: { chat: 'c1', path: '/home/u/p/src' } }
    ])
    const a = await run('/home/u/p/src/app.ts')
    expect(a.asked).toEqual(['/home/u/p/src'])
    expect(a.opened[0]).toMatchObject({ pathname: '/file/[chat]' })
  })

  it('ausente (arquivo apagado, pasta fora da raiz) → aviso discreto e nada aberto', async () => {
    const r = await run('src/sumiu.ts')
    expect(r).toMatchObject({
      ok: false,
      opened: [],
      notices: ['Não encontrei src/sumiu.ts na raiz do chat.']
    })
    const fora = await run('/etc/hosts')
    expect(fora.opened).toEqual([])
    expect(fora.notices).toEqual(['Não encontrei /etc/hosts na raiz do chat.'])
  })

  it('host fora do ar → o aviso dele', async () => {
    const r = await run('src/app.ts', async () => ({
      ok: false,
      reason: 'host-offline',
      message: 'O host (PC) está offline.'
    }))
    expect(r.notices).toEqual(['O host (PC) está offline.'])
    expect(r.opened).toEqual([])
  })

  it('host Windows: separador dele no caminho aberto', async () => {
    const win = async (dir: string): Promise<RemoteDirResult> =>
      dir === 'src'
        ? {
            ok: true,
            dir: 'C:\\p\\src',
            root: 'C:\\p',
            confine: true,
            truncated: false,
            entries: [{ name: 'app.ts', kind: 'file' }]
          }
        : { ok: false, reason: 'missing', message: 'x' }
    const r = await checkHostPath(win, 'src\\app.ts')
    expect(r).toEqual({ kind: 'file', abs: 'C:\\p\\src\\app.ts', name: 'app.ts', root: 'C:\\p' })
    expect(await checkHostPath(win, 'src/app.ts')).toMatchObject({ kind: 'file' })
  })

  it('o @caminho tocado é o do token (sem @ nem aspas)', async () => {
    const seg = mentionSegments('abra @"src/app.ts" por favor')!
    const m = seg.find((p) => 'mention' in p)
    const path = m && 'mention' in m ? m.mention.path : ''
    expect(path).toBe('src/app.ts')
    expect((await run(path)).ok).toBe(true)
  })
})
