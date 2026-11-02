// Provedores de VOZ falsos (nunca gasta cota paga): OpenAI-compatível `/audio/transcriptions` e
// `/audio/speech` e o formato da ElevenLabs (`/v1/text-to-speech/{voz}[/stream]`, `/v1/models`,
// `/v1/voices`). Montado dentro do `fakeLlm.ts` (mesma porta).
// - Transcrição DETERMINÍSTICA: os fixtures registrados (`wav` + texto) têm a duração COM VOZ medida
//   (quadros de 32 ms com RMS ≥ 0,01 — o limiar do app); o áudio recebido é medido igual e vira o
//   texto do fixture mais próximo — parcial (menos de 70% da fala) = o começo proporcional das
//   palavras. Sem fixtures: "fala de teste de N segundos".
// - Fala: um tom senoidal de ~45 ms por caractere (WAV 24 kHz, ou PCM cru com `response_format:
//   'pcm'`/ElevenLabs `output_format=pcm_*`) — tempo de reprodução realista sem sintetizar voz.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

export interface VoiceFixture {
  voicedMs: number
  text: string
}

export interface FakeVoiceState {
  fixtures: VoiceFixture[]
  /** Requests de voz recebidas (testes conferem modelo, idioma, voz, parâmetros). */
  log: { path: string; fields: Record<string, string>; audioMs?: number; voicedMs?: number }[]
  /** Falha a próxima transcrição com este status (testes de erro). */
  failNext?: number
  /** Pasta servida em `GET /mic/<arquivo>.wav` (fixtures para o microfone de teste do app). */
  micDir?: string
  /** Fila do microfone de teste do app (`POST /mic/queue?name=` → `GET /mic/next`). */
  micQueue?: string[]
}

/** Duração com voz (ms) de um WAV PCM16/float32 (quadros de 32 ms, RMS ≥ 0,01). */
export function voicedMsOf(wav: Uint8Array): { voicedMs: number; audioMs: number } {
  const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
  const tag = (o: number) => String.fromCharCode(...wav.subarray(o, o + 4))
  if (tag(0) !== 'RIFF') return { voicedMs: 0, audioMs: 0 }
  let o = 12
  let rate = 16000
  let ch = 1
  let bits = 16
  let fmtTag = 1
  while (o + 8 <= wav.length) {
    const id = tag(o)
    const size = dv.getUint32(o + 4, true)
    if (id === 'fmt ') {
      fmtTag = dv.getUint16(o + 8, true)
      ch = dv.getUint16(o + 10, true)
      rate = dv.getUint32(o + 12, true)
      bits = dv.getUint16(o + 22, true)
    } else if (id === 'data') {
      const start = o + 8
      const end = Math.min(wav.length, start + size)
      const bps = bits / 8
      const n = Math.floor((end - start) / (bps * ch))
      const frame = Math.round((rate * 32) / 1000)
      let voiced = 0
      for (let f = 0; f + frame <= n; f += frame) {
        let sum = 0
        for (let i = f; i < f + frame; i++) {
          const p = start + i * bps * ch
          const s =
            bits === 16 ? dv.getInt16(p, true) / 32768 : fmtTag === 3 ? dv.getFloat32(p, true) : 0
          sum += s * s
        }
        if (Math.sqrt(sum / frame) >= 0.01) voiced++
      }
      return { voicedMs: voiced * 32, audioMs: Math.round((n / rate) * 1000) }
    }
    o += 8 + size + (size % 2)
  }
  return { voicedMs: 0, audioMs: 0 }
}

/** Fixtures de uma pasta: `<nome>.wav` + `<nome>.txt`. */
export function loadFixtures(dir: string): VoiceFixture[] {
  const out: VoiceFixture[] = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.wav')) continue
    let text = ''
    try {
      text = readFileSync(join(dir, f.replace(/\.wav$/, '.txt')), 'utf8').trim()
    } catch {
      continue
    }
    out.push({ voicedMs: voicedMsOf(new Uint8Array(readFileSync(join(dir, f)))).voicedMs, text })
  }
  return out
}

export function transcriptFor(state: FakeVoiceState, voicedMs: number): string {
  if (voicedMs < 64) return ''
  if (!state.fixtures.length) return `fala de teste de ${Math.round(voicedMs / 100) / 10} segundos`
  let best = state.fixtures[0]
  for (const f of state.fixtures)
    if (Math.abs(f.voicedMs - voicedMs) < Math.abs(best.voicedMs - voicedMs)) best = f
  const ratio = voicedMs / Math.max(1, best.voicedMs)
  if (ratio >= 0.7) return best.text
  const words = best.text.split(/\s+/)
  return words.slice(0, Math.max(1, Math.round(words.length * ratio))).join(' ')
}

/** Multipart → campos de texto + o arquivo. */
function parseMultipart(
  buf: Buffer,
  contentType: string
): { fields: Record<string, string>; file: Uint8Array | null } {
  const m = /boundary=([^;]+)/.exec(contentType)
  const fields: Record<string, string> = {}
  let file: Uint8Array | null = null
  if (!m) return { fields, file }
  const boundary = Buffer.from(`--${m[1].replace(/^"|"$/g, '')}`)
  let pos = buf.indexOf(boundary)
  while (pos >= 0) {
    const start = pos + boundary.length
    if (buf.subarray(start, start + 2).toString() === '--') break
    const headEnd = buf.indexOf('\r\n\r\n', start)
    if (headEnd < 0) break
    const head = buf.subarray(start, headEnd).toString()
    const next = buf.indexOf(boundary, headEnd + 4)
    if (next < 0) break
    const body = buf.subarray(headEnd + 4, next - 2)
    const name = /name="([^"]*)"/.exec(head)?.[1] ?? ''
    if (/filename=/.test(head)) file = new Uint8Array(body)
    else fields[name] = body.toString()
    pos = next
  }
  return { fields, file }
}

/** Tom senoidal PCM16 mono (~45 ms por caractere, 0,3–6 s). */
export function tonePcm(text: string, rate = 24000): Buffer {
  const ms = Math.min(6000, Math.max(300, text.trim().length * 45))
  const n = Math.round((rate * ms) / 1000)
  const out = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / 240, (n - i) / 240)
    out.writeInt16LE(
      Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 0.3 * env * 32767),
      i * 2
    )
  }
  return out
}

export function wavOf(pcm: Buffer, rate: number): Buffer {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + pcm.length, 4)
  h.write('WAVE', 8)
  h.write('fmt ', 12)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(rate, 24)
  h.writeUInt32LE(rate * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([h, pcm])
}

/** Trata as rotas de voz; true = respondeu. */
export function handleVoice(
  req: IncomingMessage,
  res: ServerResponse,
  buf: Buffer,
  url: URL,
  state: FakeVoiceState
): boolean {
  const path = url.pathname
  const json = (status: number, v: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(v))
  }
  if (req.method === 'POST' && path.endsWith('/audio/transcriptions')) {
    const auth = req.headers.authorization ?? ''
    if (/invalida/.test(auth)) {
      json(401, { error: { message: 'chave falsa inválida' } })
      return true
    }
    if (state.failNext) {
      const s = state.failNext
      state.failNext = undefined
      json(s, { error: { message: `falha falsa ${s}` } })
      return true
    }
    const { fields, file } = parseMultipart(buf, String(req.headers['content-type'] ?? ''))
    const m = file ? voicedMsOf(file) : { voicedMs: 0, audioMs: 0 }
    state.log.push({ path, fields, ...m })
    json(200, { text: transcriptFor(state, m.voicedMs), usage: { cost: 0.0001 } })
    return true
  }
  if (req.method === 'POST' && path.endsWith('/audio/speech')) {
    let body: Record<string, unknown> = {}
    try {
      body = JSON.parse(buf.toString() || '{}')
    } catch {
      /* corpo inválido */
    }
    const fields = Object.fromEntries(Object.entries(body).map(([k, v]) => [k, String(v)]))
    state.log.push({ path, fields })
    const pcm = tonePcm(String(body.input ?? ''))
    if (body.response_format === 'pcm') {
      res.writeHead(200, { 'Content-Type': 'audio/pcm;rate=24000' })
      res.end(pcm)
    } else {
      res.writeHead(200, { 'Content-Type': 'audio/wav' })
      res.end(wavOf(pcm, 24000))
    }
    return true
  }
  if (path === '/mic/queue' && req.method === 'POST') {
    const name = url.searchParams.get('name') ?? ''
    ;(state.micQueue ??= []).push(name)
    json(200, { queued: state.micQueue.length })
    return true
  }
  if (path === '/mic/next' && req.method === 'GET') {
    const name = state.micQueue?.shift()
    if (!name || !state.micDir || !/^[\w.-]+\.wav$/.test(name)) {
      res.writeHead(204)
      res.end()
      return true
    }
    res.writeHead(200, { 'Content-Type': 'audio/wav' })
    res.end(readFileSync(join(state.micDir, name)))
    return true
  }
  if (req.method === 'GET' && path.startsWith('/mic/') && state.micDir) {
    const name = path.slice(5)
    if (!/^[\w.-]+\.wav$/.test(name)) return false
    try {
      const body = readFileSync(join(state.micDir, name))
      res.writeHead(200, { 'Content-Type': 'audio/wav' })
      res.end(body)
    } catch {
      json(404, { error: 'fixture não encontrado' })
    }
    return true
  }
  // ---------------- ElevenLabs ----------------
  if (path.startsWith('/v1/text-to-speech/') && req.method === 'POST') {
    if (!req.headers['xi-api-key']) {
      json(401, { detail: { status: 'invalid_api_key', message: 'sem chave' } })
      return true
    }
    let body: Record<string, unknown> = {}
    try {
      body = JSON.parse(buf.toString() || '{}')
    } catch {
      /* corpo inválido */
    }
    const fmt = url.searchParams.get('output_format') ?? 'pcm_24000'
    const rate = Number(/pcm_(\d+)/.exec(fmt)?.[1] ?? 24000)
    state.log.push({
      path,
      fields: {
        ...Object.fromEntries(Object.entries(body).map(([k, v]) => [k, JSON.stringify(v)])),
        output_format: fmt
      }
    })
    res.writeHead(200, { 'Content-Type': 'audio/pcm' })
    res.end(tonePcm(String(body.text ?? ''), rate))
    return true
  }
  if (path === '/v1/models' && req.method === 'GET') {
    json(200, [
      {
        model_id: 'eleven_flash_v2_5',
        name: 'Flash v2.5',
        can_do_text_to_speech: true,
        languages: [{ language_id: 'pt' }]
      },
      {
        model_id: 'eleven_multilingual_v2',
        name: 'Multilingual v2',
        can_do_text_to_speech: true,
        languages: [{ language_id: 'pt' }]
      }
    ])
    return true
  }
  if (path === '/v1/voices' && req.method === 'GET') {
    json(200, {
      voices: [
        {
          voice_id: 'voz-falsa-1',
          name: 'Voz Falsa',
          category: 'premade',
          labels: { gender: 'female' }
        },
        {
          voice_id: 'voz-falsa-2',
          name: 'Outra Voz',
          category: 'premade',
          labels: { gender: 'male' }
        }
      ]
    })
    return true
  }
  if (path === '/v1/user' && req.method === 'GET') {
    json(200, { subscription: { tier: 'free' } })
    return true
  }
  return false
}
