// Clipes da chamada de voz no celular (preâmbulos, frases de ferramenta e "obrigado por aguardar") — adaptação de
// ClearChatDesktop/src/main/voice/clips.ts (shim gerado em src/vendor/desktop/voice/clips.ts: o
// `VoiceCallManager` vendorado importa daqui o tipo `ClipClass`). O desktop grava os clipes em
// `<userData>/voice-clips/<voz>/<configuração>` com node:fs + hash-wasm; aqui a MESMA definição (o
// pool da classe, voz, modelo, parâmetros) vira um hash POR CLASSE e os bytes ficam num `ClipStore`
// injetado (no aparelho: `Documents/voice-clips/`, `src/voice/native.ts`) — o cache é por
// CONFIGURAÇÃO de voz (`clipScope` = voz + os 16 hex de `clipConfigKey`, a mesma chave do desktop:
// provedor, modelo, voz, parâmetros): a voz deste aparelho e a de uma persona com o MESMO id de voz
// mas outro modelo/instruções convivem (antes a geração de uma apagava as chaves `<voz>__…` da outra
// e cada lado via o outro "faltando"). Classes: `FILLER` (o pool de preâmbulos), `TOOL` (as frases
// de ferramenta) e `THANKS` (o "obrigado por aguardar" — `delayPhrases.thanksPool`); mudar as frases
// de uma classe não invalida as outras (hash por classe — o de `FILLER` é o mesmo de antes). Clipe
// ausente ou de definição velha → null: o preâmbulo não toca; a frase de ferramenta e o
// agradecimento são sintetizados ao vivo (= desktop). Chaves do formato anterior (`<voz>__<hash>…`,
// sem a configuração — o hash da classe já era da configuração) continuam tocando e são copiadas
// para a chave nova na próxima geração, sem sintetizar. Limpeza (`pruneClips`, depois de cada
// geração): as vozes em uso (a daqui, as das personas/chats, a da chamada) nunca perdem clipes; um
// conjunto sem voz em uso e sem uso há `CLIP_UNUSED_MAX_AGE_MS` sai. Classes antigas (interjeições
// "Uhum/Aham", saíram em 2026-11-12) contam como velhas e somem na limpeza. Clipes só são gerados
// com o clique do usuário (uma API paga). Sem React Native (testável no Node).
//
// Mudança sugerida no desktop: mover a parte pura de clips.ts para um módulo sem node:fs (ex.:
// `clipsCore.ts`) para o celular vendorar em vez de copiar.
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import {
  DELAY_PHRASE_POOL_MAX,
  FILLER_POOL_MAX,
  resolveFillerPool,
  resolveThanksPool,
  resolveToolPhrasePool,
  TOOL_PHRASE_POOL_MAX,
  type FillerPhrase,
  type ToolPhrase,
  type TtsSettings
} from '@shared/voice'
import { resolveGpuParams } from '@shared/gpuVoice'

/**
 * Classes de clipes (= desktop): `FILLER` (preâmbulo pós-turno), `TOOL` (frase da 1ª tool) e
 * `THANKS` ("Obrigado por aguardar." antes da resposta que demorou — pronto na hora).
 */
export type ClipClass = 'FILLER' | 'TOOL' | 'THANKS'
export const CLIP_CLASSES: readonly ClipClass[] = ['FILLER', 'TOOL', 'THANKS']

/** Teto do `<n>` (= desktop: o maior pool — preâmbulos, frases de ferramenta ou agradecimentos). */
export const CLIP_MAX_VARIANTS = Math.max(
  FILLER_POOL_MAX,
  TOOL_PHRASE_POOL_MAX,
  DELAY_PHRASE_POOL_MAX
)

/**
 * Conjunto completo por classe, na ordem dos pools: `FILLER` = o pool de preâmbulos, `TOOL` = as
 * frases de ferramenta, `THANKS` = o "obrigado por aguardar" (null = os padrões).
 */
export function clipPhraseSet(
  fillerPool?: readonly FillerPhrase[] | null,
  toolPool?: readonly ToolPhrase[] | null,
  thanksPool?: readonly string[] | null
): Record<ClipClass, readonly string[]> {
  return {
    FILLER: resolveFillerPool(fillerPool ? [...fillerPool] : null).map((f) => f.text),
    TOOL: resolveToolPhrasePool(toolPool ? [...toolPool] : null).map((f) => f.text),
    THANKS: resolveThanksPool(thanksPool)
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
 * O que muda o SOM dos clipes além das frases (= `clipConfigPayload` do desktop): backend; na API
 * o provedor (id + tipo), o modelo, a voz e os parâmetros do modelo (`api.params`, sem o
 * `auto_mode` da ElevenLabs); no local o motor e a voz; na GPU motor, voz, passos e parâmetros.
 * NÃO entram endereço/chave/headers (a assinatura de app varia por chat sem mudar o som),
 * `elevenLabsWs` e `installed`. Puro.
 */
export function clipConfigPayload(settings: TtsSettings): Record<string, unknown> {
  if (settings.backend === 'local')
    return {
      backend: 'local',
      engine: settings.local?.engine ?? 'kokoro',
      voice: settings.local?.voice ?? null
    }
  if (settings.backend === 'gpu') {
    const g = settings.gpu
    return {
      backend: 'gpu',
      engine: g?.engine ?? null,
      voice: g?.voice ?? null,
      steps: g?.steps ?? null,
      params: g ? resolveGpuParams(g.engine, g.params?.[g.engine]) : null
    }
  }
  const api = settings.api
  return {
    backend: 'api',
    providerId: api.providerId?.trim() || null,
    providerKind: api.providerKind ?? null,
    model: api.model.trim(),
    voice: (api.voice ?? '').trim() || null,
    params: soundApiParams(api.params) ?? null
  }
}

/** `api.params` só com o que muda o som (sem `elevenlabs.auto_mode`, famílias vazias fora). */
function soundApiParams(params: TtsSettings['api']['params']): Record<string, unknown> | null {
  if (!params) return null
  const p = JSON.parse(JSON.stringify(params)) as Record<string, Record<string, unknown>>
  if (p.elevenlabs) delete p.elevenlabs.auto_mode
  for (const k of Object.keys(p)) if (!p[k] || !Object.keys(p[k]).length) delete p[k]
  return Object.keys(p).length ? p : null
}

/** JSON com as chaves ordenadas (a ordem em que a UI gravou os parâmetros não muda a chave). */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`)
      .join(',')}}`
  return JSON.stringify(v ?? null)
}

/** Chave (sha256 hex) da configuração de voz — o mesmo valor do `clipConfigKey` do desktop. */
export function clipConfigKey(settings: TtsSettings): string {
  return bytesToHex(
    sha256(new TextEncoder().encode(stableJson({ v: 1, ...clipConfigPayload(settings) })))
  )
}

/** Nome guardável de uma chave (o mesmo saneamento do store em arquivos). */
export const safeClipKey = (key: string): string => key.replace(/[^A-Za-z0-9_-]/g, '_')

/**
 * Conjunto de clipes de uma configuração de voz: `<voz>__<16 hex de clipConfigKey>` — o prefixo
 * das chaves dela (a mesma voz efetiva dá sempre o mesmo conjunto: tela, editor, dock e chamada).
 */
export function clipScope(settings: TtsSettings, ownKey?: string | null): string {
  const base = `${clipVoiceId(settings)}__${clipConfigKey(settings).slice(0, 16)}`
  return safeClipKey(ownKey ? `${base}-${ownKey}` : base)
}

/**
 * Pools PRÓPRIOS de uma persona/chat (protocolo 1.18.0 — `effectivePhrasePools`): quais classes vêm
 * deles. Com algum, os clipes ganham um conjunto próprio (o escopo leva o hash dos pools próprios) —
 * gerar os do aparelho não apaga os da persona com a mesma voz (= desktop, pasta própria).
 */
export interface ClipOwnPools {
  filler: boolean
  tool: boolean
}

/** Hash curto (8 hex) dos pools próprios; null = nenhum (o conjunto de sempre da voz). */
export function ownPoolsKey(
  own: ClipOwnPools | null | undefined,
  fillerPool?: readonly FillerPhrase[] | null,
  toolPool?: readonly ToolPhrase[] | null
): string | null {
  if (!own || (!own.filler && !own.tool)) return null
  const set = clipPhraseSet(fillerPool, toolPool, null)
  return bytesToHex(
    sha256(
      new TextEncoder().encode(
        stableJson({
          v: 1,
          ...(own.filler ? { FILLER: set.FILLER } : {}),
          ...(own.tool ? { TOOL: set.TOOL } : {})
        })
      )
    )
  ).slice(0, 8)
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
  toolPool?: readonly ToolPhrase[] | null,
  thanksPool?: readonly string[] | null
): string {
  return phrasesHash(settings, { [cls]: clipPhraseSet(fillerPool, toolPool, thanksPool)[cls] })
}

/** Hash da definição inteira (todas as classes) — muda com a voz ou qualquer pool. */
export function clipsHash(
  settings: TtsSettings,
  fillerPool?: readonly FillerPhrase[] | null,
  toolPool?: readonly ToolPhrase[] | null,
  thanksPool?: readonly string[] | null
): string {
  return phrasesHash(settings, clipPhraseSet(fillerPool, toolPool, thanksPool))
}

/**
 * Onde os bytes dos clipes ficam (aparelho: arquivos; testes: memória). As chaves chegam já
 * guardáveis (`safeClipKey`) e `list` devolve as guardadas no mesmo formato.
 */
export interface ClipStore {
  read(key: string): Promise<{ audio: Uint8Array; mime: string } | null>
  write(key: string, clip: { audio: Uint8Array; mime: string }): Promise<void>
  /** Todas as chaves guardadas (limpeza). */
  list(): Promise<string[]>
  /** Apaga estas chaves (idempotente). */
  remove(keys: readonly string[]): Promise<void>
  /** Último uso de cada conjunto (`clipScope` → epoch ms), guardado junto dos clipes. */
  readUsage(): Promise<Record<string, number>>
  writeUsage(usage: Record<string, number>): Promise<void>
}

function checkClip(cls: ClipClass, n: number): void {
  if (!CLIP_CLASSES.includes(cls)) throw new Error(`classe de clipe desconhecida: ${cls}`)
  if (!Number.isInteger(n) || n < 1 || n > CLIP_MAX_VARIANTS)
    throw new Error(`variante de clipe inválida: ${n}`)
}

/**
 * Chave de um clipe: conjunto da configuração (`clipScope`) + hash da classe + classe + variante
 * (nada de texto livre no nome).
 */
export function clipKey(scope: string, hash: string, cls: ClipClass, n: number): string {
  checkClip(cls, n)
  return safeClipKey(`${scope}__${hash.slice(0, 24)}_${cls}_${n}`)
}

/**
 * Chave do formato anterior (`<voz>__<hash da classe>_<CLASSE>_<n>`, sem a configuração): o hash
 * da classe já cobria voz/modelo/parâmetros, então o clipe vale para a configuração que o gerou —
 * lido como reserva e copiado para a chave nova na próxima geração.
 */
export function legacyClipKey(voiceId: string, hash: string, cls: ClipClass, n: number): string {
  checkClip(cls, n)
  return safeClipKey(`${voiceId}__${hash.slice(0, 24)}_${cls}_${n}`)
}

const NEW_KEY_RE = /^(.+__[0-9a-f]{16}(?:-[0-9a-f]{8})?)__[0-9a-f]{24}_[A-Z]+_\d+$/
const LEGACY_KEY_RE = /^(.+)__[0-9a-f]{24}_[A-Z]+_\d+$/
/** O formato mais antigo (`<hash>_<CLASSE>_<n>`, sem a voz): não vale para ninguém. */
const ANCIENT_KEY_RE = /^[0-9a-f]{24}_[A-Z]+_\d+$/

/**
 * Conjunto de uma chave guardada: `clipScope` no formato novo, `legacy:<voz>` no anterior, null
 * no mais antigo (sem a voz) e em nomes desconhecidos.
 */
function scopeOfKey(key: string): string | null {
  const m = NEW_KEY_RE.exec(key)
  if (m) return m[1]
  const l = LEGACY_KEY_RE.exec(key)
  return l ? `legacy:${l[1]}` : null
}

/** Uma entrada da definição atual: a chave, a do formato anterior, classe, variante e texto. */
export interface ClipEntry {
  key: string
  legacyKey: string
  cls: ClipClass
  n: number
  text: string
}

/** Todas as chaves da definição atual (classe, variante, texto) — a chave leva o hash da classe. */
export function clipEntries(
  settings: TtsSettings,
  fillerPool?: readonly FillerPhrase[] | null,
  toolPool?: readonly ToolPhrase[] | null,
  thanksPool?: readonly string[] | null,
  own?: ClipOwnPools | null
): ClipEntry[] {
  const set = clipPhraseSet(fillerPool, toolPool, thanksPool)
  const voice = clipVoiceId(settings)
  const ownKey = ownPoolsKey(own, fillerPool, toolPool)
  const scope = clipScope(settings, ownKey)
  return CLIP_CLASSES.flatMap((cls) => {
    const hash = clipClassHash(settings, cls, fillerPool, toolPool, thanksPool)
    return set[cls].map((text, i) => ({
      key: clipKey(scope, hash, cls, i + 1),
      // o formato anterior é sempre dos pools do aparelho (pools próprios nasceram depois)
      legacyKey: ownKey ? clipKey(scope, hash, cls, i + 1) : legacyClipKey(voice, hash, cls, i + 1),
      cls,
      n: i + 1,
      text
    }))
  })
}

/** Bytes de uma entrada: a chave nova ou, sem ela, a do formato anterior (mesma definição). */
async function readEntry(
  store: ClipStore,
  e: Pick<ClipEntry, 'key' | 'legacyKey'>
): Promise<{ audio: Uint8Array; mime: string } | null> {
  return (await store.read(e.key)) ?? (await store.read(e.legacyKey))
}

/** Conjunto sem voz em uso e sem uso há mais que isto sai na limpeza. */
export const CLIP_UNUSED_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
/** A marca de uso é regravada no máximo 1× por isto por conjunto (a chamada lê clipes o tempo todo). */
const USAGE_THROTTLE_MS = 60 * 60 * 1000
const usageWritten = new WeakMap<ClipStore, Map<string, number>>()

/** Marca o conjunto como usado agora (tocado, conferido ou gerado); falha = ignora. */
async function markUsed(store: ClipStore, scope: string, force = false): Promise<void> {
  const now = Date.now()
  let seen = usageWritten.get(store)
  if (!seen) usageWritten.set(store, (seen = new Map()))
  const last = seen.get(scope)
  if (!force && last !== undefined && now - last < USAGE_THROTTLE_MS) return
  seen.set(scope, now)
  try {
    const usage = await store.readUsage()
    await store.writeUsage({ ...usage, [scope]: now })
  } catch {
    // a marca não é essencial
  }
}

/** Estado dos clipes da voz (CTA "Gerar clipes"): no total e por classe. */
export async function clipsStatus(
  store: ClipStore,
  settings: TtsSettings,
  fillerPool?: readonly FillerPhrase[] | null,
  toolPool?: readonly ToolPhrase[] | null,
  thanksPool?: readonly string[] | null,
  own?: ClipOwnPools | null
): Promise<{
  total: number
  ready: number
  byClass: Record<ClipClass, { total: number; ready: number }>
}> {
  const byClass = Object.fromEntries(
    CLIP_CLASSES.map((c) => [c, { total: 0, ready: 0 }])
  ) as Record<ClipClass, { total: number; ready: number }>
  let ready = 0
  const entries = clipEntries(settings, fillerPool, toolPool, thanksPool, own)
  for (const e of entries) {
    byClass[e.cls].total++
    if (await readEntry(store, e)) {
      ready++
      byClass[e.cls].ready++
    }
  }
  if (ready) await markUsed(store, clipScope(settings, ownPoolsKey(own, fillerPool, toolPool)))
  return { total: entries.length, ready, byClass }
}

/** Bytes de um clipe só se ele é da definição atual (senão null — nunca toca clipe velho). */
export async function loadCurrentClipAudio(
  store: ClipStore,
  settings: TtsSettings,
  fillerPool: readonly FillerPhrase[] | null | undefined,
  cls: ClipClass,
  n: number,
  toolPool?: readonly ToolPhrase[] | null,
  thanksPool?: readonly string[] | null,
  own?: ClipOwnPools | null
): Promise<{ audio: Uint8Array; mime: string } | null> {
  if (!CLIP_CLASSES.includes(cls)) return null
  const count = clipPhraseSet(fillerPool, toolPool, thanksPool)[cls].length
  if (!Number.isInteger(n) || n < 1 || n > count) return null
  const hash = clipClassHash(settings, cls, fillerPool, toolPool, thanksPool)
  const ownKey = ownPoolsKey(own, fillerPool, toolPool)
  const scope = clipScope(settings, ownKey)
  const key = clipKey(scope, hash, cls, n)
  const clip = await readEntry(store, {
    key,
    legacyKey: ownKey ? key : legacyClipKey(clipVoiceId(settings), hash, cls, n)
  })
  if (clip) await markUsed(store, scope)
  return clip
}

/**
 * Gera (sintetiza) os clipes da configuração de voz que faltam (preâmbulos, frases de ferramenta e
 * agradecimentos) — os do formato anterior desta configuração são copiados, sem sintetizar — e
 * apaga os de definições velhas DESTA configuração; os de outras configurações (outra persona,
 * mesma voz com outro modelo/instruções) ficam. `synth` = a mesma síntese da chamada (bytes
 * completos). Progresso por clipe; cancelável. Só com o clique do usuário.
 */
export async function generateClips(opts: {
  store: ClipStore
  settings: TtsSettings
  fillerPool?: readonly FillerPhrase[] | null
  toolPool?: readonly ToolPhrase[] | null
  thanksPool?: readonly string[] | null
  /** Quais pools são próprios da persona/chat (conjunto próprio — `ownPoolsKey`). */
  own?: ClipOwnPools | null
  synth: (text: string, signal: AbortSignal) => Promise<{ audio: Uint8Array; mime: string }>
  signal?: AbortSignal
  onProgress?: (done: number, total: number) => void
}): Promise<{ total: number; generated: number }> {
  const entries = clipEntries(
    opts.settings,
    opts.fillerPool,
    opts.toolPool,
    opts.thanksPool,
    opts.own
  )
  const scope = clipScope(opts.settings, ownPoolsKey(opts.own, opts.fillerPool, opts.toolPool))
  const signal = opts.signal ?? new AbortController().signal
  let done = 0
  let generated = 0
  opts.onProgress?.(0, entries.length)
  for (const e of entries) {
    if (signal.aborted) throw new Error('cancelado')
    if (!(await opts.store.read(e.key))) {
      const old = await opts.store.read(e.legacyKey)
      if (old) await opts.store.write(e.key, old)
      else {
        const clip = await opts.synth(e.text, signal)
        await opts.store.write(e.key, clip)
        generated++
      }
    }
    opts.onProgress?.(++done, entries.length)
  }
  // velhos DESTA configuração e os do formato mais antigo (sem a voz — não valem para ninguém)
  const keep = new Set(entries.map((e) => e.key))
  const stale = (await opts.store.list()).filter(
    (k) => ANCIENT_KEY_RE.test(k) || (k.startsWith(`${scope}__`) && !keep.has(k))
  )
  await opts.store.remove(stale)
  await markUsed(opts.store, scope, true)
  return { total: entries.length, generated }
}

/**
 * Limpeza (armazenamento limitado): `keep` = as settings RESOLVIDAS (`resolveTts`) de toda voz em
 * uso — a deste aparelho, as das personas/chats e a da chamada. Os clipes da definição atual delas
 * (inclusive os do formato anterior) nunca saem; os velhos delas (frases que mudaram) e os do
 * formato mais antigo (sem a voz na chave) saem já; um conjunto que nenhuma delas usa ganha uma
 * marca na 1ª vez que é visto e sai quando fica `maxAgeMs` sem uso. Nomes desconhecidos ficam.
 */
export async function pruneClips(
  store: ClipStore,
  opts: {
    keep: readonly TtsSettings[]
    fillerPool?: readonly FillerPhrase[] | null
    toolPool?: readonly ToolPhrase[] | null
    thanksPool?: readonly string[] | null
    maxAgeMs?: number
    now?: number
  }
): Promise<{ removed: string[] }> {
  const now = opts.now ?? Date.now()
  const maxAge = opts.maxAgeMs ?? CLIP_UNUSED_MAX_AGE_MS
  const keepScopes = new Set<string>()
  const keepKeys = new Set<string>()
  for (const s of opts.keep) {
    keepScopes.add(clipScope(s))
    for (const e of clipEntries(s, opts.fillerPool, opts.toolPool, opts.thanksPool)) {
      keepKeys.add(e.key)
      keepKeys.add(e.legacyKey)
    }
  }
  const usage = { ...(await store.readUsage()) }
  const remove: string[] = []
  const groups = new Map<string, string[]>()
  for (const k of await store.list()) {
    if (keepKeys.has(k)) continue
    if (ANCIENT_KEY_RE.test(k)) {
      remove.push(k) // formato mais antigo (sem a voz): não vale para ninguém
      continue
    }
    const scope = scopeOfKey(k)
    if (!scope) continue
    if (keepScopes.has(scope)) {
      remove.push(k) // definição velha de uma configuração em uso
      continue
    }
    groups.set(scope, [...(groups.get(scope) ?? []), k])
  }
  for (const [scope, keys] of groups) {
    const t = usage[scope]
    if (t === undefined)
      usage[scope] = now // 1ª vez vista sem voz em uso: começa a contar
    else if (now - t > maxAge) {
      remove.push(...keys)
      delete usage[scope]
    }
  }
  for (const scope of Object.keys(usage))
    if (!groups.has(scope) && !keepScopes.has(scope)) delete usage[scope]
  await store.remove(remove)
  await store.writeUsage(usage)
  return { removed: remove }
}

/** Store em memória (testes e fallback) — as chaves saneadas como no store em arquivos. */
export function memoryClipStore(): ClipStore & { keys(): string[] } {
  const m = new Map<string, { audio: Uint8Array; mime: string }>()
  let usage: Record<string, number> = {}
  return {
    read: async (k) => m.get(safeClipKey(k)) ?? null,
    write: async (k, c) => void m.set(safeClipKey(k), c),
    list: async () => [...m.keys()],
    remove: async (keys) => {
      for (const k of keys) m.delete(safeClipKey(k))
    },
    readUsage: async () => ({ ...usage }),
    writeUsage: async (u) => void (usage = { ...u }),
    keys: () => [...m.keys()]
  }
}
