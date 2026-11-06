// Preferências de localização DESTE aparelho (puro sobre o KeyValueStore; nunca sincronizam):
// precisão (aproximada/exata) e aprovação (perguntar/sempre/nunca). Ficam fora dos settings
// sincronizados de propósito: a localização é do aparelho, o modo "nunca" não existe nos modos de
// aprovação do protocolo e o desktop normaliza `approvalModes` descartando itens que não conhece.
import type { KeyValueStore } from '@/account/storage'
import type { Precision } from './geo'

export type LocationApproval = 'ask' | 'always' | 'never'

export interface LocationSettings {
  precision: Precision
  approval: LocationApproval
}

export const DEFAULT_LOCATION_SETTINGS: LocationSettings = {
  precision: 'approximate',
  approval: 'ask'
}

const KEYS = { precision: 'location.precision', approval: 'location.approval' } as const

export const PRECISION_LABEL: Record<Precision, string> = {
  approximate: 'Aproximada',
  exact: 'Exata'
}

export const APPROVAL_LABEL: Record<LocationApproval, string> = {
  ask: 'Perguntar',
  always: 'Sempre permitir',
  never: 'Nunca'
}

export const APPROVAL_HINT: Record<LocationApproval, string> = {
  ask: 'Pergunta a você a cada uso da localização',
  always: 'O agente usa a localização sem perguntar',
  never: 'O agente não recebe a localização (a busca de lugares só com um endereço ou coordenadas)'
}

export function readLocationSettings(kv: KeyValueStore): LocationSettings {
  const p = kv.get(KEYS.precision)
  const a = kv.get(KEYS.approval)
  return {
    precision: p === 'exact' ? 'exact' : 'approximate',
    approval: a === 'always' || a === 'never' ? a : 'ask'
  }
}

export function writeLocationSetting<K extends keyof LocationSettings>(
  kv: KeyValueStore,
  key: K,
  value: LocationSettings[K]
): void {
  kv.set(KEYS[key], value)
}

/** Loja com aviso (Configurações e card de aprovação). */
export class LocationPrefs {
  private snapshot: LocationSettings
  private listeners = new Set<() => void>()
  constructor(private readonly kv: KeyValueStore) {
    this.snapshot = readLocationSettings(kv)
  }
  get = (): LocationSettings => this.snapshot
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  set<K extends keyof LocationSettings>(key: K, value: LocationSettings[K]): void {
    writeLocationSetting(this.kv, key, value)
    this.snapshot = readLocationSettings(this.kv)
    for (const fn of [...this.listeners]) fn()
  }
}
