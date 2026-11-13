// Configurações sincronizadas (SYNC_PROTOCOL.md §4.3.1–4.3.3): plaintexts de `provider`, `preset` e
// `setting` montados com a mesma semântica do desktop (repo.ts/webSearchConfig.ts do main; o
// formulário do provedor vem vendorado de @shared/providerDraft), o patch LWW por campo (para `config` da persona, chave a
// chave, com as chaves removidas) e a lista de buscadores do web_search. Puro (sem React Native).
import { PROVIDER_KIND_DEFAULT_URL, providerKind, type ProviderKind } from '@shared/providerKinds'
import {
  PROVIDER_KIND_NAME,
  type ProviderDraft,
  type ProviderDraftInput
} from '@shared/providerDraft'
import { DEFAULT_CHAT_CONFIG, supportsCacheControl } from '@shared/defaults'
import { defaultModelRef, resolvePresetModel } from '@shared/models'
import { applyPreset, sanitizePresetConfig, withoutCwd, type PresetConfig } from '@shared/presets'
import type { ChatConfig, Provider } from '@shared/types'
import {
  ENGINE_META,
  isApiEngine,
  maskKey,
  normalizeEngines,
  normalizeKeys,
  type ApiEngineId,
  type EngineConfig,
  type SearchEngineId
} from '@shared/webSearchSettings'
import { CONFIG_UNSET } from '@/data/lww'
import type { Plain } from '@/data/types'

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const isObj = (v: unknown): v is Plain => !!v && typeof v === 'object' && !Array.isArray(v)

// ---------------- provedor (§4.3.1) ----------------

export {
  draftToInput,
  draftWithBaseUrl,
  draftWithKind,
  parseHeaders,
  type ProviderDraft
} from '@shared/providerDraft'
/** Entrada validada do formulário (= `ProviderInput` do desktop). */
export type ProviderInput = ProviderDraftInput

/** Rótulos curtos para o celular (o desktop diz "OpenAI-compatible (genérico)" etc.). */
export const KIND_SHORT: Record<ProviderKind, string> = {
  openai: 'OpenAI-compatible',
  openrouter: 'OpenRouter',
  anthropic: 'Anthropic',
  elevenlabs: 'ElevenLabs (voz)'
}

export const KIND_DESCRIPTION: Record<ProviderKind, string> = {
  openai: 'Qualquer API compatível com /chat/completions da OpenAI',
  openrouter: 'OpenAI-compatible + extras (custo, raciocínio, cache, PDF em qualquer modelo)',
  anthropic: 'POST /messages nativo: PDF, prompt caching, x-api-key',
  elevenlabs: 'Só voz (fala) — não aparece nos modelos de chat'
}

export function providerDraft(p?: Provider | null): ProviderDraft {
  if (p)
    return {
      name: p.name,
      kind: providerKind(p),
      kindTouched: true,
      baseUrl: p.baseUrl,
      apiKey: p.apiKey,
      headersText: Object.keys(p.headers ?? {}).length ? JSON.stringify(p.headers, null, 2) : ''
    }
  return {
    name: PROVIDER_KIND_NAME.openrouter,
    kind: 'openrouter',
    baseUrl: PROVIDER_KIND_DEFAULT_URL.openrouter,
    apiKey: '',
    headersText: ''
  }
}

/** Plaintext do registro (campos desconhecidos do registro atual preservados, §4.3). */
export function providerPlain(input: ProviderInput, prev: Plain | null, now: number): Plain {
  return {
    ...(prev ?? {}),
    sv: 1,
    name: input.name.trim() || 'Provider',
    kind: providerKind({ baseUrl: input.baseUrl, kind: input.kind }),
    baseUrl: input.baseUrl.trim().replace(/\/+$/, ''),
    apiKey: input.apiKey.trim(),
    headers: input.headers ?? {},
    createdAt: typeof prev?.createdAt === 'number' ? prev.createdAt : now
  }
}

/** "•••• abcd" (como a lista do desktop); sem chave → null. */
export function maskApiKey(key: string | null | undefined): string | null {
  const k = (key ?? '').trim()
  if (!k) return null
  return k.length < 8 ? '••••' : `•••• ${k.slice(-4)}`
}

// ---------------- persona (§4.3.3) ----------------

export interface PresetInput {
  name: string
  description: string
  icon: string
  config: PresetConfig
}

/** Plaintext da persona: `config` sanitizada e sem `cwd` (local do dispositivo, §4.4). */
export function presetPlain(input: PresetInput, prev: Plain | null, now: number): Plain {
  return {
    ...(prev ?? {}),
    sv: 1,
    name: input.name.trim() || (typeof prev?.name === 'string' ? prev.name : 'Persona'),
    description: (input.description ?? '').trim(),
    icon: (input.icon ?? '').trim(),
    config: withoutCwd(sanitizePresetConfig(input.config)),
    createdAt: typeof prev?.createdAt === 'number' ? prev.createdAt : now,
    updatedAt: now
  }
}

/**
 * Campos mudados de `prev` para `next` (§7.5), acumulados sobre o patch ainda não enviado. `config`
 * vai chave a chave: chaves mudadas em `config`, removidas em `__configUnset`.
 */
export function lwwPatch(prev: Plain | null, next: Plain, pending: Plain | null): Plain {
  const out: Plain = { ...(pending ?? {}) }
  for (const [k, v] of Object.entries(next)) {
    if (k === 'config') continue
    if (!prev || !same(prev[k], v)) out[k] = v
  }
  if (!isObj(next.config)) return out
  const a = isObj(prev?.config) ? prev.config : {}
  const b = next.config
  const cfg: Plain = isObj(out.config) ? { ...out.config } : {}
  const unset = new Set(Array.isArray(out[CONFIG_UNSET]) ? (out[CONFIG_UNSET] as string[]) : [])
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (same(a[k], b[k])) continue
    if (b[k] === undefined) {
      delete cfg[k]
      unset.add(k)
    } else {
      cfg[k] = b[k]
      unset.delete(k)
    }
  }
  if (!prev) {
    // registro novo: a config inteira
    out.config = b
    delete out[CONFIG_UNSET]
    return out
  }
  if (Object.keys(cfg).length) out.config = cfg
  else delete out.config
  if (unset.size) out[CONFIG_UNSET] = [...unset].sort()
  else delete out[CONFIG_UNSET]
  return out
}

/** Nome para uma cópia ("X (cópia)", "X (cópia 2)"…) — `copyName` do desktop. */
export { copyName } from '@shared/presets'

// ---------------- settings (§4.3.2) ----------------

/** Registro `setting`: `{ sv, value }` (null = removida; nunca tombstone). */
export const settingPlain = (value: unknown): Plain => ({ sv: 1, value: value ?? null })

// ---------------- pesquisa na web (webSearchEngines + webSearchApiKeys) ----------------

export interface EngineState extends EngineConfig {
  hasKey: boolean
  keyMask: string | null
  /** Só no computador (precisa de navegador): o celular pula no web_search. */
  desktopOnly: boolean
}

/** Lista para a tela (= `getWebSearchSettings` do desktop). */
export function engineStates(enginesRaw: unknown, keysRaw: unknown): EngineState[] {
  const keys = normalizeKeys(keysRaw)
  return normalizeEngines(enginesRaw, (id) => !!keys[id]).map((e) => {
    const key = isApiEngine(e.id) ? keys[e.id] : undefined
    return { ...e, hasKey: !!key, keyMask: maskKey(key), desktopOnly: e.id === 'brave-site' }
  })
}

const toConfig = (e: EngineConfig): EngineConfig => ({
  id: e.id,
  enabled: e.enabled,
  options: e.options
})

/**
 * Nova lista (ordem/liga-desliga/opções) = `updateWebSearchEngines`: ligar buscador com API sem
 * chave salva é recusado com texto legível. Devolve o valor do setting.
 */
export function enginesValue(list: EngineConfig[], keysRaw: unknown): EngineConfig[] | string {
  const keys = normalizeKeys(keysRaw)
  for (const e of list)
    if (e.enabled && e.id in ENGINE_META && isApiEngine(e.id) && !keys[e.id])
      return `Informe a chave de API para habilitar o ${ENGINE_META[e.id].label}.`
  return normalizeEngines(list.map(toConfig), (id) => !!keys[id])
}

/**
 * Salva (ou, vazia, remove) a chave de um buscador = `setWebSearchKey`: sem chave o buscador é
 * desligado. Devolve os dois settings (`keys` null = remover o setting).
 */
export function withEngineKey(
  id: SearchEngineId,
  key: string | null,
  keysRaw: unknown,
  enginesRaw: unknown
): { keys: Partial<Record<ApiEngineId, string>> | null; engines: EngineConfig[] } | string {
  if (!(id in ENGINE_META) || !isApiEngine(id)) return 'Este buscador não usa chave.'
  const keys = normalizeKeys(keysRaw)
  const v = typeof key === 'string' ? key.trim() : ''
  if (/\s/.test(v)) return 'A chave não pode conter espaços.'
  if (v) keys[id] = v
  else delete keys[id]
  return {
    keys: Object.keys(keys).length ? keys : null,
    engines: normalizeEngines(enginesRaw, (x) => !!keys[x]).map(toConfig)
  }
}

// ---------------- edição sobre uma versão que mudou enquanto o formulário estava aberto ----------------

/**
 * O formulário abriu com `base`; enquanto isso o registro virou `current` (outro dispositivo).
 * Salvar aplica só o que o usuário mudou (`edited` ≠ `base`) sobre `current` — campo a campo e,
 * em `config`, chave a chave —, para não desfazer a edição do outro lado.
 */
export function mergeEdits<T extends object>(current: T, base: T, edited: T): T {
  const c = current as Plain
  const b = base as Plain
  const e = edited as Plain
  const out: Plain = { ...c }
  for (const k of new Set([...Object.keys(b), ...Object.keys(e)])) {
    if (k === 'config' && isObj(e.config)) {
      const bc = isObj(b.config) ? b.config : {}
      const cfg: Plain = { ...(isObj(c.config) ? c.config : {}) }
      for (const ck of new Set([...Object.keys(bc), ...Object.keys(e.config)])) {
        if (same(bc[ck], e.config[ck])) continue
        if (e.config[ck] === undefined) delete cfg[ck]
        else cfg[ck] = e.config[ck]
      }
      out.config = cfg
      continue
    }
    if (!same(b[k], e[k])) {
      if (e[k] === undefined) delete out[k]
      else out[k] = e[k]
    }
  }
  return out as T
}

/** Entrada do formulário a partir do provedor salvo. */
export const providerInputOf = (p: Provider): ProviderInput => ({
  name: p.name,
  kind: providerKind(p),
  baseUrl: p.baseUrl,
  apiKey: p.apiKey,
  headers: p.headers ?? {}
})

// ---------------- persona resolvida (o que o editor mostra) ----------------

export interface DefaultsForPreset {
  defaultModel?: { providerId?: string | null; model?: string | null } | null
  defaultSystemPrompt?: string | null
}

/**
 * Config de um chat novo com a persona por cima (= `newChatBase` + `resolvePreset` do renderer do
 * desktop, sem pasta): o editor mostra o efetivo e grava só o que o usuário muda. A lista de tools é
 * a mesma em todo aparelho (§4.3.6): as do computador valem quando o chat roda num computador.
 */
export function resolvePresetConfig(
  defaults: DefaultsForPreset,
  providers: Provider[],
  config: PresetConfig | null | undefined
): { cfg: ChatConfig; missingProvider: boolean } {
  const chat = providers.filter((p) => providerKind(p) !== 'elevenlabs')
  const ids = chat.map((p) => p.id)
  const ref = defaultModelRef(
    {
      defaultProviderId: defaults.defaultModel?.providerId,
      defaultModel: defaults.defaultModel?.model
    },
    ids
  )
  const prov = chat.find((p) => p.id === ref.providerId)
  const base = DEFAULT_CHAT_CONFIG('', {
    providerId: ref.providerId,
    model: ref.model,
    systemPrompt: defaults.defaultSystemPrompt ?? undefined,
    baseUrl: prov?.baseUrl,
    kind: prov ? providerKind(prov) : undefined
  })
  const cfg = applyPreset(base, config)
  const r = resolvePresetModel({ providerId: base.providerId, model: base.model }, config, ids)
  cfg.providerId = r.ref.providerId
  cfg.model = r.ref.model
  if (config?.cacheEnabled === undefined) {
    const p = chat.find((x) => x.id === cfg.providerId)
    if (p) cfg.cacheEnabled = supportsCacheControl(providerKind(p))
  }
  return { cfg, missingProvider: r.missingProvider }
}
