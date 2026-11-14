// Ligações React da voz: estado da chamada e do ditado (useSyncExternalStore sobre os controllers) e
// a voz de um chat NESTE aparelho (protocolo 1.9.0 — microfone/telefone esmaecidos com o motivo).
import { useMemo, useSyncExternalStore } from 'react'
import type { VoiceLayers } from '@shared/voice'
import { store } from '@/data/native'
import { settings, useSettingsVersion } from '@/settings/react'
import { voice } from './native'
import type { CallView } from './call'
import type { DictationView } from './dictation'
import { readVoiceSettings, type VoiceSignature } from './endpoints'
import {
  chatVoiceIcons,
  resolveChatVoice,
  voiceLayers,
  type ChatVoice,
  type VoiceIcon
} from './resolve'

export function useCallView(): CallView {
  return useSyncExternalStore(voice.call.subscribe, voice.call.getView)
}

export function useDictationView(): DictationView {
  return useSyncExternalStore(voice.dictation.subscribe, voice.dictation.getView)
}

/** Camadas de voz de uma config de chat: a `voice` dele e a da persona de origem (lida ao vivo). */
export function chatVoiceLayers(cfg: Record<string, unknown> | null | undefined): VoiceLayers {
  const presetId = typeof cfg?.presetId === 'string' ? cfg.presetId : null
  const pc = presetId ? store.getPlain('preset', presetId)?.config : null
  const pv = pc && typeof pc === 'object' ? (pc as Record<string, unknown>).voice : null
  return voiceLayers(cfg?.voice, pv)
}

/** Assinatura de app de uma config de chat (os headers de atribuição das requests dele). */
export function chatSignature(cfg: Record<string, unknown> | null | undefined): VoiceSignature {
  const id = typeof cfg?.appSignature === 'string' ? cfg.appSignature : null
  const c = cfg?.appSignatureCustom as { referer?: unknown; title?: unknown } | null | undefined
  const custom =
    c && typeof c === 'object' && typeof c.referer === 'string' && typeof c.title === 'string'
      ? { referer: c.referer, title: c.title }
      : undefined
  return id || custom
    ? { ...(id ? { appSignature: id } : {}), ...(custom ? { appSignatureCustom: custom } : {}) }
    : null
}

/**
 * A voz de um chat aqui (camadas da config do chat — salvo, do controle remoto ou ao vivo): a
 * resolução, as camadas e a assinatura de app (para o ditado) e o estado dos ícones. Refaz quando as
 * Configurações mudam.
 */
export function useChatVoice(cfg: Record<string, unknown> | null | undefined): {
  layers: VoiceLayers
  signature: VoiceSignature
  voice: ChatVoice
  mic: VoiceIcon
  call: VoiceIcon
} {
  const version = useSettingsVersion()
  const key = JSON.stringify([
    cfg?.voice ?? null,
    cfg?.presetId ?? null,
    cfg?.appSignature ?? null,
    cfg?.appSignatureCustom ?? null
  ])
  return useMemo(() => {
    void version
    const layers = chatVoiceLayers(cfg)
    const providers = settings.providers()
    const r = resolveChatVoice(
      layers,
      readVoiceSettings((id) => store.deviceSetting(id)),
      (id) => providers.find((p) => p.id === id) ?? null
    )
    return { layers, signature: chatSignature(cfg), voice: r, ...chatVoiceIcons(r) }
    // a config entra pela chave (objeto novo a cada leitura do cache)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, key])
}

export { voice }
