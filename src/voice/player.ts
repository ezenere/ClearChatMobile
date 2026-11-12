// Fila de reprodução da chamada de voz no celular — o papel do `UtteranceQueue` do renderer do
// desktop (src/renderer/src/lib/voice/utteranceQueue.ts, Web Audio/`<audio>`): toca as utterances
// (frases da resposta, preâmbulo, frases de demora) NA ORDEM, sem sobreposição, estados
// `idle`/`playing`, `drop(id)`/`cancel()` com fade curto, volume, o **ducking** (`setDuck` — o
// usuário fala por cima: a voz do assistente abaixa numa rampa e continua tocando) e a posição da
// frase tocando (`currentPosition` — o "ouvido" em palavras do barge-in e a leitura ao vivo). O
// player é injetável (no aparelho, `expo-audio` — `src/voice/nativeAudio.ts`; nos testes, um falso
// com a duração do WAV). PCM cru (`audio/pcm;rate=N`, ElevenLabs) vira WAV antes de tocar. Sem
// streaming dentro da frase: cada frase chega com os bytes completos (trade-off documentado no
// README — o expo-audio não toca PCM progressivo). Sem React Native.
import { audioDurationMs } from '@shared/voiceCallMarks'
import { encodeWav, parsePcmContentType, Pcm16MonoAligner } from '@vendor/desktop/voice/wav'

export interface Utterance {
  id: string
  audio: Uint8Array
  mime: string
  /** Origem (ausente = 'sentence'). */
  kind?: 'sentence' | 'filler' | 'delay'
  /** Sentença da resposta: o texto dela (a leitura ao vivo esmaece o que ainda não tocou). */
  text?: string
}

export interface PlaybackHandle {
  /** Resolve quando termina de tocar (ou é parado); rejeita numa falha de reprodução. */
  done: Promise<void>
  stop(fadeMs?: number): void
  setVolume(v: number): void
  /**
   * Quanto já tocou (ms) e a duração total quando o player a conhece (null = ainda não). Ausente =
   * o player não informa (a fila estima pelo relógio desde o início).
   */
  position?(): { playedMs: number; durationMs: number | null }
}

export interface PlaybackBackend {
  /** Começa a tocar (bytes completos, wav/mp3). */
  play(audio: Uint8Array, mime: string, volume: number): Promise<PlaybackHandle>
}

export type UtteranceState = 'idle' | 'playing'

export interface UtteranceQueueOptions {
  backend: PlaybackBackend
  onState?: (s: UtteranceState) => void
  onItem?: (e: { item: Utterance; phase: 'start' | 'end' }) => void
  onError?: (e: { item: Utterance; reason: string }) => void
  /** Relógio (testes). */
  now?: () => number
}

/** Passo da rampa do ducking (ms) — o volume do `AudioPlayer` muda a cada passo. */
export const DUCK_STEP_MS = 16

/** `audio/pcm;rate=N` → WAV; o resto como veio. */
export function playableAudio(u: Pick<Utterance, 'audio' | 'mime'>): {
  audio: Uint8Array
  mime: string
} {
  const pcm = parsePcmContentType(u.mime)
  if (!pcm) return { audio: u.audio, mime: u.mime }
  return {
    audio: encodeWav(new Pcm16MonoAligner(pcm.channels).push(u.audio), pcm.sampleRate),
    mime: 'audio/wav'
  }
}

interface Slot {
  item: Utterance
  handle: PlaybackHandle | null
  stopped: boolean
  /** Início da reprodução (relógio da fila) e a duração pelos bytes (WAV/PCM; mp3 = null). */
  startedAt: number
  bytesMs: number | null
}

export class UtteranceQueue {
  private queue: Utterance[] = []
  private cur: Slot | null = null
  private vol = 1
  private duckGain = 1
  private duckTimer: ReturnType<typeof setInterval> | null = null
  private st: UtteranceState = 'idle'
  private gen = 0
  private readonly o: UtteranceQueueOptions

  constructor(o: UtteranceQueueOptions) {
    this.o = o
  }

  private now(): number {
    return this.o.now?.() ?? Date.now()
  }

  get state(): UtteranceState {
    return this.st
  }
  get current(): Utterance | null {
    return this.cur?.item ?? null
  }
  get queuedIds(): string[] {
    return this.queue.map((u) => u.id)
  }
  get volume(): number {
    return this.vol
  }
  /** Fator do ducking atual (1 = normal). */
  get duck(): number {
    return this.duckGain
  }

  /**
   * Posição da utterance tocando agora: quanto já tocou e a duração total quando conhecida (o
   * barge-in em palavras e a leitura ao vivo). null = nada tocando (ou ainda não começou).
   */
  currentPosition(): { id: string; playedMs: number; durationMs: number | null } | null {
    const c = this.cur
    if (!c?.handle || c.stopped) return null
    const p = c.handle.position?.() ?? null
    const durationMs = p?.durationMs ?? c.bytesMs
    const played = p ? p.playedMs : this.now() - c.startedAt
    return {
      id: c.item.id,
      playedMs: Math.max(0, Math.round(durationMs != null ? Math.min(played, durationMs) : played)),
      durationMs: durationMs != null ? Math.round(durationMs) : null
    }
  }

  setVolume(v: number): void {
    this.vol = Math.min(1, Math.max(0, Number.isFinite(v) ? v : 1))
    this.applyVolume()
  }

  /**
   * Ducking (barge-in com histerese): o áudio do assistente vai ao fator `gain` (0..1; 1 = volta ao
   * normal) numa rampa linear de `fadeMs` e CONTINUA tocando — vale para o que toca e para o que
   * vier depois, até o próximo `setDuck`. `fadeMs` 0 = na hora (= `UtteranceQueue.setDuck` do
   * desktop).
   */
  setDuck(gain: number, fadeMs = 0): void {
    const target = Number.isFinite(gain) ? Math.min(1, Math.max(0, gain)) : 1
    if (this.duckTimer) clearInterval(this.duckTimer)
    this.duckTimer = null
    const from = this.duckGain
    if (!(fadeMs > 0) || from === target) {
      this.duckGain = target
      this.applyVolume()
      return
    }
    const steps = Math.max(1, Math.round(fadeMs / DUCK_STEP_MS))
    let i = 0
    this.duckTimer = setInterval(() => {
      i++
      this.duckGain = from + (target - from) * Math.min(1, i / steps)
      this.applyVolume()
      if (i >= steps && this.duckTimer) {
        clearInterval(this.duckTimer)
        this.duckTimer = null
      }
    }, fadeMs / steps)
  }

  private applyVolume(): void {
    const c = this.cur
    if (c?.handle && !c.stopped) c.handle.setVolume(this.vol * this.duckGain)
  }

  enqueue(u: Utterance): void {
    this.queue.push(u)
    if (!this.cur) void this.next()
  }

  private setState(s: UtteranceState): void {
    if (this.st === s) return
    this.st = s
    this.o.onState?.(s)
  }

  private async next(): Promise<void> {
    const item = this.queue.shift()
    if (!item) {
      this.cur = null
      this.setState('idle')
      return
    }
    const gen = ++this.gen
    const slot: Slot = { item, handle: null, stopped: false, startedAt: this.now(), bytesMs: null }
    this.cur = slot
    this.setState('playing')
    let failed: string | null = null
    try {
      const { audio, mime } = playableAudio(item)
      slot.bytesMs = audioDurationMs(audio, mime)
      const handle = await this.o.backend.play(audio, mime, this.vol * this.duckGain)
      if (slot.stopped) handle.stop(0)
      else {
        slot.handle = handle
        slot.startedAt = this.now()
        // o ducking pode ter mudado enquanto o arquivo abria
        handle.setVolume(this.vol * this.duckGain)
        this.o.onItem?.({ item, phase: 'start' })
        await handle.done
      }
    } catch (e) {
      failed = e instanceof Error ? e.message : String(e)
    }
    if (failed && !slot.stopped) this.o.onError?.({ item, reason: failed })
    else if (slot.handle) this.o.onItem?.({ item, phase: 'end' })
    if (gen !== this.gen) return // cancelado: quem cancelou já seguiu
    void this.next()
  }

  /** Para a atual e descarta a fila (barge-in / fim da chamada). */
  cancel(fadeMs = 0): void {
    this.queue = []
    const c = this.cur
    if (c) {
      c.stopped = true
      c.handle?.stop(fadeMs)
    }
    this.gen++
    this.cur = null
    this.setState('idle')
  }

  /** Tira uma utterance (a atual com fade, ou da fila). */
  drop(id: string, fadeMs = 0): void {
    this.queue = this.queue.filter((u) => u.id !== id)
    const c = this.cur
    if (c && c.item.id === id) {
      c.stopped = true
      c.handle?.stop(fadeMs)
      // a `next` em andamento segue para a próxima quando o `done` resolver
    }
  }

  /** Solta o timer da rampa (fim da chamada). */
  dispose(): void {
    if (this.duckTimer) clearInterval(this.duckTimer)
    this.duckTimer = null
  }
}
