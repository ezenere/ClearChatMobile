// Entrada de áudio da voz (ditado e chamada), sem React Native: a fonte entrega quadros PCM16 mono
// 16 kHz de ~32 ms com o RMS de cada um (o "sensor" do desktop trabalha com quadros de ~33 ms —
// `FRAME_MS` do useVoiceCall). Duas fontes:
// - nativa (`src/voice/nativeAudio.ts`): o microfone pelo `AudioStream` do expo-audio;
// - de teste (`FakeMicSource`, só em desenvolvimento/testes): toca um WAV (fixture gerado
//   localmente) em tempo real como se fosse o microfone e depois silêncio — os testes e o E2E
//   NUNCA abrem o microfone real.
import { floatToPcm16, frameRms, resampleMono } from '@vendor/renderer/audio/pcm'

export const MIC_SAMPLE_RATE = 16_000
/** Amostras por quadro (512 a 16 kHz = 32 ms). */
export const FRAME_SAMPLES = 512
export const FRAME_MS = (FRAME_SAMPLES / MIC_SAMPLE_RATE) * 1000

export interface MicFrame {
  /** PCM16 LE mono 16 kHz. */
  pcm: Int16Array
  /** RMS do quadro (0..1). */
  rms: number
  /** Duração (ms). */
  ms: number
}

export interface MicSource {
  readonly kind: 'native' | 'fake'
  /** Abre a captura (o chamador já tem a permissão). Erro legível em pt-BR. */
  start(onFrame: (f: MicFrame) => void, onError?: (e: Error) => void): Promise<void>
  stop(): Promise<void>
}

/** Junta amostras float de qualquer taxa em quadros de 32 ms a 16 kHz. */
export class FrameAssembler {
  private rest = new Float32Array(0)
  constructor(private readonly emit: (f: MicFrame) => void) {}

  push(samples: Float32Array, rate: number): void {
    const s = rate === MIC_SAMPLE_RATE ? samples : resampleMono(samples, rate, MIC_SAMPLE_RATE)
    let buf: Float32Array
    if (this.rest.length) {
      buf = new Float32Array(this.rest.length + s.length)
      buf.set(this.rest)
      buf.set(s, this.rest.length)
    } else buf = s
    let o = 0
    while (buf.length - o >= FRAME_SAMPLES) {
      const frame = buf.subarray(o, o + FRAME_SAMPLES)
      this.emit({ pcm: floatToPcm16(frame), rms: frameRms(frame), ms: FRAME_MS })
      o += FRAME_SAMPLES
    }
    this.rest = buf.slice(o)
  }

  reset(): void {
    this.rest = new Float32Array(0)
  }
}

/** Bytes LE de um Int16Array (para a sessão de transcrição). */
export const pcmBytes = (pcm: Int16Array): Uint8Array =>
  new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)

/**
 * Lê um WAV PCM (16 bits ou float 32, mono ou estéreo — mixado) → amostras float mono + taxa.
 * Erro legível para outros formatos.
 */
export function decodeWav(bytes: Uint8Array): { samples: Float32Array; rate: number } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (o: number) => String.fromCharCode(...bytes.subarray(o, o + 4))
  if (bytes.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('não é um WAV')
  let o = 12
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null
  while (o + 8 <= bytes.length) {
    const id = tag(o)
    const size = dv.getUint32(o + 4, true)
    const body = o + 8
    if (id === 'fmt ') {
      fmt = {
        format: dv.getUint16(body, true),
        channels: dv.getUint16(body + 2, true),
        rate: dv.getUint32(body + 4, true),
        bits: dv.getUint16(body + 14, true)
      }
    } else if (id === 'data') {
      if (!fmt) throw new Error('WAV sem cabeçalho fmt')
      const end = Math.min(bytes.length, body + size)
      const { format, channels, rate, bits } = fmt
      const float = format === 3 || (format === 0xfffe && bits === 32)
      const bps = bits / 8
      const frames = Math.floor((end - body) / (bps * channels))
      const out = new Float32Array(frames)
      for (let i = 0; i < frames; i++) {
        let acc = 0
        for (let c = 0; c < channels; c++) {
          const p = body + (i * channels + c) * bps
          acc +=
            bits === 16
              ? dv.getInt16(p, true) / 32768
              : float && bits === 32
                ? dv.getFloat32(p, true)
                : bits === 8
                  ? (dv.getUint8(p) - 128) / 128
                  : 0
        }
        out[i] = acc / channels
      }
      if (!(bits === 16 || bits === 8 || (float && bits === 32)))
        throw new Error(`WAV com ${bits} bits não suportado`)
      return { samples: out, rate }
    }
    o = body + size + (size % 2)
  }
  throw new Error('WAV sem dados')
}

/**
 * "Microfone" de teste: toca as amostras em tempo real (um quadro a cada 32 ms) e depois silêncio
 * contínuo (ou para, com `loop: false` e `tailMs`). Só para desenvolvimento/testes — o app só usa
 * com o interruptor de desenvolvimento ligado (`EXPO_PUBLIC_CLEARCHAT_FAKE_MIC` ou o deep link
 * `clearchat://dev/fakemic`).
 */
export class FakeMicSource implements MicSource {
  readonly kind = 'fake' as const
  private timer: ReturnType<typeof setInterval> | null = null
  private pos = 0
  private frames: Float32Array

  constructor(
    samples: Float32Array,
    rate: number,
    private readonly opts: { frameMs?: number; silenceAfter?: boolean } = {}
  ) {
    this.frames = rate === MIC_SAMPLE_RATE ? samples : resampleMono(samples, rate, MIC_SAMPLE_RATE)
  }

  static fromWav(bytes: Uint8Array, opts?: { frameMs?: number }): FakeMicSource {
    const { samples, rate } = decodeWav(bytes)
    return new FakeMicSource(samples, rate, opts)
  }

  async start(onFrame: (f: MicFrame) => void): Promise<void> {
    await this.stop()
    this.pos = 0
    const asm = new FrameAssembler(onFrame)
    const tick = () => {
      const slice =
        this.pos < this.frames.length
          ? this.frames.subarray(this.pos, this.pos + FRAME_SAMPLES)
          : new Float32Array(FRAME_SAMPLES)
      this.pos += FRAME_SAMPLES
      const frame =
        slice.length === FRAME_SAMPLES
          ? slice
          : (() => {
              const f = new Float32Array(FRAME_SAMPLES)
              f.set(slice)
              return f
            })()
      asm.push(frame, MIC_SAMPLE_RATE)
    }
    this.timer = setInterval(tick, this.opts.frameMs ?? FRAME_MS)
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
