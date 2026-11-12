// Sessão de transcrição no celular — o subconjunto "API" da sessão do desktop
// (ClearChatDesktop/src/main/voice/session.ts, que depende dos motores locais e do disco): acumula
// o PCM16 mono 16 kHz, parciais melhor-esforço pela API enquanto o usuário fala (ditado, com
// `livePartials`; nunca duas em voo), transcrição ESPECULATIVA na pausa (fim de turno adaptativo da
// chamada) e a final em `stop()` — reaproveitando a especulação/parcial que já cobre a fala inteira
// (sem request a mais), com UMA nova tentativa numa falha transitória (`isTransientVoiceError`
// vendorado). `cancel()` descarta tudo. O WAV enviado é o `encodeWav` vendorado. Sem React Native.
//
// **Portão de ativação de fala** (`@shared/speechGate` vendorado — o mesmo do desktop) na frente de
// TODA via de STT (parciais, especulação e a final; ditado e chamada): trecho com voz de menos
// (abaixo do nível de ativação deste aparelho / do piso de ruído + 10 dB) NÃO chama o STT, o que vai
// é aparado do 1º ao último quadro com voz (com folga) e o texto passa pelo pós-filtro de
// alucinações de silêncio ("Tchau.", "Obrigado." inventados pelo whisper). O piso de ruído aprendido
// atravessa as sessões (as falas curtas da chamada são uma sessão cada).
import type { VoicePartialEvent, VoiceTranscribeResult } from '@shared/ipc'
import type { SttSettings } from '@shared/voice'
import {
  filterSilenceHallucination,
  INITIAL_NOISE_FLOOR_DB,
  SpeechGate,
  type GateAnalysis
} from '@shared/speechGate'
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
  /**
   * Nível de ativação do microfone (dBFS — `audioInput.activationDb`, local do aparelho); ausente =
   * `DEFAULT_ACTIVATION_DB`. Abaixo dele nada é fala (o portão não manda ao STT).
   */
  activationDb?: number
  /** Parciais ao vivo pela API (`sttSettings.livePartials` — ditado e chamada). */
  partials?: boolean
  onPartial?: (e: VoicePartialEvent) => void
  /** Testes: fetch injetado / intervalo das parciais. */
  fetch?: typeof fetch
  partialIntervalMs?: number
}

let seq = 0

/**
 * Piso de ruído aprendido pela última sessão (dBFS): a próxima começa dele — na chamada cada fala é
 * uma sessão curta, e o piso precisa atravessar as falas para se adaptar ao ambiente (= desktop).
 */
let lastNoiseFloorDb = INITIAL_NOISE_FLOOR_DB

/** Testes: o piso volta ao inicial. */
export function resetNoiseFloor(): void {
  lastNoiseFloorDb = INITIAL_NOISE_FLOOR_DB
}

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
  private readonly gate: SpeechGate
  private readonly o: TranscribeSessionOptions

  constructor(opts: TranscribeSessionOptions) {
    this.o = opts
    this.gate = new SpeechGate({
      activationDb: opts.activationDb,
      sampleRate: VOICE_SAMPLE_RATE,
      noiseFloorDb: lastNoiseFloorDb
    })
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
    const chunk = pcm16.slice()
    this.chunks.push(chunk)
    this.bytes += chunk.length
    this.gate.push(chunk)
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

  /** Encerra a sessão (o piso de ruído aprendido segue para a próxima). */
  private close(): void {
    if (!this.closed && this.gate.frames > 0) lastNoiseFloorDb = this.gate.noiseFloorDb
    this.closed = true
  }

  /** Portão de fala sobre `[0, end)` do buffer. */
  private analyze(end: number): GateAnalysis {
    return this.gate.analyze(0, end)
  }

  /** Transcreve SÓ o trecho com voz (`send` do portão) e passa o texto pelo pós-filtro. */
  private request(
    g: GateAnalysis & { send: { start: number; end: number } },
    signal?: AbortSignal
  ): Promise<{ text: string; model: string; baseUrl: string; ms: number }> {
    return this.rawRequest(g.send, signal).then((r) => ({
      ...r,
      text: filterSilenceHallucination(r.text, g)
    }))
  }

  private rawRequest(
    range: { start: number; end: number },
    signal?: AbortSignal
  ): Promise<{ text: string; model: string; baseUrl: string; ms: number }> {
    const audio = encodeWav(this.pcm().subarray(range.start, range.end), VOICE_SAMPLE_RATE)
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
    const covered = this.bytes
    // portão de fala: trecho sem voz suficiente não sobe (o whisper alucina em silêncio/ruído)
    const g = this.analyze(covered)
    if (!g.send) return
    this.lastPartialAt = now
    this.partialInFlight = true
    const t0 = Date.now()
    this.request({ ...g, send: g.send })
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
    // portão de fala: sem voz suficiente a especulação é vazia — sem request (e reusável: a final
    // também não chamaria o STT)
    const g = this.analyze(covered)
    const p: Promise<VoiceTranscribeResult | null> = g.send
      ? this.request({ ...g, send: g.send })
          .then((r) => ({ ...r, backend: 'api' as const, fellBack: false, speculative: true }))
          .catch(() => null)
      : Promise.resolve(this.empty({ speculative: true }))
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
    // portão de fala: o buffer sem voz suficiente não vai ao STT (vazio, sem request)
    const g = total ? this.analyze(total) : null
    if (!g?.send) {
      this.close()
      return this.empty()
    }
    if (opts.reuseSpeculative && this.spec && this.spec.covered === total) {
      const r = await this.spec.p
      if (r) {
        this.close()
        return r
      }
    }
    if (opts.reusePartial && this.lastPartial && this.lastPartial.covered === total) {
      this.close()
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
    const voiced = { ...g, send: g.send }
    try {
      let r
      try {
        r = await this.request(voiced)
      } catch (e) {
        if (this.ctrl.signal.aborted || !isTransientVoiceError(e, 'stt')) throw e
        r = await this.request(voiced)
      }
      return { ...r, backend: 'api', fellBack: false }
    } finally {
      this.close()
    }
  }

  /** Resultado vazio (nada com voz) — sem request. */
  private empty(extra: Partial<VoiceTranscribeResult> = {}): VoiceTranscribeResult {
    return {
      text: '',
      model: this.o.settings.api.model,
      baseUrl: '',
      ms: 0,
      backend: 'api',
      fellBack: false,
      ...extra
    }
  }

  cancel(): void {
    this.close()
    this.ctrl.abort()
    this.chunks = []
    this.bytes = 0
  }
}
