// Fase 6 — voz no celular: transcrição pela API (multipart em bytes, paridade com o vendorado),
// sessão (parcial/especulação/final reaproveitada), fala (OpenAI/ElevenLabs), settings de áudio
// (partes do dispositivo fora — `deviceId`/`activationDb`; "só no computador"), portão de ativação
// de fala (silêncio/ruído nunca chegam ao STT; alucinações filtradas), clipes (só os preâmbulos),
// fila de reprodução (ducking, posição), ditado com o microfone de TESTE e a chamada de voz inteira
// contra o servidor de sync falso + LLM/STT/TTS falsos (turno, meta.voice, marcadores codificados
// §4.3.8, end_call, custos, falar por cima → volume de volta / barge-in em palavras, tags de voz
// tiradas da fala, `interjections` legado nunca reenviado). Nunca abre microfone real nem gasta cota.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_CHAT_CONFIG } from '../src/vendor/shared/defaults'
import type { ChatConfig, Provider, ToolName } from '../src/vendor/shared/types'
import { setLocationSource } from '../src/agent/request'
import { OsmGeocoder } from '../src/location/nominatim'
import { OverpassClient } from '../src/location/overpass'
import { LocationService } from '../src/location/service'
import { DEFAULT_LOCATION_SETTINGS } from '../src/location/settings'
import { SettingsService } from '../src/settings/service'
import { FakeDevice, fakeFetch, osmRoutes } from './fakes/osm'
import {
  DEFAULT_FILLER_POOL,
  DEFAULT_KEEPALIVE_POOL,
  DEFAULT_KEEPALIVE_TOOL_POOL,
  DEFAULT_THANKS_POOL,
  DEFAULT_TOOL_PHRASE_POOL,
  DEFAULT_STT_SETTINGS,
  DEFAULT_TTS_SETTINGS,
  type SttSettings
} from '../src/vendor/shared/voice'
import { DEFAULT_ACTIVATION_DB } from '../src/vendor/shared/speechGate'
import { transcribeAudio as vendoredTranscribe } from '../src/vendor/desktop/voice/stt'
import { synthesizeBlock } from '../src/vendor/desktop/voice/tts'
import { encodeWav } from '../src/vendor/desktop/voice/wav'
import { openRecord } from '../src/crypto'
import { transcribeAudio, SttError } from '../src/voice/stt'
import { resetNoiseFloor, TranscribeSession } from '../src/voice/session'
import { audioSettingOut, resolveStt, resolveTts, readVoiceSettings } from '../src/voice/endpoints'
import { outgoingPlain } from '../src/data/legacy'
import {
  CLIP_CLASSES,
  clipClassHash,
  clipPhraseSet,
  clipsHash,
  clipsStatus,
  generateClips,
  loadCurrentClipAudio,
  memoryClipStore
} from '../src/voice/clips'
import {
  FakeMicSource,
  decodeWav,
  FRAME_SAMPLES,
  type MicFrame,
  type MicSource
} from '../src/voice/mic'
import {
  UtteranceQueue,
  type PlaybackBackend,
  type PlaybackHandle,
  playableAudio
} from '../src/voice/player'
import { createVoiceStack } from '../src/voice/stack'
import { floatToPcm16, frameRms } from '../src/vendor/renderer/audio/pcm'
import { voicedMsOf, wavOf } from './fakes/fakeVoice'
import { makeHarness, until, type Harness } from './hostHarness'

const RATE = 16_000

/** "Fala" sintética: trechos de voz (ruído tonal ~0,15 RMS) e silêncio (ruído baixíssimo). */
function speech(parts: [number, boolean][]): Float32Array {
  const total = parts.reduce((n, [ms]) => n + Math.round((ms * RATE) / 1000), 0)
  const out = new Float32Array(total)
  let o = 0
  let seed = 7
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1
  for (const [ms, voiced] of parts) {
    const n = Math.round((ms * RATE) / 1000)
    for (let i = 0; i < n; i++, o++)
      out[o] = voiced
        ? 0.15 * Math.sin((2 * Math.PI * 180 * i) / RATE) + 0.08 * rnd()
        : 0.0005 * rnd()
  }
  return out
}
/** Tom com ruído no nível `rms` (0..1) por `ms` — fala baixa/alta para o portão de ativação. */
function tone(ms: number, rms: number): Float32Array {
  const n = Math.round((ms * RATE) / 1000)
  const out = new Float32Array(n)
  const amp = rms * Math.SQRT2
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * 180 * i) / RATE)
  return out
}
const cat = (...parts: Float32Array[]): Float32Array => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}
const pcmOf = (s: Float32Array): Uint8Array => new Uint8Array(floatToPcm16(s).buffer)

const wav16 = (s: Float32Array): Uint8Array => {
  const pcm = floatToPcm16(s)
  return encodeWav(new Uint8Array(pcm.buffer), RATE)
}

const sttSettings = (baseUrl: string, extra: Partial<SttSettings['api']> = {}): SttSettings => ({
  ...DEFAULT_STT_SETTINGS,
  api: {
    providerId: 'p',
    model: 'whisper-falso',
    baseUrl,
    apiKey: 'sk-fake',
    providerKind: 'openai',
    ...extra
  }
})

/** Microfone roteirizado: o teste empurra quadros (silêncio/voz) no ritmo que quiser. */
class ScriptedMic implements MicSource {
  readonly kind = 'fake' as const
  cb: ((f: MicFrame) => void) | null = null
  starts = 0
  async start(onFrame: (f: MicFrame) => void): Promise<void> {
    this.starts++
    this.cb = onFrame
  }
  async stop(): Promise<void> {
    this.cb = null
  }
  feed(samples: Float32Array): void {
    for (let o = 0; o + FRAME_SAMPLES <= samples.length; o += FRAME_SAMPLES) {
      const f = samples.subarray(o, o + FRAME_SAMPLES)
      this.cb?.({ pcm: floatToPcm16(f), rms: frameRms(f), ms: 32 })
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Reprodução falsa com posição e volume: "toca" pelo tempo do WAV dividido por `speed`; guarda cada
 * volume aplicado (o ducking) e informa a posição (o "ouvido" do barge-in em palavras).
 */
function trackedPlayback(speed = 1): PlaybackBackend & {
  played: { mime: string; ms: number }[]
  volumes: number[]
} {
  const played: { mime: string; ms: number }[] = []
  const volumes: number[] = []
  return {
    played,
    volumes,
    async play(audio, mime, volume) {
      const ms = (mime.includes('wav') ? voicedMsOf(audio).audioMs : 200) / speed
      played.push({ mime, ms })
      volumes.push(volume)
      const t0 = Date.now()
      let stop!: () => void
      const done = new Promise<void>((r) => {
        const t = setTimeout(r, Math.max(5, ms))
        stop = () => {
          clearTimeout(t)
          r()
        }
      })
      const handle: PlaybackHandle = {
        done,
        stop: () => stop(),
        setVolume: (v) => volumes.push(v),
        position: () => ({ playedMs: Math.min(ms, Date.now() - t0), durationMs: ms })
      }
      return handle
    }
  }
}

/** Reprodução falsa: "toca" pelo tempo do WAV dividido por `speed`. */
function fakePlayback(speed = 8): PlaybackBackend & { played: { mime: string; ms: number }[] } {
  const played: { mime: string; ms: number }[] = []
  return {
    played,
    async play(audio, mime) {
      const ms = mime.includes('wav') ? voicedMsOf(audio).audioMs : 200
      played.push({ mime, ms })
      let stop!: () => void
      const done = new Promise<void>((r) => {
        const t = setTimeout(r, Math.max(5, ms / speed))
        stop = () => {
          clearTimeout(t)
          r()
        }
      })
      return { done, stop: () => stop(), setVolume: () => undefined }
    }
  }
}

describe('transcrição pela API (multipart em bytes)', () => {
  let h: Harness
  beforeEach(async () => {
    h = await makeHarness()
  })
  afterEach(async () => h.close())

  it('mesmos campos que o transcribeAudio vendorado (FormData do Node), idioma ISO e parâmetros da família', async () => {
    const audio = wav16(
      speech([
        [200, false],
        [1000, true],
        [300, false]
      ])
    )
    const settings = sttSettings(`${h.llm.url}/v1`, {
      params: { openai: { temperature: 0.2, prompt: 'nomes próprios' } }
    })
    const mine = await transcribeAudio(
      { audio, mimeType: 'audio/wav', fileName: 'fala.wav' },
      { settings, language: 'pt-BR' }
    )
    const theirs = await vendoredTranscribe(
      { audio, mimeType: 'audio/wav', fileName: 'fala.wav' },
      { settings, language: 'pt-BR' }
    )
    expect(mine.text).toBe(theirs.text)
    expect(mine.text).toMatch(/^fala de teste de 1(\.\d)? segundos$/)
    const [a, b] = h.llm.voice.log.slice(-2)
    expect(a.fields).toEqual(b.fields)
    expect(a.fields).toMatchObject({
      model: 'whisper-falso',
      language: 'pt',
      response_format: 'json',
      temperature: '0.2',
      prompt: 'nomes próprios'
    })
    expect(a.audioMs).toBe(b.audioMs)
  })

  it('erros legíveis com categoria: 401 → auth, 500 → http, sem provedor → config', async () => {
    const audio = wav16(speech([[500, true]]))
    await expect(
      transcribeAudio(
        { audio, mimeType: 'audio/wav' },
        { settings: sttSettings(`${h.llm.url}/v1`, { apiKey: 'invalida' }) }
      )
    ).rejects.toMatchObject({ kind: 'auth', status: 401 })
    h.llm.voice.failNext = 503
    const e = await transcribeAudio(
      { audio, mimeType: 'audio/wav' },
      { settings: sttSettings(`${h.llm.url}/v1`) }
    ).catch((x) => x)
    expect(e).toBeInstanceOf(SttError)
    expect(e.kind).toBe('http')
    expect(e.message).toContain('falha falsa 503')
    await expect(
      transcribeAudio({ audio, mimeType: 'audio/wav' }, { settings: sttSettings('') })
    ).rejects.toMatchObject({ kind: 'config' })
  })

  it('sessão: especulação na pausa vira a final sem 2ª request; transitória repete uma vez', async () => {
    h.llm.voice.fixtures = [
      {
        voicedMs: voicedMsOf(wav16(speech([[1200, true]]))).voicedMs,
        text: 'Qual é a capital da França?'
      }
    ]
    const s = new TranscribeSession({ settings: sttSettings(`${h.llm.url}/v1`), language: 'pt-BR' })
    const pcm = floatToPcm16(
      speech([
        [150, false],
        [1200, true],
        [250, false]
      ])
    )
    s.push(new Uint8Array(pcm.buffer))
    const before = h.llm.voice.log.length
    const spec = await s.speculate()
    expect(spec?.text).toBe('Qual é a capital da França?')
    const fin = await s.stop({ reuseSpeculative: true })
    expect(fin).toMatchObject({ text: 'Qual é a capital da França?', speculative: true })
    expect(h.llm.voice.log.length - before).toBe(1)
    // transitória (503) → uma nova tentativa
    const s2 = new TranscribeSession({ settings: sttSettings(`${h.llm.url}/v1`) })
    s2.push(new Uint8Array(pcm.buffer))
    h.llm.voice.failNext = 503
    expect((await s2.stop()).text).toBe('Qual é a capital da França?')
  })

  it('portão de ativação: silêncio e ruído nunca chegam ao STT (parcial, especulação e final); a fala vai aparada', async () => {
    resetNoiseFloor()
    const settings = sttSettings(`${h.llm.url}/v1`)
    const sttCalls = () => h.llm.voice.log.filter((l) => l.path.endsWith('/audio/transcriptions'))
    const before = sttCalls().length
    const partials: string[] = []
    // 3 s de silêncio + ruído de sala (−50 dBFS, abaixo da ativação de −45)
    const quiet = new TranscribeSession({
      settings,
      partials: true,
      partialIntervalMs: 0,
      onPartial: (e) => partials.push(e.text)
    })
    for (let i = 0; i < 10; i++) quiet.push(pcmOf(speech([[150, false]])))
    for (let i = 0; i < 10; i++) quiet.push(pcmOf(tone(150, 0.003)))
    expect(await quiet.speculate()).toMatchObject({ text: '' })
    expect(await quiet.stop({ reuseSpeculative: true })).toMatchObject({ text: '' })
    expect(sttCalls().length).toBe(before)
    expect(partials).toEqual([])
    // fala de 1,2 s entre 1 s de silêncio e 1,5 s de silêncio: só o trecho com voz (+ folga) sobe
    const one = speech([[1200, true]])
    h.llm.voice.fixtures = [{ voicedMs: voicedMsOf(wav16(one)).voicedMs, text: 'Abre o arquivo.' }]
    const talk = new TranscribeSession({ settings })
    talk.push(
      pcmOf(
        speech([
          [1000, false],
          [1200, true],
          [1500, false]
        ])
      )
    )
    expect((await talk.stop()).text).toBe('Abre o arquivo.')
    const sent = sttCalls().at(-1)!
    expect(sent.audioMs).toBeGreaterThanOrEqual(1200)
    expect(sent.audioMs).toBeLessThan(1900) // 1,2 s de voz + 200 ms antes + 300 ms depois (≈)
  })

  it('pós-filtro: "Obrigado." sobre um estalo curto vira vazio; o mesmo dito de verdade passa', async () => {
    resetNoiseFloor()
    const settings = sttSettings(`${h.llm.url}/v1`)
    const blip = speech([[320, true]])
    const real = speech([[1100, true]])
    h.llm.voice.fixtures = [
      { voicedMs: voicedMsOf(wav16(blip)).voicedMs, text: 'Obrigado.' },
      { voicedMs: voicedMsOf(wav16(real)).voicedMs, text: 'Obrigado.' }
    ]
    const a = new TranscribeSession({ settings })
    a.push(
      pcmOf(
        speech([
          [600, false],
          [320, true],
          [800, false]
        ])
      )
    )
    expect((await a.stop()).text).toBe('')
    const b = new TranscribeSession({ settings })
    b.push(
      pcmOf(
        speech([
          [300, false],
          [1100, true],
          [500, false]
        ])
      )
    )
    expect((await b.stop()).text).toBe('Obrigado.')
  })

  it('nível de ativação do aparelho: fala baixa (−38 dBFS) conta com −45; com −30 nem vai ao STT', async () => {
    resetNoiseFloor()
    const settings = sttSettings(`${h.llm.url}/v1`)
    const low = cat(speech([[400, false]]), tone(1200, 0.0126), speech([[600, false]]))
    h.llm.voice.fixtures = [{ voicedMs: 1200, text: 'fala baixa' }]
    const calls = () => h.llm.voice.log.filter((l) => l.path.endsWith('/audio/transcriptions'))
    const n0 = calls().length
    const loud = new TranscribeSession({ settings, activationDb: -45 })
    loud.push(pcmOf(low))
    expect((await loud.stop()).text).toBe('fala baixa')
    expect(calls().length).toBe(n0 + 1)
    const strict = new TranscribeSession({ settings, activationDb: -30 })
    strict.push(pcmOf(low))
    expect((await strict.stop()).text).toBe('')
    expect(calls().length).toBe(n0 + 1)
  })
})

describe('fala (TTS) — clientes vendorados no celular', () => {
  let h: Harness
  beforeEach(async () => {
    h = await makeHarness()
  })
  afterEach(async () => h.close())

  it('OpenAI-compatível devolve WAV; ElevenLabs devolve PCM cru que a fila converte em WAV', async () => {
    const openai = await synthesizeBlock(
      {
        text: 'Olá, tudo bem?',
        settings: {
          ...DEFAULT_TTS_SETTINGS,
          backend: 'api',
          api: {
            providerId: 'p',
            model: 'tts-falso',
            voice: 'alloy',
            baseUrl: `${h.llm.url}/v1`,
            apiKey: 'k',
            providerKind: 'openai'
          }
        }
      },
      {}
    )
    expect(openai.mime).toBe('audio/wav')
    expect(voicedMsOf(openai.audio).audioMs).toBeGreaterThan(300)
    expect(h.llm.voice.log.at(-1)).toMatchObject({
      path: '/v1/audio/speech',
      fields: { model: 'tts-falso', voice: 'alloy', input: 'Olá, tudo bem?' }
    })
    const eleven = await synthesizeBlock(
      {
        text: 'Oi!',
        settings: {
          ...DEFAULT_TTS_SETTINGS,
          backend: 'api',
          api: {
            providerId: 'e',
            model: 'eleven_flash_v2_5',
            voice: 'voz-falsa-1',
            baseUrl: h.llm.url,
            apiKey: 'xi',
            providerKind: 'elevenlabs'
          }
        }
      },
      {}
    )
    expect(eleven.mime).toMatch(/^audio\/pcm;rate=24000/)
    expect(h.llm.voice.log.at(-1)?.path).toBe('/v1/text-to-speech/voz-falsa-1/stream')
    const wav = playableAudio(eleven)
    expect(wav.mime).toBe('audio/wav')
    expect(decodeWav(wav.audio).rate).toBe(24000)
  })
})

describe('settings de áudio no celular (§4.3.2/§4.4)', () => {
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

  it('gravar tira as partes do dispositivo (deviceId, installed, gpu, endereço/chave) e nunca envia "gpu"', () => {
    expect(
      audioSettingOut('audioInput', { deviceId: 'mic-1', pttEnabled: true, language: 'pt-BR' })
    ).toEqual({ pttEnabled: true, language: 'pt-BR' })
    expect(
      audioSettingOut(
        'sttSettings',
        {
          mode: 'gpu',
          api: {
            providerId: 'or',
            model: 'm',
            baseUrl: 'x',
            apiKey: 'y',
            providerKind: 'openrouter'
          },
          local: { engine: 'whisper.cpp', model: '', installed: true },
          gpu: { engine: 'whisper' }
        },
        { mode: 'hybrid' }
      )
    ).toEqual({
      mode: 'hybrid',
      api: { providerId: 'or', model: 'm' },
      local: { engine: 'whisper.cpp', model: '' }
    })
  })

  it('STT "local" e TTS "local" são só no computador (explica, não manda áudio para a API); ElevenLabs não transcreve', () => {
    const local = resolveStt({ ...DEFAULT_STT_SETTINGS, mode: 'local' }, provider)
    expect('block' in local && local.block.desktopOnly).toBe(true)
    const el = resolveStt(
      { ...DEFAULT_STT_SETTINGS, api: { providerId: 'el', model: 'x' } },
      provider
    )
    expect('block' in el && el.block.reason).toContain('ElevenLabs')
    const hybrid = resolveStt(
      { ...DEFAULT_STT_SETTINGS, mode: 'hybrid', api: { providerId: 'or', model: 'whisper' } },
      provider
    )
    expect('settings' in hybrid && hybrid.settings.api.providerKind).toBe('openrouter')
    const tts = resolveTts(DEFAULT_TTS_SETTINGS, provider)
    expect('block' in tts && tts.block.reason).toContain('Kokoro')
    const ok = resolveTts(
      {
        ...DEFAULT_TTS_SETTINGS,
        backend: 'api',
        api: { providerId: 'el', model: '', voice: null }
      },
      provider
    )
    expect('settings' in ok && ok.settings.api.providerKind).toBe('elevenlabs')
    // registro ausente → padrões normalizados
    expect(readVoiceSettings(() => undefined).audioInput.language).toBe('pt-BR')
  })

  it('nível de ativação é parte do aparelho: nunca vai no registro e o recebido não o troca', () => {
    expect(
      audioSettingOut('audioInput', {
        deviceId: 'mic-1',
        activationDb: -30,
        pttEnabled: true,
        language: 'pt-BR'
      })
    ).toEqual({ pttEnabled: true, language: 'pt-BR' })
    const rec = { pttEnabled: false, activationDb: -22, language: 'pt-BR' }
    const setting = (id: string) => (id === 'audioInput' ? rec : undefined)
    expect(readVoiceSettings(setting).audioInput.activationDb).toBe(DEFAULT_ACTIVATION_DB)
    expect(readVoiceSettings(setting, { activationDb: -52 }).audioInput.activationDb).toBe(-52)
    expect(readVoiceSettings(setting, { activationDb: -99 }).audioInput.activationDb).toBe(-70)
    expect(readVoiceSettings(setting, { activationDb: -52 }).audioInput.pttEnabled).toBe(false)
  })

  it('`interjections` é legado: nunca sai em chat/persona/voiceCallDefaults (o resto intacto)', () => {
    const legacy = { enabled: true, shadow: true, classes: ['ACK'] }
    const chat = {
      sv: 1,
      title: 't',
      config: { model: 'm', voice: { enabled: true, interjections: legacy, endCall: false } }
    }
    expect(outgoingPlain('chat', 'c1', chat)).toEqual({
      sv: 1,
      title: 't',
      config: { model: 'm', voice: { enabled: true, endCall: false } }
    })
    expect(
      (
        outgoingPlain('preset', 'p1', { sv: 1, config: { voice: { interjections: null } } }) as {
          config: { voice: object }
        }
      ).config.voice
    ).toEqual({})
    expect(
      outgoingPlain('setting', 'voiceCallDefaults', {
        sv: 1,
        value: { enabled: true, interjections: legacy, audioTags: true }
      })
    ).toEqual({ sv: 1, value: { enabled: true, audioTags: true } })
    // nada a tirar: o mesmo objeto
    const plain = { sv: 1, config: { voice: { enabled: null } } }
    expect(outgoingPlain('chat', 'c2', plain)).toBe(plain)
    expect(outgoingPlain('setting', 'audioInput', { sv: 1, value: { interjections: 1 } })).toEqual({
      sv: 1,
      value: { interjections: 1 }
    })
  })
})

describe('clipes e fila de reprodução', () => {
  it('classes: preâmbulos, frases de ferramenta e "obrigado por aguardar" (as interjeições saíram); hash por classe', () => {
    expect(CLIP_CLASSES).toEqual(['FILLER', 'TOOL', 'THANKS'])
    expect(clipPhraseSet(null)).toEqual({
      FILLER: DEFAULT_FILLER_POOL.map((f) => f.text),
      TOOL: DEFAULT_TOOL_PHRASE_POOL.map((f) => f.text),
      THANKS: [...DEFAULT_THANKS_POOL]
    })
    const tts = {
      ...DEFAULT_TTS_SETTINGS,
      backend: 'api' as const,
      api: { providerId: 'p', model: 'm', voice: 'v1' }
    }
    // mudar as frases de ferramenta não invalida os preâmbulos (e vice-versa)
    const tools = [{ text: 'Vou ver.', categories: ['generic' as const] }]
    expect(clipClassHash(tts, 'FILLER', null, tools)).toBe(clipClassHash(tts, 'FILLER', null, null))
    expect(clipClassHash(tts, 'TOOL', null, tools)).not.toBe(clipClassHash(tts, 'TOOL', null, null))
    expect(clipsHash(tts, null, tools)).not.toBe(clipsHash(tts))
    // agradecimentos personalizados: só a classe THANKS muda
    const thanks = ['Valeu pela paciência.']
    expect(clipClassHash(tts, 'THANKS', null, null, thanks)).not.toBe(
      clipClassHash(tts, 'THANKS', null, null, null)
    )
    expect(clipClassHash(tts, 'FILLER', null, null, thanks)).toBe(
      clipClassHash(tts, 'FILLER', null, null, null)
    )
    expect(clipClassHash(tts, 'TOOL', null, null, thanks)).toBe(
      clipClassHash(tts, 'TOOL', null, null, null)
    )
  })

  it('gera os que faltam, carrega só da definição atual e apaga os velhos', async () => {
    const store = memoryClipStore()
    const tts = {
      ...DEFAULT_TTS_SETTINGS,
      backend: 'api' as const,
      api: { providerId: 'p', model: 'm', voice: 'v1' }
    }
    // um clipe de interjeição de uma versão antiga no cache: some na próxima geração
    await store.write(`${clipsHash(tts).slice(0, 24)}_ACK_1`, {
      audio: new Uint8Array([1]),
      mime: 'audio/wav'
    })
    const synth = async (t: string) => ({ audio: new TextEncoder().encode(t), mime: 'audio/wav' })
    const st0 = await clipsStatus(store, tts)
    expect(st0.ready).toBe(0)
    expect(st0.byClass.TOOL.total).toBe(DEFAULT_TOOL_PHRASE_POOL.length)
    const r = await generateClips({ store, settings: tts, synth })
    expect(r.generated).toBe(r.total)
    expect(r.total).toBe(
      DEFAULT_FILLER_POOL.length + DEFAULT_TOOL_PHRASE_POOL.length + DEFAULT_THANKS_POOL.length
    )
    expect(store.keys().some((k) => k.includes('_ACK_'))).toBe(false)
    expect(
      new TextDecoder().decode((await loadCurrentClipAudio(store, tts, null, 'FILLER', 2))!.audio)
    ).toBe(DEFAULT_FILLER_POOL[1].text)
    expect(
      new TextDecoder().decode((await loadCurrentClipAudio(store, tts, null, 'TOOL', 3))!.audio)
    ).toBe(DEFAULT_TOOL_PHRASE_POOL[2].text)
    expect(
      new TextDecoder().decode((await loadCurrentClipAudio(store, tts, null, 'THANKS', 1))!.audio)
    ).toBe(DEFAULT_THANKS_POOL[0])
    expect(
      await loadCurrentClipAudio(store, tts, null, 'FILLER', DEFAULT_FILLER_POOL.length + 1)
    ).toBeNull()
    // outra voz (outra persona): cache próprio; gerar a dela não apaga os desta
    const other = { ...tts, api: { ...tts.api, voice: 'v2' } }
    expect(clipsHash(other)).not.toBe(clipsHash(tts))
    expect(await loadCurrentClipAudio(store, other, null, 'FILLER', 1)).toBeNull()
    await generateClips({ store, settings: other, synth })
    expect(await loadCurrentClipAudio(store, other, null, 'FILLER', 1)).not.toBeNull()
    expect(await loadCurrentClipAudio(store, tts, null, 'FILLER', 1)).not.toBeNull()
    expect((await clipsStatus(store, tts)).ready).toBe(r.total)
    // pool de frases de ferramenta mudou: só os TOOL desta voz ficam velhos (os FILLER valem)
    const tools = [{ text: 'Vou ver isso.', categories: ['generic' as const] }]
    const st1 = await clipsStatus(store, tts, null, tools)
    expect(st1.byClass.FILLER.ready).toBe(DEFAULT_FILLER_POOL.length)
    expect(st1.byClass.TOOL).toEqual({ total: 1, ready: 0 })
    expect(st1.byClass.THANKS.ready).toBe(DEFAULT_THANKS_POOL.length)
    // agradecimentos personalizados: só os THANKS ficam velhos
    const st2 = await clipsStatus(store, tts, null, null, ['Valeu pela paciência.'])
    expect(st2.byClass.THANKS).toEqual({ total: 1, ready: 0 })
    expect(st2.byClass.FILLER.ready).toBe(DEFAULT_FILLER_POOL.length)
  })

  it('ducking: rampa até o ganho, continua tocando, vale para a próxima e volta; posição da frase', async () => {
    const pb = trackedPlayback(1)
    const q = new UtteranceQueue({ backend: pb })
    const w = wavOf(Buffer.alloc(24000 * 2 * 0.6), 24000)
    q.enqueue({ id: 'a', audio: w, mime: 'audio/wav', text: 'Primeira frase.' })
    q.enqueue({ id: 'b', audio: w, mime: 'audio/wav' })
    await until(() => q.current?.id === 'a' && !!q.currentPosition(), 2000)
    q.setDuck(0.3, 80)
    await sleep(140)
    expect(q.duck).toBeCloseTo(0.3)
    // a rampa passou por valores intermediários (sem degrau seco) e terminou no ganho
    const ramp = pb.volumes.slice(1)
    expect(ramp.length).toBeGreaterThan(2)
    expect(ramp.at(-1)).toBeCloseTo(0.3)
    expect(ramp.some((v) => v > 0.31 && v < 0.99)).toBe(true)
    expect(q.current?.id).toBe('a') // continua tocando
    const pos = q.currentPosition()!
    expect(pos.id).toBe('a')
    expect(pos.durationMs).toBe(600)
    expect(pos.playedMs).toBeGreaterThan(100)
    // a próxima frase já começa abaixada
    await until(() => q.current?.id === 'b', 2000)
    expect(pb.volumes.filter((v) => v <= 0.31).length).toBeGreaterThan(0)
    q.setDuck(1, 80)
    await sleep(140)
    expect(pb.volumes.at(-1)).toBe(1)
    q.cancel()
    expect(q.currentPosition()).toBeNull()
    q.dispose()
  })

  it('fila: na ordem, sem sobreposição; drop da atual segue para a próxima; cancel limpa e fica ociosa', async () => {
    const pb = fakePlayback(50)
    const states: string[] = []
    const events: string[] = []
    const q = new UtteranceQueue({
      backend: pb,
      onState: (s) => states.push(s),
      onItem: (e) => events.push(`${e.phase}:${e.item.id}`)
    })
    const w = wavOf(Buffer.alloc(24000 * 2 * 0.5), 24000)
    q.enqueue({ id: 'a', audio: w, mime: 'audio/wav' })
    q.enqueue({ id: 'b', audio: w, mime: 'audio/wav' })
    q.enqueue({ id: 'c', audio: w, mime: 'audio/wav' })
    await until(() => q.current?.id === 'a', 2000)
    q.drop('a')
    await until(() => events.includes('end:b'), 2000)
    q.cancel()
    expect(q.state).toBe('idle')
    expect(events.slice(0, 3)).toEqual(['start:a', 'end:a', 'start:b'])
    expect(states[0]).toBe('playing')
  })
})

// ---------------- ditado e chamada sobre o host (servidor de sync falso) ----------------

describe('ditado e chamada de voz no host do celular', () => {
  let h: Harness
  const audioProv = 'prov-voz'
  beforeEach(async () => {
    h = await makeHarness()
    await h.desk.put('provider', audioProv, null, {
      sv: 1,
      name: 'Voz falsa',
      kind: 'openai',
      baseUrl: `${h.llm.url}/v1`,
      apiKey: 'sk-voz',
      headers: {},
      createdAt: 2
    })
    await h.engine.sync()
    // settings de voz: LOCAIS deste aparelho desde 1.9.0 (Configurações → Voz do celular)
    h.store.setDeviceSetting('sttSettings', {
      mode: 'api',
      api: { providerId: audioProv, model: 'whisper-falso' },
      local: null,
      livePartials: true
    })
    h.store.setDeviceSetting('ttsSettings', {
      backend: 'api',
      api: { providerId: audioProv, model: 'tts-falso', voice: 'alloy' },
      local: null
    })
    h.store.setDeviceSetting('audioInput', {
      pttEnabled: false,
      pttKey: null,
      silenceStopEnabled: true,
      silenceStopMs: 600,
      language: 'pt-BR'
    })
  })
  afterEach(async () => h.close())

  const newChat = (cfg: Partial<ChatConfig> = {}) => {
    const { chat, session } = h.stack.repo.createChat({
      config: {
        ...DEFAULT_CHAT_CONFIG(''),
        providerId: h.providerId,
        model: 'fake/agent',
        enabledTools: [],
        ...cfg
      }
    })
    return { chatId: chat.id, sid: session.id }
  }

  it('ditado: microfone de teste → parciais → para sozinho no silêncio → texto final; "Local" explica', async () => {
    const one = speech([[1500, true]])
    h.llm.voice.fixtures = [
      { voicedMs: voicedMsOf(wav16(one)).voicedMs, text: 'mande um abraço para a Ana' }
    ]
    const mic = new FakeMicSource(
      speech([
        [300, false],
        [1500, true],
        [3000, false]
      ]),
      RATE,
      { frameMs: 4 }
    )
    const voice = createVoiceStack({
      stack: h.stack,
      store: h.store,
      mic: () => mic,
      playback: fakePlayback(),
      clips: memoryClipStore(),
      requestMic: async () => true,
      bargeIn: () => false
    })
    const d = voice.dictation
    let auto = false
    d.onAutoStop = () => (auto = true)
    expect(await d.start()).toBeNull()
    expect(d.getView().phase).toBe('recording')
    await until(() => auto, 8000, 'parada por silêncio')
    const r = await d.finish()
    expect(r?.text).toBe('mande um abraço para a Ana')
    const sttCalls = h.llm.voice.log.filter((l) => l.path.endsWith('/audio/transcriptions'))
    expect(sttCalls.every((l) => l.fields.language === 'pt')).toBe(true)
    // o envio leva meta.voice (ditado)
    const { chatId, sid } = newChat()
    await h.stack.host.local(chatId, 'send', {
      sessionId: sid,
      text: r!.text,
      voice: { source: 'dictation' }
    })
    const user = h.stack.repo.path(sid).find((m) => m.message.role === 'user')!
    expect(user.meta.voice).toEqual({ source: 'dictation' })
    // modo Local: só no computador (o celular não tem motores locais)
    h.store.setDeviceSetting('sttSettings', {
      mode: 'local',
      api: { providerId: audioProv, model: 'w' },
      local: { engine: 'whisper.cpp', model: '' },
      livePartials: true
    })
    expect(await d.start()).toBe(
      'Ditado não funciona neste dispositivo — este dispositivo não tem motores locais de voz (Configurações → Voz).'
    )
  })

  it('chamada: turno falado → resposta falada → "tchau" → end_call desliga; marcadores codificados e custos', async () => {
    const q1 = speech([[1200, true]])
    const q2 = speech([[700, true]])
    h.llm.voice.fixtures = [
      { voicedMs: voicedMsOf(wav16(q1)).voicedMs, text: 'Qual é a capital da França?' },
      { voicedMs: voicedMsOf(wav16(q2)).voicedMs, text: 'Obrigado, tchau.' }
    ]
    const mic = new ScriptedMic()
    const pb = fakePlayback(10)
    const voice = createVoiceStack({
      stack: h.stack,
      store: h.store,
      mic: () => mic,
      playback: pb,
      clips: memoryClipStore(),
      requestMic: async () => true,
      bargeIn: () => false
    })
    const call = voice.call
    const { chatId, sid } = newChat()
    await call.start(sid)
    expect(call.getView().call.active).toBe(true)
    expect(h.stack.host.windowOpen(chatId)).toBe(true)
    const silence = speech([[64, false]])
    const feedSilenceUntil = async (cond: () => boolean, ms = 15000, what = '') => {
      const t0 = Date.now()
      while (!cond()) {
        if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`)
        mic.feed(silence)
        await new Promise((r) => setTimeout(r, 4))
      }
    }
    // 1º turno
    mic.feed(speech([[200, false]]))
    mic.feed(q1)
    await feedSilenceUntil(
      () => h.stack.repo.path(sid).some((m) => m.message.role === 'user'),
      15000,
      'turno enviado'
    )
    await feedSilenceUntil(
      () =>
        h.stack.repo.path(sid).some((m) => m.message.role === 'assistant' && !m.meta.synthetic) &&
        pb.played.length > 0 &&
        call.getView().call.phase === 'listening',
      15000,
      'resposta falada'
    )
    const user = h.stack.repo.path(sid).find((m) => m.message.role === 'user')!
    expect(user.message.content).toBe('Qual é a capital da França?')
    expect(user.meta.voice).toMatchObject({ source: 'call', sttModel: 'whisper-falso' })
    const reply = h.stack.repo
      .path(sid)
      .find((m) => m.message.role === 'assistant' && !m.meta.synthetic)!
    expect(reply.meta.voice).toMatchObject({ source: 'call', spoken: true, ttsModel: 'tts-falso' })
    expect(reply.meta.voice?.callId).toBe(user.meta.voice?.callId)
    // o turno de voz oferece end_call (a descrição está na própria tool) e NÃO põe prompt oculto:
    // sem "Prompt do modo voz" na persona/chat, o system prompt é o normal do chat
    const req = h.llm.requests.filter((r) => r.path.endsWith('/chat/completions')).at(-1)!
    const sys = JSON.stringify((req.body.messages as unknown[])[0])
    expect(sys).not.toContain('conversa por voz')
    expect(JSON.stringify(req.body.tools)).toContain('end_call')
    // 2º turno: despedida → end_call → a chamada cai depois de tocar
    // o rabo do eco (meia-duplex) passa: o microfone volta a ouvir
    await feedSilenceUntil(() => !call.getView().deaf, 3000, 'microfone voltar')
    mic.feed(q2)
    await feedSilenceUntil(() => !call.getView().call.active, 20000, 'desligar pelo agente')
    await until(
      () => h.stack.repo.path(sid).filter((m) => m.meta.kind === 'voice-call').length === 2,
      8000,
      'marcador de fim'
    )
    const marks = h.stack.repo.path(sid).filter((m) => m.meta.kind === 'voice-call')
    expect(marks[0].meta.voiceCall?.phase).toBe('start')
    const end = marks[1].meta.voiceCall!
    expect(end).toMatchObject({ phase: 'end', endedBy: 'agent' })
    expect(end.usage?.turns).toBe(2)
    // o STT falso está em 127.0.0.1: conta como requests locais (grátis), como no desktop
    expect((end.usage?.stt.apiRequests ?? 0) + (end.usage?.stt.localRequests ?? 0)).toBeGreaterThan(
      1
    )
    expect(end.usage?.tts.chars).toBeGreaterThan(0)
    expect(end.usage?.llm.calls).toBeGreaterThan(0)
    const tool = h.stack.repo.path(sid).find((m) => m.message.role === 'tool')!
    expect(tool.message.content).toBe('Chamada encerrada pelo agente.')
    // registro: o marcador vai como memory-extraction + voiceCall (§4.3.8)
    await h.stack.writer.flush(chatId)
    await until(() => !h.stack.writer.pending(chatId), 8000, 'outbox')
    const rec = h.server.records.get(`message|${marks[1].id}`)!
    const plain = (await openRecord(h.desk.sk.record, h.server.userId, rec, rec.env!)) as {
      meta: Record<string, unknown>
    }
    expect(plain.meta.kind).toBe('memory-extraction')
    expect(plain.meta.voiceCall).toMatchObject({ phase: 'end' })
    expect(plain.meta.memoryExtraction).toBeUndefined()
  }, 60_000)

  it('meia-duplex: fala durante a resposta é ignorada; "Interromper" faz o barge-in e o histórico fica só com o ouvido', async () => {
    const q1 = speech([[1000, true]])
    h.llm.voice.fixtures = [
      { voicedMs: voicedMsOf(wav16(q1)).voicedMs, text: '/slow conte uma história' }
    ]
    const mic = new ScriptedMic()
    const pb = fakePlayback(1) // tempo real: dá tempo de interromper
    const voice = createVoiceStack({
      stack: h.stack,
      store: h.store,
      mic: () => mic,
      playback: pb,
      clips: memoryClipStore(),
      requestMic: async () => true,
      bargeIn: () => false
    })
    const call = voice.call
    const { sid } = newChat()
    await call.start(sid)
    const silence = speech([[64, false]])
    const feedUntil = async (cond: () => boolean, what: string) => {
      const t0 = Date.now()
      while (!cond()) {
        if (Date.now() - t0 > 20000) throw new Error(`timeout: ${what}`)
        mic.feed(silence)
        await new Promise((r) => setTimeout(r, 4))
      }
    }
    mic.feed(q1)
    await feedUntil(() => call.getView().playing, 'começar a falar')
    mic.feed(silence)
    expect(call.getView().deaf).toBe(true)
    const starts = () => call.getView().timeline.filter((e) => e.kind === 'speech-start').length
    const before = starts()
    mic.feed(speech([[1500, true]])) // eco/fala durante a resposta: microfone surdo
    expect(starts()).toBe(before)
    expect(call.getView().playing).toBe(true)
    call.interrupt()
    await feedUntil(() => !h.stack.runner.isRunning(sid), 'turno parar')
    const reply = h.stack.repo
      .path(sid)
      .filter((m) => m.message.role === 'assistant' && !m.meta.synthetic)
    expect(reply.length).toBeLessThanOrEqual(1)
    if (reply[0]) expect(reply[0].meta.interrupted).toBe(true)
    call.stop()
    await until(() => !call.getView().call.active, 4000)
  }, 60_000)

  it('falar por cima (com fone): voz do assistente abaixa → volta (tosse) e abaixa → barge-in em palavras; tags tiradas da fala', async () => {
    resetNoiseFloor()
    const q1 = speech([[1300, true]])
    const q2 = speech([[1500, true]])
    h.llm.voice.fixtures = [
      {
        voicedMs: voicedMsOf(wav16(q1)).voicedMs,
        text: 'Conte devagar uma história comprida sobre o mar. [risos] Depois fale das ondas que batem na praia sem parar nunca.'
      },
      { voicedMs: voicedMsOf(wav16(q2)).voicedMs, text: 'Espera aí, me fala do farol.' },
      // a fala curta por cima (parcial ao vivo): só backchannel — não confirma o barge-in
      { voicedMs: voicedMsOf(wav16(speech([[700, true]]))).voicedMs, text: 'Uhum.' }
    ]
    const mic = new ScriptedMic()
    const pb = trackedPlayback(1) // tempo real: dá tempo de falar por cima
    const voice = createVoiceStack({
      stack: h.stack,
      store: h.store,
      mic: () => mic,
      playback: pb,
      clips: memoryClipStore(),
      requestMic: async () => true,
      bargeIn: () => true
    })
    const call = voice.call
    const { sid } = newChat()
    await call.start(sid)
    const silence = speech([[64, false]])
    const feedUntil = async (cond: () => boolean, what: string, ms = 20000) => {
      const t0 = Date.now()
      while (!cond()) {
        if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`)
        mic.feed(silence)
        await sleep(4)
      }
    }
    const kinds = () => call.getView().timeline.map((e) => e.kind)
    mic.feed(q1)
    // a 1ª frase da resposta tocando (e a leitura ao vivo andando)
    await feedUntil(() => !!call.follow.get().current, 'começar a falar')
    await sleep(350)
    expect(call.follow.get().sessionId).toBe(sid)
    // tags de voz: a voz falsa não interpreta → saem do texto da síntese
    const ttsInputs = h.llm.voice.log
      .filter((l) => l.path.endsWith('/audio/speech'))
      .map((l) => l.fields.input)
    expect(ttsInputs.join(' ')).not.toContain('[risos]')
    // --- tosse/clique curto por cima (200 ms): abaixo do onset — nada abaixa nem vira turno ---
    mic.feed(speech([[200, true]]))
    mic.feed(speech([[600, false]]))
    expect(kinds()).not.toContain('duck')
    expect(kinds()).not.toContain('duck-restore')
    expect(Math.min(...pb.volumes)).toBe(1)
    // --- fala curta por cima (700 ms de voz): passa do onset (500 ms) → abaixa; para → volta ---
    mic.feed(speech([[700, true]]))
    expect(kinds()).toContain('duck')
    expect(call.getView().ducked).toBe(true)
    await until(() => Math.min(...pb.volumes) <= 0.31, 3000, 'abaixar') // padrão 0,3
    mic.feed(speech([[600, false]]))
    expect(kinds()).toContain('duck-restore')
    expect(call.getView().ducked).toBe(false)
    await until(() => pb.volumes.at(-1) === 1, 3000, 'volume de volta')
    expect(kinds()).not.toContain('barge-in') // nada cancelado: a resposta continuou
    expect(h.stack.repo.path(sid).filter((m) => m.message.role === 'user').length).toBe(1)
    // --- insiste falando por cima: barge-in (voz) no meio da frase ---
    await sleep(300)
    mic.feed(q2)
    const bi = call.getView().timeline.find((e) => e.kind === 'barge-in')!
    expect(bi).toMatchObject({ reason: 'voiced' })
    // a frase tocando no barge-in (se havia uma — sob carga pode cair entre duas frases)
    const heardEv = call.getView().timeline.find((e) => e.kind === 'heard')
    if (heardEv) expect(heardEv.reason).toBe('heard-estimated')
    expect(call.follow.get().current).toBeNull()
    await feedUntil(
      () =>
        h.stack.repo.path(sid).filter((m) => m.message.role === 'user').length === 2 &&
        !h.stack.runner.isRunning(sid),
      'próximo turno'
    )
    const replies = h.stack.repo
      .path(sid)
      .filter((m) => m.message.role === 'assistant' && !m.meta.synthetic)
    const cut = replies[0]
    const content = String(cut.message.content)
    // histórico só com o que foi OUVIDO, em palavras: prefixo + "…"; o resto só para exibição
    expect(cut.meta.interrupted).toBe(true)
    expect(cut.meta.voice).toMatchObject({ source: 'call', spoken: 'partial' })
    expect(content.endsWith('…') || /[.!?]$/.test(content)).toBe(true)
    const unheard = cut.meta.voice?.unheard ?? ''
    expect(unheard.length).toBeGreaterThan(10)
    expect(unheard).toContain('praia')
    expect(`${content.replace(/…$/, '')} ${unheard}`.replace(/\s+/g, ' ')).toContain(
      'Depois fale das ondas'
    )
    // a request seguinte leva só o ouvido (nunca o `unheard`)
    const req = h.llm.requests.filter((r) => r.path.endsWith('/chat/completions')).at(-1)!
    const sentAssistant = (req.body.messages as { role: string; content: unknown }[])
      .filter((m) => m.role === 'assistant')
      .map((m) => JSON.stringify(m.content))
      .join(' ')
    expect(sentAssistant).toContain(content)
    expect(sentAssistant).not.toContain('sem parar nunca')
    call.stop()
    await until(() => !call.getView().call.active, 4000)
    expect(call.follow.get()).toEqual({ sessionId: null, heard: [], current: null })
  }, 60_000)

  it('`interjections` legado num chat antigo: o celular regrava o chat sem ele', async () => {
    const { chatId, sid } = newChat({
      voice: {
        enabled: null,
        model: null,
        tools: null,
        voicePrompt: null,
        fillers: null,
        // registro gravado por uma versão antiga
        ...({ interjections: { enabled: true, shadow: true } } as object)
      }
    })
    // a config lida já vem normalizada (sem o campo)
    expect(h.stack.repo.chat(chatId)!.config.voice).not.toHaveProperty('interjections')
    await h.stack.host.local(chatId, 'send', { sessionId: sid, text: 'oi' })
    await until(() => !h.stack.runner.isRunning(sid), 8000)
    await h.stack.writer.flush(chatId)
    await until(() => !h.stack.writer.pending(chatId), 8000, 'outbox')
    const rec = h.server.records.get(`chat|${chatId}`)!
    const plain = (await openRecord(h.desk.sk.record, h.server.userId, rec, rec.env!)) as {
      config: { voice?: Record<string, unknown> }
    }
    expect(plain.config.voice).toBeTruthy()
    expect(plain.config.voice).not.toHaveProperty('interjections')
  })
})

// ---------------- voz da persona/chat e settings locais (protocolo 1.9.0) ----------------

describe('voz da persona e settings de voz locais (1.9.0) no host do celular', () => {
  let h: Harness
  const audioProv = 'prov-voz'
  const personaProv = 'prov-persona'
  const prov = (name: string) => ({
    sv: 1,
    name,
    kind: 'openai',
    baseUrl: `${h.llm.url}/v1`,
    apiKey: 'sk-voz',
    headers: {},
    createdAt: 2
  })
  beforeEach(async () => {
    resetNoiseFloor()
    h = await makeHarness()
    await h.desk.put('provider', audioProv, null, prov('Voz falsa'))
    await h.desk.put('provider', personaProv, null, prov('Voz da persona'))
    // a persona fala/ouve com o provedor dela, em inglês
    await h.desk.put('preset', 'pers-narr', null, {
      sv: 1,
      name: 'Narradora',
      description: '',
      icon: 'sparkles',
      config: {
        voice: {
          tts: {
            backend: 'api',
            api: { providerId: personaProv, model: 'tts-persona', voice: 'nova' }
          },
          stt: {
            mode: 'api',
            api: { providerId: personaProv, model: 'whisper-persona' },
            language: 'en-US'
          }
        }
      },
      createdAt: 1,
      updatedAt: 1
    })
    await h.engine.sync()
    h.store.setDeviceSetting('sttSettings', {
      mode: 'api',
      api: { providerId: audioProv, model: 'whisper-falso' },
      local: null,
      livePartials: false
    })
    h.store.setDeviceSetting('ttsSettings', {
      backend: 'api',
      api: { providerId: audioProv, model: 'tts-falso', voice: 'alloy' },
      local: null
    })
  })
  afterEach(async () => h.close())

  const newChat = (cfg: Partial<ChatConfig> = {}) => {
    const { chat, session } = h.stack.repo.createChat({
      config: {
        ...DEFAULT_CHAT_CONFIG(''),
        providerId: h.providerId,
        model: 'fake/agent',
        enabledTools: [],
        ...cfg
      }
    })
    return { chatId: chat.id, sid: session.id }
  }

  it('settings de voz são deste aparelho: o registro de um app antigo é ignorado e nada sobe; a voz da persona sincroniza', async () => {
    const mine = h.store.deviceSetting('sttSettings')
    await h.desk.put('setting', 'sttSettings', null, {
      sv: 1,
      value: { mode: 'api', api: { providerId: 'outro', model: 'do-pc' } }
    })
    await h.engine.sync()
    expect(h.store.deviceSetting('sttSettings')).toEqual(mine)
    const s = new SettingsService({
      store: h.store,
      writer: h.stack.memory.writer,
      memory: h.stack.memory.index
    })
    expect(s.setting('sttSettings')).toEqual(mine)
    s.setSetting('ttsSettings', {
      backend: 'api',
      api: { providerId: audioProv, model: 'tts-2', voice: null },
      local: null
    })
    expect(h.store.deviceSetting<{ api: { model: string } }>('ttsSettings')?.api.model).toBe(
      'tts-2'
    )
    // a voz da persona vai no registro dela (escolha + parâmetros, sem endereço/chave)
    const p = s.savePreset({
      name: 'Locutor',
      description: '',
      icon: 'sparkles',
      config: {
        voice: {
          enabled: null,
          model: null,
          tools: null,
          voicePrompt: null,
          fillers: null,
          tts: {
            backend: 'api',
            api: { providerId: personaProv, model: 'tts-x', voice: 'onyx' }
          }
        }
      }
    })
    await until(() => !h.stack.memory.writer.pending(), 8000, 'LWW')
    expect(h.store.lwwOutbox()).toEqual([])
    expect(h.server.records.get('setting|ttsSettings')).toBeUndefined()
    expect(h.server.records.get('setting|sttSettings')!.rev).toBe(1) // só o do "app antigo"
    const rec = h.server.records.get(`preset|${p.id}`)!
    const plain = (await openRecord(h.desk.sk.record, h.server.userId, rec, rec.env!)) as {
      config: { voice: Record<string, unknown> }
    }
    expect(plain.config.voice.tts).toEqual({
      backend: 'api',
      api: { providerId: personaProv, model: 'tts-x', voice: 'onyx' }
    })
  })

  it('ditado e chamada com a voz/transcrição da persona (idioma dela); provedor dela ausente → a deste aparelho', async () => {
    const q1 = speech([[1200, true]])
    h.llm.voice.fixtures = [
      { voicedMs: voicedMsOf(wav16(q1)).voicedMs, text: 'What is the capital of France?' }
    ]
    const { chatId, sid } = newChat({ presetId: 'pers-narr' })
    expect(h.stack.repo.chat(chatId)!.config.voice?.tts).toBeUndefined() // herda ao vivo
    // --- ditado no composer com as camadas do chat ---
    const dictMic = new FakeMicSource(
      speech([
        [300, false],
        [1200, true],
        [400, false]
      ]),
      RATE,
      { frameMs: 4 }
    )
    let mic: MicSource = dictMic
    const voice = createVoiceStack({
      stack: h.stack,
      store: h.store,
      mic: () => mic,
      playback: fakePlayback(10),
      clips: memoryClipStore(),
      requestMic: async () => true,
      bargeIn: () => false
    })
    const persona = h.store.getPlain('preset', 'pers-narr')!.config as { voice: unknown }
    const layers = { chat: null, persona: persona.voice as never }
    expect(await voice.dictation.start(layers)).toBeNull()
    await new Promise((r) => setTimeout(r, 300))
    const dict = await voice.dictation.finish()
    expect(dict?.text).toBe('What is the capital of France?')
    const sttLog = () => h.llm.voice.log.filter((l) => l.path.endsWith('/audio/transcriptions'))
    expect(sttLog().at(-1)?.fields).toMatchObject({ model: 'whisper-persona', language: 'en' })
    // --- chamada: decidida no início com a voz da persona ---
    const scripted = new ScriptedMic()
    mic = scripted
    await voice.call.start(sid)
    const silence = speech([[64, false]])
    const feedUntil = async (cond: () => boolean, what: string) => {
      const t0 = Date.now()
      while (!cond()) {
        if (Date.now() - t0 > 20000) throw new Error(`timeout: ${what}`)
        scripted.feed(silence)
        await new Promise((r) => setTimeout(r, 4))
      }
    }
    scripted.feed(speech([[200, false]]))
    scripted.feed(q1)
    await feedUntil(
      () =>
        h.stack.repo.path(sid).some((m) => m.message.role === 'assistant' && !m.meta.synthetic) &&
        !h.stack.runner.isRunning(sid) &&
        voice.call.getView().call.phase === 'listening',
      'resposta falada'
    )
    const tts = h.llm.voice.log.filter((l) => l.path.endsWith('/audio/speech'))
    expect(tts.length).toBeGreaterThan(0)
    expect(tts.every((l) => l.fields.model === 'tts-persona' && l.fields.voice === 'nova')).toBe(
      true
    )
    expect(sttLog().at(-1)?.fields).toMatchObject({ model: 'whisper-persona', language: 'en' })
    const reply = h.stack.repo
      .path(sid)
      .find((m) => m.message.role === 'assistant' && !m.meta.synthetic)!
    expect(reply.meta.voice?.ttsModel).toBe('tts-persona')
    voice.call.stop()
    await until(() => !voice.call.getView().call.active, 4000)
    // o provedor da persona não existe mais aqui: a chamada usa a voz deste aparelho
    h.desk.del('provider', personaProv, null)
    await h.engine.sync()
    expect(h.stack.providers().some((p) => p.id === personaProv)).toBe(false)
    const n = tts.length
    await voice.call.start(sid)
    scripted.feed(q1)
    await feedUntil(
      () =>
        h.llm.voice.log.filter((l) => l.path.endsWith('/audio/speech')).length > n &&
        !h.stack.runner.isRunning(sid) &&
        voice.call.getView().call.phase === 'listening',
      'resposta com a voz daqui'
    )
    const after = h.llm.voice.log.filter((l) => l.path.endsWith('/audio/speech')).slice(n)
    expect(after.every((l) => l.fields.model === 'tts-falso')).toBe(true)
    // ...e a transcrição daqui, mas no idioma da persona (o idioma é dela)
    expect(sttLog().at(-1)?.fields).toMatchObject({ model: 'whisper-falso', language: 'en' })
    voice.call.stop()
    await until(() => !voice.call.getView().call.active, 4000)
  }, 60_000)
})

// ---------------- frases de ferramenta (tool do celular → categoria "location") ----------------

describe('frases de ferramenta na chamada (tool do celular)', () => {
  let h: Harness
  afterEach(async () => {
    await h?.close()
    setLocationSource(null)
  })

  it('nearby_places num chat deste celular: a frase "location" toca do clipe gerado (no lugar do preâmbulo)', async () => {
    resetNoiseFloor()
    const net = fakeFetch(osmRoutes())
    const svc = new LocationService({
      device: new FakeDevice(),
      settings: () => ({ ...DEFAULT_LOCATION_SETTINGS, approval: 'always' }),
      overpass: new OverpassClient({ fetch: net.fetch, userAgent: 'test', minIntervalMs: 0 }),
      geocoder: new OsmGeocoder({ fetch: net.fetch, userAgent: 'test', sleep: async () => {} }),
      now: () => 30_000
    })
    h = await makeHarness({ location: svc })
    await h.desk.put('provider', 'prov-voz', null, {
      sv: 1,
      name: 'Voz falsa',
      kind: 'openai',
      baseUrl: `${h.llm.url}/v1`,
      apiKey: 'sk-voz',
      headers: {},
      createdAt: 2
    })
    await h.engine.sync()
    h.store.setDeviceSetting('sttSettings', {
      mode: 'api',
      api: { providerId: 'prov-voz', model: 'whisper-falso' },
      livePartials: false
    })
    h.store.setDeviceSetting('ttsSettings', {
      backend: 'api',
      api: { providerId: 'prov-voz', model: 'tts-falso', voice: 'alloy' }
    })
    const q = speech([[1300, true]])
    h.llm.voice.fixtures = [
      { voicedMs: voicedMsOf(wav16(q)).voicedMs, text: '/near-at Avenida Paulista | café' }
    ]
    const mic = new ScriptedMic()
    const voice = createVoiceStack({
      stack: h.stack,
      store: h.store,
      mic: () => mic,
      playback: fakePlayback(10),
      clips: memoryClipStore(),
      requestMic: async () => true,
      bargeIn: () => false
    })
    // "Gerar clipes" (o TTS falso — nada pago): preâmbulos e frases de ferramenta da voz daqui
    await voice.call.generateClips()
    expect(voice.call.getView().clips).toMatchObject({ state: 'ok', missing: [] })
    const { chat, session } = h.stack.repo.createChat({
      config: {
        ...DEFAULT_CHAT_CONFIG(''),
        providerId: h.providerId,
        model: 'fake/agent',
        enabledTools: ['get_location', 'nearby_places'] as unknown as ToolName[]
      }
    })
    await voice.call.start(session.id)
    mic.feed(speech([[200, false]]))
    mic.feed(q)
    const silence = speech([[64, false]])
    const t0 = Date.now()
    const decided = () =>
      voice.call.getView().timeline.find((e) => e.kind === 'decision' && e.class === 'TOOL')
    while (!decided() || h.stack.runner.isRunning(session.id)) {
      if (Date.now() - t0 > 20000) throw new Error('timeout: frase de ferramenta')
      mic.feed(silence)
      await new Promise((r) => setTimeout(r, 4))
    }
    expect(decided()).toMatchObject({ class: 'TOOL', played: true, reason: 'location' })
    // no lugar do preâmbulo (que ainda não tinha tocado)
    expect(
      voice.call
        .getView()
        .timeline.some(
          (e) => e.kind === 'decision' && e.class === 'FILLER' && e.reason === 'tool-phrase'
        )
    ).toBe(true)
    const tool = h.stack.repo.path(session.id).find((m) => m.message.role === 'tool')!
    expect(String(tool.message.content)).toContain('Cantina do Teste')
    expect(chat.id).toBeTruthy()
    voice.call.stop()
    await until(() => !voice.call.getView().call.active, 4000)
  }, 60_000)
})

describe('frases de espera na chamada ("manter viva" e "obrigado por aguardar")', () => {
  let h: Harness
  afterEach(async () => {
    await h?.close()
    setLocationSource(null)
  })

  /** Host com a voz falsa e as frases de espera curtas (1 s de silêncio → "manter viva"). */
  const setup = async (opts: { thanksAfterMs: number; location?: LocationService }) => {
    resetNoiseFloor()
    h = await makeHarness(opts.location ? { location: opts.location } : {})
    await h.desk.put('provider', 'prov-voz', null, {
      sv: 1,
      name: 'Voz falsa',
      kind: 'openai',
      baseUrl: `${h.llm.url}/v1`,
      apiKey: 'sk-voz',
      headers: {},
      createdAt: 2
    })
    await h.engine.sync()
    h.store.setDeviceSetting('sttSettings', {
      mode: 'api',
      api: { providerId: 'prov-voz', model: 'whisper-falso' },
      livePartials: false
    })
    h.store.setDeviceSetting('ttsSettings', {
      backend: 'api',
      api: { providerId: 'prov-voz', model: 'tts-falso', voice: 'alloy' }
    })
    h.store.setDeviceSetting('voiceCallDefaults', {
      fillers: { enabled: false },
      delayPhrases: { enabled: true, keepAliveAfterMs: 1000, thanksAfterMs: opts.thanksAfterMs }
    })
    const mic = new ScriptedMic()
    const voice = createVoiceStack({
      stack: h.stack,
      store: h.store,
      mic: () => mic,
      playback: fakePlayback(10),
      clips: memoryClipStore(),
      requestMic: async () => true,
      bargeIn: () => false
    })
    const silence = speech([[64, false]])
    /** Microfone em silêncio (fecha as falas) até `cond`. */
    const pump = async (cond: () => boolean, what: string, ms = 20000) => {
      const t0 = Date.now()
      while (!cond()) {
        if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`)
        mic.feed(silence)
        await sleep(4)
      }
    }
    const tl = () => voice.call.getView().timeline
    const decisions = (cls: string) => tl().filter((e) => e.kind === 'decision' && e.class === cls)
    return { mic, voice, pump, tl, decisions }
  }

  const chatWith = (tools: string[] = []) =>
    h.stack.repo.createChat({
      config: {
        ...DEFAULT_CHAT_CONFIG(''),
        providerId: h.providerId,
        model: 'fake/agent',
        enabledTools: tools as unknown as ToolName[]
      }
    })

  it('um ruído durante a espera só PAUSA: a "manter viva" ainda toca depois dele (antes zerava o turno)', async () => {
    const q = speech([[1300, true]])
    const noise = speech([[400, true]])
    const { mic, voice, pump, tl, decisions } = await setup({ thanksAfterMs: 4500 })
    h.llm.voice.fixtures = [
      { voicedMs: voicedMsOf(wav16(q)).voicedMs, text: '/sleep 4500 a resposta demorada' },
      { voicedMs: voicedMsOf(wav16(noise)).voicedMs, text: 'Uhum.' }
    ]
    const { session } = chatWith()
    await voice.call.start(session.id)
    mic.feed(speech([[200, false]]))
    mic.feed(q)
    await pump(() => h.stack.runner.isRunning(session.id), 'turno enviado')
    // ruído/"uhum" logo no começo da espera (antes da 1ª "manter viva")
    expect(decisions('KEEPALIVE')).toEqual([])
    mic.feed(noise)
    await pump(
      () => tl().filter((e) => e.kind === 'speech-start').length >= 2,
      'o ruído abriu uma fala'
    )
    await pump(() => decisions('KEEPALIVE').some((e) => e.played), '"manter viva" depois do ruído')
    const all = tl()
    const starts = all.filter((e) => e.kind === 'speech-start')
    const ka = decisions('KEEPALIVE').find((e) => e.played)!
    expect(all.indexOf(starts[1])).toBeGreaterThan(-1)
    expect(all.indexOf(ka)).toBeGreaterThan(all.indexOf(starts[1]))
    expect(ka.reason).toBe('waiting/thinking')
    expect(DEFAULT_KEEPALIVE_POOL).toContain(ka.text)
    // o "uhum" não virou turno: a resposta do turno original chega e é falada
    await pump(
      () => !h.stack.runner.isRunning(session.id) && tl().some((e) => e.kind === 'sentence-end'),
      'resposta falada'
    )
    const users = h.stack.repo.path(session.id).filter((m) => m.message.role === 'user')
    expect(users).toHaveLength(1)
    expect(String(users[0].message.content)).toContain('/sleep 4500')
    voice.call.stop()
    await until(() => !voice.call.getView().call.active, 4000)
  }, 60_000)

  it('ferramenta demorada: frase de ferramenta → "manter viva" (pool da ferramenta) → "obrigado por aguardar" (clipe) antes da resposta', async () => {
    const net = fakeFetch(osmRoutes())
    let first = true
    // a 1ª request (o geocoder) demora 5 s: a tool fica rodando
    const slow = async (url: string, init: RequestInit) => {
      if (first) {
        first = false
        await sleep(5000)
      }
      return net.fetch(url, init)
    }
    const svc = new LocationService({
      device: new FakeDevice(),
      settings: () => ({ ...DEFAULT_LOCATION_SETTINGS, approval: 'always' }),
      overpass: new OverpassClient({ fetch: slow, userAgent: 'test', minIntervalMs: 0 }),
      geocoder: new OsmGeocoder({ fetch: slow, userAgent: 'test', sleep: async () => {} }),
      now: () => 30_000
    })
    const q = speech([[1300, true]])
    const { mic, voice, pump, tl, decisions } = await setup({ thanksAfterMs: 1000, location: svc })
    h.llm.voice.fixtures = [
      { voicedMs: voicedMsOf(wav16(q)).voicedMs, text: '/near-at Avenida Paulista | café' }
    ]
    // "Gerar clipes" (TTS falso): preâmbulos, frases de ferramenta e agradecimentos desta voz
    await voice.call.generateClips()
    expect(voice.call.getView().clips).toMatchObject({ state: 'ok', missing: [] })
    const { session } = chatWith(['get_location', 'nearby_places'])
    await voice.call.start(session.id)
    mic.feed(speech([[200, false]]))
    mic.feed(q)
    await pump(
      () =>
        decisions('THANKS').length > 0 &&
        !h.stack.runner.isRunning(session.id) &&
        tl().some((e) => e.kind === 'sentence-end'),
      'resposta depois da espera',
      30_000
    )
    expect(decisions('TOOL')[0]).toMatchObject({ played: true, reason: 'location' })
    const kas = decisions('KEEPALIVE').filter((e) => e.played)
    expect(kas.length).toBeGreaterThanOrEqual(1)
    expect(kas.length).toBeLessThanOrEqual(2)
    for (const k of kas) {
      expect(k.reason).toBe('waiting/tool')
      expect(DEFAULT_KEEPALIVE_TOOL_POOL).toContain(k.text)
    }
    const thanks = decisions('THANKS')
    expect(thanks).toHaveLength(1)
    expect(thanks[0]).toMatchObject({ played: true, reason: 'after-wait' }) // do clipe
    expect(DEFAULT_THANKS_POOL).toContain(thanks[0].text)
    // ordem: ferramenta → manter viva → obrigado → 1ª frase da resposta
    const all = tl()
    const idx = (e: (typeof all)[number] | undefined) => (e ? all.indexOf(e) : -1)
    const firstSentence = all.find((e) => e.kind === 'sentence-start')
    expect(idx(decisions('TOOL')[0])).toBeGreaterThan(-1)
    expect(idx(decisions('TOOL')[0])).toBeLessThan(idx(kas[0]))
    expect(idx(kas[kas.length - 1])).toBeLessThan(idx(thanks[0]))
    expect(idx(thanks[0])).toBeLessThan(idx(firstSentence))
    const tool = h.stack.repo.path(session.id).find((m) => m.message.role === 'tool')!
    expect(String(tool.message.content)).toContain('Cantina do Teste')
    voice.call.stop()
    await until(() => !voice.call.getView().call.active, 4000)
  }, 60_000)

  it('resposta logo depois de uma "manter viva": sem agradecimento (a última frase de espera foi há pouco)', async () => {
    const q = speech([[1300, true]])
    const { mic, voice, pump, tl, decisions } = await setup({ thanksAfterMs: 4500 })
    h.llm.voice.fixtures = [
      { voicedMs: voicedMsOf(wav16(q)).voicedMs, text: '/sleep 2500 resposta rápida' }
    ]
    const { session } = chatWith()
    await voice.call.start(session.id)
    mic.feed(speech([[200, false]]))
    mic.feed(q)
    await pump(
      () =>
        decisions('THANKS').length > 0 &&
        !h.stack.runner.isRunning(session.id) &&
        tl().some((e) => e.kind === 'sentence-end'),
      'resposta'
    )
    const kas = decisions('KEEPALIVE').filter((e) => e.played)
    expect(kas.length).toBeGreaterThanOrEqual(1)
    expect(kas[0].reason).toBe('waiting/thinking')
    expect(decisions('THANKS')).toEqual([
      expect.objectContaining({ played: false, reason: 'too-soon' })
    ])
    expect(tl().some((e) => e.kind === 'clip-emitted' && e.class === 'THANKS')).toBe(false)
    voice.call.stop()
    await until(() => !voice.call.getView().call.active, 4000)
  }, 60_000)
})
