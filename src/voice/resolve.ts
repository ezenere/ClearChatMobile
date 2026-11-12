// Voz da persona/chat NESTE celular (protocolo 1.9.0 — `voice.tts`/`voice.stt`): a resolução é a do
// desktop (`resolveTtsVoice`/`resolveSttVoice` em `@shared/voice`, vendorados) com as capacidades do
// celular — só `provider`: a escolha pela API vale quando o provedor existe AQUI (com endereço) e
// serve a capacidade; motores locais e GPU não existem no celular → a escolha cai nas settings deste
// aparelho (`fallback.reason`). `voiceUse` = o que USAR (a escolha quando vale aqui, senão null = as
// daqui; e o idioma da escolha) e `settingsWith` = as settings deste aparelho com essa escolha
// aplicada (o endereço/chave saem depois, do provedor da escolha — `resolveStt`/`resolveTts`).
// Usado pela chamada (decidida no início, vale a chamada inteira), pelo ditado do composer, pelos
// ícones esmaecidos e pelas seções "Fala"/"Transcrição" da persona/chat. Sem React Native.
import type { Provider } from '@shared/types'
import {
  applySttChoice,
  applyTtsChoice,
  normalizeVoiceCallConfig,
  resolveSttVoice,
  resolveTtsVoice,
  type VoiceCallConfig,
  type VoiceDeviceCaps,
  type VoiceLayers,
  type VoiceSttChoice,
  type VoiceSttResolution,
  type VoiceTtsChoice,
  type VoiceTtsResolution
} from '@shared/voice'
import { providerSupportsVoice } from '@shared/voiceCatalog'
import {
  callUnavailableText,
  dictationUnavailableText,
  voiceFallbackNote,
  voiceIconState,
  type VoiceIconState
} from '@vendor/renderer/voice/voiceChoice'
import type { VoiceSettings } from './endpoints'

/** Fala e transcrição resolvidas de um chat/persona aqui. */
export interface ChatVoice {
  tts: VoiceTtsResolution
  stt: VoiceSttResolution
}

/** O que a chamada/o ditado USAM: a escolha da persona/chat (quando vale aqui) e o idioma dela. */
export interface VoiceUse {
  tts: VoiceTtsChoice | null
  stt: VoiceSttChoice | null
  language: string | null
}

/** Capacidades de voz do celular: só provedores (= `voiceCapsFrom` do desktop, sem motores). */
export function mobileVoiceCaps(provider: (id: string) => Provider | null): VoiceDeviceCaps {
  return {
    provider(id, capability) {
      const p = provider(id)
      if (!p || !p.baseUrl?.trim())
        return { ok: false, reason: 'o provedor escolhido não existe neste dispositivo' }
      if (!providerSupportsVoice({ baseUrl: p.baseUrl, kind: p.kind }, capability))
        return {
          ok: false,
          reason: `o provedor “${p.name}” não serve ${capability === 'tts' ? 'fala' : 'transcrição'}`
        }
      return { ok: true }
    }
  }
}

/** Camadas de voz (normalizadas): a `voice` do chat e a da persona de origem. */
export function voiceLayers(chat: unknown, persona: unknown): VoiceLayers {
  const layer = (v: unknown): VoiceCallConfig | null =>
    v && typeof v === 'object' ? normalizeVoiceCallConfig(v) : null
  return { chat: layer(chat), persona: layer(persona) }
}

/** Fala e transcrição de um chat/persona NESTE celular (settings daqui + provedores daqui). */
export function resolveChatVoice(
  layers: VoiceLayers | null | undefined,
  device: VoiceSettings,
  provider: (id: string) => Provider | null
): ChatVoice {
  const caps = mobileVoiceCaps(provider)
  return {
    tts: resolveTtsVoice(layers, device.tts, caps),
    stt: resolveSttVoice(layers, device.stt, device.audioInput.language, caps)
  }
}

/** O que usar (= `voiceUse` do desktop): a escolha quando vale aqui; null = as settings daqui. */
export function voiceUse(r: ChatVoice): VoiceUse {
  return {
    tts: r.tts.source === 'device' ? null : r.tts.choice,
    stt: r.stt.source === 'device' ? null : r.stt.choice,
    language: r.stt.choice?.language ?? null
  }
}

/** As settings deste aparelho com a escolha aplicada (idioma da escolha no `audioInput`). */
export function settingsWith(v: VoiceSettings, use: VoiceUse | null | undefined): VoiceSettings {
  if (!use) return v
  return {
    ...v,
    tts: applyTtsChoice(v.tts, use.tts),
    stt: applySttChoice(v.stt, use.stt),
    audioInput: use.language ? { ...v.audioInput, language: use.language } : v.audioInput
  }
}

/** "Chamada de voz indisponível neste dispositivo — Transcrição: …. Fala: …." (null = disponível). */
export function callRefusal(r: ChatVoice): string | null {
  if (r.tts.available && r.stt.available) return null
  const parts = [
    !r.stt.available && `Transcrição: ${r.stt.reason ?? 'indisponível'}.`,
    !r.tts.available && `Fala: ${r.tts.reason ?? 'indisponível'}.`
  ].filter(Boolean)
  return `Chamada de voz indisponível neste dispositivo — ${parts.join(' ')}`
}

/** Os textos do desktop apontam para "Configurações → Áudio…": no celular a tela é "Voz". */
export const mobileVoiceText = (s: string): string =>
  s.replace(/Configurações → Áudio(?: → [^).]+)?/g, 'Configurações → Voz')

/** Estado de um ícone de voz (microfone/telefone) e o texto do toque/acessibilidade. */
export interface VoiceIcon {
  state: VoiceIconState
  /** Por que está esmaecido (null = funciona). */
  text: string | null
  /** Aviso discreto: a voz/transcrição da persona caiu na padrão deste aparelho. */
  note: string | null
}

/**
 * Microfone (ditado) e telefone (chamada) de um chat neste aparelho (= os ícones esmaecidos do
 * desktop): esmaecidos com o motivo quando a transcrição/fala efetiva não funciona aqui; com a voz
 * da persona caindo no padrão daqui, a nota discreta do fallback.
 */
export function chatVoiceIcons(r: ChatVoice): { mic: VoiceIcon; call: VoiceIcon } {
  const sttNote = voiceFallbackNote('stt', r.stt)
  const ttsNote = voiceFallbackNote('tts', r.tts)
  const dict = dictationUnavailableText(r.stt)
  const call = callUnavailableText(r)
  return {
    mic: {
      state: voiceIconState([r.stt]),
      text: dict ? mobileVoiceText(dict) : null,
      note: sttNote
    },
    call: {
      state: voiceIconState([r.stt, r.tts]),
      text: call ? mobileVoiceText(call) : null,
      note: [sttNote, ttsNote].filter(Boolean).join(' ') || null
    }
  }
}
