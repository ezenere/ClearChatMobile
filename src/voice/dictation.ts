// Ditado no composer (celular): grava → parciais pela API (com `livePartials`) → transcrição final
// pela API do provedor escolhido em `sttSettings` → o texto entra no ponto de inserção (funções
// puras vendoradas do desktop: `insertDictationText`/`dictationPreview`/`planDictationCommit`). A
// mensagem enviada leva `meta.voice = { source: 'dictation' }` (= desktop). Parada por silêncio
// (`audioInput.silenceStopEnabled`/`silenceStopMs`, `SilenceDetector` vendorado) e push-to-talk
// (segurar o botão) seguem as settings sincronizadas. Motores locais: "só no computador" — explica
// e não manda o áudio para a API sem o usuário escolher. Sem React Native.
import type { VoicePartialEvent } from '@shared/ipc'
import type { Provider } from '@shared/types'
import { SilenceDetector, DEFAULT_SILENCE_THRESHOLD } from '@vendor/renderer/audio/silence'
import { captureErrorText } from '@vendor/renderer/voice/dictation'
import { readVoiceSettings, resolveStt } from './endpoints'
import { pcmBytes, type MicSource } from './mic'
import { TranscribeSession } from './session'

export type DictationPhase = 'idle' | 'starting' | 'recording' | 'transcribing'

export interface DictationView {
  phase: DictationPhase
  /** Última parcial (translúcida no campo). */
  partial: string
  level: number
  error: string | null
  /** Aviso (ex.: parciais desligadas, limite de duração). */
  notice: string | null
  /** Começo da gravação (relógio). */
  startedAt: number | null
}

export interface DictationDeps {
  setting(id: string): unknown
  provider(id: string): Provider | null
  requestMic(): Promise<boolean>
  mic(): MicSource
  fetch?: typeof fetch
  now?: () => number
}

const IDLE: DictationView = {
  phase: 'idle',
  partial: '',
  level: 0,
  error: null,
  notice: null,
  startedAt: null
}

/** Resultado do ditado: texto final ('' = nada falado). */
export interface DictationResult {
  text: string
  model: string
  audioMs: number
}

export class DictationController {
  private view: DictationView = IDLE
  private listeners = new Set<() => void>()
  private session: TranscribeSession | null = null
  private mic: MicSource | null = null
  private silence: SilenceDetector | null = null
  private spoke = false
  private gen = 0
  /** Parada por silêncio pediu o fim (a tela conclui). */
  onAutoStop: (() => void) | null = null

  constructor(private readonly d: DictationDeps) {}

  getView = (): DictationView => this.view
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  private set(p: Partial<DictationView>): void {
    this.view = { ...this.view, ...p }
    for (const fn of [...this.listeners]) fn()
  }

  /** "Segurar para falar" (`audioInput.pttEnabled`, sincronizado). */
  pttEnabled(): boolean {
    return readVoiceSettings(this.d.setting).audioInput.pttEnabled
  }

  /** Por que o ditado não roda aqui (pt-BR) — null = pode. */
  blocked(): string | null {
    const v = readVoiceSettings(this.d.setting)
    const r = resolveStt(v.stt, this.d.provider)
    return 'block' in r ? r.block.reason : null
  }

  /** Começa a gravar. Erro legível no estado (`error`) e devolvido. */
  async start(): Promise<string | null> {
    if (this.view.phase !== 'idle') return null
    const v = readVoiceSettings(this.d.setting)
    const r = resolveStt(v.stt, this.d.provider)
    if ('block' in r) {
      this.set({ ...IDLE, error: r.block.reason })
      return r.block.reason
    }
    const gen = ++this.gen
    this.set({ ...IDLE, phase: 'starting' })
    if (!(await this.d.requestMic())) {
      const msg = captureErrorText({ name: 'NotAllowedError', message: '' })
      if (gen === this.gen) this.set({ ...IDLE, error: msg })
      return msg
    }
    if (gen !== this.gen) return null
    const session = new TranscribeSession({
      settings: r.settings,
      language: v.audioInput.language,
      partials: v.stt.livePartials,
      onPartial: (e: VoicePartialEvent) => {
        if (this.session !== session) return
        if (e.error) this.set({ notice: e.error })
        if (e.text) this.set({ partial: e.text })
      },
      ...(this.d.fetch ? { fetch: this.d.fetch } : {})
    })
    this.session = session
    this.spoke = false
    this.silence = new SilenceDetector({
      threshold: DEFAULT_SILENCE_THRESHOLD,
      silenceMs: v.audioInput.silenceStopEnabled ? v.audioInput.silenceStopMs : 0
    })
    const mic = this.d.mic()
    this.mic = mic
    try {
      await mic.start(
        (f) => {
          if (this.session !== session) return
          session.push(pcmBytes(f.pcm))
          this.set({ level: f.rms })
          if (f.rms >= DEFAULT_SILENCE_THRESHOLD) this.spoke = true
          // parada por silêncio: só depois de alguma fala (silêncio inicial não encerra)
          if (this.spoke && this.silence?.push(f.rms, f.ms)) {
            this.silence = null
            this.onAutoStop?.()
          }
        },
        (e) => {
          if (this.session === session) this.fail(captureErrorText(e))
        }
      )
    } catch (e) {
      const msg = captureErrorText(e as Error)
      this.fail(msg)
      return msg
    }
    if (gen !== this.gen) {
      void mic.stop()
      return null
    }
    this.set({ phase: 'recording', startedAt: this.d.now?.() ?? Date.now() })
    return null
  }

  private fail(msg: string): void {
    this.gen++
    const mic = this.mic
    this.mic = null
    void mic?.stop()
    this.session?.cancel()
    this.session = null
    this.set({ ...IDLE, error: msg })
  }

  /** Conclui: para a captura e transcreve. null = cancelado no meio; erro → `error` e lança. */
  async finish(): Promise<DictationResult | null> {
    const session = this.session
    if (!session || this.view.phase === 'transcribing') return null
    const gen = this.gen
    const mic = this.mic
    this.mic = null
    await mic?.stop().catch(() => undefined)
    this.set({ phase: 'transcribing', level: 0 })
    const audioMs = session.audioMs
    try {
      const r = await session.stop({ reusePartial: true })
      if (gen !== this.gen) return null
      this.session = null
      this.set({ ...IDLE })
      return { text: r.text.trim(), model: r.model, audioMs }
    } catch (e) {
      if (gen !== this.gen) return null
      this.session = null
      const msg = `A transcrição falhou: ${e instanceof Error ? e.message : String(e)}`
      this.set({ ...IDLE, error: msg, partial: this.view.partial })
      throw new Error(msg, { cause: e })
    }
  }

  /** × : descarta tudo. */
  cancel(): void {
    this.gen++
    const mic = this.mic
    this.mic = null
    void mic?.stop()
    this.session?.cancel()
    this.session = null
    this.set({ ...IDLE })
  }

  clearError(): void {
    this.set({
      error: null,
      notice: null,
      partial: this.view.phase === 'idle' ? '' : this.view.partial
    })
  }
}
