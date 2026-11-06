// Merge do primeiro login (SYNC_PROTOCOL.md §12 / §16.3) — porta do `enterMerge`/`runMerge`/`dedupe`/
// `applyRemap` do engine do desktop sobre o cache do celular. Acontece quando o aparelho tem dados
// criados SEM conta ("Usar sem conta": cache com dono `local`) e abre o cofre de uma conta:
//   1. baixa todo o estado online (registros + estados de chat; sem blobs) e decifra;
//   2. online vazio → envia tudo sem perguntar; local vazio → só baixa; os dois → pergunta
//      "Priorizar online" · "Priorizar local" (a tela mostra as contagens e os chats conflitantes);
//   3. deduplicação local → online (o id canônico é sempre o online; a prioridade decide o conteúdo)
//      e remapeamento das referências (§12.5);
//   4. conteúdo vencedor por registro; registros idênticos não geram envio;
//   5. o que fica para subir vai às outboxes (LWW e conteúdo — chats em replay com
//      `chat_bases = 0`, os blobs antes do registro, §14) e o sync normal liga com cursor = head.
// Tudo o que muda o cache roda numa transação só: um app morto no meio refaz o merge do zero.
// Sem React Native (testável no Node com o servidor falso).
import { SyncApiError, SyncNetworkError } from '@vendor/desktop/sync/http'
import { openRecord, type Subkeys } from '@/crypto'
import { RecordState, type LocalStore } from './store'
import {
  type Change,
  type ChatState,
  isRecordType,
  type Plain,
  type PullPage,
  type RecordsPage
} from './types'

export type MergePriority = 'online' | 'local'

export interface MergeCounts {
  providers: number
  chats: number
  presets: number
  memories: number
}

/** O que a pergunta do merge mostra (§12.2, §12.6). */
export interface MergeInfo {
  local: MergeCounts
  online: MergeCounts
  /** Chats com o mesmo id nos dois lados e histórias diferentes (a versão não priorizada é apagada). */
  conflictingChats: number
}

export interface OnlineRecord {
  change: Change
  /** null = tombstone, tipo desconhecido ou não decifrou. */
  plain: Plain | null
}

export interface OnlineSnapshot {
  records: Map<string, OnlineRecord>
  head: number
  states: ChatState[]
}

export interface MergeHttp {
  get<T = unknown>(path: string): Promise<T>
  post<T = unknown>(path: string, json?: unknown): Promise<T>
}

export interface MergeKeys {
  userId: string
  sk: Subkeys
}

const key = (type: string, id: string): string => `${type}\u0000${id}`
const isObj = (v: unknown): v is Plain => !!v && typeof v === 'object' && !Array.isArray(v)
const isContent = (t: string): boolean => t === 'session' || t === 'message'

/** Tipos que o merge sobe (skills não entram — opt-in, §13). */
const MERGE_TYPES = new Set([
  'provider',
  'preset',
  'setting',
  'memory_collection',
  'memory',
  'chat',
  'session',
  'message'
])

/** Ordem de aplicação (o desktop aplica nesta ordem; sessões por profundidade, o resto por seq). */
const ORDER = [
  'setting',
  'provider',
  'preset',
  'memory_collection',
  'memory',
  'chat',
  'session',
  'message'
]

/** Nome sem caixa/acento (= `normName` do desktop). */
export const normName = (s: unknown): string =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLowerCase()

/** baseUrl normalizada (= `normBase` do desktop): esquema/host em minúsculas, sem `/` final. */
export const normBase = (u: unknown): string => {
  const s = String(u ?? '').trim()
  try {
    const x = new URL(s)
    return `${x.protocol.toLowerCase()}//${x.host.toLowerCase()}${x.pathname.replace(/\/+$/, '')}${x.search}`
  } catch {
    return s.replace(/\/+$/, '').toLowerCase()
  }
}

/** JSON canônico (chaves ordenadas, sem `undefined`) — = `canonical` do desktop. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null)
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(',')}}`
}

const withoutCwd = (cfg: unknown): unknown => {
  if (!isObj(cfg)) return cfg ?? {}
  const { cwd: _cwd, ...rest } = cfg
  return rest
}

/** Plaintexts iguais para o merge (sessão: o status é de execução, não conta). */
function samePlain(type: string, a: Plain | null, b: Plain | null): boolean {
  if (!a || !b) return false
  if (type === 'session') {
    const { status: _sa, ...ra } = a
    const { status: _sb, ...rb } = b
    return canonical(ra) === canonical(rb)
  }
  return canonical(a) === canonical(b)
}

// ---------------- download (§12.3) ----------------

/** `records/fetch` dos registros que vieram `omitted` (§7.2). Os que não vierem ficam sem payload. */
async function fillOmitted(http: MergeHttp, changes: Change[]): Promise<void> {
  const need = changes.filter((c) => !c.deleted && (c.omitted || !c.env) && isRecordType(c.type))
  for (let i = 0; i < need.length; i += 500) {
    const part = need.slice(i, i + 500)
    const r = await http.post<{ records: Change[] }>('/api/v1/records/fetch', {
      items: part.map((c) => ({ type: c.type, id: c.id }))
    })
    const map = new Map((r.records ?? []).map((x) => [key(x.type, x.id), x]))
    for (const c of part) {
      const full = map.get(key(c.type, c.id))
      if (!full || full.rev !== c.rev || full.deleted || !full.env || full.omitted) continue
      c.env = full.env
      delete c.omitted
    }
  }
}

/** Baixa e decifra todo o estado online (registros e tombstones do feed; estados dos chats). */
export async function downloadOnline(
  http: MergeHttp,
  keys: MergeKeys,
  log?: (msg: string) => void
): Promise<OnlineSnapshot> {
  const records = new Map<string, OnlineRecord>()
  let head = 0
  let since = 0
  try {
    for (let guard = 0; guard < 1_000_000; guard++) {
      const r = await http.get<PullPage>(`/api/v1/sync/changes?since=${since}&limit=1000&payload=1`)
      for (const c of r.changes ?? []) records.set(key(c.type, c.id), { change: c, plain: null })
      head = Math.max(head, r.head ?? 0)
      const next = r.next ?? since
      if (!r.has_more || next <= since) break
      since = next
    }
  } catch (e) {
    if (!(e instanceof SyncApiError && e.code === 'cursor_expired')) throw e
    // feed com tombstones já coletados (§7.9): só o estado atual
    records.clear()
    head = 0
    let after = 0
    for (let guard = 0; guard < 1_000_000; guard++) {
      const r = await http.get<RecordsPage>(`/api/v1/records?after=${after}&limit=1000&payload=1`)
      const list = r.records ?? []
      if (!head) head = r.head ?? 0
      for (const c of list) records.set(key(c.type, c.id), { change: c, plain: null })
      if (!r.has_more || !list.length) break
      after = r.next ?? list[list.length - 1].seq
    }
  }
  await fillOmitted(
    http,
    [...records.values()].map((r) => r.change)
  )
  for (const r of records.values()) {
    const c = r.change
    if (c.deleted || !isRecordType(c.type) || !c.env) continue
    try {
      r.plain = await openRecord(keys.sk.record, keys.userId, c, c.env)
    } catch {
      log?.(`merge: não decifrou ${c.type}/${c.id}`)
    }
  }
  const st = await http.get<{ chat_states?: ChatState[] }>('/api/v1/chat-states?since=0')
  return { records, head, states: st?.chat_states ?? [] }
}

// ---------------- análise ----------------

const liveOnline = (snap: OnlineSnapshot, type: string): OnlineRecord[] =>
  [...snap.records.values()].filter((r) => r.change.type === type && !r.change.deleted)

const liveLocal = (store: LocalStore, type: string): number =>
  store.sql.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM records WHERE type = ? AND deleted = 0 AND state = 0',
    [type]
  )?.n ?? 0

/** O aparelho tem dados próprios (os settings sozinhos não contam, como no desktop)? */
export function localHasData(store: LocalStore): boolean {
  return ['provider', 'chat', 'preset', 'memory', 'memory_collection'].some(
    (t) => liveLocal(store, t) > 0
  )
}

/** Há algo online além de skills? */
export function onlineHasData(snap: OnlineSnapshot): boolean {
  return [...snap.records.values()].some((r) => !r.change.deleted && MERGE_TYPES.has(r.change.type))
}

/** Chats com o mesmo id nos dois lados e histórias diferentes (§12.6). */
export function conflictingChats(store: LocalStore, snap: OnlineSnapshot): string[] {
  const out: string[] = []
  for (const r of liveOnline(snap, 'chat')) {
    const chatId = r.change.id
    if (!store.getPlain('chat', chatId)) continue
    const online = [...snap.records.values()].filter(
      (x) => isContent(x.change.type) && x.change.scope === chatId && !x.change.deleted
    )
    const local = new Map(store.contentRecords(chatId).map((x) => [key(x.type, x.id), x.plain]))
    let same = local.size === online.length
    for (const o of online) {
      if (!same) break
      same = samePlain(o.change.type, local.get(key(o.change.type, o.change.id)) ?? null, o.plain)
    }
    if (!same) out.push(chatId)
  }
  return out
}

export function mergeInfo(store: LocalStore, snap: OnlineSnapshot): MergeInfo {
  return {
    local: {
      providers: liveLocal(store, 'provider'),
      chats: liveLocal(store, 'chat'),
      presets: liveLocal(store, 'preset'),
      memories: liveLocal(store, 'memory')
    },
    online: {
      providers: liveOnline(snap, 'provider').length,
      chats: liveOnline(snap, 'chat').length,
      presets: liveOnline(snap, 'preset').length,
      memories: liveOnline(snap, 'memory').length
    },
    conflictingChats: conflictingChats(store, snap).length
  }
}

// ---------------- dedupe e remapeamento (§12.4–12.5) ----------------

/** Mapa `tipo\0idLocal` → id online das entidades deduplicadas (§12.4). */
export function dedupe(store: LocalStore, snap: OnlineSnapshot): Map<string, string> {
  const remap = new Map<string, string>()
  const used = new Set<string>()
  const cands = (t: string) => liveOnline(snap, t).filter((r) => r.plain)
  const pick = (type: string, localId: string, match: (p: Plain) => boolean): void => {
    if (snap.records.has(key(type, localId))) return // mesmo id: mesma entidade
    const hit = cands(type).find(
      (r) =>
        !used.has(key(type, r.change.id)) &&
        !store.recordMeta(type, r.change.id) &&
        match(r.plain as Plain)
    )
    if (!hit) return
    used.add(key(type, hit.change.id))
    remap.set(key(type, localId), hit.change.id)
  }
  for (const { id, plain: l } of store.plainsOf('provider'))
    pick(
      'provider',
      id,
      (p) =>
        normBase(p.baseUrl) === normBase(l.baseUrl) &&
        (normName(p.name) === normName(l.name) || (!!l.apiKey && p.apiKey === l.apiKey))
    )
  for (const { id, plain: l } of store.plainsOf('preset'))
    pick(
      'preset',
      id,
      (p) =>
        normName(p.name) === normName(l.name) &&
        canonical(withoutCwd(p.config)) === canonical(withoutCwd(l.config))
    )
  for (const { id, plain: l } of store.plainsOf('memory_collection'))
    pick(
      'memory_collection',
      id,
      (p) => p.category === l.category && normName(p.name) === normName(l.name)
    )
  for (const { id, plain: l } of store.plainsOf('memory')) {
    const col = remap.get(key('memory_collection', String(l.collectionId))) ?? l.collectionId
    pick('memory', id, (p) => p.collectionId === col && normName(p.title) === normName(l.title))
  }
  return remap
}

type Getter = (type: string, id: unknown) => string | undefined

/** `ChatConfig`/`PresetConfig`: provedores, persona, coleções da memória (= `remapConfig` do desktop). */
function remapConfig(cfg: Plain, get: Getter): boolean {
  let changed = false
  const set = (obj: Plain, k: string, type: string): void => {
    const n = get(type, obj[k])
    if (n) {
      obj[k] = n
      changed = true
    }
  }
  set(cfg, 'providerId', 'provider')
  set(cfg, 'presetId', 'preset')
  if (isObj(cfg.smartApprove)) {
    set(cfg.smartApprove, 'providerId', 'provider')
    if (isObj(cfg.smartApprove.capture)) set(cfg.smartApprove.capture, 'providerId', 'provider')
  }
  if (isObj(cfg.voice) && isObj(cfg.voice.model)) set(cfg.voice.model, 'providerId', 'provider')
  if (isObj(cfg.memory)) {
    const mem = cfg.memory
    if (isObj(mem.extraction)) set(mem.extraction, 'providerId', 'provider')
    if (Array.isArray(mem.collections))
      mem.collections = mem.collections.map((c) => {
        const n = get('memory_collection', c)
        if (n) changed = true
        return n ?? c
      })
    if (isObj(mem.writeTo))
      for (const cat of Object.keys(mem.writeTo)) set(mem.writeTo, cat, 'memory_collection')
  }
  return changed
}

/** Settings com provedor/persona dentro do valor (§12.5). */
const SETTING_PATHS: Record<string, { path: string[]; type: 'provider' | 'preset' }> = {
  defaultModel: { path: [], type: 'provider' },
  smartApproveDefaults: { path: ['capture'], type: 'provider' },
  autoTitle: { path: [], type: 'provider' },
  sttSettings: { path: ['api'], type: 'provider' },
  ttsSettings: { path: ['api'], type: 'provider' },
  voiceCallDefaults: { path: ['model'], type: 'provider' }
}

/** Referências de um plaintext local remapeadas (null = nada mudou). */
export function remapPlain(type: string, id: string, plain: Plain, get: Getter): Plain | null {
  const p = JSON.parse(JSON.stringify(plain)) as Plain
  let changed = false
  const set = (obj: Plain, k: string, t: string): void => {
    const n = get(t, obj[k])
    if (n) {
      obj[k] = n
      changed = true
    }
  }
  if ((type === 'chat' || type === 'preset') && isObj(p.config))
    changed = remapConfig(p.config, get) || changed
  if (type === 'session') set(p, 'providerId', 'provider')
  if (type === 'memory') {
    set(p, 'collectionId', 'memory_collection')
    set(p, 'supersedesId', 'memory')
  }
  if (type === 'setting') {
    if (id === 'defaultPresetId') set(p, 'value', 'preset')
    else if (id === 'defaultProviderId') set(p, 'value', 'provider')
    const sp = SETTING_PATHS[id]
    if (sp) {
      let obj: unknown = p.value
      for (const k of sp.path) obj = isObj(obj) ? obj[k] : undefined
      if (isObj(obj)) set(obj, 'providerId', sp.type)
    }
  }
  return changed ? p : null
}

// ---------------- aplicação (§12.4–12.8) ----------------

export interface MergeResult {
  /** Registros que vão subir (outboxes). */
  queued: number
  /** Entidades locais deduplicadas com uma online. */
  remapped: number
}

/**
 * Aplica o merge no cache (uma transação): dedupe + remapeamento, conteúdo vencedor, outboxes
 * refeitas com o que sobe, estados dos chats, cursor = head e o novo dono do cache (`owner`).
 */
export function applyMerge(
  store: LocalStore,
  snap: OnlineSnapshot,
  priority: MergePriority,
  owner: string
): MergeResult {
  return store.sql.tx(() => {
    const conflicting = new Set(conflictingChats(store, snap))
    // 1) deduplicação local → online (o id canônico é o online)
    const remap = dedupe(store, snap)
    for (const [k, newId] of remap) {
      const [type, oldId] = k.split('\u0000')
      store.renameRecord(type, oldId, newId)
    }
    if (remap.size) {
      const get: Getter = (t, id) => (typeof id === 'string' ? remap.get(key(t, id)) : undefined)
      for (const r of store.allRecords()) {
        if (r.deleted || !r.plain || r.state !== RecordState.Ok) continue
        const next = remapPlain(r.type, r.id, r.plain, get)
        if (next) store.replacePlain(r.type, r.id, next)
      }
    }
    // chats com histórias diferentes e prioridade online: a versão local sai antes
    if (priority === 'online')
      for (const chatId of conflicting)
        for (const r of store.contentRecords(chatId)) store.forgetContent(r.type, r.id, chatId)

    // 2) conteúdo vencedor por registro online
    const queue: Parameters<LocalStore['queueForMerge']>[0][] = []
    const online = [...snap.records.values()].sort((a, b) => {
      const oa = ORDER.indexOf(a.change.type)
      const ob = ORDER.indexOf(b.change.type)
      if (oa !== ob) return (oa < 0 ? 99 : oa) - (ob < 0 ? 99 : ob)
      if (a.change.type === 'session')
        return Number(a.plain?.depth ?? 0) - Number(b.plain?.depth ?? 0)
      return a.change.seq - b.change.seq
    })
    for (const r of online) {
      const c = r.change
      if (!isRecordType(c.type)) {
        if (!c.deleted && !store.recordMeta(c.type, c.id))
          store.putRecord(c, null, RecordState.Opaque)
        continue
      }
      const local = c.type === 'skill' ? null : store.getPlain(c.type, c.id)
      const conflict = isContent(c.type) && !!c.scope && conflicting.has(c.scope)
      const ref = { type: c.type, id: c.id, scope: c.scope ?? null }
      if (c.deleted) {
        if (local && priority === 'local') {
          // apagado online e presente aqui: prioridade local recria (base = rev do tombstone)
          queue.push({ ...ref, baseRev: c.rev, seq: c.seq, plain: local })
        } else store.deleteRecord(c)
        continue
      }
      if (!r.plain) continue // não decifrou: fica de fora (como no desktop)
      if (!local) {
        if (conflict && priority === 'local') {
          // só existe online num chat conflitante e a prioridade é local → tombstone
          store.deleteRecord(c)
          queue.push({ ...ref, baseRev: c.rev, seq: c.seq, plain: null })
        } else store.putRecord(c, r.plain, RecordState.Ok)
        continue
      }
      let useOnline: boolean
      if (isContent(c.type)) useOnline = !conflict || priority === 'online'
      else if (c.type === 'setting') useOnline = priority === 'online' || local.value == null
      else useOnline = priority === 'online'
      if (useOnline || samePlain(c.type, local, r.plain))
        store.putRecord(c, r.plain, RecordState.Ok)
      else queue.push({ ...ref, baseRev: c.rev, seq: c.seq, plain: local })
    }

    // 3) tudo o que é local e não existe online → sobe como novo (base 0)
    for (const l of store.allRecords()) {
      if (snap.records.has(key(l.type, l.id)) || !MERGE_TYPES.has(l.type)) continue
      if (l.deleted) {
        store.dropTombstone(l.type, l.id) // apagado aqui e nunca enviado
        continue
      }
      if (l.state !== RecordState.Ok || !l.plain) continue
      queue.push({ type: l.type, id: l.id, scope: l.scope, baseRev: 0, seq: 0, plain: l.plain })
    }
    store.clearOutboxes()
    for (const q of queue) store.queueForMerge(q)
    // 4) estados de host, cursor e o dono do cache (o sync normal liga depois)
    store.replaceChatStates(snap.states)
    store.setCursor(snap.head)
    store.setMeta('owner', owner)
    for (const k of store.refetchChats()) store.setMeta(`refetch:${k}`, null)
    store.refreshDirtyChats()
    return { queued: queue.length, remapped: remap.size }
  })
}

// ---------------- fluxo (observável pela tela) ----------------

export type MergeState =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'ask'; info: MergeInfo }
  | { phase: 'running'; priority: MergePriority }
  | { phase: 'error'; error: string }

export interface FirstLoginMergeDeps {
  store: LocalStore
  http: MergeHttp
  /** Chaves da conta (o merge roda com o cofre aberto). */
  keys: () => MergeKeys | null
  /** Dono do cache depois do merge (`<servidor>|<usuário>`). */
  owner: () => string
  /** Merge aplicado: liga o sync normal e as outboxes. */
  onDone: (r: MergeResult) => void
  log?: (msg: string) => void
}

const errText = (e: unknown): string => {
  if (e instanceof SyncNetworkError)
    return 'Sem conexão com o servidor. Tente de novo quando estiver online.'
  if (e instanceof SyncApiError) return e.message
  return e instanceof Error && e.message ? e.message : 'Não foi possível unir os dados.'
}

export class FirstLoginMerge {
  private readonly d: FirstLoginMergeDeps
  private state: MergeState = { phase: 'idle' }
  private snap: OnlineSnapshot | null = null
  private listeners = new Set<() => void>()
  /** Muda a cada `begin`/`cancel`: um download antigo não aplica nada. */
  private gen = 0

  constructor(deps: FirstLoginMergeDeps) {
    this.d = deps
  }

  getState = (): MergeState => this.state

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private set(s: MergeState): void {
    this.state = s
    for (const fn of this.listeners) fn()
  }

  /** Há merge em andamento (a tela de dados fica atrás da pergunta/progresso). */
  get active(): boolean {
    return this.state.phase !== 'idle'
  }

  /**
   * Baixa o estado online e decide: online vazio → envia tudo; local vazio → só baixa; os dois →
   * pergunta (`ask`). Erro de rede → `error` (tentar de novo).
   */
  async begin(): Promise<void> {
    const gen = ++this.gen
    this.snap = null
    this.set({ phase: 'checking' })
    try {
      const keys = this.d.keys()
      if (!keys) throw new Error('Desbloqueie a conta primeiro.')
      const snap = await downloadOnline(this.d.http, keys, this.d.log)
      if (gen !== this.gen) return
      if (!onlineHasData(snap)) return this.run('local', snap)
      if (!localHasData(this.d.store)) return this.run('online', snap)
      this.snap = snap
      this.set({ phase: 'ask', info: mergeInfo(this.d.store, snap) })
    } catch (e) {
      if (gen !== this.gen) return
      this.d.log?.(`merge: ${(e as Error).message}`)
      this.set({ phase: 'error', error: errText(e) })
    }
  }

  /** Resposta à pergunta (§12.2). */
  async resolve(priority: MergePriority): Promise<void> {
    if (this.state.phase !== 'ask' || !this.snap) throw new Error('Não há merge pendente.')
    this.run(priority, this.snap)
  }

  /** Bloqueou/saiu no meio: esquece o download (o merge recomeça no próximo desbloqueio). */
  cancel(): void {
    this.gen++
    this.snap = null
    if (this.state.phase !== 'idle') this.set({ phase: 'idle' })
  }

  private run(priority: MergePriority, snap: OnlineSnapshot): void {
    this.set({ phase: 'running', priority })
    let r: MergeResult
    try {
      r = applyMerge(this.d.store, snap, priority, this.d.owner())
    } catch (e) {
      this.d.log?.(`merge não aplicado: ${(e as Error).message}`)
      this.set({ phase: 'error', error: 'Não foi possível unir os dados. Tente de novo.' })
      return
    }
    this.snap = null
    this.d.log?.(`merge (${priority}): ${r.queued} para subir, ${r.remapped} deduplicados`)
    this.d.store.notifyReset()
    this.set({ phase: 'idle' })
    this.d.onDone(r)
  }
}
