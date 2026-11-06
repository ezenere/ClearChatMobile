// Lista "Ao vivo em <host>" (SYNC_PROTOCOL.md §23.4): o `live.list` depois de cada `welcome`
// substitui a lista inteira (eventos `live.*` antes do ack são descartados — já estão nele), os
// `live.update`/`live.removed`/`live.host` de depois são aplicados por cima, na ordem em que chegam
// (uma fila só, porque decifrar é assíncrono). Dentro de um epoch, `arev` menor ou igual à conhecida
// é ignorada (anti-replay); epoch novo = espelho descartado. Itens que não decifram (ou com outro
// `chatId` dentro) não aparecem. Depois de uma reconexão, os chats conhecidos que não vieram na
// lista ficam "reconectando…" por `settling_s` (reinício do servidor) e então somem. Só em memória.
// Puro: sem rede nem React.
import type { Envelope } from '@/remote/crypto'
import {
  isSafeInt,
  LIVE,
  parseLiveInfo,
  type LiveChatInfo,
  type LiveChatWire,
  type LiveHost
} from './types'

export interface LiveEntry {
  chatId: string
  epoch: number
  arev: number
  running: boolean
  info: LiveChatInfo
  host: LiveHost
  /** Conhecido antes da reconexão e ainda não confirmado pela lista nova (composer desligado). */
  stale: boolean
}

export interface LiveGroup {
  host: LiveHost
  chats: LiveEntry[]
}

export type LiveListEvent =
  | { kind: 'changed' }
  | { kind: 'removed'; chatIds: string[]; reason: string; hostId: string }
  | { kind: 'epoch'; chatId: string; epoch: number }
  /** Voltou (lista nova depois de reconectar, mesmo epoch): resync + `history.changes` (§23.5.6). */
  | { kind: 'back'; chatId: string }
  | { kind: 'running'; chatId: string; running: boolean }

export interface LiveListTimers {
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (t: unknown) => void
}

export interface LiveListDeps {
  /** Decifra o anúncio com a AAD montada com os campos DE FORA (§23.4). */
  open: (w: LiveChatWire) => Promise<Record<string, unknown>>
  /** Este aparelho (o servidor não manda os anúncios dele mesmo; defensivo). */
  deviceId: () => string | null
  timers?: LiveListTimers
  log?: (msg: string) => void
}

const defaultTimers: LiveListTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>)
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

/** Item da lista do servidor (null = malformado). */
export function parseWire(v: unknown): LiveChatWire | null {
  if (!isObj(v) || typeof v.chat_id !== 'string' || !v.chat_id) return null
  if (!isSafeInt(v.epoch, 1) || !isSafeInt(v.arev, 1) || !isObj(v.env)) return null
  const h = isObj(v.host) ? v.host : null
  if (!h || typeof h.device_id !== 'string' || !h.device_id) return null
  return {
    chat_id: v.chat_id,
    epoch: v.epoch,
    arev: v.arev,
    running: v.running === true,
    env: v.env as unknown as Envelope,
    host: {
      device_id: h.device_id,
      name: typeof h.name === 'string' && h.name ? h.name : 'outro dispositivo',
      platform: typeof h.platform === 'string' ? h.platform : '',
      status: h.status === 'grace' ? 'grace' : 'online'
    },
    ...(typeof v.announced_at === 'string' ? { announced_at: v.announced_at } : {})
  }
}

export class LiveList {
  private readonly d: LiveListDeps
  private readonly t: LiveListTimers
  private entries = new Map<string, LiveEntry>()
  /** Esperando o ack do `live.list` desta conexão: eventos `live.*` são descartados. */
  private listing = false
  private chain: Promise<void> = Promise.resolve()
  private settleTimer: unknown = null
  private listeners = new Set<(e: LiveListEvent) => void>()
  private version = 0
  private cachedGroups: LiveGroup[] | null = null
  /** Muda a cada `clear`: operações enfileiradas antes não aplicam nada. */
  private gen = 0

  constructor(deps: LiveListDeps) {
    this.d = deps
    this.t = deps.timers ?? defaultTimers
  }

  // ---------------- observável ----------------

  on(fn: (e: LiveListEvent) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  getVersion = (): number => this.version

  private emit(e: LiveListEvent): void {
    if (e.kind === 'changed') {
      this.version++
      this.cachedGroups = null
    }
    for (const fn of this.listeners) {
      try {
        fn(e)
      } catch (err) {
        this.d.log?.(`ouvinte da lista ao vivo: ${(err as Error).message}`)
      }
    }
  }

  // ---------------- leitura ----------------

  get(chatId: string): LiveEntry | null {
    return this.entries.get(chatId) ?? null
  }

  has(chatId: string): boolean {
    return this.entries.has(chatId)
  }

  get size(): number {
    return this.entries.size
  }

  all(): LiveEntry[] {
    return [...this.entries.values()]
  }

  /** Agrupada por host (ordem: o host com o chat mais recente primeiro; chats por `updatedAt`). */
  groups(): LiveGroup[] {
    if (this.cachedGroups) return this.cachedGroups
    const by = new Map<string, LiveGroup>()
    for (const e of this.entries.values()) {
      const g = by.get(e.host.device_id)
      if (g) g.chats.push(e)
      else by.set(e.host.device_id, { host: e.host, chats: [e] })
    }
    const out = [...by.values()]
    for (const g of out) g.chats.sort((a, b) => b.info.updatedAt - a.info.updatedAt)
    out.sort((a, b) => (b.chats[0]?.info.updatedAt ?? 0) - (a.chats[0]?.info.updatedAt ?? 0))
    this.cachedGroups = out
    return out
  }

  // ---------------- conexão ----------------

  /** Socket caiu: tudo vira "reconectando…" até a lista nova (§23.4). */
  onDisconnected(): void {
    this.listing = false
    let changed = false
    // entradas imutáveis (a tela compara por referência)
    for (const [id, e] of this.entries)
      if (!e.stale) {
        this.entries.set(id, { ...e, stale: true })
        changed = true
      }
    if (changed) this.emit({ kind: 'changed' })
  }

  /** `welcome` recebido (com `live_chats` nas caps): a lista vem pelo `live.list` em seguida. */
  beginListing(): void {
    this.listing = true
  }

  /** Servidor sem suporte (ou bloqueou/saiu): esvazia. */
  clear(reason = 'withdrawn'): void {
    this.listing = false
    if (this.settleTimer) this.t.clearTimeout(this.settleTimer)
    this.settleTimer = null
    const gone = [...this.entries.values()]
    this.entries.clear()
    this.gen++
    if (!gone.length) return
    for (const hostId of new Set(gone.map((e) => e.host.device_id)))
      this.emit({
        kind: 'removed',
        chatIds: gone.filter((e) => e.host.device_id === hostId).map((e) => e.chatId),
        reason,
        hostId
      })
    this.emit({ kind: 'changed' })
  }

  /** Ack do `live.list` (`{ chats, settling_s }`): substitui a lista. */
  applyList(ack: Record<string, unknown>): Promise<void> {
    this.listing = false
    return this.enqueue(async () => {
      const wires = (Array.isArray(ack.chats) ? ack.chats : [])
        .map(parseWire)
        .filter((w): w is LiveChatWire => !!w)
      const settling = Math.max(0, Number(ack.settling_s) || 0)
      const fresh = new Map<string, LiveEntry>()
      for (const w of wires) {
        const e = await this.decode(w)
        if (e) fresh.set(e.chatId, e)
      }
      const prev = this.entries
      const next = new Map<string, LiveEntry>()
      const removed: LiveEntry[] = []
      for (const e of fresh.values()) {
        const old = prev.get(e.chatId)
        next.set(e.chatId, e)
        if (old && old.epoch !== e.epoch)
          this.emit({ kind: 'epoch', chatId: e.chatId, epoch: e.epoch })
        else if (old) this.emit({ kind: 'back', chatId: e.chatId })
      }
      for (const old of prev.values()) {
        if (fresh.has(old.chatId)) continue
        if (settling > 0) next.set(old.chatId, { ...old, stale: true })
        else removed.push(old)
      }
      this.entries = next
      if (this.settleTimer) this.t.clearTimeout(this.settleTimer)
      this.settleTimer = null
      if (settling > 0 && [...next.values()].some((e) => e.stale))
        this.settleTimer = this.t.setTimeout(() => this.settle(), settling * 1000)
      this.emitRemoved(removed, 'withdrawn')
      this.emit({ kind: 'changed' })
    })
  }

  /** `settling_s` passou: os que não voltaram somem. */
  private settle(): void {
    this.settleTimer = null
    void this.enqueue(async () => {
      const gone = [...this.entries.values()].filter((e) => e.stale)
      if (!gone.length) return
      for (const e of gone) this.entries.delete(e.chatId)
      this.emitRemoved(gone, 'withdrawn')
      this.emit({ kind: 'changed' })
    })
  }

  private emitRemoved(list: LiveEntry[], reason: string): void {
    for (const hostId of new Set(list.map((e) => e.host.device_id)))
      this.emit({
        kind: 'removed',
        chatIds: list.filter((e) => e.host.device_id === hostId).map((e) => e.chatId),
        reason,
        hostId
      })
  }

  // ---------------- eventos ----------------

  /** `live.update` / `live.removed` / `live.host`. Antes do ack do `live.list`: descartados. */
  onEvent(f: Record<string, unknown>): void {
    if (this.listing) return
    switch (f.t) {
      case 'live.update': {
        const wires = (Array.isArray(f.chats) ? f.chats : [])
          .map(parseWire)
          .filter((w): w is LiveChatWire => !!w)
        void this.enqueue(() => this.applyUpdate(wires))
        return
      }
      case 'live.removed': {
        const hostId = String(f.host_device_id ?? '')
        const ids = Array.isArray(f.chat_ids) ? f.chat_ids.map(String) : []
        const reason = typeof f.reason === 'string' ? f.reason : 'withdrawn'
        void this.enqueue(async () => {
          const gone: LiveEntry[] = []
          for (const id of ids) {
            const e = this.entries.get(id)
            if (!e || (hostId && e.host.device_id !== hostId)) continue
            this.entries.delete(id)
            gone.push(e)
          }
          if (!gone.length) return
          this.emitRemoved(gone, reason)
          this.emit({ kind: 'changed' })
        })
        return
      }
      case 'live.host': {
        const hostId = String(f.host_device_id ?? '')
        const status = f.status === 'grace' ? 'grace' : 'online'
        void this.enqueue(async () => {
          let changed = false
          for (const [id, e] of this.entries)
            if (e.host.device_id === hostId && e.host.status !== status) {
              this.entries.set(id, { ...e, host: { ...e.host, status } })
              changed = true
            }
          if (changed) this.emit({ kind: 'changed' })
        })
        return
      }
    }
  }

  private async applyUpdate(wires: LiveChatWire[]): Promise<void> {
    let changed = false
    for (const w of wires) {
      const old = this.entries.get(w.chat_id)
      // anti-replay: mesma epoch e arev já conhecida (ou menor)
      if (old && old.epoch === w.epoch && w.arev <= old.arev && !old.stale) continue
      if (old && w.epoch < old.epoch) continue
      const e = await this.decode(w)
      if (!e) continue
      this.entries.set(e.chatId, e)
      changed = true
      if (old && old.epoch !== e.epoch)
        this.emit({ kind: 'epoch', chatId: e.chatId, epoch: e.epoch })
      else if (old && old.stale) this.emit({ kind: 'back', chatId: e.chatId })
      if (old && old.running !== e.running)
        this.emit({ kind: 'running', chatId: e.chatId, running: e.running })
    }
    if (changed) this.emit({ kind: 'changed' })
  }

  private async decode(w: LiveChatWire): Promise<LiveEntry | null> {
    if (w.host.device_id === this.d.deviceId()) return null
    let plain: Record<string, unknown>
    try {
      plain = await this.d.open(w)
    } catch (e) {
      this.d.log?.(
        `anúncio ao vivo ilegível (${w.chat_id.slice(0, 8)}…): ${(e as Error)?.message ?? 'erro'}`
      )
      return null
    }
    const info = parseLiveInfo(plain, w.chat_id)
    if (!info) {
      this.d.log?.(`anúncio ao vivo inválido (${w.chat_id.slice(0, 8)}…)`)
      return null
    }
    return {
      chatId: w.chat_id,
      epoch: w.epoch,
      arev: w.arev,
      running: w.running,
      info,
      host: w.host,
      stale: false
    }
  }

  private enqueue(fn: () => Promise<void>): Promise<void> {
    const gen = this.gen
    const p = this.chain
      .then(() => (gen === this.gen ? fn() : undefined))
      .catch((e: unknown) => {
        this.d.log?.(`lista ao vivo: ${(e as Error).message}`)
      })
    this.chain = p
    return p
  }
}

/** Tolerância de queda do host (§23.1): o servidor manda `live.removed` depois dela. */
export const HOST_GRACE_MS = LIVE.hostDropGraceS * 1000
