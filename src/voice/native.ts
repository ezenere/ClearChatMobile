// Instância da voz no aparelho (chamada + ditado) e o "microfone de teste" de desenvolvimento.
//
// Microfone de teste (SÓ em build de desenvolvimento — nunca em produção): ligado pela variável
// `EXPO_PUBLIC_CLEARCHAT_FAKE_MIC=1` ou pelo deep link `clearchat://dev/fakemic?on=1` (guardado no
// kv deste aparelho; `?on=0` desliga). Com ele, a captura NÃO abre o microfone: emite silêncio e
// toca os WAVs injetados por `clearchat://dev/fakemic?play=<url de um .wav>` (fixtures gerados
// localmente, servidos pelo provedor falso) — o E2E dita e conversa sem microfone real.
import { AppState } from 'react-native'
import { Storage } from 'expo-sqlite/kv-store'
import { store } from '@/data/native'
import { hostStack } from '@/host/native'
import {
  decodeWav,
  FRAME_MS,
  FRAME_SAMPLES,
  FrameAssembler,
  MIC_SAMPLE_RATE,
  type MicFrame,
  type MicSource
} from './mic'
import { expoPlayback, fileClipStore, NativeMicSource, requestMicPermission } from './nativeAudio'
import { createVoiceStack } from './stack'
import { resampleMono } from '@vendor/renderer/audio/pcm'

const FAKE_KEY = 'dev.fakeMic'
const POLL_KEY = 'dev.fakeMicPoll'
const BARGE_KEY = 'voice.bargeIn'

/** Microfone de teste ligado (só em desenvolvimento). */
export function fakeMicEnabled(): boolean {
  if (!__DEV__) return false
  if (process.env.EXPO_PUBLIC_CLEARCHAT_FAKE_MIC === '1') return true
  try {
    return Storage.getItemSync(FAKE_KEY) === '1'
  } catch {
    return false
  }
}

export function setFakeMicEnabled(on: boolean): void {
  if (!__DEV__) return
  Storage.setItemSync(FAKE_KEY, on ? '1' : '0')
}

/**
 * Base de um servidor de teste que entrega WAVs para o microfone (`GET <base>/mic/next`, 204 =
 * nada). Assim o E2E injeta fala SEM abrir um deep link (o Android pausa a Activity ao entregar o
 * intent — o app trataria como segundo plano e encerraria a chamada/ditado).
 */
export function setFakeMicPoll(base: string | null): void {
  if (!__DEV__) return
  Storage.setItemSync(POLL_KEY, base ?? '')
}
const fakeMicPoll = (): string => {
  try {
    return Storage.getItemSync(POLL_KEY) ?? ''
  } catch {
    return ''
  }
}

/** "Interromper falando" (com fone): opção deste aparelho (§4.4 — não sincroniza). */
export function bargeInEnabled(): boolean {
  try {
    return Storage.getItemSync(BARGE_KEY) === '1'
  } catch {
    return false
  }
}
export function setBargeInEnabled(on: boolean): void {
  Storage.setItemSync(BARGE_KEY, on ? '1' : '0')
}

/** Microfone de teste: silêncio contínuo + os clipes injetados, em tempo real. */
class DevFakeMic implements MicSource {
  readonly kind = 'fake' as const
  private timer: ReturnType<typeof setInterval> | null = null
  private queue: Float32Array[] = []
  private pos = 0
  private asm: FrameAssembler | null = null
  private poll: ReturnType<typeof setInterval> | null = null
  private polling = false

  inject(samples: Float32Array): void {
    this.queue.push(samples)
  }

  async start(onFrame: (f: MicFrame) => void): Promise<void> {
    await this.stop()
    this.asm = new FrameAssembler(onFrame)
    this.timer = setInterval(() => {
      const cur = this.queue[0]
      let frame: Float32Array
      if (cur) {
        frame = new Float32Array(FRAME_SAMPLES)
        frame.set(cur.subarray(this.pos, this.pos + FRAME_SAMPLES))
        this.pos += FRAME_SAMPLES
        if (this.pos >= cur.length) {
          this.queue.shift()
          this.pos = 0
        }
      } else frame = new Float32Array(FRAME_SAMPLES).map(() => (Math.random() - 0.5) * 0.001)
      this.asm?.push(frame, MIC_SAMPLE_RATE)
    }, FRAME_MS)
    const base = fakeMicPoll()
    if (base)
      this.poll = setInterval(() => {
        if (this.polling) return
        this.polling = true
        void fetch(`${base}/mic/next`)
          .then(async (r) => {
            if (r.status !== 200) return
            const { samples, rate } = decodeWav(new Uint8Array(await r.arrayBuffer()))
            this.inject(
              rate === MIC_SAMPLE_RATE ? samples : resampleMono(samples, rate, MIC_SAMPLE_RATE)
            )
            console.log(`CLEARCHAT_FAKEMIC played ${Math.round((samples.length / rate) * 1000)}ms`)
          })
          .catch(() => undefined)
          .finally(() => {
            this.polling = false
          })
      }, 400)
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    if (this.poll) clearInterval(this.poll)
    this.timer = null
    this.poll = null
    this.asm = null
  }
}

export const devFakeMic = new DevFakeMic()

/** Baixa um WAV (fixture) e o toca no microfone de teste. */
export async function injectFakeMic(url: string): Promise<number> {
  if (!__DEV__) throw new Error('só em desenvolvimento')
  const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer())
  const { samples, rate } = decodeWav(bytes)
  const s = rate === MIC_SAMPLE_RATE ? samples : resampleMono(samples, rate, MIC_SAMPLE_RATE)
  devFakeMic.inject(s)
  return Math.round((s.length / MIC_SAMPLE_RATE) * 1000)
}

const log = (msg: string): void => {
  if (__DEV__) console.log(`[clearchat:voice] ${msg}`)
}

export const voice = createVoiceStack({
  stack: hostStack,
  store,
  mic: () => (fakeMicEnabled() ? devFakeMic : new NativeMicSource()),
  playback: expoPlayback,
  clips: fileClipStore(),
  // microfone de teste: sem pedir a permissão (nada é aberto)
  requestMic: async () => {
    if (fakeMicEnabled()) return true
    // o diálogo do sistema pausa a Activity (AppState vira "background"): não é segundo plano
    permissionPending++
    try {
      return await requestMicPermission()
    } finally {
      // o "active" da volta chega logo depois da resposta
      setTimeout(() => permissionPending--, 1500)
    }
  },
  bargeIn: bargeInEnabled,
  log
})

let permissionPending = 0
let started = false
/** Foreground only (como o host): segundo plano encerra a chamada e cancela o ditado. */
export function startVoice(): void {
  if (started) return
  started = true
  AppState.addEventListener('change', (s) => {
    if (s === 'active' || permissionPending > 0) return
    if (voice.call.getView().call.active) voice.call.stop('o app foi para o segundo plano')
    if (voice.dictation.getView().phase !== 'idle') voice.dictation.cancel()
  })
  // o chat deixou de ser executado aqui (outro dispositivo assumiu): a chamada cai
  hostStack.host.subscribe(() => {
    const st = voice.call.getView().call
    if (!st.active || !st.chatId) return
    const s = hostStack.host.state(st.chatId)
    if (s?.host && s.host.device_id !== hostStack.host.deviceId)
      voice.call.stop(`${s.host.name} assumiu o chat`)
  })
}
