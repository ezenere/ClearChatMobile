// Fase 6 (voz) contra o servidor de sync REAL local, com LLM/STT/TTS FALSOS: o "desktop" (seed)
// grava o provedor de voz e as settings de áudio como um app ≤ 1.8.x (o celular ≥ 1.9.0 as IGNORA —
// as settings de voz são deste aparelho e configuradas aqui); o "celular" (AccountService +
// SyncEngine + host reais) recebe, dita (meta.voice de ditado), faz uma chamada inteira com o microfone de TESTE
// (turno falado → resposta falada → "tchau" → end_call) e grava a persona com voz; o desktop
// decifra os registros e confere: marcador da chamada codificado como no §4.3.8
// (`memory-extraction` + `voiceCall`), falas com `meta.voice`, a tool end_call e a `voice` da persona.
import { afterAll, describe, expect, it } from 'vitest'
import { AccountService } from '../../src/account/service'
import { MemoryKeyValueStore, MemorySecretStore } from '../../src/account/storage'
import { AttachmentStore, type AttachmentFs } from '../../src/data/attachments'
import { bindAccount } from '../../src/data/binding'
import { SyncEngine } from '../../src/data/engine'
import { LocalStore } from '../../src/data/store'
import { bindHost } from '../../src/host/binding'
import { createHostStack } from '../../src/host/stack'
import { DEFAULT_CHAT_CONFIG } from '../../src/vendor/shared/defaults'
import { floatToPcm16, frameRms } from '../../src/vendor/renderer/audio/pcm'
import { encodeWav } from '../../src/vendor/desktop/voice/wav'
import { hex, openRecord, sha256 } from '../../src/crypto'
import type { Change } from '../../src/data/types'
import { memoryClipStore } from '../../src/voice/clips'
import { FRAME_SAMPLES, type MicFrame, type MicSource } from '../../src/voice/mic'
import type { PlaybackBackend } from '../../src/voice/player'
import { createVoiceStack } from '../../src/voice/stack'
import { SettingsService } from '../../src/settings/service'
import { openNodeSql } from '../nodeSql'
import { startFakeLlm } from '../fakes/fakeLlm'
import { voicedMsOf } from '../fakes/fakeVoice'
import { codeFor, enabled, logMark, randomEmail, rest, signupWeb, waitFor } from './realServer'
import { item, loginDesktop, push, setupKeysWithDek, type Desktop } from './seed'

const PASSWORD = 'senha de integração da voz'
const cleanup: (() => void | Promise<void>)[] = []
afterAll(async () => {
  for (const f of cleanup.reverse()) await f()
})

class MemoryFs implements AttachmentFs {
  files = new Map<string, Uint8Array>()
  exists = (f: string) => this.files.has(f)
  uri = (f: string) => `mem://${f}`
  write = (f: string, d: Uint8Array) => void this.files.set(f, d)
  clear = () => this.files.clear()
}

const RATE = 16_000
function speech(parts: [number, boolean][]): Float32Array {
  const total = parts.reduce((n, [ms]) => n + Math.round((ms * RATE) / 1000), 0)
  const out = new Float32Array(total)
  let o = 0
  for (const [ms, voiced] of parts)
    for (let i = 0, n = Math.round((ms * RATE) / 1000); i < n; i++, o++)
      out[o] = voiced ? 0.15 * Math.sin((2 * Math.PI * 180 * i) / RATE) : 0.0003 * Math.sin(i)
  return out
}
const wav16 = (s: Float32Array) => encodeWav(new Uint8Array(floatToPcm16(s).buffer), RATE)

class ScriptedMic implements MicSource {
  readonly kind = 'fake' as const
  cb: ((f: MicFrame) => void) | null = null
  async start(onFrame: (f: MicFrame) => void): Promise<void> {
    this.cb = onFrame
  }
  async stop(): Promise<void> {
    this.cb = null
  }
  feed(s: Float32Array): void {
    for (let o = 0; o + FRAME_SAMPLES <= s.length; o += FRAME_SAMPLES) {
      const f = s.subarray(o, o + FRAME_SAMPLES)
      this.cb?.({ pcm: floatToPcm16(f), rms: frameRms(f), ms: 32 })
    }
  }
}

const playback: PlaybackBackend = {
  async play(audio, mime) {
    const ms = mime.includes('wav') ? voicedMsOf(audio).audioMs : 100
    let stop!: () => void
    const done = new Promise<void>((r) => {
      const t = setTimeout(r, Math.max(5, ms / 10))
      stop = () => {
        clearTimeout(t)
        r()
      }
    })
    return { done, stop: () => stop(), setVolume: () => undefined }
  }
}

async function serverRecords(d: Desktop, scope: string | null, type?: string) {
  const out: { type: string; id: string; plain: Record<string, unknown> }[] = []
  let after = 0
  for (;;) {
    const q = scope ? `scope=${scope}&` : ''
    const r = await rest(
      'GET',
      `/api/v1/records?${q}after=${after}&limit=500&payload=1`,
      undefined,
      d.token
    )
    for (const c of (r.records ?? []) as Change[]) {
      if (c.deleted || !c.env || (type && c.type !== type)) continue
      out.push({ type: c.type, id: c.id, plain: await openRecord(d.sk.record, d.userId, c, c.env) })
    }
    if (!r.has_more || !r.records?.length) break
    after = r.next ?? r.records[r.records.length - 1].seq
  }
  return out
}

describe.skipIf(!enabled)('voz contra o servidor real (LLM/STT/TTS falsos)', () => {
  it('settings do desktop → ditado e chamada no celular → registros que o desktop decifra', async () => {
    const llm = await startFakeLlm(0, { delay: 5 })
    cleanup.push(() => llm.close())
    const q1 = speech([[1200, true]])
    const q2 = speech([[2400, true]])
    llm.voice.fixtures = [
      { voicedMs: voicedMsOf(wav16(q1)).voicedMs, text: 'Qual é a capital da França?' },
      { voicedMs: voicedMsOf(wav16(q2)).voicedMs, text: 'Obrigado, pode desligar. Tchau.' }
    ]
    const email = randomEmail('voz')
    const web = await signupWeb(email)
    const { dek } = await setupKeysWithDek(web, PASSWORD)
    const desk = await loginDesktop(email, web.userId, dek)
    const now = Date.now()
    await push(desk, [
      await item(desk, 'provider', 'prov-falso', null, {
        sv: 1,
        name: 'LLM falso',
        kind: 'openai',
        baseUrl: `${llm.url}/v1`,
        apiKey: 'sk-falsa',
        headers: {},
        createdAt: now
      }),
      // as settings de áudio como um desktop ≤ 1.8.x grava (o celular ≥ 1.9.0 ignora)
      await item(desk, 'setting', 'sttSettings', null, {
        sv: 1,
        value: {
          mode: 'api',
          api: { providerId: 'prov-falso', model: 'whisper-falso' },
          local: { engine: 'whisper.cpp', model: '' },
          livePartials: true
        }
      }),
      await item(desk, 'setting', 'ttsSettings', null, {
        sv: 1,
        value: {
          backend: 'api',
          api: { providerId: 'prov-falso', model: 'tts-falso', voice: 'alloy' },
          local: null
        }
      }),
      await item(desk, 'setting', 'audioInput', null, {
        sv: 1,
        value: {
          pttEnabled: true,
          pttKey: 'Ctrl+Shift+Space',
          silenceStopEnabled: true,
          silenceStopMs: 5000,
          language: 'pt-BR'
        }
      })
    ])

    const account = new AccountService({
      secrets: new MemorySecretStore(),
      kv: new MemoryKeyValueStore(),
      device: { defaultName: 'Pixel (voz)', platform: 'android', appVersion: '0.1.0' },
      envUrl: URL_(),
      wsTiming: { backoffBaseMs: 100, backoffMaxMs: 1000 }
    })
    cleanup.push(() => account.setForeground(false))
    await account.init()
    const n0 = logMark()
    await account.requestCode(email)
    await account.verifyCode(await codeFor(email, n0), 'Pixel (voz)')
    const store = new LocalStore(openNodeSql())
    const keys = () => {
      const sk = account.subkeys
      const userId = account.accountUserId
      return sk && userId ? { userId, sk } : null
    }
    const engine = new SyncEngine({ store, http: account.http, keys })
    const fs = new MemoryFs()
    const attachments = new AttachmentStore({ fs, keys, fetchBlob: (id) => engine.fetchBlob(id) })
    bindAccount(account, engine, attachments)
    const stack = createHostStack({
      store,
      engine,
      http: {
        get: (path) => account.http.get(path),
        post: (path, json) => account.http.post(path, json),
        putBlob: async (blobId, ct, sha) => {
          await account.http.req('PUT', `/api/v1/blobs/${encodeURIComponent(blobId)}`, {
            body: ct,
            headers: { 'Content-Type': 'application/octet-stream', 'X-Content-SHA256': sha }
          })
        }
      },
      keys,
      openMemorySql: () => openNodeSql(),
      ws: { request: (t, f, ms) => account.wsRequest(t, f, ms) },
      deviceId: () => account.getState().device?.id ?? null,
      deviceName: () => account.getState().device?.name ?? 'Celular',
      files: {
        ensure: async (f) => void (await attachments.ensure(f)),
        readBase64: async (f) => Buffer.from(fs.files.get(f) ?? []).toString('base64'),
        readText: async (f) => new TextDecoder().decode(fs.files.get(f) ?? new Uint8Array()),
        size: (f) => fs.files.get(f)?.length ?? null,
        save: async (data, ext) => {
          const f = `${hex(await sha256(data))}.${ext}`
          attachments.put(f, data)
          return f
        },
        bytes: async (f) => fs.files.get(f) ?? null
      }
    })
    bindHost(account, stack.host, stack.runner)
    await account.unlock(PASSWORD, { remember: true })
    await waitFor(
      () => engine.getStatus().phase === 'idle' && !engine.getStatus().initial,
      'pull',
      60_000
    )
    await waitFor(() => !!store.setting('ttsSettings'), 'registro de um app antigo')
    // 1.9.0: settings de voz são deste aparelho — o registro recebido não vira a do celular
    expect(store.deviceSetting('ttsSettings')).toBeUndefined()
    store.setDeviceSetting('sttSettings', {
      mode: 'api',
      api: { providerId: 'prov-falso', model: 'whisper-falso' },
      local: null,
      livePartials: true
    })
    store.setDeviceSetting('ttsSettings', {
      backend: 'api',
      api: { providerId: 'prov-falso', model: 'tts-falso', voice: 'alloy' },
      local: null
    })
    store.setDeviceSetting('audioInput', {
      pttEnabled: true,
      silenceStopEnabled: true,
      silenceStopMs: 5000,
      language: 'pt-BR'
    })
    await waitFor(() => stack.host.isConnected, 'websocket do celular')

    const mic = new ScriptedMic()
    const voice = createVoiceStack({
      stack,
      store,
      mic: () => mic,
      playback,
      clips: memoryClipStore(),
      requestMic: async () => true,
      bargeIn: () => false
    })
    const { chat, session } = stack.repo.createChat({
      config: {
        ...DEFAULT_CHAT_CONFIG(''),
        providerId: 'prov-falso',
        model: 'fake/agent',
        enabledTools: []
      }
    })
    const sid = session.id
    // ---- ditado → envio com meta.voice ----
    await stack.host.local(chat.id, 'send', {
      sessionId: sid,
      text: 'texto ditado',
      voice: { source: 'dictation' }
    })
    await waitFor(() => !stack.runner.isRunning(sid), 'turno do ditado', 20_000)

    // ---- chamada ----
    await voice.call.start(sid)
    const silence = speech([[64, false]])
    const feedUntil = async (cond: () => boolean, what: string) => {
      const t0 = Date.now()
      while (!cond()) {
        if (Date.now() - t0 > 25_000) throw new Error(`timeout: ${what}`)
        mic.feed(silence)
        await new Promise((r) => setTimeout(r, 5))
      }
    }
    mic.feed(q1)
    await feedUntil(
      () =>
        stack.repo
          .path(sid)
          .some((m) => m.meta.voice?.source === 'call' && m.message.role === 'assistant'),
      'resposta falada'
    )
    await feedUntil(
      () => voice.call.getView().call.phase === 'listening' && !voice.call.getView().deaf,
      'escutar de novo'
    )
    mic.feed(q2)
    await feedUntil(() => !voice.call.getView().call.active, 'o agente desligar')
    await waitFor(
      () => stack.repo.path(sid).filter((m) => m.meta.kind === 'voice-call').length === 2,
      'marcadores',
      10_000
    )
    await waitFor(() => !stack.writer.pending(chat.id), 'outbox', 20_000)

    // ---- persona com voz (Configurações no celular) ----
    const settings = new SettingsService({
      store,
      writer: stack.memory.writer,
      memory: stack.memory.index,
      notify: (list) => engine.notifySettings(list)
    })
    const p = settings.savePreset({
      name: 'Atendente',
      description: '',
      icon: 'sparkles',
      config: {
        voice: {
          enabled: true,
          model: null,
          tools: null,
          voicePrompt: 'Fale curto.',
          promptMode: 'append',
          fillers: null,
          endCall: false,
          audioTags: true,
          // `interjections` (legado, §4.3.6) de uma tela antiga: nunca chega ao servidor
          ...({ interjections: { enabled: true, shadow: true } } as object)
        }
      }
    })

    // ---- o desktop decifra ----
    const recs = await serverRecords(desk, chat.id)
    const msgs = recs
      .filter((r) => r.type === 'message')
      .map(
        (r) =>
          r.plain as {
            message: {
              role: string
              content: unknown
              tool_calls?: { function: { name: string } }[]
            }
            meta: Record<string, unknown>
          }
      )
    const marks = msgs.filter((m) => (m.meta.voiceCall as { phase?: string } | undefined)?.phase)
    expect(marks.length).toBe(2)
    for (const m of marks) {
      expect(m.meta.kind).toBe('memory-extraction')
      expect(m.meta.memoryExtraction).toBeUndefined()
      expect(m.message.role).toBe('assistant')
    }
    const end = marks.find((m) => (m.meta.voiceCall as { phase: string }).phase === 'end')!
    expect(end.meta.voiceCall).toMatchObject({ endedBy: 'agent', usage: { turns: 2 } })
    expect(
      msgs.some(
        (m) =>
          m.message.role === 'user' && (m.meta.voice as { source?: string })?.source === 'dictation'
      )
    ).toBe(true)
    expect(
      msgs.some(
        (m) =>
          m.message.role === 'user' &&
          (m.meta.voice as { source?: string })?.source === 'call' &&
          m.message.content === 'Qual é a capital da França?'
      )
    ).toBe(true)
    expect(
      msgs.some((m) => m.message.tool_calls?.some((t) => t.function.name === 'end_call'))
    ).toBe(true)
    await waitFor(
      async () => (await serverRecords(desk, null, 'preset')).some((r) => r.id === p.id),
      'persona no servidor',
      15_000
    )
    const preset = (await serverRecords(desk, null, 'preset')).find((r) => r.id === p.id)!
    const pvoice = (preset.plain.config as Record<string, unknown>).voice
    expect(pvoice).toMatchObject({ voicePrompt: 'Fale curto.', endCall: false, audioTags: true })
    expect(pvoice).not.toHaveProperty('interjections')
  }, 120_000)
})

function URL_(): string {
  return process.env.CLEARCHAT_SYNC_TEST_URL ?? ''
}
