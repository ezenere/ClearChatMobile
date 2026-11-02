// Sessão de transcrição no celular — o subconjunto "API" da sessão do desktop
// (ClearChatDesktop/src/main/voice/session.ts, que depende dos motores locais e do disco): acumula
// o PCM16 mono 16 kHz, parciais melhor-esforço pela API enquanto o usuário fala (ditado, com
// `livePartials`; nunca duas em voo), transcrição ESPECULATIVA na pausa (fim de turno adaptativo da
// chamada) e a final em `stop()` — reaproveitando a especulação/parcial que já cobre a fala inteira
// (sem request a mais), com UMA nova tentativa numa falha transitória (`isTransientVoiceError`
// vendorado). `cancel()` descarta tudo. O WAV enviado é o `encodeWav` vendorado. Sem React Native.
import type { VoicePartialEvent, VoiceTranscribeResult } from '@shared/ipc'
import type { SttSettings } from '@shared/voice'
import { isTransientVoiceError } from '@vendor/desktop/voice/callErrors'
import { STT_PARTIAL_INTERVAL_MS } from '@vendor/desktop/voice/stt'
import { encodeWav } from '@vendor/desktop/voice/wav'
import { transcribeAudio, type SttTranscribeOptions } from './stt'

/** PCM16 mono a esta taxa (Hz) — o formato do buffer e do WAV (= desktop). */
export const VOICE_SAMPLE_RATE = 16_000
const BYTES_PER_MS = (VOICE_SAMPLE_RATE * 2) / 1000
/** Parciais pela API só até este tamanho de fala (cada uma sobe o buffer inteiro). */
export const PARTIAL_MAX_MS = 20_000
/** Teto da gravação (o limite de upload da API é ~24 MB ≈ 12 min de PCM16 16 kHz). */
export const SESSION_MAX_MS = 10 * 60_000

export interface TranscribeSessionOptions {
  /** Settings resolvidas (endereço/chave do provedor em `api`). */
  settings: SttSettings
  language?: string
  /** Parciais ao vivo pela API (ditado). A chamada usa só a especulação. */
  partials?: boolean
  onPartial?: (e: VoicePartialEvent) => void
  /** Testes: fetch injetado / intervalo das parciais. */
  fetch?: typeof fetch
  partialIntervalMs?: number
}

let seq = 0

export class TranscribeSession {
  readonly id = `stt-${Date.now().toString(36)}-${++seq}`
  private chunks: Uint8Array[] = []
  private bytes = 0
  private ctrl = new AbortController()
  private closed = false
  private partialInFlight = false
  private lastPartialAt = 0
  private lastPartial: { covered: number; text: string } | null = null
  private spec: { covered: number; p: Promise<VoiceTranscribeResult | null> } | null = null
  private capped = false
  private readonly o: TranscribeSessionOptions

  constructor(opts: TranscribeSessionOptions) {
    this.o = opts
  }

  /** Áudio recebido (ms). */
  get audioMs(): number {
    return Math.round(this.bytes / BYTES_PER_MS)
  }

  push(pcm16: Uint8Array): void {
    if (this.closed || !pcm16.length) return
    if (this.audioMs >= SESSION_MAX_MS) {
      if (!this.capped) {
        this.capped = true
        this.o.onPartial?.({
          sessionId: this.id,
          text: this.lastPartial?.text ?? '',
          isFinal: false,
          ms: 0,
          error: 'A gravação chegou ao limite de 10 minutos — o resto não foi gravado.'
        })
      }
      return
    }
    this.chunks.push(pcm16.slice())
    this.bytes += pcm16.length
    this.maybePartial()
  }

  private pcm(): Uint8Array {
    if (this.chunks.length !== 1) {
      const all = new Uint8Array(this.bytes)
      let o = 0
      for (const c of this.chunks) {
        all.set(c, o)
        o += c.length
      }
      this.chunks = [all]
    }
    return this.chunks[0] ?? new Uint8Array(0)
  }

  private request(
    signal?: AbortSignal
  ): Promise<{ text: string; model: string; baseUrl: string; ms: number }> {
    const audio = encodeWav(this.pcm(), VOICE_SAMPLE_RATE)
    const opts: SttTranscribeOptions = {
      settings: this.o.settings,
      language: this.o.language,
      signal: signal ?? this.ctrl.signal,
      ...(this.o.fetch ? { fetch: this.o.fetch } : {})
    }
    return transcribeAudio({ audio, mimeType: 'audio/wav', fileName: 'fala.wav' }, opts)
  }

  private maybePartial(): void {
    if (!this.o.partials || !this.o.onPartial || this.partialInFlight || this.closed) return
    const now = Date.now()
    if (now - this.lastPartialAt < (this.o.partialIntervalMs ?? STT_PARTIAL_INTERVAL_MS)) return
    if (this.audioMs < 600 || this.audioMs > PARTIAL_MAX_MS) return
    if (this.lastPartial && this.bytes - this.lastPartial.covered < 300 * BYTES_PER_MS) return
    this.lastPartialAt = now
    this.partialInFlight = true
    const covered = this.bytes
    const t0 = Date.now()
    this.request()
      .then((r) => {
        if (this.closed) return
        this.lastPartial = { covered, text: r.text }
        this.o.onPartial?.({
          sessionId: this.id,
          text: r.text,
          isFinal: false,
          ms: Date.now() - t0,
          coveredMs: Math.round(covered / BYTES_PER_MS)
        })
      })
      .catch(() => {
        // parcial é melhor-esforço: a final reporta o erro
      })
      .finally(() => {
        this.partialInFlight = false
      })
  }

  /** Transcrição especulativa do que já foi falado (pausa da chamada). null = falhou/cancelada. */
  speculate(): Promise<VoiceTranscribeResult | null> {
    if (this.closed || !this.bytes) return Promise.resolve(null)
    if (this.spec && this.spec.covered === this.bytes) return this.spec.p
    const covered = this.bytes
    const p = this.request()
      .then((r) => ({ ...r, backend: 'api' as const, fellBack: false, speculative: true }))
      .catch(() => null)
    this.spec = { covered, p }
    return p
  }

  /**
   * Final: a especulação (ou a parcial) que já cobre a fala inteira vira a final sem request; senão
   * transcreve o buffer (uma nova tentativa numa falha transitória). Vazio → texto vazio.
   */
  async stop(
    opts: { reuseSpeculative?: boolean; reusePartial?: boolean } = {}
  ): Promise<VoiceTranscribeResult> {
    if (this.closed) throw new Error('sessão de transcrição encerrada')
    const total = this.bytes
    if (!total) {
      this.closed = true
      return {
        text: '',
        model: this.o.settings.api.model,
        baseUrl: '',
        ms: 0,
        backend: 'api',
        fellBack: false
      }
    }
    if (opts.reuseSpeculative && this.spec && this.spec.covered === total) {
      const r = await this.spec.p
      if (r) {
        this.closed = true
        return r
      }
    }
    if (opts.reusePartial && this.lastPartial && this.lastPartial.covered === total) {
      this.closed = true
      return {
        text: this.lastPartial.text,
        model: this.o.settings.api.model,
        baseUrl: this.o.settings.api.baseUrl ?? '',
        ms: 0,
        backend: 'api',
        fellBack: false,
        partialReused: true
      }
    }
    try {
      let r
      try {
        r = await this.request()
      } catch (e) {
        if (this.ctrl.signal.aborted || !isTransientVoiceError(e, 'stt')) throw e
        r = await this.request()
      }
      return { ...r, backend: 'api', fellBack: false }
    } finally {
      this.closed = true
    }
  }

  cancel(): void {
    this.closed = true
    this.ctrl.abort()
    this.chunks = []
    this.bytes = 0
  }
}
