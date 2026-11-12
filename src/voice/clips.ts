// Clipes da chamada de voz no celular (preâmbulos e frases de ferramenta) — adaptação de
// ClearChatDesktop/src/main/voice/clips.ts (shim gerado em src/vendor/desktop/voice/clips.ts: o
// `VoiceCallManager` vendorado importa daqui o tipo `ClipClass`). O desktop grava os clipes em
// `<userData>/voice-clips/<voz>` com node:fs + hash-wasm; aqui a MESMA definição (o pool da classe,
// voz, modelo, parâmetros) vira um hash POR CLASSE e os bytes ficam num `ClipStore` injetado (no
// aparelho: `Documents/voice-clips/`, `src/voice/native.ts`) — o cache é por voz (a voz entra no
// hash): a voz de uma persona tem os clipes dela. Classes: `FILLER` (o pool de preâmbulos) e `TOOL`
// (as frases de ferramenta); mudar as frases de ferramenta não invalida os preâmbulos (hash por
// classe — o de `FILLER` é o mesmo de antes). Clipe ausente ou de definição velha → null: o
// preâmbulo não toca; a frase de ferramenta é sintetizada ao vivo (= desktop). Classes antigas
// (interjeições "Uhum/Aham", saíram em 2026-11-12) contam como velhas e somem na próxima geração.
// Clipes só são gerados com o clique do usuário (uma API paga). Sem React Native (testável no Node).
//
// Mudança sugerida no desktop: mover a parte pura de clips.ts para um módulo sem node:fs (ex.:
// `clipsCore.ts`) para o celular vendorar em vez de copiar.
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import {
  FILLER_POOL_MAX,
  resolveFillerPool,
  resolveToolPhrasePool,
  TOOL_PHRASE_POOL_MAX,
  type FillerPhrase,
  type ToolPhrase,
  type TtsSettings
} from '@shared/voice'
import { resolveGpuParams } from '@shared/gpuVoice'

/** Classes de clipes (= desktop): `FILLER` (preâmbulo pós-turno) e `TOOL` (frase da 1ª tool). */
export type ClipClass = 'FILLER' | 'TOOL'
export const CLIP_CLASSES: readonly ClipClass[] = ['FILLER', 'TOOL']

/** Teto do `<n>` (= desktop: o maior pool — preâmbulos ou frases de ferramenta). */
export const CLIP_MAX_VARIANTS = Math.max(FILLER_POOL_MAX, TOOL_PHRASE_POOL_MAX)

/**
 * Conjunto completo por classe, na ordem dos pools: `FILLER` = o pool de preâmbulos, `TOOL` = as
 * frases de ferramenta (null = os padrões).
 */
export function clipPhraseSet(
  fillerPool?: readonly FillerPhrase[] | null,
  toolPool?: readonly ToolPhrase[] | null
): Record<ClipClass, readonly string[]> {
  return {
    FILLER: resolveFillerPool(fillerPool ? [...fillerPool] : null).map((f) => f.text),
    TOOL: resolveToolPhrasePool(toolPool ? [...toolPool] : null).map((f) => f.text)
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
function phrasesHash(
  settings: TtsSettings,
  phrases: Partial<Record<ClipClass, readonly string[]>>
): string {
  const payload = JSON.stringify({
    phrases,
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

/**
 * Hash da definição de UMA classe (`{ [cls]: frases }` + voz): é o que entra na chave dos clipes —
 * o de `FILLER` é igual ao hash antigo (só preâmbulos), então os clipes já gerados continuam valendo.
 */
export function clipClassHash(
  settings: TtsSettings,
  cls: ClipClass,
  fillerPool?: readonly FillerPhrase[] | null,
  toolPool?: readonly ToolPhrase[] | null
): string {
  return phrasesHash(settings, { [cls]: clipPhraseSet(fillerPool, toolPool)[cls] })
}

/** Hash da definição inteira (todas as classes) — muda com a voz ou qualquer pool. */
export function clipsHash(
  settings: TtsSettings,
  fillerPool?: readonly FillerPhrase[] | null,
  toolPool?: readonly ToolPhrase[] | null
): string {
  return phrasesHash(settings, clipPhraseSet(fillerPool, toolPool))
}

/** Onde os bytes dos clipes ficam (aparelho: arquivos; testes: memória). */
export interface ClipStore {
  read(key: string): Promise<{ audio: Uint8Array; mime: string } | null>
  write(key: string, clip: { audio: Uint8Array; mime: string }): Promise<void>
  /**
   * Apaga os clipes da voz `voiceId` (chaves `<voz>__…`) que não estão em `keep` (definições velhas)
   * e os do formato antigo (sem a voz na chave); os das outras vozes ficam.
   */
  prune(keep: readonly string[], voiceId: string): Promise<void>
}

/** O clipe de chave `key` deve sair num `prune(keep, voiceId)`? (mesma regra nos dois stores). */
export function prunable(key: string, keep: readonly string[], voiceId: string): boolean {
  if (keep.includes(key)) return false
  return !key.includes('__') || key.startsWith(`${voiceId}__`)
}

/** Chave de um clipe: hash da definição + classe + variante (nada de texto livre no nome). */
export function clipKey(voiceId: string, hash: string, cls: ClipClass, n: number): string {
  if (!CLIP_CLASSES.includes(cls)) throw new Error(`classe de clipe desconhecida: ${cls}`)
  if (!Number.isInteger(n) || n < 1 || n > CLIP_MAX_VARIANTS)
    throw new Error(`variante de clipe inválida: ${n}`)
  return `${voiceId}__${hash.slice(0, 24)}_${cls}_${n}`
}

/** Todas as chaves da definição atual (classe, variante, texto) — a chave leva o hash da classe. */
export function clipEntries(
  settings: TtsSettings,
  fillerPool?: readonly FillerPhrase[] | null,
  toolPool?: readonly ToolPhrase[] | null
): { key: string; cls: ClipClass; n: number; text: string }[] {
  const set = clipPhraseSet(fillerPool, toolPool)
  const voice = clipVoiceId(settings)
  return CLIP_CLASSES.flatMap((cls) => {
    const hash = clipClassHash(settings, cls, fillerPool, toolPool)
    return set[cls].map((text, i) => ({
      key: clipKey(voice, hash, cls, i + 1),
      cls,
      n: i + 1,
      text
    }))
  })
}

/** Estado dos clipes da voz (CTA "Gerar clipes"): no total e por classe. */
export async function clipsStatus(
  store: ClipStore,
  settings: TtsSettings,
  fillerPool?: readonly FillerPhrase[] | null,
  toolPool?: readonly ToolPhrase[] | null
): Promise<{
  total: number
  ready: number
  byClass: Record<ClipClass, { total: number; ready: number }>
}> {
  const byClass = Object.fromEntries(
    CLIP_CLASSES.map((c) => [c, { total: 0, ready: 0 }])
  ) as Record<ClipClass, { total: number; ready: number }>
  let ready = 0
  const entries = clipEntries(settings, fillerPool, toolPool)
  for (const e of entries) {
    byClass[e.cls].total++
    if (await store.read(e.key)) {
      ready++
      byClass[e.cls].ready++
    }
  }
  return { total: entries.length, ready, byClass }
}

/** Bytes de um clipe só se ele é da definição atual (senão null — nunca toca clipe velho). */
export async function loadCurrentClipAudio(
  store: ClipStore,
  settings: TtsSettings,
  fillerPool: readonly FillerPhrase[] | null | undefined,
  cls: ClipClass,
  n: number,
  toolPool?: readonly ToolPhrase[] | null
): Promise<{ audio: Uint8Array; mime: string } | null> {
  if (!CLIP_CLASSES.includes(cls)) return null
  const count = clipPhraseSet(fillerPool, toolPool)[cls].length
  if (!Number.isInteger(n) || n < 1 || n > count) return null
  return store.read(
    clipKey(clipVoiceId(settings), clipClassHash(settings, cls, fillerPool, toolPool), cls, n)
  )
}

/**
 * Gera (sintetiza) os clipes da voz que faltam (preâmbulos e frases de ferramenta) e apaga os de
 * definições velhas DESTA voz — os de outras vozes (personas) ficam. `synth` = a mesma síntese da
 * chamada (bytes completos). Progresso por clipe; cancelável. Só com o clique do usuário.
 */
export async function generateClips(opts: {
  store: ClipStore
  settings: TtsSettings
  fillerPool?: readonly FillerPhrase[] | null
  toolPool?: readonly ToolPhrase[] | null
  synth: (text: string, signal: AbortSignal) => Promise<{ audio: Uint8Array; mime: string }>
  signal?: AbortSignal
  onProgress?: (done: number, total: number) => void
}): Promise<{ total: number; generated: number }> {
  const entries = clipEntries(opts.settings, opts.fillerPool, opts.toolPool)
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
  await opts.store.prune(
    entries.map((e) => e.key),
    clipVoiceId(opts.settings)
  )
  return { total: entries.length, generated }
}

/** Store em memória (testes e fallback). */
export function memoryClipStore(): ClipStore & { keys(): string[] } {
  const m = new Map<string, { audio: Uint8Array; mime: string }>()
  return {
    read: async (k) => m.get(k) ?? null,
    write: async (k, c) => void m.set(k, c),
    prune: async (keep, voiceId) => {
      for (const k of [...m.keys()]) if (prunable(k, keep, voiceId)) m.delete(k)
    },
    keys: () => [...m.keys()]
  }
}
