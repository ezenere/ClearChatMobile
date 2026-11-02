// Chamada de voz no celular (chats executados AQUI — foreground, como o host): junta o dono do
// turno do desktop (`VoiceCallManager`, vendorado sem alteração — turno/fila, preâmbulo, frases de
// demora, interjeições, TTS por frase, turno continuado, barge-in, `end_call`, marcadores e custos)
// com o "sensor" que no desktop vive no renderer (src/renderer/src/lib/voice/useVoiceCall.ts):
// captura contínua, fim de turno ADAPTATIVO (`AdaptiveTurnGate` + transcrição especulativa na
// pausa + `classifyUtteranceEnd`), uma sessão de transcrição por fala, interjeições por pausa
// (`InterjectionWatcher`), backchannel × barge-in (`PlaybackHold`) e a fila de reprodução.
//
// Diferenças do desktop (documentadas no README):
// - sem cancelamento de eco (o `AudioStream` do expo-audio abre a fonte MIC, não a de chamada):
//   por padrão o microfone fica SURDO enquanto o assistente fala (meia-duplex de verdade) e o
//   botão "Interromper" faz o barge-in; "Interromper falando" (com fone) é opção deste aparelho;
// - TTS por frase com os bytes completos (sem WebSocket da ElevenLabs nem PCM progressivo);
// - transcrição só pela API (especulação na pausa pela API, como o desktop sem motor local).
// Sem React Native: as fontes de áudio/reprodução e o host entram por `CallDeps`.
import type { VoiceCallTimelineEvent } from '@shared/ipc'
import type { AgentEvent, Chat, ChatConfig, Provider, Session, StoredMessage } from '@shared/types'
import {
  DEFAULT_INTERJECTION_POLICY,
  resolveVoiceCallConfig,
  VOICE_CALL_INACTIVE,
  type InterjectionPolicy,
  type ResolvedVoiceCall,
  type TurnTiming,
  type VoiceCallConfig,
  type VoiceCallState
} from '@shared/voice'
import {
  INTERJECTION_MAX_AGE_MS,
  INTERJECTION_TAIL_CHARS,
  InterjectionWatcher,
  PlaybackHold,
  VoicedSpan
} from '@shared/voicePolicy'
import { AdaptiveTurnGate, classifyUtteranceEnd, type UtteranceEnd } from '@shared/voiceTurn'
import { audioDurationMs, type VoiceMessageMeta } from '@shared/voiceCallMarks'
import { DEFAULT_SILENCE_THRESHOLD } from '@vendor/renderer/audio/silence'
import { captureErrorText } from '@vendor/renderer/voice/dictation'
import { VoiceCallManager, type VoiceCallAmend } from '@vendor/desktop/voice/call'
import { classifyVoiceError, voiceProviderLabel } from '@vendor/desktop/voice/callErrors'
import { synthesizeBlock } from '@vendor/desktop/voice/tts'
import { clipsStatus, generateClips, loadCurrentClipAudio, type ClipStore } from './clips'
import { readVoiceSettings, resolveStt, resolveTts, type VoiceSettings } from './endpoints'
import { FRAME_MS, pcmBytes, type MicFrame, type MicSource } from './mic'
import { UtteranceQueue, type PlaybackBackend } from './player'
import { TranscribeSession } from './session'
import { onSttApiUsage } from './stt'

/** Pre-roll da fala (quadros de 32 ms mantidos antes do início) — não corta o começo (~300 ms). */
const PREROLL_MAX = 10
const FADE_MS = 80
const INTERJECTION_FADE_MS = 40
/** Meia-duplex: depois da última frase tocar, o microfone continua surdo por mais este tempo (eco). */
const ECHO_TAIL_MS = 350

export interface CallDeps {
  /** Repositório do chat (sessões, config, caminho ativo). */
  repo: {
    session(id: string): Session | null
    chat(id: string): Chat | null
    path(sessionId: string): StoredMessage[]
  }
  runner: {
    bus: { on(fn: (e: AgentEvent) => void): () => void }
    busyChats(): Set<string>
    amendVoiceTurn(sessionId: string, amend: VoiceCallAmend): Promise<unknown>
    appendDisplayMessage(sessionId: string, content: string, meta: StoredMessage['meta']): unknown
  }
  /** Envia o turno como mensagem do usuário (mesmo caminho do composer local). */
  send(
    chatId: string,
    sessionId: string,
    text: string,
    voice: VoiceMessageMeta | undefined
  ): Promise<void>
  /** Janela de escrita aberta durante a chamada (marcadores e turnos seguidos). */
  holdWindow(chatId: string): Promise<() => void>
  /** Config de voz da persona de origem do chat (lida ao vivo). */
  personaVoice(chatId: string): VoiceCallConfig | null
  /** `value` de um registro `setting` do cache. */
  setting(id: string): unknown
  provider(id: string): Provider | null
  /** Pede a permissão do microfone (pt-BR no diálogo do sistema); false = negada. */
  requestMic(): Promise<boolean>
  /** Fonte de áudio (nativa ou a de teste do modo de desenvolvimento). */
  mic(): MicSource
  playback: PlaybackBackend
  clips: ClipStore
  /** "Interromper falando" (com fone): fala do usuário corta a resposta. Padrão: false (meia-duplex). */
  bargeIn(): boolean
  /** Registra a fonte do contexto da chamada na request (`setVoiceCallSource`). */
  setVoiceCallSource(
    fn: (
      chat: Pick<Chat, 'id' | 'config'>,
      session: Pick<Session, 'id' | 'depth'>
    ) => ResolvedVoiceCall | null
  ): void
  fetch?: typeof fetch
  log?: (msg: string) => void
  now?: () => number
}

export interface CallView {
  call: VoiceCallState
  level: number
  live: { text: string; state: 'partial' | 'speculative' | 'final' | null }
  /** Erro da chamada atual ou o motivo do fim (fica até a próxima chamada). */
  error: string | null
  volume: number
  clips: { state: 'unknown' | 'ok' | 'missing' | 'generating'; done?: number; total?: number }
  /** Reprodução em curso (o botão "Interromper" aparece). */
  playing: boolean
  /** Microfone surdo agora (meia-duplex enquanto o assistente fala). */
  deaf: boolean
  timeline: VoiceCallTimelineEvent[]
}

const INITIAL: CallView = {
  call: VOICE_CALL_INACTIVE,
  level: 0,
  live: { text: '', state: null },
  error: null,
  volume: 1,
  clips: { state: 'unknown' },
  playing: false,
  deaf: false,
  timeline: []
}

/** Pré-checagem da chamada (pt-BR): o que falta para ligar neste chat. null = pronto. */
export function callReadiness(
  chat: Chat,
  settings: VoiceSettings,
  provider: (id: string) => Provider | null,
  persona: VoiceCallConfig | null
): { reason: string; desktopOnly: boolean } | null {
  const resolved = resolveVoiceCallConfig(
    chat.config.voice ?? null,
    settings.voiceCallDefaults,
    persona
  )
  if (!resolved.enabled)
    return {
      reason: 'A chamada de voz está desligada para este chat (persona/Configurações → Voz).',
      desktopOnly: false
    }
  const stt = resolveStt(settings.stt, provider)
  if ('block' in stt) return stt.block
  const tts = resolveTts(settings.tts, provider)
  if ('block' in tts) return tts.block
  return null
}

export class VoiceCallController {
  private view: CallView = INITIAL
  private listeners = new Set<() => void>()
  private readonly d: CallDeps
  readonly manager: VoiceCallManager
  private queue: UtteranceQueue | null = null
  private mic: MicSource | null = null
  private releaseWindow: (() => void) | null = null
  private offUsage: (() => void) | null = null
  // ---- sensor ----
  private gate: AdaptiveTurnGate | null = null
  private session: TranscribeSession | null = null
  private chain: Promise<void> = Promise.resolve()
  private speaking = false
  private preroll: Uint8Array[] = []
  private policy: InterjectionPolicy = DEFAULT_INTERJECTION_POLICY
  private watcher: InterjectionWatcher | null = null
  private voiced = new VoicedSpan()
  private hold = new PlaybackHold()
  private spec: { seq: number; text: string; end: UtteranceEnd } | null = null
  private started = new Set<string>()
  private askedSeq = -1
  private pendingObs: { speechMs: number } | null = null
  private allowSpec = true
  private lastPlaybackAt = 0
  private lastPhase: VoiceCallState['phase'] = 'listening'
  private generation = 0

  constructor(deps: CallDeps) {
    this.d = deps
    this.manager = new VoiceCallManager({
      sendTurn: (sessionId, text, meta) => {
        const s = this.d.repo.session(sessionId)
        if (!s) return
        void this.d
          .send(s.chatId, sessionId, text, meta?.voice)
          .catch((e: unknown) =>
            this.manager.reportError(e instanceof Error ? e.message : String(e))
          )
      },
      synth: (text, signal) => this.synth(text, signal),
      synthPhrase: (text, signal) => this.synth(text, signal),
      emitState: (state) => this.onState(state),
      emitUtterance: (u) => {
        if (u.kind === undefined || u.kind === 'sentence' || u.kind === 'delay') {
          const ms = audioDurationMs(u.audio, u.mime)
          if (ms) this.manager.noteTtsAudio(ms)
        }
        this.queue?.enqueue(u)
      },
      emitUtteranceCancel: (id) => this.queue?.drop(id, FADE_MS),
      emitTimeline: (e) => this.pushTimeline(e),
      logEval: (e) => this.d.log?.(`voice-eval ${e.kind} ${e.class}#${e.variant} ${e.reason}`),
      clip: (cls, n) => {
        const v = this.settings()
        const tts = resolveTts(v.tts, this.d.provider)
        if ('block' in tts) return Promise.resolve(null)
        return loadCurrentClipAudio(
          this.d.clips,
          tts.settings,
          v.voiceCallDefaults.fillers.pool,
          cls,
          n
        )
      },
      sessionInfo: (sessionId) => {
        const s = this.d.repo.session(sessionId)
        return s
          ? { chatId: s.chatId, depth: s.depth, busy: this.d.runner.busyChats().has(s.chatId) }
          : null
      },
      chatConfig: (chatId) => this.d.repo.chat(chatId)?.config ?? null,
      personaVoice: (chatId) => this.d.personaVoice(chatId),
      // sem motor local: o veredito do fim de turno sai pela API (lento)
      slowSpeculation: () => true,
      classifyError: (e, source) => {
        const v = this.settings()
        const base = source === 'stt' ? v.stt.api : v.tts.api
        const p = base.providerId ? this.d.provider(base.providerId) : null
        return classifyVoiceError(e, source, voiceProviderLabel(p?.baseUrl ?? null, false))
      },
      onCallEnded: () => this.queue?.cancel(FADE_MS),
      settings: () => {
        const v = this.settings()
        const tts = resolveTts(v.tts, this.d.provider)
        const stt = resolveStt(v.stt, this.d.provider)
        return {
          defaults: v.voiceCallDefaults,
          audioInput: v.audioInput,
          stt: 'settings' in stt ? stt.settings : v.stt,
          tts: 'settings' in tts ? tts.settings : v.tts
        }
      },
      onEvent: (cb) => this.d.runner.bus.on(cb),
      amendTurn: async (sessionId, amend) => {
        await this.d.runner.amendVoiceTurn(sessionId, amend)
      },
      appendMarker: (sessionId, content, meta) => {
        this.d.runner.appendDisplayMessage(sessionId, content, meta)
      },
      sessionMessages: (sessionId) => this.d.repo.path(sessionId),
      ttsUnitPrice: () => null,
      ...(deps.now ? { now: deps.now } : {})
    })
    this.d.setVoiceCallSource((chat, session) => {
      const c = this.manager.callContextFor(chat, session)
      // "Modelo da chamada" com um provedor que não existe NESTE aparelho = sem modelo próprio
      return c?.model && !this.d.provider(c.model.providerId) ? { ...c, model: null } : c
    })
  }

  // ---------------- estado para a tela ----------------

  getView = (): CallView => this.view
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  private set(p: Partial<CallView>): void {
    this.view = { ...this.view, ...p }
    for (const fn of [...this.listeners]) fn()
  }
  private pushTimeline(e: VoiceCallTimelineEvent): void {
    const tl = [...this.view.timeline, e]
    this.set({ timeline: tl.length > 60 ? tl.slice(-60) : tl })
  }

  private settings(): VoiceSettings {
    return readVoiceSettings(this.d.setting)
  }

  private onState(state: VoiceCallState): void {
    const was = this.view.call.active
    this.set({
      call: state,
      error: state.error ?? (state.active ? null : this.view.error)
    })
    if (state.phase !== this.lastPhase) {
      this.lastPhase = state.phase
      if (state.phase === 'thinking' || state.phase === 'transcribing') this.started = new Set()
    }
    // a chamada terminou por dentro (end_call, erro fatal): desmonta a captura e solta a janela
    if (was && !state.active) void this.teardown()
  }

  private async synth(
    text: string,
    signal: AbortSignal
  ): Promise<{ audio: Uint8Array; mime: string }> {
    const tts = resolveTts(this.settings().tts, this.d.provider)
    if ('block' in tts) throw new Error(tts.block.reason)
    return synthesizeBlock({ text, settings: tts.settings }, { signal })
  }

  // ---------------- ciclo da chamada ----------------

  /** Liga a chamada no chat (sessão principal). Erro legível (pt-BR). */
  async start(sessionId: string): Promise<void> {
    if (this.view.call.active) throw new Error('Já existe uma chamada de voz ativa.')
    const session = this.d.repo.session(sessionId)
    const chat = session ? this.d.repo.chat(session.chatId) : null
    if (!session || !chat) throw new Error('Chat não encontrado.')
    const v = this.settings()
    const ready = callReadiness(chat, v, this.d.provider, this.d.personaVoice(chat.id))
    if (ready) throw new Error(ready.reason)
    if (!(await this.d.requestMic()))
      throw new Error(captureErrorText({ name: 'NotAllowedError', message: '' }))
    const gen = ++this.generation
    this.releaseWindow = await this.d.holdWindow(chat.id)
    if (gen !== this.generation) {
      this.releaseWindow()
      this.releaseWindow = null
      return
    }
    this.set({ ...INITIAL, volume: this.view.volume })
    this.queue = new UtteranceQueue({
      backend: this.d.playback,
      onState: (st) => {
        this.set({ playing: st === 'playing' })
        if (st === 'idle') {
          this.lastPlaybackAt = this.now()
          this.manager.playbackIdle()
        }
      },
      onItem: ({ item, phase }) => {
        if (phase === 'start' && (item.kind ?? 'sentence') === 'sentence') this.started.add(item.id)
        this.pushTimeline({
          ts: this.now(),
          kind:
            (item.kind ?? 'sentence') === 'sentence'
              ? phase === 'start'
                ? 'sentence-start'
                : 'sentence-end'
              : phase === 'start'
                ? 'clip-start'
                : 'clip-end',
          id: item.id
        })
      },
      onError: ({ item, reason }) => {
        this.pushTimeline({
          ts: this.now(),
          kind: 'playback-error',
          id: item.id,
          class: item.kind ?? 'sentence',
          reason
        })
        if (item.kind === 'filler' || item.kind === 'interjection' || item.kind === 'delay') {
          this.set({ error: `Não foi possível tocar um clipe: ${reason}` })
          return
        }
        this.stop(`não foi possível tocar uma frase da resposta (${reason})`)
      }
    })
    this.queue.setVolume(this.view.volume)
    try {
      this.manager.start(sessionId)
    } catch (e) {
      await this.teardown()
      throw e
    }
    this.offUsage = onSttApiUsage((u) => {
      if (this.manager.state().active) this.manager.noteSttApiUsage(u)
    })
    // política resolvida (persona → chat → global) e a especulação pela API (= desktop)
    const resolved = resolveVoiceCallConfig(
      chat.config.voice ?? null,
      v.voiceCallDefaults,
      this.d.personaVoice(chat.id)
    )
    this.policy = resolved.interjections
    this.allowSpec = v.voiceCallDefaults.turn.speculativeApi || v.stt.livePartials
    void this.refreshClips()
    await this.startCapture()
  }

  /** Desliga (usuário). `reason` = fim por falha. */
  stop(reason?: string): void {
    if (!this.manager.state().active) {
      void this.teardown()
      return
    }
    this.manager.stop(reason)
  }

  private async teardown(): Promise<void> {
    this.generation++
    await this.stopCapture()
    this.queue?.cancel(FADE_MS)
    this.queue = null
    this.offUsage?.()
    this.offUsage = null
    const release = this.releaseWindow
    this.releaseWindow = null
    // o marcador de fim pode esperar o turno terminar: a janela fica mais um pouco
    if (release) setTimeout(release, 8000)
    this.set({ level: 0, playing: false, deaf: false })
  }

  async toggleMute(): Promise<void> {
    if (!this.manager.state().active) return
    const next = !this.manager.state().muted
    if (next) await this.stopCapture()
    this.manager.mute(next)
    if (!next) await this.startCapture()
    this.set({ level: 0 })
  }

  setVolume(v: number): void {
    const value = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1
    this.set({ volume: value })
    this.queue?.setVolume(value)
  }

  /** "Interromper": barge-in pelo botão (o histórico fica só com as frases que tocaram). */
  interrupt(): void {
    if (!this.manager.state().active || !this.queue) return
    this.queue.cancel(FADE_MS)
    this.manager.bargeIn({ playedIds: [...this.started] })
    this.hold.reset()
  }

  clearError(): void {
    this.set({ error: null })
  }

  // ---------------- clipes (preâmbulo/interjeições) ----------------

  async refreshClips(): Promise<void> {
    const v = this.settings()
    const tts = resolveTts(v.tts, this.d.provider)
    if ('block' in tts) return this.set({ clips: { state: 'unknown' } })
    try {
      const s = await clipsStatus(this.d.clips, tts.settings, v.voiceCallDefaults.fillers.pool)
      this.set({
        clips: { state: s.ready >= s.total ? 'ok' : 'missing', done: s.ready, total: s.total }
      })
    } catch {
      this.set({ clips: { state: 'unknown' } })
    }
  }

  /** "Gerar clipes": sintetiza as interjeições e o pool de preâmbulos com a voz atual. */
  async generateClips(): Promise<void> {
    const v = this.settings()
    const tts = resolveTts(v.tts, this.d.provider)
    if ('block' in tts) throw new Error(tts.block.reason)
    this.set({ clips: { state: 'generating', done: 0, total: 0 } })
    try {
      await generateClips({
        store: this.d.clips,
        settings: tts.settings,
        fillerPool: v.voiceCallDefaults.fillers.pool,
        synth: (text, signal) => synthesizeBlock({ text, settings: tts.settings }, { signal }),
        onProgress: (done, total) => this.set({ clips: { state: 'generating', done, total } })
      })
    } finally {
      await this.refreshClips()
    }
  }

  // ---------------- captura + porta de fala ----------------

  private now(): number {
    return this.d.now?.() ?? Date.now()
  }

  private async startCapture(): Promise<void> {
    const st = this.manager.state()
    if (!st.active || st.muted) return
    const timing: TurnTiming = st.turnTiming
    this.gate = new AdaptiveTurnGate(timing, DEFAULT_SILENCE_THRESHOLD)
    this.watcher = new InterjectionWatcher(this.policy.minPauseMs)
    this.hold = new PlaybackHold()
    this.voiced = new VoicedSpan()
    this.spec = null
    this.speaking = false
    this.preroll = []
    this.askedSeq = -1
    this.pendingObs = null
    const gen = this.generation
    const mic = this.d.mic()
    this.mic = mic
    try {
      await mic.start(
        (f) => {
          if (gen === this.generation && this.mic === mic) this.onFrame(f)
        },
        (e) => {
          if (gen === this.generation) this.stop(captureErrorText(e))
        }
      )
    } catch (e) {
      if (this.mic === mic) this.mic = null
      if (gen === this.generation) this.stop(captureErrorText(e as Error))
    }
  }

  private async stopCapture(): Promise<void> {
    const mic = this.mic
    this.mic = null
    this.speaking = false
    this.preroll = []
    this.gate?.reset()
    this.hold.reset()
    this.gate = null
    this.dropSession()
    if (mic) await mic.stop().catch(() => undefined)
  }

  /** Microfone surdo agora? (meia-duplex: frase tocando ou o rabo do eco logo depois). */
  private isDeaf(): boolean {
    if (this.d.bargeIn()) return false
    if (this.queue?.current) return true
    return this.now() - this.lastPlaybackAt < ECHO_TAIL_MS && this.lastPlaybackAt > 0
  }

  /** Um quadro de 32 ms do microfone. */
  onFrame(f: MicFrame): void {
    const deaf = this.isDeaf()
    if (deaf !== this.view.deaf) this.set({ deaf })
    const rms = deaf ? 0 : f.rms
    this.onLevel(rms)
    if (deaf) return
    const bytes = pcmBytes(f.pcm)
    if (this.speaking) {
      this.session?.push(bytes)
      return
    }
    this.preroll.push(bytes.slice())
    if (this.preroll.length > PREROLL_MAX) this.preroll.shift()
  }

  private ensureSession(): TranscribeSession | null {
    if (this.session) return this.session
    const stt = resolveStt(this.settings().stt, this.d.provider)
    if ('block' in stt) {
      this.set({ error: stt.block.reason })
      return null
    }
    this.session = new TranscribeSession({
      settings: stt.settings,
      language: this.settings().audioInput.language,
      ...(this.d.fetch ? { fetch: this.d.fetch } : {})
    })
    return this.session
  }

  private dropSession(): void {
    const s = this.session
    this.session = null
    s?.cancel()
  }

  private setLive(text: string, state: CallView['live']['state']): void {
    this.set({ live: { text: text.trim(), state: text.trim() ? state : null } })
  }

  private endUtterance(reuseSpeculative: boolean, speechMs?: number): void {
    this.manager.speechEnd()
    const session = this.session
    this.session = null
    this.chain = this.chain
      .then(async () => {
        if (!session) {
          this.manager.turn('')
          return
        }
        const audioMs = session.audioMs
        try {
          const r = await session.stop({ reuseSpeculative, reusePartial: true })
          this.manager.noteTranscript({ text: r.text, model: r.model, backend: 'api', audioMs })
          this.setLive(r.text, 'final')
          this.manager.turn(r.text, {
            speechMs: typeof speechMs === 'number' ? Math.round(speechMs) : null
          })
        } catch (e) {
          if (this.manager.voiceApiError('stt', e, { retried: true })) return
          this.set({ error: e instanceof Error ? e.message : String(e) })
          this.manager.turn('')
        }
      })
      .catch(() => undefined)
  }

  private sendObservation(speechMs: number, end: UtteranceEnd | null): void {
    if (!this.policy.enabled || !this.gate) return
    const tail = (this.spec?.text ?? '').slice(-INTERJECTION_TAIL_CHARS)
    if (!end && !this.spec) {
      this.pushTimeline({
        ts: this.now(),
        kind: 'decision',
        class: 'NONE',
        played: false,
        speechMs,
        pauseMs: this.gate.pauseMs,
        text: tail,
        reason: 'no-verdict'
      })
      return
    }
    this.manager.interjectionObserved({
      speechMs,
      pauseMs: this.gate.pauseMs,
      tail,
      observedAt: this.now(),
      end
    })
  }

  private closeUtterance(): void {
    const gate = this.gate
    if (!gate) return
    this.speaking = false
    this.preroll = []
    this.pendingObs = null
    const holdMs = this.hold.speechMs
    const kind = this.hold.end()
    this.spec = null
    if (kind === 'backchannel') {
      this.dropSession()
      this.manager.backchannel({ ms: holdMs })
    } else {
      this.endUtterance(this.askedSeq === gate.specSeq && this.askedSeq > 0, this.voiced.spanMs)
    }
    this.watcher?.reset()
    this.voiced.reset()
  }

  private speculate(seq: number): void {
    this.askedSeq = seq
    const session = this.session
    if (!session || !this.allowSpec) {
      this.onVerdict(seq, null)
      return
    }
    void session
      .speculate()
      .then((r) => this.onVerdict(seq, r ? r.text : null))
      .catch(() => this.onVerdict(seq, null))
  }

  private onVerdict(seq: number, text: string | null): void {
    const gate = this.gate
    if (!gate || seq !== gate.specSeq || !gate.speaking) return
    const end: UtteranceEnd = text == null ? 'unknown' : classifyUtteranceEnd(text)
    if (text != null) {
      this.spec = { seq, text, end }
      this.setLive(text, 'speculative')
    }
    this.pushTimeline({
      ts: this.now(),
      kind: 'turn-verdict',
      pauseMs: gate.pauseMs,
      text: (text ?? '').slice(-80),
      reason: end
    })
    if (this.pendingObs && !this.hold.open) {
      const o = this.pendingObs
      this.pendingObs = null
      if (gate.pauseMs > this.policy.minPauseMs + INTERJECTION_MAX_AGE_MS)
        this.pushTimeline({
          ts: this.now(),
          kind: 'decision',
          class: 'NONE',
          played: false,
          speechMs: o.speechMs,
          pauseMs: gate.pauseMs,
          text: (text ?? '').slice(-80),
          reason: 'late-verdict'
        })
      else this.sendObservation(o.speechMs, text == null ? null : end)
    }
    if (gate.setVerdict(seq, end) === 'end') this.closeUtterance()
  }

  private onLevel(rms: number): void {
    const gate = this.gate
    if (!gate) return
    this.set({ level: rms })
    const ev = gate.push(rms, FRAME_MS)
    if (ev === 'start') this.voiced.reset()
    if (ev === 'start' || this.speaking) this.voiced.push(rms, FRAME_MS, DEFAULT_SILENCE_THRESHOLD)
    if (rms >= DEFAULT_SILENCE_THRESHOLD) {
      const cur = this.queue?.current ?? null
      if (cur?.kind === 'interjection') this.queue?.drop(cur.id, INTERJECTION_FADE_MS)
    }
    if (ev === 'resume') {
      this.spec = null
      this.askedSeq = -1
      this.pendingObs = null
    }
    if (ev === 'start') {
      const queue = this.queue
      const cur = queue?.current ?? null
      const sentencePlaying = !!cur && (cur.kind ?? 'sentence') === 'sentence'
      const mainSpeaking = this.manager.state().phase === 'speaking'
      const heard = this.started.size > 0
      if (queue && (sentencePlaying || (heard && mainSpeaking))) {
        this.hold.start(rms, FRAME_MS, DEFAULT_SILENCE_THRESHOLD)
      } else {
        const dropped = queue ? [...(cur ? [cur.id] : []), ...queue.queuedIds] : []
        if (dropped.length) queue?.cancel(FADE_MS)
        this.manager.speechBegin({ dropped })
      }
      this.askedSeq = -1
      this.setLive('', null)
      this.speaking = true
      this.spec = null
      this.pendingObs = null
      const session = this.ensureSession()
      for (const b of this.preroll.splice(0)) session?.push(b)
      this.watcher?.reset()
      return
    }
    if (ev === 'speculate') {
      if (this.hold.open) {
        if (gate.setVerdict(gate.specSeq, 'unknown') === 'end') this.closeUtterance()
      } else this.speculate(gate.specSeq)
      return
    }
    if (ev === 'end') {
      this.closeUtterance()
      return
    }
    if (this.hold.open) {
      if (this.hold.frame(rms, FRAME_MS, DEFAULT_SILENCE_THRESHOLD) === 'barge-in') {
        this.queue?.cancel(FADE_MS)
        this.manager.bargeIn({ playedIds: [...this.started] })
        this.hold.reset()
      }
      return
    }
    if (!this.speaking) return
    const obs = this.watcher?.push(rms, FRAME_MS, DEFAULT_SILENCE_THRESHOLD, this.now())
    if (obs) {
      this.pushTimeline({
        ts: this.now(),
        kind: 'pause',
        pauseMs: obs.pauseMs,
        speechMs: obs.speechMs
      })
      const verdict = gate.verdict
      if (verdict && verdict !== 'unknown') this.sendObservation(obs.speechMs, verdict)
      else if (verdict === 'unknown' || !this.manager.state().turnTiming.adaptive)
        this.sendObservation(obs.speechMs, null)
      else this.pendingObs = { speechMs: obs.speechMs }
    }
  }
}

export type { ChatConfig }
