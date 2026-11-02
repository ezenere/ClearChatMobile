// Transcrição pela API no celular — `transcribeAudio` de ClearChatDesktop/src/main/voice/stt.ts
// (vendorado em src/vendor/desktop/voice/stt.ts) com UMA troca: o corpo multipart é montado à mão.
// O vendorado usa `new Blob([bytes])` + `FormData`; o `Blob` do React Native não aceita bytes
// ("Creating blobs from 'ArrayBuffer' … are not supported"), então aqui o corpo vira um
// `Uint8Array` com o mesmo conteúdo (campos `file`, `model`, `language`, `response_format` e os
// parâmetros da família). O resto — erros (`SttError` com `kind`/`status`), nome do arquivo,
// idioma, parâmetros, custo (`usage.cost`) — é o do desktop, importado do vendorado. Sem React Native.
import { connectionErrorText } from '@shared/network'
import { voiceProviderSupport } from '@shared/voiceCatalog'
import { apiParamsToSend } from '@shared/voiceParams'
import type { SttSettings } from '@shared/voice'
import {
  audioFileName,
  languageParam,
  STT_DEFAULT_TIMEOUT_MS,
  SttError,
  sttUsageCost,
  type TranscribeAudioInput,
  type TranscribeResult
} from '@vendor/desktop/voice/stt'
import { abortError } from '@/agent/tools/util'

export { SttError, type TranscribeAudioInput, type TranscribeResult }

/** Uma request de transcrição que deu certo (custos da chamada de voz). */
export interface SttApiUsage {
  model: string
  baseUrl: string
  local: boolean
  audioMs: number | null
  cost?: number
}
const usageListeners = new Set<(u: SttApiUsage) => void>()
/** Assina cada transcrição pela API (a chamada soma no marcador de fim). */
export function onSttApiUsage(cb: (u: SttApiUsage) => void): () => void {
  usageListeners.add(cb)
  return () => usageListeners.delete(cb)
}

/** Duração (ms) de um WAV PCM pelo cabeçalho; não-WAV → null (= desktop). */
export function wavDurationMs(audio: Uint8Array, mime: string): number | null {
  if (!/wav/i.test(mime) || audio.length < 44) return null
  const dv = new DataView(audio.buffer, audio.byteOffset, audio.byteLength)
  if (dv.getUint32(0, false) !== 0x52494646) return null
  const byteRate = dv.getUint32(28, true)
  return byteRate > 0 ? Math.round(((audio.length - 44) / byteRate) * 1000) : null
}

function isLocalEndpoint(url: string): boolean {
  try {
    const host = new URL(url).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
  } catch {
    return false
  }
}

function errorDetail(raw: string): string {
  let msg = ''
  try {
    const j = JSON.parse(raw) as Record<string, unknown>
    const e = j.error
    const cand =
      (e && typeof e === 'object'
        ? ((e as Record<string, unknown>).message ??
          (e as Record<string, unknown>).detail ??
          (e as Record<string, unknown>).msg)
        : e) ??
      j.detail ??
      j.message
    msg = typeof cand === 'string' ? cand : cand ? JSON.stringify(cand) : ''
  } catch {
    msg = /<html/i.test(raw) ? '' : raw
  }
  msg = msg.replace(/\s+/g, ' ').trim()
  return msg.length > 160 ? `${msg.slice(0, 160)}…` : msg
}

function httpError(status: number, raw: string, url: string): SttError {
  const detail = errorDetail(raw)
  const tail = detail ? ` — ${detail}` : ''
  if (status === 401 || status === 403)
    return new SttError('auth', `chave de API inválida ou sem permissão (HTTP ${status})${tail}`, {
      backend: 'api',
      status
    })
  if (status === 402 || status === 429)
    return new SttError(
      'quota',
      `limite de uso/cota da transcrição atingido (HTTP ${status})${tail}`,
      { backend: 'api', status }
    )
  return new SttError('http', `HTTP ${status} na transcrição de áudio em ${url}${tail}`, {
    backend: 'api',
    status
  })
}

/** Corpo multipart/form-data em bytes (o `Blob` do RN não aceita bytes). */
export function multipartBody(
  fields: [string, string][],
  file: { field: string; name: string; type: string; data: Uint8Array },
  boundary = `----ClearChatVoice${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
): { body: Uint8Array<ArrayBuffer>; contentType: string } {
  const enc = new TextEncoder()
  const esc = (s: string) => s.replace(/["\r\n]/g, '_')
  const parts: Uint8Array[] = []
  parts.push(
    enc.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="${esc(file.field)}"; filename="${esc(file.name)}"\r\nContent-Type: ${file.type}\r\n\r\n`
    ),
    file.data,
    enc.encode('\r\n')
  )
  for (const [k, v] of fields)
    parts.push(
      enc.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="${esc(k)}"\r\n\r\n${v}\r\n`
      )
    )
  parts.push(enc.encode(`--${boundary}--\r\n`))
  let n = 0
  for (const p of parts) n += p.length
  const body = new Uint8Array(n)
  let o = 0
  for (const p of parts) {
    body.set(p, o)
    o += p.length
  }
  return { body, contentType: `multipart/form-data; boundary=${boundary}` }
}

export interface SttTranscribeOptions {
  settings: SttSettings
  language?: string
  timeoutMs?: number
  signal?: AbortSignal
  /** Testes: fetch injetado. */
  fetch?: typeof fetch
}

/** = `transcribeAudio` do desktop (mesmos erros e resultado), com o multipart em bytes. */
export async function transcribeAudio(
  input: TranscribeAudioInput,
  opts: SttTranscribeOptions
): Promise<TranscribeResult> {
  const api = opts.settings.api
  const baseUrl = (api.baseUrl ?? '').trim().replace(/\/+$/, '')
  const model = api.model.trim()
  const key = (api.apiKey ?? '').trim()
  if (!baseUrl)
    throw new SttError(
      'config',
      'nenhum provedor de transcrição escolhido — escolha um em Configurações → Voz',
      { backend: 'api' }
    )
  if (!model)
    throw new SttError('config', 'modelo de transcrição não configurado', { backend: 'api' })
  if (!key && !isLocalEndpoint(baseUrl))
    throw new SttError(
      'config',
      'chave de API de transcrição não configurada no provedor (Configurações → Provedores)',
      { backend: 'api' }
    )
  const url = `${baseUrl}/audio/transcriptions`
  const timeoutMs = opts.timeoutMs ?? STT_DEFAULT_TIMEOUT_MS
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout
  const fields: [string, string][] = [['model', model]]
  const language = languageParam(opts.language)
  if (language) fields.push(['language', language])
  fields.push(['response_format', 'json'])
  const family = voiceProviderSupport({ baseUrl, kind: api.providerKind ?? undefined })
  for (const [k, v] of Object.entries(apiParamsToSend('stt', family, model, api.params)))
    fields.push([k, String(v)])
  const { body, contentType } = multipartBody(fields, {
    field: 'file',
    name: audioFileName(input.mimeType, input.fileName),
    type: input.mimeType,
    data: input.audio
  })
  const t0 = Date.now()
  let raw: string
  let status: number
  try {
    const res = await (opts.fetch ?? fetch)(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': contentType,
        ...(key ? { Authorization: `Bearer ${key}` } : {})
      },
      body,
      signal
    })
    status = res.status
    raw = await res.text()
  } catch (e) {
    if (opts.signal?.aborted) throw abortError()
    if (timeout.aborted)
      throw new SttError(
        'timeout',
        `tempo esgotado na transcrição de áudio (${timeoutMs / 1000} s) em ${url}`,
        { backend: 'api', cause: e }
      )
    throw new SttError(
      'network',
      `erro de rede ao transcrever áudio em ${url}: ${connectionErrorText(e)}`,
      { backend: 'api', cause: e }
    )
  }
  if (status < 200 || status >= 300) throw httpError(status, raw, url)
  let text: string | null = null
  let cost: number | undefined
  try {
    const json = (raw.trim() ? JSON.parse(raw) : null) as { text?: unknown } | null
    if (typeof json?.text === 'string') text = json.text
    cost = sttUsageCost(json)
  } catch {
    text = null
  }
  if (text === null)
    throw new SttError(
      'http',
      `resposta da API em formato inesperado (HTTP ${status} sem campo "text")`,
      { backend: 'api', status }
    )
  const usage: SttApiUsage = {
    model,
    baseUrl,
    local: isLocalEndpoint(baseUrl),
    audioMs: wavDurationMs(input.audio, input.mimeType),
    ...(cost !== undefined ? { cost } : {})
  }
  for (const cb of usageListeners) {
    try {
      cb(usage)
    } catch {
      /* medição nunca derruba a transcrição */
    }
  }
  return { text, model, baseUrl, ms: Date.now() - t0 }
}
