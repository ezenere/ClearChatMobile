// Settings de áudio no celular (§4.3.2): leitura normalizada dos registros sincronizados
// (`audioInput`, `sttSettings`, `ttsSettings`, `voiceCallDefaults`), resolução do provedor pelo id
// (endereço/chave/tipo só em memória — nunca gravados) e a forma gravada (sem as partes do
// dispositivo — = `voiceSettingOut` do desktop: `audioInput.deviceId`/`activationDb` nunca saem; o
// nível de ativação deste aparelho vive no kv local, `native.ts`). O celular não tem motores locais nem GPU: o modo
// "local"/"híbrido" do STT e o backend "local" do TTS aparecem como "só no computador" e a voz
// explica em vez de mandar o áudio para a API sem o usuário escolher. Sem React Native.
import {
  normalizeAudioInput,
  normalizeSttSettings,
  normalizeTtsSettings,
  normalizeVoiceCallDefaults,
  type AudioInputSettings,
  type SttSettings,
  type TtsSettings,
  type VoiceCallDefaults
} from '@shared/voice'
import { normalizeActivationDb } from '@shared/speechGate'
import {
  providerSupportsVoice,
  supportsAudioTags,
  voiceProviderSupport
} from '@shared/voiceCatalog'
import { providerKind } from '@shared/providerKinds'
import type { Provider } from '@shared/types'

export interface VoiceSettings {
  audioInput: AudioInputSettings
  stt: SttSettings
  tts: TtsSettings
  voiceCallDefaults: VoiceCallDefaults
}

/** Partes do dispositivo do `audioInput` (§4.3.2): nunca vão no registro; o recebido não as troca. */
export const AUDIO_INPUT_DEVICE_FIELDS = ['deviceId', 'activationDb'] as const

/**
 * Settings de áudio completas a partir do cache (`setting(id)` = `value` do registro). O nível de
 * ativação é o DESTE aparelho (`device.activationDb`, kv local) — um `activationDb` que viesse no
 * registro é ignorado (parte do dispositivo, como o `deviceId`).
 */
export function readVoiceSettings(
  setting: (id: string) => unknown,
  device: { activationDb?: number | null } = {}
): VoiceSettings {
  return {
    audioInput: {
      ...normalizeAudioInput(setting('audioInput')),
      activationDb: normalizeActivationDb(device.activationDb)
    },
    stt: normalizeSttSettings(setting('sttSettings')),
    tts: normalizeTtsSettings(setting('ttsSettings')),
    voiceCallDefaults: normalizeVoiceCallDefaults(setting('voiceCallDefaults'))
  }
}

type Plain = Record<string, unknown>
const isObj = (v: unknown): v is Plain => !!v && typeof v === 'object' && !Array.isArray(v)

/** Campos do endpoint que só existem em memória (resolvidos do provedor) — nunca gravados. */
const ENDPOINT_RUNTIME = ['baseUrl', 'apiKey', 'providerKind', 'extraBody']

/**
 * Valor a gravar no registro `setting` (§4.3.2): sem `audioInput.deviceId`/`activationDb` (partes
 * do dispositivo), sem o bloco `gpu`, sem `local.installed` e sem endereço/chave resolvidos; o modo
 * `gpu` nunca sai (o celular não o tem — por segurança vira o valor online ou o padrão). Objeto
 * vazio → null.
 */
export function audioSettingOut(id: string, value: unknown, online?: unknown): unknown {
  if (!isObj(value)) return value ?? null
  const out = JSON.parse(JSON.stringify(value)) as Plain
  if (id === 'audioInput') for (const k of AUDIO_INPUT_DEVICE_FIELDS) delete out[k]
  const field = id === 'sttSettings' ? 'mode' : id === 'ttsSettings' ? 'backend' : null
  if (field) {
    delete out.gpu
    if (isObj(out.api)) for (const k of ENDPOINT_RUNTIME) delete out.api[k]
    if (isObj(out.local)) delete out.local.installed
    if (out[field] === 'gpu') {
      const v = isObj(online) ? online[field] : undefined
      out[field] = typeof v === 'string' && v !== 'gpu' ? v : id === 'sttSettings' ? 'api' : 'local'
    }
  }
  return Object.keys(out).length ? out : null
}

/** Família da API do provedor de voz (decide os parâmetros) — null = não serve voz. */
export const voiceFamily = (p: Pick<Provider, 'baseUrl' | 'kind'>) =>
  voiceProviderSupport({ baseUrl: p.baseUrl, kind: p.kind })

/** Provedores que servem a capacidade (STT: OpenAI-compatível/OpenRouter; TTS: + ElevenLabs). */
export function voiceProviders(all: Provider[], capability: 'stt' | 'tts'): Provider[] {
  return all.filter((p) => providerSupportsVoice({ baseUrl: p.baseUrl, kind: p.kind }, capability))
}

/** Por que a voz não roda neste celular (pt-BR) — `desktopOnly` = escolha que só o PC executa. */
export interface VoiceBlock {
  reason: string
  desktopOnly: boolean
}

/**
 * STT do celular: só a API. `local` → explica (o usuário escolheu manter o áudio fora da API);
 * `hybrid` → a API (é a primária da transcrição final no desktop); sem provedor → pede um.
 */
export function resolveStt(
  stt: SttSettings,
  provider: (id: string) => Provider | null
): { settings: SttSettings; provider: Provider } | { block: VoiceBlock } {
  if (stt.mode === 'local' || stt.mode === 'gpu')
    return {
      block: {
        reason:
          'A transcrição está em “Local” (motor no computador) — neste celular só a API transcreve. Escolha “API” em Configurações → Voz.',
        desktopOnly: true
      }
    }
  const p = stt.api.providerId ? provider(stt.api.providerId) : null
  if (!p)
    return {
      block: {
        reason: stt.api.providerId
          ? 'O provedor de transcrição escolhido não existe neste aparelho — escolha outro em Configurações → Voz.'
          : 'Nenhum provedor de transcrição escolhido — escolha um em Configurações → Voz.',
        desktopOnly: false
      }
    }
  if (!providerSupportsVoice({ baseUrl: p.baseUrl, kind: p.kind }, 'stt'))
    return {
      block: {
        reason: `O provedor “${p.name}” não transcreve áudio (a ElevenLabs direta só fala) — escolha outro em Configurações → Voz.`,
        desktopOnly: false
      }
    }
  return {
    provider: p,
    settings: {
      ...stt,
      mode: 'api',
      api: {
        ...stt.api,
        baseUrl: p.baseUrl,
        apiKey: p.apiKey,
        providerKind: providerKind({ baseUrl: p.baseUrl, kind: p.kind })
      }
    }
  }
}

/** TTS do celular: só a API (OpenAI-compatível/OpenRouter `/audio/speech` ou ElevenLabs REST). */
export function resolveTts(
  tts: TtsSettings,
  provider: (id: string) => Provider | null
): { settings: TtsSettings; provider: Provider } | { block: VoiceBlock } {
  if (tts.backend !== 'api')
    return {
      block: {
        reason:
          tts.backend === 'gpu'
            ? 'A fala está no modo GPU local (só no computador). Escolha “API” em Configurações → Voz.'
            : 'A fala está em “Local” (Kokoro, só no computador) — neste celular a voz vem da API. Escolha “API” em Configurações → Voz.',
        desktopOnly: true
      }
    }
  const p = tts.api.providerId ? provider(tts.api.providerId) : null
  if (!p)
    return {
      block: {
        reason: tts.api.providerId
          ? 'O provedor de fala escolhido não existe neste aparelho — escolha outro em Configurações → Voz.'
          : 'Nenhum provedor de fala escolhido — escolha um em Configurações → Voz.',
        desktopOnly: false
      }
    }
  const kind = providerKind({ baseUrl: p.baseUrl, kind: p.kind })
  if (!tts.api.model.trim() && voiceFamily(p) !== 'elevenlabs')
    return {
      block: {
        reason: 'Modelo de fala não configurado — escolha um em Configurações → Voz.',
        desktopOnly: false
      }
    }
  return {
    provider: p,
    settings: {
      ...tts,
      api: { ...tts.api, baseUrl: p.baseUrl, apiKey: p.apiKey, providerKind: kind }
    }
  }
}

/**
 * A voz da chamada (Configurações → Voz → Fala) interpreta tags de voz? (`supportsAudioTags` com a
 * família do provedor escolhido — = `useCallTtsTagsSupport` do desktop): os editores avisam quando
 * as tags pedidas seriam tiradas da fala.
 */
export function callTtsTagsSupport(
  tts: TtsSettings,
  provider: (id: string) => Provider | null
): { supported: boolean; model: string | null } {
  if (tts.backend !== 'api' || !tts.api.providerId) return { supported: false, model: null }
  const p = provider(tts.api.providerId)
  const family = p ? voiceFamily(p) : null
  return { supported: supportsAudioTags(family, tts.api.model), model: tts.api.model || null }
}
