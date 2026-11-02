// Configurações no celular: provedores, personas, settings sincronizados (§4.3.1–4.3.3) e memórias
// (§4.3.4–4.3.5). Toda escrita vai ao cache na hora e sobe pela outbox LWW persistida
// (`LwwWriter`, a mesma das memórias): funciona offline e, num conflito, os campos mudados aqui são
// reaplicados sobre a versão do servidor (setting = LWW inteiro). As memórias passam pelo
// MemoryStore vendorado do desktop (validações, slugs) sobre o índice local. Sem React Native.
import { MemoryError, type MemoryStore } from '@vendor/desktop/memory/store'
import type {
  Memory,
  MemoryCollection,
  MemoryCollectionInput,
  MemoryCollectionPatch,
  MemoryInput,
  MemoryPatch
} from '@shared/memory'
import { DEFAULT_PRESET_SETTING } from '@shared/presets'
import {
  SEARCH_ENGINES_SETTING,
  SEARCH_INTERVAL_SETTING,
  SEARCH_KEYS_SETTING,
  normalizeSearchInterval,
  type EngineConfig,
  type SearchEngineId
} from '@shared/webSearchSettings'
import type { Preset, Provider } from '@shared/types'
import { UserError } from '@/account/errors'
import type { LwwWriter } from '@/data/lww'
import type { LocalStore } from '@/data/store'
import type { Plain } from '@/data/types'
import { providerFromPlain } from '@/host/stack'
import { presetFromPlain } from '@/host/newChat'
import {
  copyName,
  engineStates,
  enginesValue,
  lwwPatch,
  mergeEdits,
  presetPlain,
  providerInputOf,
  providerPlain,
  settingPlain,
  withEngineKey,
  type EngineState,
  type PresetInput,
  type ProviderInput
} from './records'

export interface SettingsDeps {
  store: LocalStore
  /** Outbox LWW (a mesma da memória). */
  writer: Pick<LwwWriter, 'write'>
  /** Índice local da memória (MemoryStore do desktop sobre ele; `reset` remonta dos registros). */
  memory: { readonly store: MemoryStore; reset(): void }
  /** Configuração gravada aqui (as telas recarregam; `list` = a lista de chats também). */
  notify?: (list: boolean) => void
  /** Provedor salvo/apagado: esquece a lista de modelos em cache. */
  invalidateModels?: (providerId: string) => void
  now?: () => number
  uuid?: () => string
}

type Ref = { type: 'provider' | 'preset' | 'setting'; id: string }

export class SettingsService {
  private readonly d: SettingsDeps

  constructor(deps: SettingsDeps) {
    this.d = deps
  }

  private now(): number {
    return this.d.now?.() ?? Date.now()
  }

  private uuid(): string {
    return this.d.uuid?.() ?? crypto.randomUUID()
  }

  /** Grava a revisão (cache + outbox) com só os campos mudados como "sujos". */
  private put(ref: Ref, next: Plain): void {
    const store = this.d.store
    const prev = store.getPlain(ref.type, ref.id)
    const pending = store.lwwPatch(ref.type, ref.id)
    const patch =
      ref.type === 'setting'
        ? next
        : lwwPatch(prev, next, pending && !pending.__deleted ? pending : null)
    this.d.writer.write({ type: ref.type, id: ref.id, scope: null, plain: next, patch })
  }

  private remove(ref: Ref): void {
    if (!this.d.store.getPlain(ref.type, ref.id)) return
    this.d.writer.write({ type: ref.type, id: ref.id, scope: null, plain: null, patch: {} })
  }

  // ---------------- provedores ----------------

  providers(): Provider[] {
    return this.d.store
      .plainsOf('provider')
      .map((r) => providerFromPlain(r.id, r.plain))
      .sort((a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name))
  }

  provider(id: string): Provider | null {
    const p = this.d.store.getPlain('provider', id)
    return p ? providerFromPlain(id, p) : null
  }

  /**
   * Cria (sem `id`) ou edita. Com `base` (o que o formulário mostrou ao abrir), só os campos
   * mudados pelo usuário vão sobre a versão atual. Devolve o id.
   */
  saveProvider(input: ProviderInput, id?: string, base?: ProviderInput): string {
    const pid = id ?? this.uuid()
    const prev = id ? this.d.store.getPlain('provider', id) : null
    if (id && !prev) throw new UserError('Este provedor foi apagado.')
    const edited =
      prev && base ? mergeEdits(providerInputOf(providerFromPlain(pid, prev)), base, input) : input
    this.put({ type: 'provider', id: pid }, providerPlain(edited, prev, this.now()))
    this.d.invalidateModels?.(pid)
    this.d.notify?.(false)
    return pid
  }

  deleteProvider(id: string): void {
    this.remove({ type: 'provider', id })
    this.d.invalidateModels?.(id)
    this.d.notify?.(false)
  }

  // ---------------- personas ----------------

  presets(): Preset[] {
    return this.d.store
      .plainsOf('preset')
      .map((r) => presetFromPlain(r.id, r.plain))
      .sort((a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name, 'pt-BR'))
  }

  preset(id: string): Preset | null {
    const p = this.d.store.getPlain('preset', id)
    return p ? presetFromPlain(id, p) : null
  }

  /** Cria ou edita; com `base`, só o que o usuário mudou vai sobre a versão atual. */
  savePreset(input: PresetInput, id?: string, base?: PresetInput): Preset {
    if (!input.name.trim()) throw new UserError('Dê um nome à persona.')
    const pid = id ?? this.uuid()
    const prev = id ? this.d.store.getPlain('preset', id) : null
    if (id && !prev) throw new UserError('Esta persona foi apagada.')
    let edited = input
    if (prev && base) {
      const cur = presetFromPlain(pid, prev)
      edited = mergeEdits(
        { name: cur.name, description: cur.description, icon: cur.icon, config: cur.config },
        base,
        input
      )
    }
    const plain = presetPlain(edited, prev, this.now())
    this.put({ type: 'preset', id: pid }, plain)
    this.d.notify?.(true)
    return presetFromPlain(pid, plain)
  }

  duplicatePreset(id: string): Preset {
    const cur = this.preset(id)
    if (!cur) throw new UserError('Esta persona foi apagada.')
    return this.savePreset({
      name: copyName(cur.name, this.presets()),
      description: cur.description,
      icon: cur.icon,
      config: cur.config
    })
  }

  /** Apaga a persona; se era a padrão do Novo chat, a padrão volta a "nenhuma" (= desktop). */
  deletePreset(id: string): void {
    this.remove({ type: 'preset', id })
    if (this.setting(DEFAULT_PRESET_SETTING) === id) this.setSetting(DEFAULT_PRESET_SETTING, null)
    this.d.notify?.(true)
  }

  // ---------------- settings (LWW inteiro) ----------------

  setting<T = unknown>(id: string): T | undefined {
    return this.d.store.setting<T>(id)
  }

  /** Grava um setting sincronizado (`null` = removido; o registro nunca é apagado, §4.3.2). */
  setSetting(id: string, value: unknown): void {
    const cur = this.d.store.getPlain('setting', id)
    if (cur && JSON.stringify(cur.value ?? null) === JSON.stringify(value ?? null)) return
    this.put({ type: 'setting', id }, { ...(cur ?? {}), ...settingPlain(value) })
    this.d.notify?.(false)
  }

  // ---------------- pesquisa na web ----------------

  engines(): EngineState[] {
    return engineStates(this.setting(SEARCH_ENGINES_SETTING), this.setting(SEARCH_KEYS_SETTING))
  }

  setEngines(list: EngineConfig[]): void {
    const v = enginesValue(list, this.setting(SEARCH_KEYS_SETTING))
    if (typeof v === 'string') throw new UserError(v)
    this.setSetting(SEARCH_ENGINES_SETTING, v)
  }

  /** Salva (ou, vazia, remove) a chave de API; sem chave o buscador é desligado. */
  setEngineKey(id: SearchEngineId, key: string | null): void {
    const r = withEngineKey(
      id,
      key,
      this.setting(SEARCH_KEYS_SETTING),
      this.setting(SEARCH_ENGINES_SETTING)
    )
    if (typeof r === 'string') throw new UserError(r)
    this.setSetting(SEARCH_KEYS_SETTING, r.keys)
    this.setSetting(SEARCH_ENGINES_SETTING, r.engines)
  }

  searchInterval(): number {
    return normalizeSearchInterval(this.setting(SEARCH_INTERVAL_SETTING))
  }

  setSearchInterval(seconds: number): void {
    this.setSetting(SEARCH_INTERVAL_SETTING, normalizeSearchInterval(seconds))
  }

  // ---------------- memórias ----------------

  private mem<T>(fn: (s: MemoryStore) => T): T {
    try {
      return fn(this.d.memory.store)
    } catch (e) {
      if (e instanceof MemoryError) throw new UserError(e.message, { cause: e })
      throw e
    }
  }

  collections(): MemoryCollection[] {
    return this.mem((s) => s.listCollections())
  }

  memories(collectionId?: string): Memory[] {
    return this.mem((s) => s.listMemories(collectionId ? { collectionId } : {})).sort(
      (a, b) => b.updatedAt - a.updatedAt
    )
  }

  /** Busca FTS (a mesma das tools de memória). */
  searchMemories(query: string, collectionId?: string): Memory[] {
    return this.mem((s) => s.listMemories({ query, ...(collectionId ? { collectionId } : {}) }))
  }

  memory(id: string): Memory | null {
    return this.mem((s) => s.getMemory(id))
  }

  createCollection(input: MemoryCollectionInput): MemoryCollection {
    return this.mem((s) => s.createCollection(input))
  }

  updateCollection(id: string, patch: MemoryCollectionPatch): MemoryCollection {
    return this.mem((s) => s.updateCollection(id, patch))
  }

  /**
   * Apaga a coleção e as memórias dela (§7.7: o servidor apaga as memórias do escopo; aqui a
   * cascata do cache faz o mesmo). O índice local remonta dos registros.
   */
  deleteCollection(id: string): void {
    if (!this.d.store.getPlain('memory_collection', id)) return
    this.d.writer.write({ type: 'memory_collection', id, scope: null, plain: null, patch: {} })
    this.d.memory.reset()
    this.d.notify?.(false)
  }

  createMemory(input: MemoryInput): Memory {
    return this.mem((s) => s.createMemory(input, { updatedBy: 'user' }))
  }

  updateMemory(id: string, patch: MemoryPatch): Memory {
    return this.mem((s) => s.updateMemory(id, patch, { updatedBy: 'user' }))
  }

  deleteMemory(id: string): void {
    this.mem((s) => s.deleteMemory(id))
  }
}
