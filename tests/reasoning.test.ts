// Raciocínio omitido (= desktop d1a8965): os Claude ≥ 4.7 (padrão `display: "omitted"`) mandam o
// bloco thinking da Messages API SEM texto. O rascunho mostra "Pensando… · N s" enquanto o bloco
// está aberto (não só o "Gerando resposta…"), o relógio para no fechamento e a mensagem gravada sem
// texto de raciocínio mostra "Raciocínio · N s" (meta.reasoningMs). Partes puras (reasoningUi), o
// relógio no espelho (controle remoto sem marcas; host local com as marcas do runner) e o host do
// celular com o provedor falso (Messages API).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { StoredMessage, StreamDraft } from '../src/vendor/shared/types'
import { DEFAULT_CHAT_CONFIG } from '../src/vendor/shared/defaults'
import { formatSecondsPt } from '../src/vendor/renderer/reasoning'
import { LiveMirror } from '../src/remote/mirror'
import { draftReasoningUi, draftThinking, savedReasoningUi } from '../src/chat/reasoningUi'
import { makeHarness, until, type Harness } from './hostHarness'

const draft = (o: Partial<StreamDraft> = {}): StreamDraft => ({
  content: '',
  reasoning: '',
  toolCalls: [],
  ...o
})

function assistant(
  o: { content?: string; reasoning?: string } = {},
  meta: StoredMessage['meta'] = {}
): StoredMessage {
  return {
    id: 'a1',
    sessionId: 's1',
    seq: 1,
    parentId: null,
    message: {
      role: 'assistant',
      content: o.content ?? 'Oi',
      ...(o.reasoning != null ? { reasoning: o.reasoning } : {})
    },
    meta,
    createdAt: 0
  } as StoredMessage
}

// ---------------- puro ----------------

describe('reasoningUi (puro)', () => {
  it('rascunho com o bloco de raciocínio aberto SEM texto: "Pensando… · N s", só o cabeçalho, sem "Gerando resposta…"', () => {
    const d = draft()
    expect(draftReasoningUi(d, { start: 1000 }, 4200)).toEqual({
      show: true,
      live: true,
      empty: true,
      label: 'Pensando…',
      details: ['3 s'],
      typing: false
    })
    // menos de 1 s: sem o tempo ainda
    expect(draftReasoningUi(d, { start: 1000 }, 1500).details).toEqual([])
    expect(draftThinking(d, { start: 1000 })).toBe(true)
    // bloco fechado, resposta ainda não chegou: "Raciocínio · 3 s" e o "Gerando resposta…"
    expect(draftReasoningUi(d, { start: 1000, end: 4200 }, 9000)).toEqual({
      show: true,
      live: false,
      empty: true,
      label: 'Raciocínio',
      details: ['3 s'],
      typing: true
    })
    expect(draftThinking(d, { start: 1000, end: 4200 })).toBe(false)
    // a resposta chegando: sem o indicador
    const ans = draftReasoningUi(draft({ content: 'Oi' }), { start: 1000, end: 4200 }, 9000)
    expect(ans).toMatchObject({ show: true, live: false, typing: false, details: ['3 s'] })
  })

  it('sem raciocínio nem relógio (controle remoto de um bloco omitido): só o "Gerando resposta…"', () => {
    expect(draftReasoningUi(draft(), undefined, 5000)).toMatchObject({
      show: false,
      live: false,
      typing: true
    })
    expect(draftThinking(draft(), undefined)).toBe(false)
    expect(draftThinking(null, { start: 1 })).toBe(false)
    // tool call chegando: nada de indicador nem "Pensando…"
    const tc = draft({ toolCalls: [{ id: 't', name: 'shell', arguments: '' }] })
    expect(draftReasoningUi(tc, undefined, 0)).toMatchObject({ show: false, typing: false })
  })

  it('rascunho com o texto do raciocínio: caixa (não vazio), "Pensando…" com o tempo do relógio', () => {
    const d = draft({ reasoning: 'vejamos' })
    expect(draftReasoningUi(d, { start: 0 }, 12_000)).toMatchObject({
      show: true,
      live: true,
      empty: false,
      label: 'Pensando…',
      details: ['12 s'],
      typing: false
    })
    // sem relógio ainda (rascunho de antes de abrir a tela): "Pensando…" sem tempo
    expect(draftReasoningUi(d, undefined, 0)).toMatchObject({ live: true, details: [] })
    expect(draftThinking(d, undefined)).toBe(true)
  })

  it('mensagem gravada: "Raciocínio · N s" também sem texto (meta.reasoningMs); nada sem os dois', () => {
    expect(savedReasoningUi(assistant({}, { reasoningMs: 3200 }))).toEqual({
      label: 'Raciocínio',
      details: ['3 s'],
      empty: true
    })
    expect(
      savedReasoningUi(
        assistant(
          { reasoning: 'pensei' },
          { reasoningMs: 65_000, usage: { reasoningTokens: 1200 } as never }
        )
      )
    ).toEqual({ label: 'Raciocínio', details: ['1 min 5 s', '1,2 mil tokens'], empty: false })
    expect(savedReasoningUi(assistant({ reasoning: 'pensei' }))).toEqual({
      label: 'Raciocínio',
      details: [],
      empty: false
    })
    expect(savedReasoningUi(assistant())).toBeNull()
    expect(savedReasoningUi(assistant({}, { reasoningMs: 0 }))).toBeNull()
  })
})

// ---------------- espelho ----------------

describe('espelho: relógio do raciocínio (reasoningClocks)', () => {
  let t = 0
  let changes = 0
  let m: LiveMirror
  beforeEach(() => {
    t = 0
    changes = 0
    m = new LiveMirror(1, { resync: () => {}, changed: () => changes++, now: () => t })
    m.onEvent(1, {
      kind: 'snapshot',
      sessions: { s1: { status: 'running', draft: null, tools: {}, compaction: null } },
      queues: {},
      approvals: [],
      questions: [],
      retries: [],
      processes: [],
      skills: []
    })
  })
  let n = 1
  const delta = (streamId: string, off: [number, number], content = '', reasoning = '') =>
    m.onEvent(++n, {
      kind: 'draft.delta',
      sessionId: 's1',
      streamId,
      off: { content: off[0], reasoning: off[1] },
      append: { ...(content ? { content } : {}), ...(reasoning ? { reasoning } : {}) }
    })
  beforeEach(() => {
    n = 1
  })

  it('controle remoto (stream sem marcas): começa quando o raciocínio aparece aqui e para na resposta; o bloco sem texto não tem relógio', () => {
    t = 1000
    delta('A', [0, 0]) // o host abriu um bloco omitido: o stream não leva nada
    expect(m.view.drafts.s1).toEqual(draft())
    expect(m.view.reasoningClocks.s1).toBeUndefined()
    t = 2000
    delta('A', [0, 0], '', 'hmm')
    expect(m.view.reasoningClocks.s1).toEqual({ start: 2000 })
    t = 5000
    delta('A', [0, 3], '', ' ok')
    const same = m.view.reasoningClocks.s1
    expect(same).toEqual({ start: 2000 })
    t = 6000
    delta('A', [0, 6], 'Oi')
    expect(m.view.reasoningClocks.s1).toEqual({ start: 2000, end: 6000 })
    // encerrado (esperando a mensagem): o relógio parado continua com ele
    m.onEvent(++n, { kind: 'draft.end', sessionId: 's1', streamId: 'A' })
    expect(m.view.drafts.s1.content).toBe('Oi')
    expect(m.view.reasoningClocks.s1).toEqual({ start: 2000, end: 6000 })
    // a mensagem chegou: some o draft e o relógio
    m.onPersistedAssistant(assistant({ content: 'Oi', reasoning: 'hmm ok' }))
    expect(m.view.drafts.s1).toBeUndefined()
    expect(m.view.reasoningClocks.s1).toBeUndefined()
  })

  it('host local: as marcas do runner — bloco sem texto aberto = "Pensando… · N s", fechado = "Raciocínio · N s"; resposta nova não herda as marcas', () => {
    m.setDraftMarks('s1', { reasoningStartedAt: 1 }) // sem draft: ignorado
    expect(m.view.reasoningClocks.s1).toBeUndefined()
    t = 100
    delta('A', [0, 0])
    const c0 = changes
    m.setDraftMarks('s1', { reasoningStartedAt: 1000 })
    expect(changes).toBe(c0 + 1)
    const open = m.view
    expect(open.reasoningClocks.s1).toEqual({ start: 1000 })
    expect(draftReasoningUi(open.drafts.s1, open.reasoningClocks.s1, 4200)).toMatchObject({
      show: true,
      live: true,
      empty: true,
      label: 'Pensando…',
      details: ['3 s'],
      typing: false
    })
    // as mesmas marcas: nada muda (a tela não re-renderiza)
    m.setDraftMarks('s1', { reasoningStartedAt: 1000 })
    expect(m.view).toBe(open)
    expect(changes).toBe(c0 + 1)
    // fechamento do bloco
    m.setDraftMarks('s1', { reasoningStartedAt: 1000, reasoningEndedAt: 4200 })
    const closed = m.view
    expect(closed.reasoningClocks.s1).toEqual({ start: 1000, end: 4200 })
    expect(draftReasoningUi(closed.drafts.s1, closed.reasoningClocks.s1, 9000)).toMatchObject({
      live: false,
      label: 'Raciocínio',
      details: ['3 s'],
      typing: true
    })
    t = 5000
    delta('A', [0, 0], 'Oi')
    expect(m.view.reasoningClocks.s1).toEqual({ start: 1000, end: 4200 })
    // a resposta seguinte do turno (outro stream) começa sem as marcas da anterior
    delta('B', [0, 0])
    expect(m.view.drafts.s1).toEqual(draft())
    expect(m.view.reasoningClocks.s1).toBeUndefined()
    m.setDraftMarks('s1', { reasoningStartedAt: 7000 })
    expect(m.view.reasoningClocks.s1).toEqual({ start: 7000 })
    // fim do turno: nada ao vivo
    m.endTurn()
    expect(m.view.reasoningClocks).toEqual({})
  })
})

// ---------------- host do celular (provedor falso, Messages API) ----------------

describe('host local: bloco de raciocínio sem texto do provedor (Messages API)', () => {
  let h: Harness
  beforeEach(async () => {
    h = await makeHarness({ kind: 'anthropic' })
  })
  afterEach(async () => {
    await h?.close()
  })

  it('"Pensando… · N s" enquanto o bloco está aberto, o relógio para no fechamento e a mensagem gravada mostra "Raciocínio · N s"', async () => {
    const { chat, session } = h.stack.repo.createChat({
      config: {
        ...DEFAULT_CHAT_CONFIG(''),
        providerId: h.providerId,
        model: 'claude-opus-5-5',
        enabledTools: []
      }
    })
    const sid = session.id
    const view = () => h.stack.host.view(chat.id)
    h.stack.host.setActive(chat.id)
    await h.stack.host.local(chat.id, 'send', { sessionId: sid, text: '/omitted 1500' })
    await until(() => view()?.reasoningClocks[sid] != null, 8000, 'relógio do bloco aberto')
    const open = view()!
    const clock = open.reasoningClocks[sid]
    expect(clock.end).toBeUndefined()
    // nada de texto (o provedor omite o raciocínio): só o relógio
    expect(open.drafts[sid]).toEqual(draft())
    expect(draftThinking(open.drafts[sid], clock)).toBe(true)
    expect(draftReasoningUi(open.drafts[sid], clock, clock.start + 1200)).toMatchObject({
      show: true,
      live: true,
      empty: true,
      label: 'Pensando…',
      details: ['1 s'],
      typing: false
    })
    await until(() => view()?.reasoningClocks[sid]?.end != null, 8000, 'bloco fechado')
    const done = view()!.reasoningClocks[sid]
    expect(done.start).toBe(clock.start)
    expect(done.end! - done.start).toBeGreaterThanOrEqual(1300)
    await until(() => !h.stack.runner.isRunning(sid), 10_000, 'fim do turno')
    const a = h.stack.repo
      .path(sid)
      .filter((x) => x.message.role === 'assistant')
      .at(-1)!
    expect(a.message.content).toBe('ok: pensei sem mostrar')
    expect((a.message as { reasoning?: string }).reasoning).toBeUndefined()
    expect(a.meta.reasoningMs).toBeGreaterThanOrEqual(1300)
    expect(savedReasoningUi(a)).toEqual({
      label: 'Raciocínio',
      details: [formatSecondsPt(a.meta.reasoningMs!)],
      empty: true
    })
  })
})
