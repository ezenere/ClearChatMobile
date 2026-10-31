// Servidor de sync de mentira (em memória) para os testes do motor: feed por seq com piso de
// tombstones (410), /records paginado, /records/fetch, push atômico com as regras de revisão (§7.4:
// rev_mismatch, gone, idempotência por push_id, cascata do chat, chat_busy), estados de chat e blobs.
// Implementa a interface EngineHttp direto (erros como o SyncHttp real: SyncApiError/SyncNetworkError).
import { SyncApiError, SyncNetworkError } from '../src/vendor/desktop/sync/http'
import {
  blobIdFromSha256,
  deriveSubkeys,
  encryptBlob,
  randomBytes,
  sealRecord,
  sha256,
  type Subkeys
} from '../src/crypto'
import type { EngineHttp } from '../src/data/engine'
import type { Change, ChatState, PushBody, PushItem } from '../src/data/types'

type Rec = Change

const k = (type: string, id: string) => `${type}|${id}`

export class FakeSync implements EngineHttp {
  userId = 'user-fake-1'
  seq = 0
  floor = 0
  records = new Map<string, Rec>()
  receipts = new Map<string, unknown>()
  blobs = new Map<string, Uint8Array>()
  chatStates: ChatState[] = []
  busyChats = new Set<string>()
  /** Registros acima deste tamanho (bytes do ciphertext) vêm `omitted` no feed. */
  omitAbove = Infinity
  offline = false
  calls: string[] = []
  /** Commit aplicado → mudanças (para simular o `sync.changes` do WebSocket). */
  onCommit: ((changes: Change[]) => void) | null = null

  private now = () => new Date().toISOString()

  private err(status: number, code: string, details: Record<string, unknown> = {}): never {
    throw new SyncApiError(`erro ${code}`, status, code, details)
  }

  private view(r: Rec, payload: boolean): Change {
    const c: Change = { ...r }
    if (!payload || r.deleted) delete c.env
    if (payload && !r.deleted && r.size > this.omitAbove) {
      delete c.env
      c.omitted = true
    }
    return c
  }

  async get<T>(path: string): Promise<T> {
    if (this.offline) throw new SyncNetworkError('offline')
    this.calls.push(`GET ${path}`)
    const u = new URL(`http://x${path}`)
    if (u.pathname === '/api/v1/sync/changes') {
      const since = Number(u.searchParams.get('since') ?? 0)
      const limit = Number(u.searchParams.get('limit') ?? 500)
      if (since < this.floor) this.err(410, 'cursor_expired')
      const all = [...this.records.values()]
        .filter((r) => r.seq > since)
        .sort((a, b) => a.seq - b.seq)
      const page = all.slice(0, limit)
      return {
        changes: page.map((r) => this.view(r, true)),
        next: page.length ? page[page.length - 1].seq : this.seq,
        has_more: all.length > limit,
        head: this.seq
      } as T
    }
    if (u.pathname === '/api/v1/records') {
      const after = Number(u.searchParams.get('after') ?? 0)
      const limit = Number(u.searchParams.get('limit') ?? 500)
      const all = [...this.records.values()]
        .filter((r) => !r.deleted && r.seq > after)
        .sort((a, b) => a.seq - b.seq)
      const page = all.slice(0, limit)
      return {
        records: page.map((r) => this.view(r, true)),
        next: page.length ? page[page.length - 1].seq : after,
        has_more: all.length > limit,
        head: this.seq
      } as T
    }
    if (u.pathname === '/api/v1/chat-states')
      return { chat_states: this.chatStates, state_cursor: 1 } as T
    this.err(404, 'not_found')
  }

  async post<T>(path: string, json?: unknown): Promise<T> {
    if (this.offline) throw new SyncNetworkError('offline')
    this.calls.push(`POST ${path}`)
    if (path === '/api/v1/records/fetch') {
      const items = (json as { items: { type: string; id: string }[] }).items
      return {
        records: items.flatMap((i) => {
          const r = this.records.get(k(i.type, i.id))
          return r ? [{ ...r }] : []
        })
      } as T
    }
    if (path === '/api/v1/sync/push') return this.push(json as PushBody, 'dev-mobile') as T
    this.err(404, 'not_found')
  }

  async req<T>(method: string, path: string): Promise<T> {
    if (this.offline) throw new SyncNetworkError('offline')
    this.calls.push(`${method} ${path}`)
    const m = /^\/api\/v1\/blobs\/([^/]+)$/.exec(path)
    if (method === 'GET' && m) {
      const b = this.blobs.get(decodeURIComponent(m[1]))
      if (!b) this.err(404, 'not_found')
      return b as T
    }
    this.err(404, 'not_found')
  }

  /** Push (§7.4) — atômico; `device` = quem grava. */
  push(body: PushBody, device: string): unknown {
    const prev = this.receipts.get(body.push_id)
    if (prev) return prev
    const conflicts: unknown[] = []
    for (const it of body.items) {
      if (it.rev !== it.base_rev + 1) this.err(400, 'invalid_request')
      if (it.type === 'chat' && it.deleted && this.busyChats.has(it.id))
        this.err(409, 'chat_busy', { chat_id: it.id })
      const cur = this.records.get(k(it.type, it.id))
      const curRev = cur?.rev ?? 0
      if (curRev !== it.base_rev) {
        conflicts.push({
          type: it.type,
          id: it.id,
          reason: 'rev_mismatch',
          current: cur && this.view(cur, true)
        })
        continue
      }
      if (cur?.deleted && !it.deleted && it.base_rev !== cur.rev)
        conflicts.push({ type: it.type, id: it.id, reason: 'gone', current: this.view(cur, true) })
    }
    if (conflicts.length) this.err(409, 'conflict', { conflicts })
    const results = body.items.map((it) => this.commitItem(it, device))
    const out = {
      results: results.map((r) => ({ type: r.type, id: r.id, rev: r.rev, seq: r.seq })),
      head: this.seq
    }
    this.receipts.set(body.push_id, out)
    this.onCommit?.(results.map((r) => this.view(r, true)))
    return out
  }

  private commitItem(it: PushItem, device: string): Rec {
    const seq = ++this.seq
    const r: Rec = {
      seq,
      type: it.type,
      id: it.id,
      scope: it.scope,
      rev: it.rev,
      deleted: it.deleted,
      ...(it.env ? { env: it.env } : {}),
      size: it.env ? Math.ceil((it.env.c.length * 3) / 4) : 0,
      blobs: it.blobs,
      device_id: device,
      updated_at: this.now()
    }
    this.records.set(k(it.type, it.id), r)
    // cascata física do chat: só o tombstone do chat fica no feed (§7.7)
    if (it.type === 'chat' && it.deleted)
      for (const [key, x] of this.records)
        if (x.scope === it.id && (x.type === 'session' || x.type === 'message'))
          this.records.delete(key)
    return r
  }

  /** GC de tombstones: remove-os e sobe o piso (§7.8). */
  gcTombstones(): void {
    for (const [key, r] of this.records)
      if (r.deleted) {
        this.floor = Math.max(this.floor, r.seq)
        this.records.delete(key)
      }
    this.floor = Math.max(this.floor, 1)
  }
}

/** "Desktop" de teste: cifra registros com uma DEK conhecida e grava no servidor falso. */
export class DesktopWriter {
  sk!: Subkeys
  constructor(
    readonly server: FakeSync,
    readonly device = 'dev-desktop'
  ) {}

  async init(): Promise<this> {
    this.sk = await deriveSubkeys(randomBytes(32))
    return this
  }

  rev(type: string, id: string): number {
    return this.server.records.get(k(type, id))?.rev ?? 0
  }

  async item(
    type: string,
    id: string,
    scope: string | null,
    plain: Record<string, unknown>,
    blobs: string[] = []
  ): Promise<PushItem> {
    const base = this.rev(type, id)
    const env = await sealRecord(
      this.sk.record,
      this.server.userId,
      { type, id, scope, rev: base + 1 },
      plain
    )
    return { type, id, scope, base_rev: base, rev: base + 1, deleted: false, env, blobs }
  }

  async put(
    type: string,
    id: string,
    scope: string | null,
    plain: Record<string, unknown>,
    blobs: string[] = []
  ): Promise<void> {
    this.server.push(
      { push_id: crypto.randomUUID(), items: [await this.item(type, id, scope, plain, blobs)] },
      this.device
    )
  }

  async putMany(items: Promise<PushItem>[] | PushItem[]): Promise<void> {
    const list = await Promise.all(items)
    for (let i = 0; i < list.length; i += 400)
      this.server.push({ push_id: crypto.randomUUID(), items: list.slice(i, i + 400) }, this.device)
  }

  del(type: string, id: string, scope: string | null): void {
    const base = this.rev(type, id)
    this.server.push(
      {
        push_id: crypto.randomUUID(),
        items: [{ type, id, scope, base_rev: base, rev: base + 1, deleted: true, blobs: [] }]
      },
      this.device
    )
  }

  /** Sobe um anexo (CCB1) e devolve { sha, blobId }. */
  async blob(data: Uint8Array): Promise<{ sha: string; blobId: string }> {
    const digest = await sha256(data)
    const sha = [...digest].map((b) => b.toString(16).padStart(2, '0')).join('')
    const blobId = await blobIdFromSha256(this.sk, digest)
    this.server.blobs.set(
      blobId,
      await encryptBlob(this.sk, this.server.userId, blobId, data, randomBytes(16))
    )
    return { sha, blobId }
  }
}

export interface MsgSpec {
  id: string
  sessionId: string
  seq: number
  role: 'user' | 'assistant' | 'tool'
  content: string | null
  parentId?: string | null
  meta?: Record<string, unknown>
  tool_calls?: { id: string; name: string; args: Record<string, unknown> }[]
  tool_call_id?: string
  createdAt?: number
}

export function messagePlain(m: MsgSpec): Record<string, unknown> {
  const message =
    m.role === 'tool'
      ? { role: 'tool', tool_call_id: m.tool_call_id, content: m.content ?? '' }
      : m.role === 'assistant'
        ? {
            role: 'assistant',
            content: m.content,
            ...(m.tool_calls
              ? {
                  tool_calls: m.tool_calls.map((c) => ({
                    id: c.id,
                    type: 'function',
                    function: { name: c.name, arguments: JSON.stringify(c.args) }
                  }))
                }
              : {})
          }
        : { role: 'user', content: m.content ?? '' }
  return {
    sv: 1,
    sessionId: m.sessionId,
    seq: m.seq,
    message,
    meta: m.meta ?? {},
    createdAt: m.createdAt ?? 1_700_000_000_000 + m.seq * 60_000,
    ...(m.parentId !== undefined ? { parentId: m.parentId } : {})
  }
}

export const chatPlain = (
  title: string,
  mainSessionId: string,
  extra: Record<string, unknown> = {}
) => ({
  sv: 1,
  title,
  config: { model: 'm', providerId: 'p1' },
  mainSessionId,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_100_000,
  ...extra
})

export const sessionPlain = (chatId: string, extra: Record<string, unknown> = {}) => ({
  sv: 1,
  chatId,
  parentSessionId: null,
  parentToolCallId: null,
  depth: 0,
  model: 'm',
  providerId: 'p1',
  title: 'Principal',
  task: null,
  status: 'idle',
  createdAt: 1_700_000_000_000,
  memory: null,
  branchSel: {},
  ...extra
})
