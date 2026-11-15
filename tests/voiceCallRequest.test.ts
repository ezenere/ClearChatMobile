// Chamada de voz na request do celular (= desktop `sentMessages` — SYNC §4.3.6/§4.3.8): os
// marcadores de início/fim deixam a nota fixa no começo da mensagem seguinte do usuário (nunca vão
// como mensagem) e as tags de voz das respostas da chamada só vão num turno de chamada com elas
// valendo. E o `resumeVoiceTurn` do runner (turno continuado: a fala que parou o turno era ruído).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  ApiMessage,
  Chat,
  ChatConfig,
  MessageMeta,
  Provider,
  StoredMessage
} from '../src/vendor/shared/types'
import { DEFAULT_CHAT_CONFIG } from '../src/vendor/shared/defaults'
import { DEFAULT_VOICE_CALL_DEFAULTS, resolveVoiceCallConfig } from '../src/vendor/shared/voice'
import { CALL_END_NOTE, CALL_START_NOTE } from '../src/vendor/shared/voiceCallMarks'
import { buildRequest, setVoiceCallSource } from '../src/agent/request'
import { makeHarness, until, type Harness } from './hostHarness'

const GEN: Provider = {
  id: 'p1',
  name: 'Genérico',
  kind: 'openai',
  baseUrl: 'https://llm.example.com/v1',
  apiKey: 'k',
  headers: {},
  createdAt: 0
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
const marker = (phase: 'start' | 'end'): StoredMessage =>
  sm(
    {
      role: 'assistant',
      content: phase === 'start' ? 'Chamada de voz iniciada' : 'Chamada encerrada'
    },
    { synthetic: true, kind: 'voice-call', voiceCall: { callId: 'c', phase, startedAt: 1 } }
  )
const history = (): StoredMessage[] => [
  marker('start'),
  sm({ role: 'user', content: 'conta uma piada' }, { voice: { source: 'call', callId: 'c' } }),
  sm(
    { role: 'assistant', content: '[laughs] Lá vai uma boa.' },
    { voice: { source: 'call', callId: 'c', spoken: true } }
  ),
  marker('end'),
  sm({ role: 'user', content: 'agora por texto' })
]
const ENV = { os: 'Android 16' }
const sent = (): any[] =>
  (buildRequest(mkChat(), { id: 's1', depth: 0, model: 'm' }, history(), GEN, ENV).body as any)
    .messages
const text = (c: any): string =>
  typeof c === 'string' ? c : c.map((p: any) => p.text ?? '').join('|')

describe('request do celular: marcadores e tags de voz da chamada', () => {
  afterEach(() => setVoiceCallSource(() => null))

  it('fora da chamada: nota no lugar de cada marcador e respostas da chamada sem tags', () => {
    setVoiceCallSource(() => null)
    const msgs = sent()
    expect(msgs.filter((m) => m.role === 'user').map((m) => text(m.content))).toEqual([
      `${CALL_START_NOTE}\n\nconta uma piada`,
      `${CALL_END_NOTE}\n\nagora por texto`
    ])
    expect(msgs.filter((m) => m.role === 'assistant').map((m) => text(m.content))).toEqual([
      'Lá vai uma boa.'
    ])
  })

  it('turno de chamada: tags só com elas pedidas E a voz interpretando', () => {
    const base = resolveVoiceCallConfig(null, DEFAULT_VOICE_CALL_DEFAULTS)
    const bot = (): string => text(sent().find((m) => m.role === 'assistant').content)
    setVoiceCallSource(() => ({ ...base, audioTags: true, audioTagsActive: false }))
    expect(bot()).toBe('Lá vai uma boa.')
    setVoiceCallSource(() => ({ ...base, audioTags: false, audioTagsActive: true }))
    expect(bot()).toBe('Lá vai uma boa.')
    setVoiceCallSource(() => ({ ...base, audioTags: true, audioTagsActive: true }))
    expect(bot()).toBe('[laughs] Lá vai uma boa.')
  })
})

describe('runner: resumeVoiceTurn (turno continuado — a fala que parou o turno era ruído)', () => {
  let h: Harness
  beforeEach(async () => {
    h = await makeHarness()
  })
  afterEach(async () => {
    await h.close()
  })

  it('só com o histórico esperando o assistente; o mesmo turno volta a rodar sem mensagem nova', async () => {
    const { session } = h.stack.repo.createChat({
      config: {
        ...DEFAULT_CHAT_CONFIG(''),
        providerId: h.providerId,
        model: 'fake/agent',
        enabledTools: []
      },
      title: ''
    })
    const sid = session.id
    const idle = (): Promise<unknown> =>
      until(() => !h.stack.runner.isRunning(sid), 10_000, 'turno terminar')
    const roles = (): string[] => h.stack.repo.path(sid).map((m) => m.message.role)
    await h.stack.runner.send(sid, 'oi')
    await idle()
    expect(roles()).toEqual(['user', 'assistant'])
    expect(h.stack.runner.resumeVoiceTurn(sid)).toBe(false)
    const userId = h.stack.repo.path(sid)[0].id
    // o turno foi parado pela fala e a resposta (nunca ouvida) saiu
    await h.stack.runner.amendVoiceTurn(sid, { userMessageId: userId, dropUser: false, spoken: {} })
    expect(roles()).toEqual(['user'])
    expect(h.stack.runner.resumeVoiceTurn(sid)).toBe(true)
    await idle()
    expect(roles()).toEqual(['user', 'assistant'])
    expect(h.stack.runner.resumeVoiceTurn('nao-existe')).toBe(false)
  })
})
