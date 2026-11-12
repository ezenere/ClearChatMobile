// Monta a voz do celular (chamada + ditado) sobre o host (repo/runner/janelas) e o cache — o mesmo
// código no aparelho (`native.ts`, com expo-audio) e nos testes no Node (microfone de teste,
// reprodução falsa). Sem React Native.
import { normalizeVoiceCallConfig, type VoiceCallConfig } from '@shared/voice'
import type { LocalStore } from '@/data/store'
import type { HostStack } from '@/host/stack'
import { setVoiceCallSource } from '@/agent/request'
import { VoiceCallController } from './call'
import type { ClipStore } from './clips'
import { DictationController } from './dictation'
import type { MicSource } from './mic'
import type { PlaybackBackend } from './player'

export interface VoiceStackDeps {
  stack: HostStack
  store: LocalStore
  mic(): MicSource
  playback: PlaybackBackend
  clips: ClipStore
  requestMic(): Promise<boolean>
  /** "Falar por cima da resposta" (opção deste aparelho — com fone). */
  bargeIn(): boolean
  /** Nível de ativação do microfone deste aparelho (dBFS; §4.3.2 — local, nunca sincroniza). */
  activationDb?(): number
  fetch?: typeof fetch
  log?: (msg: string) => void
}

export interface VoiceStack {
  call: VoiceCallController
  dictation: DictationController
}

export function createVoiceStack(d: VoiceStackDeps): VoiceStack {
  const { stack, store } = d
  const provider = (id: string) => stack.providers().find((p) => p.id === id) ?? null
  const personaVoice = (chatId: string): VoiceCallConfig | null => {
    const presetId = stack.repo.chat(chatId)?.config.presetId
    const cfg = presetId ? store.getPlain('preset', presetId)?.config : null
    const v = cfg && typeof cfg === 'object' ? (cfg as Record<string, unknown>).voice : null
    return v && typeof v === 'object' ? normalizeVoiceCallConfig(v) : null
  }
  const call = new VoiceCallController({
    repo: stack.repo,
    runner: stack.runner,
    send: async (chatId, sessionId, text, voice) => {
      await stack.host.local(chatId, 'send', {
        sessionId,
        text,
        attachments: [],
        ...(voice ? { voice } : {})
      })
    },
    holdWindow: async (chatId) => {
      const release = stack.host.holdWindow(chatId)
      try {
        await stack.host.ensureWindow(chatId, 'run')
      } catch (e) {
        release()
        throw e
      }
      return release
    },
    personaVoice,
    setting: (id) => store.setting(id),
    provider,
    requestMic: d.requestMic,
    mic: d.mic,
    playback: d.playback,
    clips: d.clips,
    bargeIn: d.bargeIn,
    ...(d.activationDb ? { activationDb: d.activationDb } : {}),
    setVoiceCallSource,
    ...(d.fetch ? { fetch: d.fetch } : {}),
    ...(d.log ? { log: d.log } : {})
  })
  const dictation = new DictationController({
    setting: (id) => store.setting(id),
    provider,
    requestMic: d.requestMic,
    mic: d.mic,
    ...(d.activationDb ? { activationDb: d.activationDb } : {}),
    ...(d.fetch ? { fetch: d.fetch } : {})
  })
  return { call, dictation }
}
