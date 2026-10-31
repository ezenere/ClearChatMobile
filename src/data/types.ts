// Formatos do sync (SYNC_PROTOCOL.md §4, §7, §8.2) que o cliente mobile lê e grava.
import type { Envelope } from '@/crypto'

/** Mudança de registro (§7.2). */
export interface Change {
  seq: number
  type: string
  id: string
  scope: string | null
  rev: number
  deleted: boolean
  env?: Envelope
  omitted?: true
  size: number
  blobs: string[]
  device_id: string
  updated_at: string
}

export interface PullPage {
  changes: Change[]
  next: number
  has_more: boolean
  head: number
}

export interface RecordsPage {
  records: Change[]
  next?: number
  has_more?: boolean
  head?: number
}

export interface PushItem {
  type: string
  id: string
  scope: string | null
  base_rev: number
  rev: number
  deleted: boolean
  env?: Envelope
  blobs: string[]
}

export interface PushBody {
  push_id: string
  items: PushItem[]
  chat_bases?: Record<string, number>
  host_epochs?: Record<string, number>
}

export interface PushResult {
  results: { type: string; id: string; rev: number; seq: number }[]
  head: number
  chat_heads?: Record<string, number>
}

export interface PushConflict {
  type: string
  id: string
  reason: 'rev_mismatch' | 'gone' | 'scope_deleted' | 'scope_missing'
  current?: Change
}

/** Estado de host/divergência de um chat (§8.2). */
export interface ChatState {
  chat_id: string
  ssq: number
  epoch: number
  head: number
  pinned: boolean
  host: {
    device_id: string
    name: string
    platform: string
    status: 'online' | 'grace' | 'offline'
  } | null
  window: { purpose: 'run' | 'edit' | 'replay'; since: string } | null
  handover: unknown
  diverged: unknown
  event?: { kind: string; device_id?: string }
}

/** Tipos conhecidos (§4.2); o resto é guardado como opaco e ignorado. */
export const RECORD_TYPES = [
  'provider',
  'setting',
  'preset',
  'memory_collection',
  'memory',
  'chat',
  'session',
  'message',
  'skill'
] as const
export type RecordType = (typeof RECORD_TYPES)[number]
export const isRecordType = (t: string): t is RecordType =>
  (RECORD_TYPES as readonly string[]).includes(t)

/** Tipos LWW por campo (§7.5). */
export const FIELD_LWW: readonly string[] = [
  'provider',
  'preset',
  'memory_collection',
  'memory',
  'chat'
]

export type Plain = Record<string, unknown>

/** Plaintext do registro `chat` (§4.3.6) — campos que o mobile lê; o resto é preservado. */
export interface ChatPlain extends Plain {
  sv: 1
  title: string
  config: Record<string, unknown>
  mainSessionId: string
  createdAt: number
  updatedAt: number
  hostCwd?: { deviceId: string; path: string } | null
}

/** Plaintext do registro `preset` (§4.3.3). */
export interface PresetPlain extends Plain {
  name: string
  description: string
  icon: string
}
