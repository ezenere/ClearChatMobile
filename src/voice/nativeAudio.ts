// Áudio no aparelho (expo-audio): o microfone pelo `AudioStream` (PCM float32 em tempo real; a
// fonte nativa é a MIC do Android, sem cancelamento de eco — ver `call.ts`), a reprodução das
// utterances por `AudioPlayer` (um arquivo WAV/MP3 temporário por frase), a permissão do microfone
// (texto do diálogo em pt-BR no app.json) e o cache dos clipes em `Documents/voice-clips/`.
import { Directory, File, Paths } from 'expo-file-system'
import {
  AudioModule,
  createAudioPlayer,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  type AudioStatus,
  type AudioStreamBuffer
} from 'expo-audio'
import type { ClipStore } from './clips'
import { FrameAssembler, MIC_SAMPLE_RATE, type MicFrame, type MicSource } from './mic'
import type { PlaybackBackend, PlaybackHandle } from './player'

const dlog = (m: string): void => {
  if (__DEV__) console.log(`[clearchat:voice] ${m}`)
}

let modeSet: Promise<void> | null = null
/** Sessão de áudio: grava e toca juntos (iOS: playAndRecord, alto-falante), toca no silencioso. */
export function ensureAudioMode(): Promise<void> {
  modeSet ??= setAudioModeAsync({
    allowsRecording: true,
    playsInSilentMode: true,
    shouldPlayInBackground: false,
    shouldRouteThroughEarpiece: false,
    interruptionMode: 'duckOthers'
  }).catch((e) => {
    modeSet = null
    throw e
  })
  return modeSet
}

/** Diálogo do sistema na primeira vez; depois, o estado guardado. false = negada. */
export async function requestMicPermission(): Promise<boolean> {
  const r = await requestRecordingPermissionsAsync()
  dlog(`permissão do microfone: ${r.status}`)
  return r.granted
}

type NativeStream = {
  start(): Promise<void>
  stop(): void
  release(): void
  readonly sampleRate: number
  addListener(event: 'audioStreamBuffer', fn: (b: AudioStreamBuffer) => void): { remove(): void }
}

/** Microfone real (só quando o usuário toca no microfone/na chamada). */
export class NativeMicSource implements MicSource {
  readonly kind = 'native' as const
  private stream: NativeStream | null = null
  private sub: { remove(): void } | null = null

  async start(onFrame: (f: MicFrame) => void, onError?: (e: Error) => void): Promise<void> {
    await this.stop()
    await ensureAudioMode()
    const Ctor = (AudioModule as unknown as { AudioStream: new (o: object) => NativeStream })
      .AudioStream
    const stream = new Ctor({ sampleRate: MIC_SAMPLE_RATE, channels: 1, encoding: 'float32' })
    const asm = new FrameAssembler(onFrame)
    let first = true
    this.sub = stream.addListener('audioStreamBuffer', (b) => {
      if (first) {
        first = false
        dlog(`microfone: 1º buffer ${b.sampleRate} Hz × ${b.channels}`)
      }
      try {
        const samples = new Float32Array(b.data)
        if (b.channels > 1) {
          const mono = new Float32Array(Math.floor(samples.length / b.channels))
          for (let i = 0; i < mono.length; i++) {
            let acc = 0
            for (let c = 0; c < b.channels; c++) acc += samples[i * b.channels + c]
            mono[i] = acc / b.channels
          }
          asm.push(mono, b.sampleRate)
        } else asm.push(samples, b.sampleRate)
      } catch (e) {
        onError?.(e instanceof Error ? e : new Error(String(e)))
      }
    })
    this.stream = stream
    try {
      dlog('microfone: abrindo (AudioStream)')
      await stream.start()
      dlog('microfone: aberto')
    } catch (e) {
      dlog(`microfone: falhou ${e instanceof Error ? e.message : String(e)}`)
      await this.stop()
      const msg = e instanceof Error ? e.message : String(e)
      throw new Error(
        /held by another app|in use/i.test(msg)
          ? 'NotReadableError: o microfone está em uso por outro aplicativo'
          : msg
      )
    }
  }

  async stop(): Promise<void> {
    this.sub?.remove()
    this.sub = null
    const s = this.stream
    this.stream = null
    if (!s) return
    try {
      s.stop()
    } finally {
      s.release()
    }
  }
}

let seq = 0
const extOf = (mime: string): string =>
  /mpeg|mp3/i.test(mime)
    ? 'mp3'
    : /ogg|opus/i.test(mime)
      ? 'ogg'
      : /aac|mp4|m4a/i.test(mime)
        ? 'm4a'
        : 'wav'

/** Reprodução por `AudioPlayer` (arquivo temporário no cache, apagado ao terminar). */
export const expoPlayback: PlaybackBackend = {
  async play(audio, mime, volume) {
    await ensureAudioMode()
    const file = new File(Paths.cache, `voz-${Date.now().toString(36)}-${++seq}.${extOf(mime)}`)
    file.create({ overwrite: true })
    file.write(audio)
    const player = createAudioPlayer({ uri: file.uri }, { updateInterval: 100 })
    player.volume = Math.min(1, Math.max(0, volume))
    let finished = false
    let resolveDone!: () => void
    let rejectDone!: (e: Error) => void
    const done = new Promise<void>((res, rej) => {
      resolveDone = res
      rejectDone = rej
    })
    const cleanup = () => {
      if (finished) return
      finished = true
      sub.remove()
      try {
        player.remove()
      } catch {
        /* já liberado */
      }
      try {
        file.delete()
      } catch {
        /* temporário */
      }
    }
    const sub = player.addListener('playbackStatusUpdate', (st: AudioStatus) => {
      if (st.didJustFinish) {
        dlog(`fim ${file.name} (${Math.round(st.duration * 1000)} ms)`)
        cleanup()
        resolveDone()
      } else if (st.playbackState === 'error' || (st as { error?: string }).error) {
        dlog(`erro ${file.name}: ${(st as { error?: string }).error ?? st.playbackState}`)
        cleanup()
        rejectDone(new Error((st as { error?: string }).error ?? 'falha ao tocar o áudio'))
      }
    })
    player.play()
    dlog(`tocando ${file.name} (${audio.length} bytes, volume ${volume.toFixed(2)})`)
    const handle: PlaybackHandle = {
      done,
      setVolume: (v) => {
        if (!finished) player.volume = Math.min(1, Math.max(0, v))
      },
      // posição do `AudioPlayer` (s): o "ouvido" em palavras do barge-in e a leitura ao vivo
      position: () => {
        if (finished) return { playedMs: 0, durationMs: null }
        const t = player.currentTime
        const d = player.duration
        return {
          playedMs: Number.isFinite(t) && t > 0 ? t * 1000 : 0,
          durationMs: Number.isFinite(d) && d > 0 ? d * 1000 : null
        }
      },
      stop: (fadeMs = 0) => {
        if (finished) return
        if (fadeMs <= 0) {
          player.pause()
          cleanup()
          resolveDone()
          return
        }
        const start = player.volume
        const steps = Math.max(1, Math.round(fadeMs / 20))
        let i = 0
        const t = setInterval(() => {
          i++
          if (finished) return clearInterval(t)
          player.volume = Math.max(0, start * (1 - i / steps))
          if (i >= steps) {
            clearInterval(t)
            player.pause()
            cleanup()
            resolveDone()
          }
        }, 20)
      }
    }
    return handle
  }
}

/** Cache dos clipes dos preâmbulos (derivado; regerado em cada aparelho — §4.4). */
export function fileClipStore(): ClipStore {
  const dir = new Directory(Paths.document, 'voice-clips')
  const fileOf = (key: string) => new File(dir, `${key.replace(/[^A-Za-z0-9_-]/g, '_')}.bin`)
  return {
    async read(key) {
      const f = fileOf(key)
      if (!f.exists) return null
      const bytes = await f.bytes()
      // 1º byte = tamanho do mime; depois o mime; depois o áudio
      const n = bytes[0]
      return {
        mime: new TextDecoder().decode(bytes.subarray(1, 1 + n)),
        audio: bytes.subarray(1 + n)
      }
    },
    async write(key, clip) {
      if (!dir.exists) dir.create({ intermediates: true })
      const mime = new TextEncoder().encode(clip.mime.slice(0, 200))
      const out = new Uint8Array(1 + mime.length + clip.audio.length)
      out[0] = mime.length
      out.set(mime, 1)
      out.set(clip.audio, 1 + mime.length)
      const f = fileOf(key)
      f.create({ overwrite: true })
      f.write(out)
    },
    async prune(keep) {
      if (!dir.exists) return
      const names = new Set(keep.map((k) => `${k.replace(/[^A-Za-z0-9_-]/g, '_')}.bin`))
      for (const e of dir.list()) if (e instanceof File && !names.has(e.name)) e.delete()
    }
  }
}
