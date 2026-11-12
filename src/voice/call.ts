// Chamada de voz no celular (chats executados AQUI — foreground, como o host): junta o dono do
// turno do desktop (`VoiceCallManager`, vendorado sem alteração — turno/fila, preâmbulo, frases de
// demora espaçadas, TTS por frase, tags de voz, turno continuado, barge-in em palavras, `end_call`,
// marcadores e custos) com o "sensor" que no desktop vive no renderer
// (src/renderer/src/lib/voice/useVoiceCall.ts): captura contínua, fala detectada pelo `LevelGate`
// (a mesma regra do portão do STT: nível de ativação deste aparelho + piso de ruído adaptativo), fim
// de turno ADAPTATIVO (`AdaptiveTurnGate` + transcrição especulativa na pausa +
// `classifyUtteranceEnd`), uma sessão de transcrição por fala, a fila de reprodução e a fala por
// cima da resposta com histerese (`PlaybackDuck`): depois de voz sustentada (onset) a voz do
// assistente ABAIXA (rampa de ganho no player) e continua; quem insiste (voz/palavras/"para") vira barge-in — o histórico fica só com as
// palavras OUVIDAS (posição do player); o que para antes (tosse, "uhum") devolve o volume e é
// descartado. Meia-duplex: nada do assistente toca durante a fala do usuário.
//
// Diferenças do desktop (documentadas no README):
// - sem cancelamento de eco (o `AudioStream` do expo-audio abre a fonte MIC, não a de chamada):
//   por padrão o microfone fica SURDO enquanto o assistente fala (meia-duplex de verdade) e o
//   botão "Interromper" faz o barge-in; "Falar por cima da resposta" (com fone) é opção deste
//   aparelho e liga o ducking/barge-in por voz do desktop;
// - TTS por frase com os bytes completos (sem WebSocket da ElevenLabs nem PCM progressivo);
// - transcrição só pela API (especulação na pausa pela API, como o desktop sem motor local).
// Sem React Native: as fontes de áudio/reprodução e o host entram por `CallDeps`.
import type { VoiceCallTimelineEvent } from '@shared/ipc'
import type { AgentEvent, Chat, ChatConfig, Provider, Session, StoredMessage } from '@shared/types'
import {
  DEFAULT_BARGE_IN,
  resolveVoiceCallConfig,
  VOICE_CALL_INACTIVE,
  type ResolvedVoiceCall,
  type TurnTiming,
  type VoiceCallConfig,
  type VoiceCallState,
  type VoiceTtsChoice
} from '@shared/voice'
import { DUCK_FADE_MS, PlaybackDuck, VoicedSpan, type BargeInReason } from '@shared/voicePolicy'
import { AdaptiveTurnGate, classifyUtteranceEnd, type UtteranceEnd } from '@shared/voiceTurn'
import { audioDurationMs, type VoiceMessageMeta } from '@shared/voiceCallMarks'
import { LevelGate } from '@shared/speechGate'
import { heardChars } from '@shared/heardText'
import { captureErrorText } from '@vendor/renderer/voice/dictation'
import { VoiceCallManager, type VoiceCallAmend } from '@vendor/desktop/voice/call'
import { classifyVoiceError, voiceProviderLabel } from '@vendor/desktop/voice/callErrors'
import { synthesizeBlock } from '@vendor/desktop/voice/tts'
import {
  clipsStatus,
  generateClips,
  loadCurrentClipAudio,
  type ClipClass,
  type ClipStore
} from './clips'
import { readVoiceSettings, resolveStt, resolveTts, type VoiceSettings } from './endpoints'
import {
  callRefusal,
  resolveChatVoice,
  settingsWith,
  voiceLayers,
  voiceUse,
  type VoiceUse
} from './resolve'
import { VoiceFollow } from './follow'
import { FRAME_MS, pcmBytes, type MicFrame, type MicSource } from './mic'
import { UtteranceQueue, type PlaybackBackend } from './player'
import { TranscribeSession } from './session'
import { onSttApiUsage } from './stt'

/** Pre-roll da fala (quadros de 32 ms mantidos antes do início) — não corta o começo (~300 ms). */
const PREROLL_MAX = 10
/** Fade (ms) do preâmbulo/frase cortados pelo usuário e do barge-in. */
const FADE_MS = 80
/** Meia-duplex: depois da última frase tocar, o microfone continua surdo por mais este tempo (eco). */
const ECHO_TAIL_MS = 350
/** Quadro com voz pelo `LevelGate` → 1; sem voz → 0 (os gates de turno usam o limiar 0,5). */
const VOICED = 1
const SPEECH = 0.5
/** Leitura ao vivo: quanto da frase atual tocou (~10×/s). */
const FOLLOW_MS = 100
/** Eventos da timeline que vão ao log de desenvolvimento. */
const LOGGED_KINDS = new Set<VoiceCallTimelineEvent['kind']>([
  'duck',
  'duck-restore',
  'barge-in',
  'heard',
  'turn-amended'
])

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
  /**
   * "Falar por cima da resposta" (com fone): o microfone ouve durante a fala do assistente — falar
   * por cima abaixa a voz dele (ducking) e insistir interrompe. Padrão: false (meia-duplex surda).
   */
  bargeIn(): boolean
  /** Nível de ativação do microfone DESTE aparelho (dBFS; ausente = −45). */
  activationDb?(): number
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
  /**
   * Clipes da voz da chamada (preâmbulos, frases de ferramenta e "obrigado por aguardar"):
   * `missing` lista as classes sem clipe — preâmbulos sem clipe ficam mudos; frases de ferramenta e
   * agradecimentos sem clipe saem ao vivo (o agradecimento é sintetizado enquanto o usuário espera).
   */
  clips: {
    state: 'unknown' | 'ok' | 'missing' | 'generating'
    done?: number
    total?: number
    missing?: ClipClass[]
  }
  /** Reprodução em curso (o botão "Interromper" aparece). */
  playing: boolean
  /** Microfone surdo agora (meia-duplex enquanto o assistente fala). */
  deaf: boolean
  /** O usuário fala por cima da resposta agora: a voz do assistente está abaixada (ducking). */
  ducked: boolean
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
  ducked: false,
  timeline: []
}

/**
 * Pré-checagem da chamada (pt-BR): o que falta para ligar neste chat. null = pronto. A voz é a da
 * persona/chat resolvida AQUI (`resolveChatVoice`: escolha disponível, ou a padrão deste aparelho);
 * nenhuma funcionando → "Chamada de voz indisponível neste dispositivo — Transcrição: …. Fala: …."
 */
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
  const r = resolveChatVoice(voiceLayers(chat.config.voice, persona), settings, provider)
  const refusal = callRefusal(r)
  if (refusal) return { reason: refusal, desktopOnly: false }
  // o que a chamada vai usar com o endereço/chave do provedor (blocos legíveis do celular)
  const eff = settingsWith(settings, voiceUse(r))
  const stt = resolveStt(eff.stt, provider)
  if ('block' in stt) return stt.block
  const tts = resolveTts(eff.tts, provider)
  if ('block' in tts) return tts.block
  return null
}

export class VoiceCallController {
  private view: CallView = INITIAL
  private listeners = new Set<() => void>()
  private readonly d: CallDeps
  readonly manager: VoiceCallManager
  /** Leitura ao vivo (o chat esmaece o que ainda não foi falado). */
  readonly follow = new VoiceFollow()
  private queue: UtteranceQueue | null = null
  private followTimer: ReturnType<typeof setInterval> | null = null
  private mic: MicSource | null = null
  private releaseWindow: (() => void) | null = null
  private offUsage: (() => void) | null = null
  // ---- sensor ----
  private level = new LevelGate()
  private gate: AdaptiveTurnGate | null = null
  private session: TranscribeSession | null = null
  private chain: Promise<void> = Promise.resolve()
  private speaking = false
  private preroll: Uint8Array[] = []
  private voiced = new VoicedSpan()
  /** Fala do usuário durante a reprodução: ducking → descartada (curta) × barge-in (insistiu). */
  private hold = new PlaybackDuck(DEFAULT_BARGE_IN)
  /** Frases da resposta atual que começaram a tocar (barge-in: o histórico fica só com elas). */
  private started = new Set<string>()
  private askedSeq = -1
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
      logEval: (e) =>
        this.d.log?.(
          `voice-eval filler#${e.variant} ${e.played ? 'tocou' : 'não tocou'} ${e.reason} (${e.latencyMs} ms)`
        ),
      // clipes da voz EFETIVA da chamada (a da persona/chat quando vale aqui) — sem clipe: o
      // preâmbulo não toca e a frase de ferramenta sai ao vivo (vendorado)
      clip: (cls, n) => {
        const v = this.settings()
        const tts = resolveTts(v.tts, this.d.provider)
        if ('block' in tts) return Promise.resolve(null)
        return loadCurrentClipAudio(
          this.d.clips,
          tts.settings,
          v.voiceCallDefaults.fillers.pool,
          cls,
          n,
          v.voiceCallDefaults.toolPhrases.pool,
          v.voiceCallDefaults.delayPhrases.thanksPool
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
      // settings RESOLVIDAS (endereço/família) da voz decidida para a chamada (a da persona/chat
      // quando vale aqui, senão as deste aparelho — `callUse`): o main decide se a voz interpreta
      // tags, sintetiza e classifica as falhas com ela
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
    // log de desenvolvimento (Metro): a fala por cima e o barge-in em palavras
    // (e as decisões das frases curtas: preâmbulo, demora, ferramenta)
    if (LOGGED_KINDS.has(e.kind) || (e.kind === 'decision' && e.class))
      this.d.log?.(
        `timeline ${e.kind}${e.class ? ` ${e.class}` : ''}${e.played != null ? (e.played ? ' tocou' : ' não tocou') : ''}${e.reason ? ` ${e.reason}` : ''}${e.speechMs != null ? ` voz=${e.speechMs}ms` : ''}${e.text ? ` “${e.text}”` : ''}`
      )
    const tl = [...this.view.timeline, e]
    this.set({ timeline: tl.length > 60 ? tl.slice(-60) : tl })
  }

  /** Voz decidida no início da chamada (vale a chamada inteira); null = sem chamada. */
  private callUse: VoiceUse | null = null

  /** As settings de voz DESTE aparelho (Configurações → Voz). */
  private deviceSettings(): VoiceSettings {
    return readVoiceSettings(this.d.setting, { activationDb: this.d.activationDb?.() })
  }

  /** As settings EFETIVAS: as daqui com a voz decidida para a chamada aplicada (fala/transcrição/idioma). */
  private settings(): VoiceSettings {
    return settingsWith(this.deviceSettings(), this.callUse)
  }

  private onState(state: VoiceCallState): void {
    const was = this.view.call.active
    this.set({
      call: state,
      error: state.error ?? (state.active ? null : this.view.error)
    })
    if (state.phase !== this.lastPhase) {
      this.lastPhase = state.phase
      // resposta nova: as frases ouvidas recomeçam do zero (e a leitura ao vivo também)
      if (state.phase === 'thinking' || state.phase === 'transcribing') {
        this.started = new Set()
        this.follow.reset()
      }
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
    const v = this.deviceSettings()
    const persona = this.d.personaVoice(chat.id)
    const ready = callReadiness(chat, v, this.d.provider, persona)
    if (ready) throw new Error(ready.reason)
    // a voz da persona/chat (ou a padrão daqui) é decidida AGORA para a chamada inteira
    const use = voiceUse(
      resolveChatVoice(voiceLayers(chat.config.voice, persona), v, this.d.provider)
    )
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
    this.callUse = use
    // o rabo do eco é da chamada anterior: a nova começa ouvindo
    this.lastPlaybackAt = 0
    this.follow.set({ sessionId, heard: [], current: null })
    const queue = new UtteranceQueue({
      backend: this.d.playback,
      // a fila esvaziou = o FIM da reprodução: o main conta daqui o silêncio das frases de espera
      // ("manter viva"/"obrigado por aguardar") e o desligamento armado pelo `end_call`
      onState: (st) => {
        this.set({ playing: st === 'playing' })
        if (st === 'idle') {
          this.lastPlaybackAt = this.now()
          this.manager.playbackIdle()
        }
      },
      onItem: ({ item, phase }) => {
        const sentence = (item.kind ?? 'sentence') === 'sentence'
        if (phase === 'start' && sentence) this.started.add(item.id)
        // leitura ao vivo: a frase tocando (o chat esmaece o que ainda não foi ouvido)
        if (sentence && item.text) {
          const text = item.text
          if (phase === 'start') this.follow.set({ current: { id: item.id, text, chars: 0 } })
          else
            this.follow.set((s) => ({
              heard: [...s.heard, text],
              current: s.current?.id === item.id ? null : s.current
            }))
        }
        this.pushTimeline({
          ts: this.now(),
          kind: sentence
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
        // clipe (preâmbulo/frase de espera/de ferramenta) não é essencial: pula com o registro; frase da
        // resposta que não toca encerra a chamada (nunca uma resposta muda)
        if (item.kind === 'filler' || item.kind === 'delay' || item.kind === 'tool') {
          const what =
            item.kind === 'filler'
              ? 'o preâmbulo'
              : item.kind === 'tool'
                ? 'a frase de ferramenta'
                : 'a frase de espera'
          this.set({ error: `Não foi possível tocar ${what}: ${reason}` })
          return
        }
        this.stop(`não foi possível tocar uma frase da resposta (${reason})`)
      }
    })
    this.queue = queue
    queue.setVolume(this.view.volume)
    // leitura ao vivo: quanto da frase atual já tocou (palavra por palavra, ~10×/s)
    this.followTimer = setInterval(() => {
      const cur = this.follow.get().current
      const pos = queue.currentPosition()
      if (!cur || !pos || pos.id !== cur.id) return
      const { chars } = heardChars(cur.text, pos.playedMs, { durationMs: pos.durationMs })
      if (chars !== cur.chars) this.follow.set({ current: { ...cur, chars } })
    }, FOLLOW_MS)
    try {
      this.manager.start(sessionId)
    } catch (e) {
      await this.teardown()
      throw e
    }
    this.offUsage = onSttApiUsage((u) => {
      if (this.manager.state().active) this.manager.noteSttApiUsage(u)
    })
    // especulação pela API (= desktop)
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
    // a leitura ao vivo para já (o chat volta ao render normal)
    if (this.followTimer) clearInterval(this.followTimer)
    this.followTimer = null
    this.follow.set({ sessionId: null, heard: [], current: null })
    await this.stopCapture()
    this.callUse = null
    this.queue?.cancel(FADE_MS)
    this.queue?.dispose()
    this.queue = null
    this.offUsage?.()
    this.offUsage = null
    const release = this.releaseWindow
    this.releaseWindow = null
    // o marcador de fim pode esperar o turno terminar: a janela fica mais um pouco
    if (release) setTimeout(release, 8000)
    this.set({ level: 0, playing: false, deaf: false, ducked: false })
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

  /** "Interromper": barge-in pelo botão (o histórico fica só com as palavras que tocaram). */
  interrupt(): void {
    if (!this.manager.state().active || !this.queue) return
    this.commitBargeIn(null)
  }

  clearError(): void {
    this.set({ error: null })
  }

  /**
   * Barge-in confirmado (o usuário insistiu falando por cima — `reason` — ou tocou em Interromper):
   * para a fala do assistente com fade; o main para o turno e deixa no histórico só o que foi OUVIDO
   * — as frases que começaram a tocar e, da que tocava, o prefixo em palavras pela posição do player.
   */
  private commitBargeIn(reason: BargeInReason | null): void {
    const q = this.queue
    // ANTES de cancelar: quanto da frase atual tocou
    const current = q?.currentPosition() ?? null
    q?.cancel(FADE_MS)
    q?.setDuck(1) // o que vier depois (o próximo turno) toca no volume normal
    this.follow.set({ current: null }) // o resto não ouvido vai para depois do "interrompido"
    this.manager.bargeIn({
      playedIds: [...this.started],
      ...(reason ? { reason, speechMs: Math.round(this.hold.voicedMs) } : {}),
      ...(current ? { current } : {})
    })
    // daqui em diante é uma fala normal do usuário: o fim de turno adaptativo volta a valer
    this.hold.reset()
    this.set({ ducked: false })
  }

  /**
   * O usuário parou de falar por cima antes de confirmar (tosse, "uhum", ruído): o volume volta (se
   * tinha abaixado) e o som curto é descartado (nenhum turno). Ruído curto que nem chegou ao onset
   * nunca abaixou nada — nada a devolver nem registrar.
   */
  private restoreDuck(): void {
    const ms = Math.round(this.hold.voicedMs)
    const ducked = this.hold.ducked
    this.hold.reset()
    if (ducked) this.queue?.setDuck(1, DUCK_FADE_MS)
    this.speaking = false
    this.preroll = []
    this.gate?.reset()
    this.dropSession()
    this.voiced.reset()
    this.setLive('', null)
    if (!ducked) return
    this.set({ ducked: false })
    this.pushTimeline({ ts: this.now(), kind: 'duck-restore', speechMs: ms })
    this.manager.backchannel({ ms })
  }

  /** A voz por cima passou do onset (voz sustentada): o áudio do assistente ABAIXA e continua. */
  private duckNow(): void {
    if (!this.queue) return
    this.queue.setDuck(this.hold.cfg.duckGain, DUCK_FADE_MS)
    this.set({ ducked: true })
    this.pushTimeline({ ts: this.now(), kind: 'duck', speechMs: Math.round(this.hold.voicedMs) })
  }

  /** Texto da fala atual chegando (parcial ao vivo): durante o ducking, palavras/"para" confirmam. */
  private onDuckText(text: string): void {
    if (!this.hold.open) return
    if (this.hold.transcript(text) === 'barge-in') this.commitBargeIn(this.hold.reason ?? 'words')
  }

  // ---------------- clipes (preâmbulos e frases de ferramenta, por voz) ----------------

  /**
   * As settings de uma voz para os clipes: a escolha de uma persona/chat (`VoiceTtsChoice`) sobre
   * as daqui, ou — sem escolha — a voz efetiva (a da chamada em andamento, ou a daqui).
   */
  private clipSettings(tts?: VoiceTtsChoice | null): VoiceSettings {
    return tts
      ? settingsWith(this.deviceSettings(), { tts, stt: null, language: null })
      : this.settings()
  }

  /** Estado dos clipes de uma voz (sem `tts`: a da chamada/a daqui). */
  async clipsOf(tts?: VoiceTtsChoice | null): Promise<CallView['clips']> {
    const v = this.clipSettings(tts)
    const r = resolveTts(v.tts, this.d.provider)
    if ('block' in r) return { state: 'unknown' }
    try {
      const s = await clipsStatus(
        this.d.clips,
        r.settings,
        v.voiceCallDefaults.fillers.pool,
        v.voiceCallDefaults.toolPhrases.pool,
        v.voiceCallDefaults.delayPhrases.thanksPool
      )
      const missing = (Object.keys(s.byClass) as ClipClass[]).filter(
        (c) => s.byClass[c].ready < s.byClass[c].total
      )
      return {
        state: missing.length ? 'missing' : 'ok',
        done: s.ready,
        total: s.total,
        missing
      }
    } catch {
      return { state: 'unknown' }
    }
  }

  async refreshClips(): Promise<void> {
    this.set({ clips: await this.clipsOf() })
  }

  /**
   * "Gerar clipes" (só com o clique — uma API paga): sintetiza os preâmbulos, as frases de
   * ferramenta e os agradecimentos de uma voz — a da chamada/a daqui, ou a escolha de uma persona/chat (`tts` —
   * "Gerar clipes desta voz"). Progresso em `onProgress` (e no `clips` da tela sem `tts`).
   */
  async generateClips(
    tts?: VoiceTtsChoice | null,
    onProgress?: (done: number, total: number) => void
  ): Promise<void> {
    const v = this.clipSettings(tts)
    const r = resolveTts(v.tts, this.d.provider)
    if ('block' in r) throw new Error(r.block.reason)
    const mine = !tts
    if (mine) this.set({ clips: { state: 'generating', done: 0, total: 0 } })
    try {
      await generateClips({
        store: this.d.clips,
        settings: r.settings,
        fillerPool: v.voiceCallDefaults.fillers.pool,
        toolPool: v.voiceCallDefaults.toolPhrases.pool,
        thanksPool: v.voiceCallDefaults.delayPhrases.thanksPool,
        synth: (text, signal) => synthesizeBlock({ text, settings: r.settings }, { signal }),
        onProgress: (done, total) => {
          onProgress?.(done, total)
          if (mine) this.set({ clips: { state: 'generating', done, total } })
        }
      })
    } finally {
      if (mine) await this.refreshClips()
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
    // fala detectada pela MESMA regra do portão do STT (`LevelGate`: nível de ativação deste
    // aparelho + piso de ruído adaptativo): os quadros viram 1 (fala) / 0 (não) antes do gate de
    // turno, do tempo com voz e do ducking — ruído de sala abaixo da ativação nunca abaixa a
    // resposta nem abre um turno
    this.level = new LevelGate({ activationDb: this.d.activationDb?.() })
    this.gate = new AdaptiveTurnGate(timing, SPEECH)
    // limiares do ducking/barge-in (`voiceCallDefaults.turn`, resolvidos no início da chamada)
    this.hold = new PlaybackDuck(timing.bargeIn ?? DEFAULT_BARGE_IN)
    this.voiced = new VoicedSpan()
    this.speaking = false
    this.preroll = []
    this.askedSeq = -1
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
    this.queue?.setDuck(1)
    this.gate = null
    this.dropSession()
    if (this.view.ducked) this.set({ ducked: false })
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
    if (!this.gate) return
    const deaf = this.isDeaf()
    if (deaf !== this.view.deaf) this.set({ deaf })
    this.set({ level: deaf ? 0 : f.rms })
    // surdo (meia-duplex): o quadro conta como silêncio e não ensina o piso de ruído
    this.onVoiced(deaf ? 0 : this.level.pushRms(f.rms, f.ms || FRAME_MS) ? VOICED : 0)
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
    const v = this.settings()
    const stt = resolveStt(v.stt, this.d.provider)
    if ('block' in stt) {
      this.set({ error: stt.block.reason })
      return null
    }
    const session: TranscribeSession = new TranscribeSession({
      settings: stt.settings,
      language: v.audioInput.language,
      activationDb: v.audioInput.activationDb,
      // parciais ao vivo (custam requests — `livePartials`, como no desktop): o texto da fala na
      // barra e, falando por cima da resposta, as palavras que confirmam o barge-in
      partials: v.stt.livePartials,
      onPartial: (e) => {
        if (this.session !== session || (e.error && !e.text)) return
        const text = typeof e.text === 'string' ? e.text : ''
        if (this.speaking) this.setLive(text, 'partial')
        this.onDuckText(text)
      },
      ...(this.d.fetch ? { fetch: this.d.fetch } : {})
    })
    this.session = session
    return session
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

  /** Fecha a fala (silêncio cumprido): fala por cima descartada, ou transcrição final → turno. */
  private closeUtterance(): void {
    const gate = this.gate
    if (!gate) return
    if (this.hold.open) {
      // a fala por cima acabou sem confirmar o barge-in: volume de volta, som descartado
      this.restoreDuck()
      return
    }
    this.speaking = false
    this.preroll = []
    // a especulação pedida nesta pausa cobre toda a fala (o usuário não voltou a falar): ela vira
    // a final — MESMO ainda em voo
    this.endUtterance(this.askedSeq === gate.specSeq && this.askedSeq > 0, this.voiced.spanMs)
    this.voiced.reset()
  }

  /** Pausa cruzou ~250 ms: transcrição especulativa → veredito. */
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
    if (text != null) this.setLive(text, 'speculative')
    this.pushTimeline({
      ts: this.now(),
      kind: 'turn-verdict',
      pauseMs: gate.pauseMs,
      text: (text ?? '').slice(-80),
      reason: end
    })
    if (gate.setVerdict(seq, end) === 'end') this.closeUtterance()
  }

  /** Um quadro já classificado (1 = fala pelo `LevelGate`, 0 = não) — = `onLevel` do desktop. */
  private onVoiced(rms: number): void {
    const gate = this.gate
    if (!gate) return
    const ev = gate.push(rms, FRAME_MS)
    // tempo com voz da fala: zera no início dela e mede só enquanto ela está aberta (o silêncio do
    // fim fica de fora — o span termina no último quadro com voz)
    if (ev === 'start') this.voiced.reset()
    if (ev === 'start' || this.speaking) this.voiced.push(rms, FRAME_MS, SPEECH)
    if (ev === 'resume') this.askedSeq = -1 // a especulação ficou velha (a fala continuou)
    if (ev === 'start') {
      const queue = this.queue
      const cur = queue?.current ?? null
      const sentencePlaying = !!cur && (cur.kind ?? 'sentence') === 'sentence'
      const mainSpeaking = this.manager.state().phase === 'speaking'
      const heard = this.started.size > 0
      if (queue && (sentencePlaying || (heard && mainSpeaking))) {
        // fala do usuário durante a resposta já ouvida: o episódio abre SEM mexer no volume — o
        // áudio do assistente só ABAIXA depois do onset (voz sustentada, `turn.duckOnsetMs`; ruído
        // curto nunca) e nada é cancelado até o usuário insistir — voz/palavras/"para"
        if (this.hold.start(rms, FRAME_MS, SPEECH) === 'duck') this.duckNow()
      } else {
        // nada da resposta foi ouvido (só preâmbulo/frase de demora, ou frases ainda na fila):
        // tudo sai com fade e o main decide o turno continuado
        const dropped = queue ? [...(cur ? [cur.id] : []), ...queue.queuedIds] : []
        if (dropped.length) queue?.cancel(FADE_MS)
        this.manager.speechBegin({ dropped })
      }
      // fala nova: a parcial/especulação da fala anterior não vale mais
      this.askedSeq = -1
      this.setLive('', null)
      this.speaking = true
      const session = this.ensureSession()
      for (const b of this.preroll.splice(0)) session?.push(b)
      return
    }
    if (ev === 'speculate') {
      // fala retida durante a reprodução (ducking): sem especulação — silêncio fixo
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
      const e = this.hold.frame(rms, FRAME_MS, SPEECH)
      if (e === 'duck') this.duckNow()
      else if (e === 'barge-in') this.commitBargeIn(this.hold.reason ?? 'voiced')
      else if (e === 'restore') this.restoreDuck()
    }
  }
}

export type { ChatConfig }
