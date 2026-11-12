// Voz da persona/chat no celular (protocolo 1.9.0) e frases de ferramenta — peças puras: as
// capacidades do celular (só provedores), a resolução (escolha do chat → da persona → as settings
// deste aparelho, com o motivo do fallback e o idioma da escolha), o que a chamada/o ditado usam,
// os textos dos ícones esmaecidos (com "Configurações → Voz"), a recusa da chamada, o Novo chat que
// não copia a voz da persona e as categorias das frases de ferramenta (localização do celular).
import { describe, expect, it } from 'vitest'
import type { Provider } from '../src/vendor/shared/types'
import {
  DEFAULT_STT_SETTINGS,
  DEFAULT_TTS_SETTINGS,
  normalizeAudioInput,
  normalizeVoiceCallDefaults,
  SUGGESTED_VOICE_PROMPT,
  voicePromptLayout
} from '../src/vendor/shared/voice'
import { PlaybackDuck, toolPhraseCategory } from '../src/vendor/shared/voicePolicy'
import { replaceCategoryLines } from '../src/vendor/renderer/voice/toolPhrases'
import type { VoiceSettings } from '../src/voice/endpoints'
import {
  callRefusal,
  chatVoiceIcons,
  mobileVoiceCaps,
  mobileVoiceText,
  resolveChatVoice,
  settingsWith,
  voiceLayers,
  voiceUse
} from '../src/voice/resolve'
import { resolveNewChat } from '../src/host/newChat'

const provs: Provider[] = [
  {
    id: 'or',
    name: 'OpenRouter',
    kind: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: 'k',
    headers: {},
    createdAt: 1
  },
  {
    id: 'el',
    name: 'ElevenLabs',
    kind: 'elevenlabs',
    baseUrl: 'https://api.elevenlabs.io',
    apiKey: 'x',
    headers: {},
    createdAt: 2
  }
]
const provider = (id: string) => provs.find((p) => p.id === id) ?? null

const device = (p: Partial<VoiceSettings> = {}): VoiceSettings => ({
  audioInput: { ...normalizeAudioInput(null), language: 'pt-BR' },
  stt: {
    ...DEFAULT_STT_SETTINGS,
    mode: 'api',
    api: { providerId: 'or', model: 'openai/whisper-large-v3-turbo' }
  },
  tts: {
    ...DEFAULT_TTS_SETTINGS,
    backend: 'api',
    api: { providerId: 'or', model: 'openai/gpt-4o-mini-tts', voice: 'alloy' }
  },
  voiceCallDefaults: normalizeVoiceCallDefaults(null),
  ...p
})

const narradora = {
  tts: {
    backend: 'api',
    api: { providerId: 'el', model: 'eleven_v3', voice: 'sarah' }
  },
  stt: { mode: 'api', api: { providerId: 'or', model: 'groq/whisper' }, language: 'en-US' }
}

describe('voz da persona/chat no celular (1.9.0)', () => {
  it('capacidades: só provedores — inexistente, sem endereço e ElevenLabs sem transcrição', () => {
    const caps = mobileVoiceCaps(provider)
    expect(caps.provider('or', 'stt')).toEqual({ ok: true })
    expect(caps.provider('nao-existe', 'tts')).toEqual({
      ok: false,
      reason: 'o provedor escolhido não existe neste dispositivo'
    })
    expect(caps.provider('el', 'stt')).toEqual({
      ok: false,
      reason: 'o provedor “ElevenLabs” não serve transcrição'
    })
    expect(caps.ttsLocal).toBeUndefined()
    expect(caps.sttGpu).toBeUndefined()
  })

  it('herança: chat → persona → este aparelho; a escolha da persona vale aqui e o idioma vem dela', () => {
    const layers = voiceLayers({ enabled: null }, narradora)
    const r = resolveChatVoice(layers, device(), provider)
    expect(r.tts).toMatchObject({ source: 'persona', choiceSource: 'persona', available: true })
    expect(r.tts.settings.api).toMatchObject({
      providerId: 'el',
      model: 'eleven_v3',
      voice: 'sarah'
    })
    expect(r.stt).toMatchObject({ source: 'persona', language: 'en-US', available: true })
    const use = voiceUse(r)
    expect(use).toMatchObject({ language: 'en-US', tts: narradora.tts })
    const eff = settingsWith(device(), use)
    expect(eff.tts.api.model).toBe('eleven_v3')
    expect(eff.stt.api.model).toBe('groq/whisper')
    expect(eff.audioInput.language).toBe('en-US')
    // a do chat vence a da persona
    const own = resolveChatVoice(
      voiceLayers(
        { tts: { backend: 'api', api: { providerId: 'or', model: 'tts-x', voice: null } } },
        narradora
      ),
      device(),
      provider
    )
    expect(own.tts.source).toBe('chat')
    expect(own.tts.settings.api.model).toBe('tts-x')
    // sem escolha nenhuma: as deste aparelho
    const none = resolveChatVoice(voiceLayers(null, null), device(), provider)
    expect(none.tts.source).toBe('device')
    expect(voiceUse(none)).toEqual({ tts: null, stt: null, language: null })
    expect(settingsWith(device(), voiceUse(none))).toEqual(device())
  })

  it('escolha indisponível aqui: cai na padrão deste aparelho com o motivo (o idioma da escolha fica)', () => {
    const local = {
      tts: { backend: 'local', local: { engine: 'kokoro', voice: 'pm_alex' } },
      stt: { mode: 'api', api: { providerId: 'groq-do-pc', model: 'w' }, language: 'es-ES' }
    }
    const r = resolveChatVoice(voiceLayers(null, local), device(), provider)
    expect(r.tts).toMatchObject({
      source: 'device',
      available: true,
      fallback: { from: 'persona', reason: 'este dispositivo não tem motores locais de voz' }
    })
    expect(r.stt.fallback?.reason).toBe('o provedor escolhido não existe neste dispositivo')
    expect(r.stt.language).toBe('es-ES')
    // a chamada usa as daqui (escolhas indisponíveis = null) com o idioma da persona
    expect(voiceUse(r)).toEqual({ tts: null, stt: null, language: 'es-ES' })
    const icons = chatVoiceIcons(r)
    expect(icons.call.state).toBe('fallback')
    expect(icons.call.text).toBeNull()
    expect(icons.call.note).toContain(
      'A transcrição da persona não está disponível neste dispositivo (o provedor escolhido não existe neste dispositivo) — usando a padrão deste dispositivo.'
    )
    expect(icons.mic.note).toContain('A transcrição da persona')
  })

  it('nem a escolha nem o aparelho funcionam: ícones esmaecidos (não configurado × não funciona), recusa da chamada', () => {
    const bare = device({
      stt: { ...DEFAULT_STT_SETTINGS, mode: 'api', api: { providerId: null, model: '' } },
      tts: { ...DEFAULT_TTS_SETTINGS }
    })
    const r = resolveChatVoice(voiceLayers(null, null), bare, provider)
    expect(r.stt).toMatchObject({ available: false, unconfigured: true })
    expect(r.tts).toMatchObject({
      available: false,
      reason: 'este dispositivo não tem motores locais de voz'
    })
    const icons = chatVoiceIcons(r)
    expect(icons.mic.state).toBe('unconfigured')
    expect(icons.mic.text).toBe(
      'Ditado não configurado neste dispositivo — nenhum modelo de transcrição escolhido (Configurações → Voz).'
    )
    expect(icons.call.state).toBe('unavailable')
    expect(icons.call.text).toBe(
      'Chamada de voz não funciona neste dispositivo — transcrição: nenhum modelo de transcrição escolhido; fala: este dispositivo não tem motores locais de voz (Configurações → Voz).'
    )
    expect(callRefusal(r)).toBe(
      'Chamada de voz indisponível neste dispositivo — Transcrição: nenhum modelo de transcrição escolhido. Fala: este dispositivo não tem motores locais de voz.'
    )
    expect(callRefusal(resolveChatVoice(null, device(), provider))).toBeNull()
    expect(mobileVoiceText('x (Configurações → Áudio → Transcrição).')).toBe(
      'x (Configurações → Voz).'
    )
  })

  it('Novo chat de uma persona: a voz/transcrição NÃO entram no snapshot (o chat herda ao vivo)', () => {
    const cfg = resolveNewChat({}, [], {
      id: 'p1',
      name: 'Narradora',
      description: '',
      icon: 'sparkles',
      config: {
        voice: {
          enabled: true,
          model: null,
          tools: null,
          voicePrompt: 'Fale curto.',
          fillers: null,
          ...(narradora as object)
        }
      },
      createdAt: 0,
      updatedAt: 0
    })
    expect(cfg.voice).toMatchObject({ enabled: true, voicePrompt: 'Fale curto.' })
    expect(cfg.voice).not.toHaveProperty('tts')
    expect(cfg.voice).not.toHaveProperty('stt')
  })
})

describe('frases de ferramenta', () => {
  it('categorias: as tools de localização do celular → location; web/info/genérica', () => {
    expect(toolPhraseCategory('get_location')).toBe('location')
    expect(toolPhraseCategory('nearby_places')).toBe('location')
    expect(toolPhraseCategory('web_search')).toBe('web')
    expect(toolPhraseCategory('list_chats')).toBe('info')
    expect(toolPhraseCategory('mcp__qualquer')).toBe('generic')
    expect(toolPhraseCategory('end_call')).toBeNull()
  })

  it('editar uma categoria troca só as frases dela; igual ao padrão volta a null', () => {
    const pool = replaceCategoryLines(
      [
        { text: 'Vou pesquisar.', categories: ['web'] },
        { text: 'Um instante.', categories: ['location', 'generic'] }
      ],
      'location',
      ['Deixa eu ver onde você está.']
    )!
    expect(pool).toEqual([
      { text: 'Vou pesquisar.', categories: ['web'] },
      { text: 'Deixa eu ver onde você está.', categories: ['location'] },
      { text: 'Um instante.', categories: ['generic'] }
    ])
  })
})

describe('sem prompt oculto; preâmbulo só quando demora; abaixar a voz só depois do onset', () => {
  it('padrões e migração: preâmbulo 250 → 2500 ms, barge-in 700 → 1200 ms, onset 500 ms; nada de prompt-base', () => {
    const d = normalizeVoiceCallDefaults({
      fillers: { enabled: true, delayMs: 250 },
      turn: { bargeInVoicedMs: 700 },
      basePromptEnabled: true,
      basePrompt: 'texto antigo'
    })
    expect(d.fillers.delayMs).toBe(2500)
    expect(d.turn).toMatchObject({ bargeInVoicedMs: 1200, duckOnsetMs: 500 })
    expect(d).not.toHaveProperty('basePromptEnabled')
    expect(d).not.toHaveProperty('basePrompt')
    // sem "Prompt do modo voz" a chamada não muda o prompt; a sugestão só entra pelo campo
    expect(voicePromptLayout({ voicePrompt: null, promptMode: 'append' })).toEqual({
      replacesSystem: false,
      parts: []
    })
    expect(
      voicePromptLayout({ voicePrompt: SUGGESTED_VOICE_PROMPT, promptMode: 'replace' })
    ).toEqual({ replacesSystem: true, parts: [{ kind: 'voice', text: SUGGESTED_VOICE_PROMPT }] })
  })

  it('PlaybackDuck: ruído curto nunca abaixa; voz sustentada abaixa (duck) e só depois pode virar barge-in', () => {
    const duck = new PlaybackDuck({ onsetMs: 500, voicedMs: 1200, restoreMs: 450 })
    expect(duck.start(1, 32, 0.5)).toBe('pending')
    for (let t = 32; t < 200; t += 32) expect(duck.frame(1, 32, 0.5)).toBe('pending')
    let ev = 'pending'
    for (let t = 0; t < 500 && ev === 'pending'; t += 32) ev = duck.frame(0, 32, 0.5)
    expect(ev).toBe('restore')
    expect(duck.ducked).toBe(false)
    duck.start(1, 32, 0.5)
    const evs: string[] = []
    for (let t = 32; t < 1300; t += 32) evs.push(duck.frame(1, 32, 0.5))
    expect(evs.indexOf('duck')).toBeGreaterThan(-1)
    expect(evs.indexOf('barge-in')).toBeGreaterThan(evs.indexOf('duck'))
  })
})
