// Campos LEGADOS do protocolo que os escritores do celular nunca enviam (= `stripLegacyVoiceKeys`
// de ClearChatDesktop/src/main/sync/records.ts). `interjections` (§4.3.6, legado desde 2026-11-12 —
// a chamada de voz não tem mais interjeições nem modo sombra) em `config.voice` de chat/persona e em
// `voiceCallDefaults`: os leitores já o descartam (normalizadores vendorados), e aqui ele some de
// QUALQUER plaintext antes de ser cifrado — inclusive de registros antigos guardados no cache (ou
// recebidos de um cliente antigo) que o celular regrava (ex.: o `chat` reenviado a cada mensagem).
import type { Plain } from './types'

const LEGACY_VOICE_KEYS = ['interjections'] as const

const isObj = (v: unknown): v is Plain => !!v && typeof v === 'object' && !Array.isArray(v)

/** Cópia do objeto de voz sem os campos legados (não-objeto, ou nada a tirar, volta como veio). */
export function stripLegacyVoiceKeys<T>(v: T): T {
  if (!isObj(v) || !LEGACY_VOICE_KEYS.some((k) => k in v)) return v
  const out: Plain = { ...v }
  for (const k of LEGACY_VOICE_KEYS) delete out[k]
  return out as T
}

/** Plaintext que sai para o servidor (push): sem os campos legados de voz. */
export function outgoingPlain(type: string, id: string, plain: Plain): Plain {
  if (type === 'chat' || type === 'preset') {
    const cfg = plain.config
    if (!isObj(cfg) || !isObj(cfg.voice)) return plain
    const voice = stripLegacyVoiceKeys(cfg.voice)
    return voice === cfg.voice ? plain : { ...plain, config: { ...cfg, voice } }
  }
  if (type === 'setting' && id === 'voiceCallDefaults') {
    const value = stripLegacyVoiceKeys(plain.value)
    return value === plain.value ? plain : { ...plain, value }
  }
  return plain
}
