// Fase 6 — voz no celular: transcrição pela API (multipart em bytes, paridade com o vendorado),
// sessão (parcial/especulação/final reaproveitada), fala (OpenAI/ElevenLabs), settings de áudio
// (partes do dispositivo fora; "só no computador"), clipes, fila de reprodução, ditado com o
// microfone de TESTE e a chamada de voz inteira contra o servidor de sync falso + LLM/STT/TTS falsos
// (turno, meta.voice, marcadores codificados §4.3.8, end_call, custos). Nunca abre microfone real
// nem gasta cota.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { DEFAULT_CHAT_CONFIG } from '../src/vendor/shared/defaults'
import type { ChatConfig, Provider } from '../src/vendor/shared/types'
import {
  DEFAULT_STT_SETTINGS,
  DEFAULT_TTS_SETTINGS,
  type SttSettings
} from '../src/vendor/shared/voice'
import { transcribeAudio as vendoredTranscribe } from '../src/vendor/desktop/voice/stt'
import { synthesizeBlock } from '../src/vendor/desktop/voice/tts'
import { encodeWav } from '../src/vendor/desktop/voice/wav'
import { openRecord } from '../src/crypto'
import { transcribeAudio, SttError } from '../src/voice/stt'
import { TranscribeSession } from '../src/voice/session'
import { audioSettingOut, resolveStt, resolveTts, readVoiceSettings } from '../src/voice/endpoints'
import {
  CLIP_PHRASES,
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
import { UtteranceQueue, type PlaybackBackend, playableAudio } from '../src/voice/player'
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
})

describe('clipes e fila de reprodução', () => {
  it('as frases das interjeições são as do desktop (quando o repositório irmão está ao lado)', () => {
    const src = new URL('../../ClearChatDesktop/src/main/voice/clips.ts', import.meta.url)
    if (!existsSync(src)) return
    const text = readFileSync(src, 'utf8')
    for (const list of Object.values(CLIP_PHRASES))
      for (const p of list) expect(text).toContain(`'${p}'`)
  })

  it('gera os que faltam, carrega só da definição atual e apaga os velhos', async () => {
    const store = memoryClipStore()
    const tts = {
      ...DEFAULT_TTS_SETTINGS,
      backend: 'api' as const,
      api: { providerId: 'p', model: 'm', voice: 'v1' }
    }
    const synth = async (t: string) => ({ audio: new TextEncoder().encode(t), mime: 'audio/wav' })
    expect((await clipsStatus(store, tts)).ready).toBe(0)
    const r = await generateClips({ store, settings: tts, synth })
    expect(r.generated).toBe(r.total)
    expect(
      new TextDecoder().decode((await loadCurrentClipAudio(store, tts, null, 'ACK', 2))!.audio)
    ).toBe('Aham.')
    expect(await loadCurrentClipAudio(store, tts, null, 'ACK', 3)).toBeNull()
    const other = { ...tts, api: { ...tts.api, voice: 'v2' } }
    expect(clipsHash(other)).not.toBe(clipsHash(tts))
    expect(await loadCurrentClipAudio(store, other, null, 'ACK', 1)).toBeNull()
    await generateClips({ store, settings: other, synth })
    expect(store.keys().every((k) => k.startsWith(clipsHash(other).slice(0, 24)))).toBe(true)
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
    await h.desk.put('setting', 'sttSettings', null, {
      sv: 1,
      value: {
        mode: 'api',
        api: { providerId: audioProv, model: 'whisper-falso' },
        local: null,
        livePartials: true
      }
    })
    await h.desk.put('setting', 'ttsSettings', null, {
      sv: 1,
      value: {
        backend: 'api',
        api: { providerId: audioProv, model: 'tts-falso', voice: 'alloy' },
        local: null
      }
    })
    await h.desk.put('setting', 'audioInput', null, {
      sv: 1,
      value: {
        pttEnabled: false,
        pttKey: null,
        silenceStopEnabled: true,
        silenceStopMs: 600,
        language: 'pt-BR'
      }
    })
    await h.engine.sync()
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
    // modo Local: só no computador
    await h.desk.put('setting', 'sttSettings', null, {
      sv: 1,
      value: {
        mode: 'local',
        api: { providerId: audioProv, model: 'w' },
        local: { engine: 'whisper.cpp', model: '' },
        livePartials: true
      }
    })
    await h.engine.sync()
    expect(await d.start()).toContain('Local')
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
    // o turno de voz usa o prompt-base do modo voz e oferece end_call
    const req = h.llm.requests.filter((r) => r.path.endsWith('/chat/completions')).at(-1)!
    const sys = JSON.stringify((req.body.messages as unknown[])[0])
    expect(sys).toContain('end_call')
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
})
