// Fila de reprodução da chamada de voz no celular — o papel do `UtteranceQueue` do renderer do
// desktop (src/renderer/src/lib/voice/utteranceQueue.ts, Web Audio/`<audio>`): toca as utterances
// (frases da resposta, preâmbulo, interjeições, frases de demora) NA ORDEM, sem sobreposição,
// estados `idle`/`playing`, `drop(id)`/`cancel()` com fade curto, volume e o ganho relativo de
// cada utterance. O player é injetável (no aparelho, `expo-audio` — `src/voice/nativeAudio.ts`;
// nos testes, um falso com a duração do WAV). PCM cru (`audio/pcm;rate=N`, ElevenLabs) vira WAV
// antes de tocar. Sem streaming dentro da frase: cada frase chega com os bytes completos (trade-off
// documentado no README — o expo-audio não toca PCM progressivo). Sem React Native.
import { encodeWav, parsePcmContentType, Pcm16MonoAligner } from '@vendor/desktop/voice/wav'

export interface Utterance {
  id: string
  audio: Uint8Array
  mime: string
  kind?: 'sentence' | 'filler' | 'interjection' | 'delay'
  gain?: number
}

export interface PlaybackHandle {
  /** Resolve quando termina de tocar (ou é parado); rejeita numa falha de reprodução. */
  done: Promise<void>
  stop(fadeMs?: number): void
  setVolume(v: number): void
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
}

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

export class UtteranceQueue {
  private queue: Utterance[] = []
  private cur: { item: Utterance; handle: PlaybackHandle | null; stopped: boolean } | null = null
  private vol = 1
  private st: UtteranceState = 'idle'
  private gen = 0
  private readonly o: UtteranceQueueOptions

  constructor(o: UtteranceQueueOptions) {
    this.o = o
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

  setVolume(v: number): void {
    this.vol = Math.min(1, Math.max(0, Number.isFinite(v) ? v : 1))
    const c = this.cur
    if (c?.handle) c.handle.setVolume(this.vol * (c.item.gain ?? 1))
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
    const slot: { item: Utterance; handle: PlaybackHandle | null; stopped: boolean } = {
      item,
      handle: null,
      stopped: false
    }
    this.cur = slot
    this.setState('playing')
    let failed: string | null = null
    try {
      const { audio, mime } = playableAudio(item)
      const handle = await this.o.backend.play(audio, mime, this.vol * (item.gain ?? 1))
      if (slot.stopped) handle.stop(0)
      else {
        slot.handle = handle
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
}
