// Divergência com a versão deste aparelho (SYNC_PROTOCOL.md §9) — porta da metade "dispositivo D"
// de ClearChatDesktop/src/main/sync/engine.ts (divergence/resolveDivergence/
// replaceContentWithOnline): enquanto o chat tem conteúdo local pendente (ou a versão divergente é
// daqui), o conteúdo remoto não é aplicado (o motor só marca "precisa rebaixar"); a versão online é
// baixada inteira (`GET /records?scope=X`) para mostrar as duas versões e resolver:
// - manter a online: `divergence/resolve {keep:'online'}` e a versão local é APAGADA (sessões e
//   mensagens que não estão online + outbox do conteúdo) e substituída pela online;
// - manter a local (só D): o lote que transforma a online na local (puts com base = rev online,
//   tombstones das que só existem online) vai no próprio resolve; o resto (acima do teto do lote)
//   sai pela outbox normal. Nenhuma cópia da versão perdedora fica. Sem React Native.
import type { Session, StoredMessage } from '@shared/types'
import { openRecord, sealRecord, type Subkeys } from '@/crypto'
import { messageFromPlain, sessionFromPlain } from '@/data/decode'
import { RecordState, type LocalStore } from '@/data/store'
import type { Change, ChatState, Plain, PushItem } from '@/data/types'
import { divergedOf } from '@/remote/types'

export interface DivergenceDeps {
  store: LocalStore
  http: {
    get<T = unknown>(path: string): Promise<T>
    post<T = unknown>(path: string, json?: unknown): Promise<T>
  }
  keys: () => { userId: string; sk: Subkeys } | null
  deviceId: () => string | null
  /** Estado atual do chat (com o otimista do host). */
  state: (chatId: string) => ChatState | null
  /** Estado novo devolvido pelo servidor (resolve) / divergência limpa localmente. */
  onState: (chatId: string, state: ChatState | null) => void
  /** Ids de blob do conteúdo (§14) e garantia de upload antes do push. */
  blobsOf: (plain: Plain) => Promise<string[]>
  ensureBlobs: (plains: Plain[]) => Promise<void>
  notify: (chats: string[]) => void
  /** Outbox do chat retomada (depois de resolver para a local). */
  resume: (chatId: string) => void
  log?: (msg: string) => void
  uuid?: () => string
}

export interface DivergenceVersion {
  sessions: Session[]
  messages: Record<string, StoredMessage[]>
}

export interface DivergenceDetails {
  chatId: string
  online: DivergenceVersion
  /** Versão deste aparelho (null = a versão divergente é de outro dispositivo). */
  local: DivergenceVersion | null
  onlyOnline: { count: number; since: number | null }
  onlyLocal: { count: number; since: number | null }
}

interface Downloaded {
  change: Change
  plain: Plain | null
}

/** JSON estável (chaves ordenadas) — compara plaintexts/mensagens das duas versões. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object')
    return `{${Object.keys(v as Record<string, unknown>)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`
  return JSON.stringify(v ?? null)
}

const MAX_ITEMS = 100
const MAX_BYTES = 3 * 1024 * 1024
const key = (type: string, id: string): string => `${type}\u0000${id}`
const same = (a: Plain, b: Plain): boolean => {
  const strip = (p: Plain): Plain => {
    const { sv: _sv, ...rest } = p
    void _sv
    return rest
  }
  return canonical(strip(a)) === canonical(strip(b))
}

export class DivergenceService {
  private readonly d: DivergenceDeps
  private busy = new Set<string>()

  constructor(deps: DivergenceDeps) {
    this.d = deps
  }

  private keys(): { userId: string; sk: Subkeys } {
    const k = this.d.keys()
    if (!k) throw new Error('Cofre bloqueado.')
    return k
  }

  /** A versão divergente deste chat é deste aparelho? */
  isSelf(chatId: string): boolean {
    const d = divergedOf(this.d.state(chatId))
    return !!d && d.device_id === this.d.deviceId()
  }

  /** §9.2: não aplicar conteúdo remoto deste chat agora. */
  hold(chatId: string): boolean {
    return this.d.store.hasOutbox(chatId, ['session', 'message']) || this.isSelf(chatId)
  }

  /** Conteúdo online de um chat (decifrado). */
  async fetchChatRecords(chatId: string): Promise<Downloaded[]> {
    const { userId, sk } = this.keys()
    const out: Downloaded[] = []
    let after = 0
    for (let guard = 0; guard < 10_000; guard++) {
      const r = await this.d.http.get<{ records?: Change[]; next?: number; has_more?: boolean }>(
        `/api/v1/records?scope=${encodeURIComponent(chatId)}&after=${after}&limit=1000&payload=1`
      )
      const list = r.records ?? []
      const omitted = list.filter((c) => !c.deleted && !c.env)
      if (omitted.length) {
        const f = await this.d.http.post<{ records: Change[] }>('/api/v1/records/fetch', {
          items: omitted.map((c) => ({ type: c.type, id: c.id }))
        })
        const byKey = new Map((f.records ?? []).map((c) => [key(c.type, c.id), c]))
        for (const c of omitted) {
          const full = byKey.get(key(c.type, c.id))
          if (full?.env) c.env = full.env
        }
      }
      for (const c of list) {
        if ((c.type !== 'session' && c.type !== 'message') || c.deleted) continue
        let plain: Plain | null = null
        try {
          if (c.env) plain = await openRecord(sk.record, userId, c, c.env)
        } catch {
          this.d.log?.(`divergência: registro online não decifrado (${c.type})`)
        }
        out.push({ change: c, plain })
      }
      if (!r.has_more || !list.length) break
      after = r.next ?? list[list.length - 1].seq
    }
    return out
  }

  private version(items: { type: string; id: string; plain: Plain }[]): DivergenceVersion {
    const v: DivergenceVersion = { sessions: [], messages: {} }
    for (const r of items) {
      if (r.type === 'session')
        v.sessions.push({ ...sessionFromPlain(r.id, r.plain), status: 'idle' })
      else {
        const m = messageFromPlain(r.id, r.plain)
        ;(v.messages[m.sessionId] ??= []).push(m)
      }
    }
    for (const list of Object.values(v.messages))
      list.sort((a, b) => a.seq - b.seq || (a.id < b.id ? -1 : 1))
    v.sessions.sort((a, b) => a.depth - b.depth || a.createdAt - b.createdAt)
    return v
  }

  /** As duas versões (a local só se a versão divergente for deste aparelho) e o que se perde. */
  async details(chatId: string): Promise<DivergenceDetails> {
    const online = await this.fetchChatRecords(chatId)
    const ver = this.version(
      online.flatMap((r) =>
        r.plain ? [{ type: r.change.type, id: r.change.id, plain: r.plain }] : []
      )
    )
    const local = this.isSelf(chatId) ? this.version(this.d.store.contentRecords(chatId)) : null
    const sig = (m: StoredMessage): string => `${m.id}:${canonical(m.message)}`
    const flat = (v: DivergenceVersion | null): StoredMessage[] =>
      v ? Object.values(v.messages).flat() : []
    const oSet = new Set(flat(ver).map(sig))
    const lSet = new Set(flat(local).map(sig))
    const onlyOnline = flat(ver).filter((m) => !lSet.has(sig(m)))
    const onlyLocal = flat(local).filter((m) => !oSet.has(sig(m)))
    const since = (l: StoredMessage[]): number | null =>
      l.length ? Math.min(...l.map((m) => m.createdAt)) : null
    return {
      chatId,
      online: ver,
      local,
      onlyOnline: { count: local ? onlyOnline.length : 0, since: local ? since(onlyOnline) : null },
      onlyLocal: { count: onlyLocal.length, since: since(onlyLocal) }
    }
  }

  async resolve(chatId: string, keep: 'online' | 'local'): Promise<void> {
    if (this.busy.has(chatId)) throw new Error('A resolução já está em andamento.')
    this.busy.add(chatId)
    try {
      const d = divergedOf(this.d.state(chatId))
      if (!d?.divergence_id) throw new Error('Este chat não está divergente.')
      if (keep === 'online') {
        const r = await this.post(chatId, { divergence_id: d.divergence_id, keep: 'online' })
        this.d.onState(chatId, (r.state as ChatState | undefined) ?? null)
        if (d.device_id === this.d.deviceId()) await this.replaceContentWithOnline(chatId, true)
        return
      }
      if (d.device_id !== this.d.deviceId())
        throw new Error('Só o dispositivo com a versão divergente pode mantê-la.')
      await this.keepLocal(chatId, d.divergence_id)
    } finally {
      this.busy.delete(chatId)
    }
  }

  private async post(
    chatId: string,
    body: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    try {
      return await this.d.http.post<Record<string, unknown>>(
        `/api/v1/chats/${encodeURIComponent(chatId)}/divergence/resolve`,
        body
      )
    } catch (e) {
      const code = (e as { code?: string }).code
      if (code === 'divergence_mismatch')
        throw new Error('A divergência mudou enquanto você decidia — confira de novo.', {
          cause: e
        })
      throw e
    }
  }

  private async keepLocal(chatId: string, divergenceId: string): Promise<void> {
    const keys = this.keys()
    const store = this.d.store
    const online = await this.fetchChatRecords(chatId)
    const onlineMap = new Map(online.map((r) => [key(r.change.type, r.change.id), r]))
    const local = store.contentRecords(chatId)
    const localIds = new Set(local.map((r) => key(r.type, r.id)))
    type Item = { item: PushItem; plain: Plain | null; type: string; id: string }
    const items: Item[] = []
    const add = async (type: string, id: string, plain: Plain | null): Promise<void> => {
      const o = onlineMap.get(key(type, id))
      if (plain && o?.plain && same(plain, o.plain)) return
      if (!plain && !o) return
      const baseRev = o
        ? o.change.rev
        : store.recordMeta(type, id)?.deleted
          ? store.recordMeta(type, id)!.rev
          : 0
      const rev = baseRev + 1
      const item: PushItem = {
        type,
        id,
        scope: chatId,
        base_rev: baseRev,
        rev,
        deleted: !plain,
        blobs: plain ? await this.d.blobsOf(plain) : []
      }
      if (plain)
        item.env = await sealRecord(
          keys.sk.record,
          keys.userId,
          { type, id, scope: chatId, rev },
          plain
        )
      items.push({ item, plain, type, id })
    }
    for (const r of local) await add(r.type, r.id, r.plain)
    for (const r of online)
      if (!localIds.has(key(r.change.type, r.change.id)))
        await add(r.change.type, r.change.id, null)
    await this.d.ensureBlobs(items.flatMap((i) => (i.plain ? [i.plain] : [])))
    const rank = (i: Item): number =>
      i.item.deleted ? (i.type === 'message' ? 2 : 3) : i.type === 'session' ? 0 : 1
    items.sort(
      (a, b) =>
        rank(a) - rank(b) ||
        (a.type === 'session'
          ? Number(a.plain?.depth ?? 0) - Number(b.plain?.depth ?? 0)
          : Number(a.plain?.seq ?? 0) - Number(b.plain?.seq ?? 0)) ||
        (a.id < b.id ? -1 : 1)
    )
    let n = 0
    let size = 0
    for (; n < items.length; n++) {
      const bytes = (items[n].item.env?.c.length ?? 0) + 200
      if (n && (n >= MAX_ITEMS || size + bytes > MAX_BYTES)) break
      size += bytes
    }
    const first = items.slice(0, n)
    const rest = items.slice(n)
    const res = await this.post(chatId, {
      divergence_id: divergenceId,
      keep: 'local',
      push_id: this.d.uuid?.() ?? crypto.randomUUID(),
      items: first.map((i) => i.item)
    })
    const results = (res.results as { type: string; id: string; rev: number; seq: number }[]) ?? []
    const seqOf = new Map(results.map((r) => [key(r.type, r.id), r]))
    store.sql.tx(() => {
      store.dropContentOutbox(chatId)
      for (const i of first) {
        const r = seqOf.get(key(i.type, i.id))
        const change: Change = {
          type: i.type,
          id: i.id,
          scope: chatId,
          rev: r?.rev ?? i.item.rev,
          seq: r?.seq ?? 0,
          deleted: i.item.deleted,
          size: 0,
          blobs: i.item.blobs,
          device_id: this.d.deviceId() ?? '',
          updated_at: new Date().toISOString()
        }
        if (i.plain) store.putRecord(change, i.plain, RecordState.Ok)
        else store.deleteRecord(change)
      }
      // o resto já está no cache: entra na outbox sobre a base online e sai pelo push normal
      for (const i of rest)
        store.queueContent({
          type: i.type,
          id: i.id,
          chatId,
          baseRev: i.item.base_rev,
          plain: i.plain
        })
      store.setMeta(`refetch:${chatId}`, null)
      store.refreshDirtyChats()
    })
    if (rest.length)
      this.d.log?.(`divergência: resolve em partes (${first.length} + ${rest.length})`)
    this.d.onState(chatId, (res.state as ChatState | undefined) ?? null)
    this.d.notify([chatId])
    this.d.resume(chatId)
  }

  /**
   * Substitui o conteúdo local pela versão online (apaga o que não está online). `discard` =
   * descarta também o conteúdo local pendente (divergência resolvida para a online).
   */
  async replaceContentWithOnline(chatId: string, discard: boolean): Promise<void> {
    const store = this.d.store
    if (!discard && this.hold(chatId)) return
    const online = await this.fetchChatRecords(chatId)
    const onlineIds = new Set(online.map((r) => key(r.change.type, r.change.id)))
    const mainId = store.getPlain('chat', chatId)?.mainSessionId
    store.sql.tx(() => {
      if (discard) store.dropContentOutbox(chatId)
      else if (store.hasOutbox(chatId, ['session', 'message'])) return
      for (const r of store.contentRecords(chatId)) {
        if (onlineIds.has(key(r.type, r.id))) continue
        if (r.type === 'session' && r.id === mainId && !discard) continue
        store.forgetContent(r.type, r.id, chatId)
      }
      for (const r of online) {
        if (!r.plain) continue
        store.putRecord(r.change, r.plain, RecordState.Ok)
      }
      store.setMeta(`refetch:${chatId}`, null)
      store.refreshDirtyChats()
    })
    this.d.notify([chatId])
  }

  /** Chats "precisa rebaixar" já sem pendência local nem divergência: baixa a versão online. */
  async refetchPending(): Promise<void> {
    for (const chatId of this.d.store.refetchChats()) {
      if (this.hold(chatId) || divergedOf(this.d.state(chatId))) continue
      try {
        await this.replaceContentWithOnline(chatId, false)
      } catch (e) {
        this.d.log?.(`rebaixar conteúdo: ${(e as Error).message}`)
      }
    }
  }
}
