// Clipes dos preâmbulos (fillers) da chamada de voz no celular — adaptação de
// ClearChatDesktop/src/main/voice/clips.ts (shim gerado em src/vendor/desktop/voice/clips.ts: o
// `VoiceCallManager` vendorado importa daqui o tipo `ClipClass`). O desktop grava os clipes em
// `<userData>/voice-clips/<voz>` com node:fs + hash-wasm; aqui a MESMA definição (o pool de
// preâmbulos, voz, modelo, parâmetros) vira um hash e os bytes ficam num `ClipStore` injetado (no
// aparelho: `Documents/voice-clips/`, `src/voice/native.ts`). Clipe ausente ou de definição velha →
// null (a chamada não toca nada no lugar — igual ao desktop). Só a classe `FILLER` (as interjeições
// "Uhum/Aham" saíram em 2026-11-12): caches antigos com outras classes contam como velhos e somem na
// próxima geração. Sem React Native (testável no Node).
//
// Mudança sugerida no desktop: mover a parte pura de clips.ts para um módulo sem node:fs (ex.:
// `clipsCore.ts`) para o celular vendorar em vez de copiar.
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import {
  FILLER_POOL_MAX,
  resolveFillerPool,
  type FillerPhrase,
  type TtsSettings
} from '@shared/voice'
import { resolveGpuParams } from '@shared/gpuVoice'

/** Classes de clipes (= desktop): só o `FILLER` (preâmbulo pós-turno). */
export type ClipClass = 'FILLER'
export const CLIP_CLASSES: readonly ClipClass[] = ['FILLER']

/** Teto do `<n>` (= desktop: uma variante por frase do pool de preâmbulos, até `FILLER_POOL_MAX`). */
export const CLIP_MAX_VARIANTS = FILLER_POOL_MAX

/** Conjunto completo por classe: o `FILLER` = o pool de preâmbulos (null = o padrão), na ordem. */
export function clipPhraseSet(
  fillerPool?: readonly FillerPhrase[] | null
): Record<ClipClass, readonly string[]> {
  return {
    FILLER: resolveFillerPool(fillerPool ? [...fillerPool] : null).map((f) => f.text)
  }
}

/** Versão do pós-processamento (entra no hash). O celular não apara o silêncio: outra versão. */
const CLIP_POSTPROCESS = 'mobile-v1'

/** Id da voz dona do cache (= `clipVoiceId` do desktop: segmento seguro). */
export function clipVoiceId(settings: TtsSettings): string {
  const raw =
    settings.backend === 'local'
      ? `local-${settings.local?.engine ?? 'kokoro'}-${settings.local?.voice ?? 'padrao'}`
      : settings.backend === 'gpu'
        ? `gpu-${settings.gpu?.engine ?? 'omnivoice'}-${settings.gpu?.voice ?? 'padrao'}`
        : `api-${(settings.api.voice ?? '').trim() || 'padrao'}`
  const safe = raw
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 64)
  return safe || 'voz'
}

/**
 * Hash da definição dos clipes (mesmo payload do desktop + a versão do pós-processamento do
 * celular): mudou → os clipes guardados não valem mais.
 */
export function clipsHash(
  settings: TtsSettings,
  fillerPool?: readonly FillerPhrase[] | null
): string {
  const payload = JSON.stringify({
    phrases: clipPhraseSet(fillerPool),
    post: CLIP_POSTPROCESS,
    backend: settings.backend,
    engine:
      settings.backend === 'local'
        ? (settings.local?.engine ?? null)
        : settings.backend === 'gpu'
          ? (settings.gpu?.engine ?? null)
          : null,
    voice:
      settings.backend === 'local'
        ? (settings.local?.voice ?? null)
        : settings.backend === 'gpu'
          ? (settings.gpu?.voice ?? null)
          : (settings.api.voice ?? null) || null,
    model: settings.backend === 'api' ? settings.api.model : null,
    ...(settings.backend === 'gpu' && settings.gpu?.steps ? { steps: settings.gpu.steps } : {}),
    ...(() => {
      if (settings.backend !== 'api' || !settings.api.params) return {}
      const p = JSON.parse(JSON.stringify(settings.api.params)) as Record<
        string,
        Record<string, unknown>
      >
      if (p.elevenlabs) delete p.elevenlabs.auto_mode
      for (const k of Object.keys(p)) if (!Object.keys(p[k]).length) delete p[k]
      return Object.keys(p).length ? { apiParams: p } : {}
    })(),
    ...(settings.backend === 'gpu' && settings.gpu
      ? {
          params: resolveGpuParams(settings.gpu.engine, settings.gpu.params?.[settings.gpu.engine])
        }
      : {})
  })
  return bytesToHex(sha256(new TextEncoder().encode(payload)))
}

/** Onde os bytes dos clipes ficam (aparelho: arquivos; testes: memória). */
export interface ClipStore {
  read(key: string): Promise<{ audio: Uint8Array; mime: string } | null>
  write(key: string, clip: { audio: Uint8Array; mime: string }): Promise<void>
  /** Apaga tudo o que não está em `keep` (definições velhas). */
  prune(keep: readonly string[]): Promise<void>
}

/** Chave de um clipe: hash da definição + classe + variante (nada de texto livre no nome). */
export function clipKey(hash: string, cls: ClipClass, n: number): string {
  if (!CLIP_CLASSES.includes(cls)) throw new Error(`classe de clipe desconhecida: ${cls}`)
  if (!Number.isInteger(n) || n < 1 || n > CLIP_MAX_VARIANTS)
    throw new Error(`variante de clipe inválida: ${n}`)
  return `${hash.slice(0, 24)}_${cls}_${n}`
}

/** Todas as chaves da definição atual (classe, variante, texto). */
export function clipEntries(
  hash: string,
  fillerPool?: readonly FillerPhrase[] | null
): { key: string; cls: ClipClass; n: number; text: string }[] {
  const set = clipPhraseSet(fillerPool)
  return CLIP_CLASSES.flatMap((cls) =>
    set[cls].map((text, i) => ({ key: clipKey(hash, cls, i + 1), cls, n: i + 1, text }))
  )
}

/** Estado dos clipes da voz atual (CTA "Gerar clipes" no painel da chamada). */
export async function clipsStatus(
  store: ClipStore,
  settings: TtsSettings,
  fillerPool?: readonly FillerPhrase[] | null
): Promise<{ total: number; ready: number }> {
  const entries = clipEntries(clipsHash(settings, fillerPool), fillerPool)
  let ready = 0
  for (const e of entries) if (await store.read(e.key)) ready++
  return { total: entries.length, ready }
}

/** Bytes de um clipe só se ele é da definição atual (senão null — nunca toca clipe velho). */
export async function loadCurrentClipAudio(
  store: ClipStore,
  settings: TtsSettings,
  fillerPool: readonly FillerPhrase[] | null | undefined,
  cls: ClipClass,
  n: number
): Promise<{ audio: Uint8Array; mime: string } | null> {
  const count = clipPhraseSet(fillerPool)[cls]?.length ?? 0
  if (!Number.isInteger(n) || n < 1 || n > count) return null
  return store.read(clipKey(clipsHash(settings, fillerPool), cls, n))
}

/**
 * Gera (sintetiza) os clipes da voz atual que faltam e apaga os de definições velhas. `synth` =
 * a mesma síntese da chamada (bytes completos). Progresso por clipe; cancelável.
 */
export async function generateClips(opts: {
  store: ClipStore
  settings: TtsSettings
  fillerPool?: readonly FillerPhrase[] | null
  synth: (text: string, signal: AbortSignal) => Promise<{ audio: Uint8Array; mime: string }>
  signal?: AbortSignal
  onProgress?: (done: number, total: number) => void
}): Promise<{ total: number; generated: number }> {
  const hash = clipsHash(opts.settings, opts.fillerPool)
  const entries = clipEntries(hash, opts.fillerPool)
  const signal = opts.signal ?? new AbortController().signal
  let done = 0
  let generated = 0
  opts.onProgress?.(0, entries.length)
  for (const e of entries) {
    if (signal.aborted) throw new Error('cancelado')
    if (!(await opts.store.read(e.key))) {
      const clip = await opts.synth(e.text, signal)
      await opts.store.write(e.key, clip)
      generated++
    }
    opts.onProgress?.(++done, entries.length)
  }
  await opts.store.prune(entries.map((e) => e.key))
  return { total: entries.length, generated }
}

/** Store em memória (testes e fallback). */
export function memoryClipStore(): ClipStore & { keys(): string[] } {
  const m = new Map<string, { audio: Uint8Array; mime: string }>()
  return {
    read: async (k) => m.get(k) ?? null,
    write: async (k, c) => void m.set(k, c),
    prune: async (keep) => {
      for (const k of [...m.keys()]) if (!keep.includes(k)) m.delete(k)
    },
    keys: () => [...m.keys()]
  }
}
