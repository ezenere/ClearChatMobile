// Cache local do sync no SQLite do app: registros (plaintext decifrado uma vez — ver README § "Cache
// local"), cursor, índices derivados para a lista de chats, a busca (FTS5) e a prévia, e os estados de
// host (§8.2). Sem rede e sem cripto: quem decifra e decide o que aplicar é o SyncEngine.
import { activePath, buildTree, type TreeMessage } from '@shared/branches'
import type { Session, StoredMessage } from '@shared/types'
import { searchableText } from '@vendor/desktop/searchIndex'
import {
  chatFromPlain,
  isPreviewable,
  messageFromPlain,
  messagePlainText,
  previewText,
  sessionFromPlain
} from './decode'
import type { Sql } from './sql'
import type { Change, ChatPlain, ChatState, Plain } from './types'

/** Estado do registro no cache. */
export const RecordState = {
  /** Plaintext decifrado e aplicado. */
  Ok: 0,
  /** Tipo desconhecido ou envelope de versão mais nova: guardado opaco (§4.2, §18). */
  Opaque: 1,
  /** Não decifrou (AAD/tag): guardado sem conteúdo, nunca exibido. */
  Broken: 2
} as const
export type RecordStateCode = (typeof RecordState)[keyof typeof RecordState]

export interface RecordMeta {
  rev: number
  seq: number
  deleted: boolean
  state: RecordStateCode
}

export interface ChatListItem {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  preview: string | null
  previewRole: 'user' | 'assistant' | null
  presetId: string | null
  /** Trecho da mensagem que casou com a busca (com `[` `]` em volta dos termos). */
  snippet?: string
}

export interface OutboxRow {
  type: string
  id: string
  scope: string | null
  chatId: string
  baseRev: number
  deleted: boolean
  plain: Plain | null
  patch: Plain | null
  /**
   * Registro `chat`: o plaintext da revisão `baseRev` (a última que o servidor tinha quando a
   * edição local começou) — o merge 3-way do §7.5 (`mergeChatRecord`) aplica sobre a versão do
   * servidor só o que mudou daqui desde ela (e `config.overrides` por unidade, §4.3.6). `{}` = chat
   * novo; null = linha de antes da versão 7 do cache (merge pelos campos de `patch`).
   */
  base: Plain | null
  mark: number
}

export interface LwwRow {
  type: string
  id: string
  scope: string | null
  baseRev: number
  deleted: boolean
  plain: Plain | null
  patch: Plain
  mark: number
}

export interface LoadedChat {
  chat: ChatPlain & { id: string }
  sessions: Session[]
  /** Todas as versões, por sessão, na ordem da sessão (seq, id). */
  messages: Map<string, StoredMessage[]>
  /** Registros do chat que não decifraram (não exibidos). */
  broken: number
}

const SCHEMA_VERSION = 7

const MIGRATIONS: Record<number, string> = {
  1: `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS records (
  type TEXT NOT NULL, id TEXT NOT NULL, scope TEXT, rev INTEGER NOT NULL, seq INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0, device_id TEXT, updated_at TEXT, size INTEGER NOT NULL DEFAULT 0,
  blobs TEXT, plain TEXT, env TEXT, state INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (type, id)
);
CREATE INDEX IF NOT EXISTS records_scope ON records(type, scope);
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, title_norm TEXT NOT NULL, created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, main_session_id TEXT, preset_id TEXT, preview TEXT, preview_role TEXT,
  dirty INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS chats_updated ON chats(updated_at DESC);
CREATE TABLE IF NOT EXISTS messages (
  rowid INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, chat_id TEXT NOT NULL, session_id TEXT NOT NULL,
  seq INTEGER NOT NULL, parent TEXT, has_parent INTEGER NOT NULL, created_at INTEGER NOT NULL,
  role TEXT, previewable INTEGER NOT NULL, text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_chat ON messages(chat_id);
CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id, seq);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  text, content='messages', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TABLE IF NOT EXISTS chat_states (chat_id TEXT PRIMARY KEY, json TEXT NOT NULL);
`,
  // prévia recalculada (limpeza de tabelas/listas no texto)
  2: `UPDATE chats SET dirty = 1;`,
  // fase 4 (host no celular): outbox do conteúdo gravado aqui e dedupe de comandos remotos (§8.6)
  3: `
CREATE TABLE IF NOT EXISTS outbox (
  type TEXT NOT NULL, id TEXT NOT NULL, scope TEXT, chat_id TEXT NOT NULL, base_rev INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0, plain TEXT, patch TEXT, mark INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (type, id)
);
CREATE INDEX IF NOT EXISTS outbox_chat ON outbox(chat_id);
CREATE TABLE IF NOT EXISTS commands_seen (cmd_id TEXT PRIMARY KEY, at INTEGER NOT NULL);
`,
  // fase 4b: índice do read_history (conversa e tools com pesos diferentes, como o searchIndex do
  // desktop), outbox LWW dos registros de memória escritos aqui e a fila guardada no segundo plano
  4: `
CREATE VIRTUAL TABLE IF NOT EXISTS history_fts USING fts5(
  body, tool, tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS messages_hist_ad AFTER DELETE ON messages BEGIN
  DELETE FROM history_fts WHERE rowid = old.rowid;
END;
CREATE TABLE IF NOT EXISTS lww_outbox (
  type TEXT NOT NULL, id TEXT NOT NULL, scope TEXT, base_rev INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0, plain TEXT, patch TEXT, mark INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (type, id)
);
CREATE TABLE IF NOT EXISTS parked_queue (
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, session_id TEXT NOT NULL, json TEXT NOT NULL,
  at INTEGER NOT NULL
);
INSERT OR REPLACE INTO meta (key, value) VALUES ('history_backfill', '1');
`,
  // 1.8.0 (§23.2): modo local de cada chat executado aqui — `live` = "Só neste aparelho" (nunca
  // vai ao servidor); ausente = online. `tomb_rev` = rev do tombstone de quando foi tirado do
  // servidor (para uma volta futura com base_rev certa, §23.8)
  5: `
CREATE TABLE IF NOT EXISTS chat_storage (
  chat_id TEXT PRIMARY KEY, storage TEXT NOT NULL, tomb_rev INTEGER NOT NULL DEFAULT 0
);
`,
  // 1.9.0 (§4.3.2/§4.4): as settings de voz viram LOCAIS do aparelho (não sincronizam). O valor
  // que cada uma tinha no cache (o último sincronizado) é copiado uma vez (`seedDeviceSettings`);
  // escritas dessas ids ainda na outbox nunca sobem
  6: `
CREATE TABLE IF NOT EXISTS device_settings (id TEXT PRIMARY KEY, value TEXT);
DELETE FROM lww_outbox WHERE type = 'setting' AND id IN ('audioInput', 'sttSettings', 'ttsSettings', 'voiceCallDefaults');
INSERT OR REPLACE INTO meta (key, value) VALUES ('device_settings_seed', '1');
`,
  // 1.10.0 (§4.3.6, §7.5): base do merge 3-way do registro `chat` pendente (herança ao vivo da
  // persona — `config.overrides` mesclado por unidade; a cópia de uma unidade herdada não
  // sobrescreve um valor próprio do servidor). Linhas antigas ficam NULL (merge pelo `patch`)
  7: `ALTER TABLE outbox ADD COLUMN base TEXT;`
}

/**
 * Settings de voz LOCAIS do aparelho desde o protocolo 1.9.0 (§4.3.2/§4.4): nunca enviadas; os
 * registros recebidos (de apps ≤ 1.8.x) são ignorados — o valor daqui fica.
 */
export const DEVICE_VOICE_SETTING_IDS = [
  'audioInput',
  'sttSettings',
  'ttsSettings',
  'voiceCallDefaults'
] as const

/** Id de `setting` local do aparelho desde 1.9.0 (nunca enviado; o recebido é ignorado). */
export const isDeviceVoiceSetting = (id: string): boolean =>
  (DEVICE_VOICE_SETTING_IDS as readonly string[]).includes(id)

/** Modo de um chat deste aparelho (§23.2). `live_pending` conta como `live` para tudo. */
export type ChatStorage = 'online' | 'live' | 'live_pending'

/** Texto indexado na busca: só a conversa (usuário/assistente), cortado. */
const FTS_MAX_CHARS = 20_000

/** Minúsculas sem acentos (busca por título). */
export const normalizeSearch = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()

const parse = (s: string | null): Plain | null => {
  if (!s) return null
  try {
    const v = JSON.parse(s) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Plain) : null
  } catch {
    return null
  }
}

const cmpMsg = (a: StoredMessage, b: StoredMessage): number =>
  a.seq - b.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

export class LocalStore {
  readonly sql: Sql
  /** Mensagens já interpretadas, por id (reaproveitadas enquanto a revisão não muda). */
  private parsed = new Map<string, { rev: number; msg: StoredMessage }>()

  /** Registros de memória aplicados no cache (o índice da memória acompanha; null = apagado). */
  private memoryListeners = new Set<(type: string, id: string, plain: Plain | null) => void>()
  private wipeListeners = new Set<() => void>()
  private deviceListeners = new Set<(id: string) => void>()
  /** Gravações da própria memória (o índice já tem a mudança): não avisa os ouvintes. */
  private quietMemory = 0

  constructor(sql: Sql) {
    this.sql = sql
    this.migrate()
    if (this.getMeta('history_backfill')) this.backfillHistory()
    if (this.getMeta('device_settings_seed')) this.seedDeviceSettings()
  }

  // ---------------- settings locais do aparelho (voz — 1.9.0) ----------------

  /** Cópia única do valor que as settings de voz tinham no cache (o último sincronizado). */
  private seedDeviceSettings(): void {
    this.sql.tx(() => {
      for (const id of DEVICE_VOICE_SETTING_IDS) {
        const v = this.setting(id)
        if (v !== undefined)
          this.sql.run('INSERT OR IGNORE INTO device_settings (id, value) VALUES (?, ?)', [
            id,
            JSON.stringify(v)
          ])
      }
      this.setMeta('device_settings_seed', null)
    })
  }

  /** Valor de uma setting local do aparelho (`DEVICE_VOICE_SETTING_IDS`); ausente = undefined. */
  deviceSetting<T = unknown>(id: string): T | undefined {
    const r = this.sql.get<{ value: string | null }>(
      'SELECT value FROM device_settings WHERE id = ?',
      [id]
    )
    if (!r?.value) return undefined
    try {
      const v = JSON.parse(r.value) as unknown
      return v == null ? undefined : (v as T)
    } catch {
      return undefined
    }
  }

  /** Grava (ou apaga, com null) uma setting local do aparelho — nunca vai ao servidor. */
  setDeviceSetting(id: string, value: unknown): void {
    if (value == null) this.sql.run('DELETE FROM device_settings WHERE id = ?', [id])
    else
      this.sql.run(
        'INSERT INTO device_settings (id, value) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value',
        [id, JSON.stringify(value)]
      )
    for (const fn of [...this.deviceListeners]) fn(id)
  }

  /** Avisa a cada gravação de uma setting local do aparelho. */
  onDeviceSetting(fn: (id: string) => void): () => void {
    this.deviceListeners.add(fn)
    return () => this.deviceListeners.delete(fn)
  }

  onMemoryRecord(fn: (type: string, id: string, plain: Plain | null) => void): () => void {
    this.memoryListeners.add(fn)
    return () => this.memoryListeners.delete(fn)
  }

  onWipe(fn: () => void): () => void {
    this.wipeListeners.add(fn)
    return () => this.wipeListeners.delete(fn)
  }

  private memoryChanged(type: string, id: string, plain: Plain | null): void {
    if (this.quietMemory || (type !== 'memory' && type !== 'memory_collection')) return
    for (const fn of this.memoryListeners) {
      try {
        fn(type, id, plain)
      } catch {
        /* o índice da memória se reconstrói na próxima leitura */
      }
    }
  }

  /** Índice do read_history para as mensagens que já estavam no cache (migração 4). */
  private backfillHistory(): void {
    this.sql.tx(() => {
      const rows = this.sql.all<{ id: string; scope: string | null; plain: string | null }>(
        "SELECT id, scope, plain FROM records WHERE type = 'message' AND deleted = 0 AND state = 0"
      )
      for (const r of rows) {
        const p = parse(r.plain)
        if (p) this.indexHistory(messageFromPlain(r.id, p))
      }
      this.setMeta('history_backfill', null)
    })
  }

  /** (Re)indexa uma mensagem no history_fts (rowid = rowid de `messages`). */
  private indexHistory(m: StoredMessage): void {
    const row = this.sql.get<{ rowid: number }>('SELECT rowid FROM messages WHERE id = ?', [m.id])
    if (!row) return
    this.sql.run('DELETE FROM history_fts WHERE rowid = ?', [row.rowid])
    const { body, tool } = searchableText(m.message, m.meta)
    if (body || tool)
      this.sql.run('INSERT INTO history_fts (rowid, body, tool) VALUES (?, ?, ?)', [
        row.rowid,
        body,
        tool
      ])
  }

  private migrate(): void {
    const row = this.sql.get<{ user_version: number }>('PRAGMA user_version')
    let v = row?.user_version ?? 0
    while (v < SCHEMA_VERSION) {
      const next = v + 1
      this.sql.tx(() => {
        this.sql.exec(MIGRATIONS[next])
        this.sql.exec(`PRAGMA user_version = ${next}`)
      })
      v = next
    }
  }

  // ---------------- meta ----------------

  getMeta(key: string): string | null {
    return (
      this.sql.get<{ value: string | null }>('SELECT value FROM meta WHERE key = ?', [key])
        ?.value ?? null
    )
  }

  setMeta(key: string, value: string | number | null): void {
    if (value === null) this.sql.run('DELETE FROM meta WHERE key = ?', [key])
    else
      this.sql.run(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        [key, String(value)]
      )
  }

  get cursor(): number {
    return Number(this.getMeta('cursor') ?? 0) || 0
  }

  setCursor(seq: number): void {
    this.setMeta('cursor', Math.max(0, Math.trunc(seq)))
  }

  /** Apaga tudo (logout, revogação, chaves redefinidas, outra conta/servidor). */
  wipe(): void {
    this.sql.tx(() => {
      for (const t of [
        'records',
        'chats',
        'messages',
        'chat_states',
        'meta',
        'outbox',
        'commands_seen',
        'lww_outbox',
        'parked_queue',
        'history_fts',
        'chat_storage'
      ])
        this.sql.run(`DELETE FROM ${t}`)
      this.sql.run(`INSERT INTO messages_fts(messages_fts) VALUES ('delete-all')`)
    })
    this.parsed.clear()
    for (const fn of this.wipeListeners) fn()
    try {
      this.sql.exec('VACUUM')
    } catch {
      /* sem espaço/ocupado: os dados já foram apagados */
    }
  }

  // ---------------- registros ----------------

  recordMeta(type: string, id: string): RecordMeta | null {
    const r = this.sql.get<{ rev: number; seq: number; deleted: number; state: number }>(
      'SELECT rev, seq, deleted, state FROM records WHERE type = ? AND id = ?',
      [type, id]
    )
    return r
      ? { rev: r.rev, seq: r.seq, deleted: !!r.deleted, state: r.state as RecordStateCode }
      : null
  }

  getPlain(type: string, id: string): Plain | null {
    const r = this.sql.get<{ plain: string | null }>(
      'SELECT plain FROM records WHERE type = ? AND id = ? AND deleted = 0',
      [type, id]
    )
    return parse(r?.plain ?? null)
  }

  /** Ids de blob referenciados pela revisão atual (preservados ao regravar). */
  recordBlobs(type: string, id: string): string[] {
    const r = this.sql.get<{ blobs: string | null }>(
      'SELECT blobs FROM records WHERE type = ? AND id = ?',
      [type, id]
    )
    try {
      const v = JSON.parse(r?.blobs ?? '[]') as unknown
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
    } catch {
      return []
    }
  }

  bumpSeq(type: string, id: string, seq: number): void {
    this.sql.run('UPDATE records SET seq = MAX(seq, ?) WHERE type = ? AND id = ?', [seq, type, id])
  }

  /** Grava a revisão de um registro (vivo). `plain` null = opaco/quebrado (guarda o envelope). */
  putRecord(c: Change, plain: Plain | null, state: RecordStateCode): void {
    this.sql.run(
      `INSERT INTO records (type, id, scope, rev, seq, deleted, device_id, updated_at, size, blobs, plain, env, state)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(type, id) DO UPDATE SET scope = excluded.scope, rev = excluded.rev, seq = excluded.seq,
         deleted = 0, device_id = excluded.device_id, updated_at = excluded.updated_at, size = excluded.size,
         blobs = excluded.blobs, plain = excluded.plain, env = excluded.env, state = excluded.state`,
      [
        c.type,
        c.id,
        c.scope ?? null,
        c.rev,
        c.seq,
        c.device_id ?? null,
        c.updated_at ?? null,
        c.size ?? 0,
        JSON.stringify(c.blobs ?? []),
        plain ? JSON.stringify(plain) : null,
        plain || !c.env ? null : JSON.stringify(c.env),
        state
      ]
    )
    if (state !== RecordState.Ok || !plain) {
      this.dropDerived(c.type, c.id, c.scope)
      this.memoryChanged(c.type, c.id, null)
      return
    }
    this.indexRecord(c.type, c.id, c.scope, plain)
    this.memoryChanged(c.type, c.id, plain)
  }

  /** Tombstone (§7.7) com a cascata local: chat → sessões/mensagens; coleção → memórias. */
  deleteRecord(c: Pick<Change, 'type' | 'id' | 'scope' | 'rev' | 'seq'>): void {
    this.sql.run(
      `INSERT INTO records (type, id, scope, rev, seq, deleted, size, blobs, plain, env, state)
       VALUES (?, ?, ?, ?, ?, 1, 0, '[]', NULL, NULL, 0)
       ON CONFLICT(type, id) DO UPDATE SET scope = excluded.scope, rev = excluded.rev, seq = excluded.seq,
         deleted = 1, plain = NULL, env = NULL, blobs = '[]', state = 0`,
      [c.type, c.id, c.scope ?? null, c.rev, c.seq]
    )
    this.dropDerived(c.type, c.id, c.scope)
    if (c.type === 'chat') this.cascadeChat(c.id)
    if (c.type === 'memory_collection')
      this.sql.run("DELETE FROM records WHERE type = 'memory' AND scope = ?", [c.id])
    this.memoryChanged(c.type, c.id, null)
  }

  /** Remove o registro do cache (resync: sumiu do servidor) com a mesma cascata. */
  removeRecord(type: string, id: string, scope: string | null): void {
    this.sql.run('DELETE FROM records WHERE type = ? AND id = ?', [type, id])
    this.dropDerived(type, id, scope)
    if (type === 'chat') this.cascadeChat(id)
    if (type === 'memory_collection')
      this.sql.run("DELETE FROM records WHERE type = 'memory' AND scope = ?", [id])
    this.memoryChanged(type, id, null)
  }

  private cascadeChat(chatId: string): void {
    const ids = this.sql.all<{ id: string }>(
      "SELECT id FROM records WHERE type = 'message' AND scope = ?",
      [chatId]
    )
    for (const { id } of ids) this.parsed.delete(id)
    this.sql.run("DELETE FROM records WHERE scope = ? AND type IN ('session', 'message')", [chatId])
    this.sql.run('DELETE FROM messages WHERE chat_id = ?', [chatId])
    this.sql.run('DELETE FROM chats WHERE id = ?', [chatId])
    this.sql.run('DELETE FROM chat_states WHERE chat_id = ?', [chatId])
  }

  /** Registros vivos já sincronizados (para o resync reconciliar, §7.9). */
  liveRecords(): { type: string; id: string; scope: string | null }[] {
    return this.sql.all('SELECT type, id, scope FROM records WHERE deleted = 0')
  }

  // ---------------- índices derivados ----------------

  private dropDerived(type: string, id: string, scope: string | null): void {
    if (type === 'chat') this.sql.run('DELETE FROM chats WHERE id = ?', [id])
    else if (type === 'message') {
      this.parsed.delete(id)
      this.sql.run('DELETE FROM messages WHERE id = ?', [id])
      if (scope) this.markDirty(scope)
    } else if (type === 'session' && scope) this.markDirty(scope)
  }

  private markDirty(chatId: string): void {
    this.sql.run('UPDATE chats SET dirty = 1 WHERE id = ?', [chatId])
  }

  private indexRecord(type: string, id: string, scope: string | null, plain: Plain): void {
    if (type === 'chat') {
      const c = chatFromPlain(id, plain)
      const presetId = typeof c.config.presetId === 'string' ? c.config.presetId : null
      this.sql.run(
        `INSERT INTO chats (id, title, title_norm, created_at, updated_at, main_session_id, preset_id, dirty)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, title_norm = excluded.title_norm,
           created_at = excluded.created_at, updated_at = excluded.updated_at,
           main_session_id = excluded.main_session_id, preset_id = excluded.preset_id, dirty = 1`,
        [
          id,
          c.title,
          normalizeSearch(c.title),
          c.createdAt,
          c.updatedAt,
          c.mainSessionId || null,
          presetId
        ]
      )
      return
    }
    if (type === 'session') {
      if (scope) this.markDirty(scope)
      return
    }
    if (type !== 'message' || !scope) return
    const m = messageFromPlain(id, plain)
    const previewable = isPreviewable(m)
    const text = previewable ? messagePlainText(m).slice(0, FTS_MAX_CHARS) : ''
    this.sql.run(
      `INSERT INTO messages (id, chat_id, session_id, seq, parent, has_parent, created_at, role, previewable, text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET chat_id = excluded.chat_id, session_id = excluded.session_id,
         seq = excluded.seq, parent = excluded.parent, has_parent = excluded.has_parent,
         created_at = excluded.created_at, role = excluded.role, previewable = excluded.previewable,
         text = excluded.text`,
      [
        id,
        scope,
        m.sessionId,
        m.seq,
        typeof m.parentId === 'string' ? m.parentId : null,
        m.parentId === undefined ? 0 : 1,
        m.createdAt,
        m.message.role,
        previewable ? 1 : 0,
        text
      ]
    )
    this.indexHistory(m)
    this.markDirty(scope)
  }

  /** Recalcula a prévia dos chats marcados (caminho ativo da sessão principal, §4.3.8). */
  refreshDirtyChats(): string[] {
    const dirty = this.sql.all<{ id: string; main_session_id: string | null }>(
      'SELECT id, main_session_id FROM chats WHERE dirty = 1'
    )
    for (const c of dirty) this.refreshChat(c.id, c.main_session_id)
    return dirty.map((c) => c.id)
  }

  private refreshChat(chatId: string, mainSessionId: string | null): void {
    let sid = mainSessionId
    if (
      !sid ||
      !this.sql.get('SELECT 1 FROM records WHERE type = ? AND id = ? AND deleted = 0', [
        'session',
        sid
      ])
    ) {
      // principal ainda não chegou: a sessão de profundidade 0 mais antiga
      const s = this.sql.get<{ id: string }>(
        "SELECT id FROM records WHERE type = 'session' AND scope = ? AND deleted = 0 AND plain IS NOT NULL ORDER BY json_extract(plain, '$.depth'), json_extract(plain, '$.createdAt') LIMIT 1",
        [chatId]
      )
      sid = s?.id ?? sid
    }
    let preview: string | null = null
    let role: string | null = null
    if (sid) {
      const sess = this.getPlain('session', sid)
      const sel = sess ? sessionFromPlain(sid, sess).branchSel : {}
      const rows = this.sql.all<{
        id: string
        seq: number
        parent: string | null
        has_parent: number
        role: string
        previewable: number
        text: string
      }>(
        'SELECT id, seq, parent, has_parent, role, previewable, text FROM messages WHERE session_id = ?',
        [sid]
      )
      type Node = TreeMessage & { role: string; previewable: number; text: string }
      const nodes: Node[] = rows.map((r) => ({
        id: r.id,
        seq: r.seq,
        ...(r.has_parent ? { parentId: r.parent } : {}),
        role: r.role,
        previewable: r.previewable,
        text: r.text
      }))
      const path = activePath(buildTree(nodes), sel)
      for (let i = path.length - 1; i >= 0; i--) {
        const n = path[i]
        if (!n.previewable || !n.text.trim()) continue
        preview = previewText(n.text)
        role = n.role
        break
      }
    }
    this.sql.run('UPDATE chats SET preview = ?, preview_role = ?, dirty = 0 WHERE id = ?', [
      preview,
      role,
      chatId
    ])
  }

  // ---------------- consultas da UI ----------------

  listChats(query = ''): ChatListItem[] {
    const q = normalizeSearch(query.trim())
    type Row = {
      id: string
      title: string
      created_at: number
      updated_at: number
      preview: string | null
      preview_role: string | null
      preset_id: string | null
    }
    const map = (r: Row, snippet?: string | null): ChatListItem => ({
      id: r.id,
      title: r.title,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      preview: r.preview,
      previewRole:
        r.preview_role === 'user' || r.preview_role === 'assistant' ? r.preview_role : null,
      presetId: r.preset_id,
      ...(snippet ? { snippet } : {})
    })
    const cols = 'c.id, c.title, c.created_at, c.updated_at, c.preview, c.preview_role, c.preset_id'
    if (!q)
      return this.sql
        .all<Row>(`SELECT ${cols} FROM chats c ORDER BY c.updated_at DESC, c.id`)
        .map((r) => map(r))
    const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`
    const byTitle = this.sql.all<Row>(
      `SELECT ${cols} FROM chats c WHERE c.title_norm LIKE ? ESCAPE '\\' ORDER BY c.updated_at DESC`,
      [like]
    )
    const fts = ftsQuery(q)
    const byContent = fts
      ? this.sql.all<Row & { snip: string }>(
          `SELECT ${cols}, snippet(messages_fts, 0, '[', ']', '…', 10) AS snip
           FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid
           JOIN chats c ON c.id = m.chat_id
           WHERE messages_fts MATCH ? ORDER BY m.created_at DESC LIMIT 400`,
          [fts]
        )
      : []
    const out = new Map<string, ChatListItem>()
    for (const r of byTitle) out.set(r.id, map(r))
    for (const r of byContent) if (!out.has(r.id)) out.set(r.id, map(r, r.snip))
    return [...out.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  chatSummary(chatId: string): ChatListItem | null {
    return this.listChats().find((c) => c.id === chatId) ?? null
  }

  /** Persona (nome/ícone) de cada registro `preset`. */
  presets(): Map<string, { name: string; icon: string }> {
    const out = new Map<string, { name: string; icon: string }>()
    for (const r of this.sql.all<{ id: string; plain: string | null }>(
      "SELECT id, plain FROM records WHERE type = 'preset' AND deleted = 0 AND plain IS NOT NULL"
    )) {
      const p = parse(r.plain)
      if (p)
        out.set(r.id, {
          name: typeof p.name === 'string' ? p.name : '',
          icon: typeof p.icon === 'string' ? p.icon : ''
        })
    }
    return out
  }

  /** Conteúdo de um chat: registro, sessões e todas as versões das mensagens. */
  loadChat(chatId: string): LoadedChat | null {
    const plain = this.getPlain('chat', chatId)
    if (!plain) return null
    const chat = { ...chatFromPlain(chatId, plain), id: chatId }
    const sessions = this.sql
      .all<{ id: string; plain: string | null }>(
        "SELECT id, plain FROM records WHERE type = 'session' AND scope = ? AND deleted = 0 AND state = 0",
        [chatId]
      )
      .flatMap((r) => {
        const p = parse(r.plain)
        return p ? [sessionFromPlain(r.id, p)] : []
      })
      .sort((a, b) => a.depth - b.depth || a.createdAt - b.createdAt)
    const revs = this.sql.all<{ id: string; rev: number; state: number }>(
      "SELECT id, rev, state FROM records WHERE type = 'message' AND scope = ? AND deleted = 0",
      [chatId]
    )
    const missing = revs.filter(
      (r) => r.state === RecordState.Ok && this.parsed.get(r.id)?.rev !== r.rev
    )
    if (missing.length) {
      const fetchOne = (id: string) =>
        this.sql.get<{ plain: string | null }>(
          "SELECT plain FROM records WHERE type = 'message' AND id = ?",
          [id]
        )?.plain ?? null
      const bulk =
        missing.length > 40
          ? new Map(
              this.sql
                .all<{ id: string; plain: string | null }>(
                  "SELECT id, plain FROM records WHERE type = 'message' AND scope = ? AND deleted = 0 AND state = 0",
                  [chatId]
                )
                .map((r) => [r.id, r.plain])
            )
          : null
      for (const r of missing) {
        const p = parse(bulk ? (bulk.get(r.id) ?? null) : fetchOne(r.id))
        if (p) this.parsed.set(r.id, { rev: r.rev, msg: messageFromPlain(r.id, p) })
      }
    }
    const messages = new Map<string, StoredMessage[]>()
    let broken = 0
    for (const r of revs) {
      if (r.state !== RecordState.Ok) {
        broken++
        continue
      }
      const m = this.parsed.get(r.id)?.msg
      if (!m) continue
      const list = messages.get(m.sessionId)
      if (list) list.push(m)
      else messages.set(m.sessionId, [m])
    }
    for (const list of messages.values()) list.sort(cmpMsg)
    return { chat, sessions, messages, broken }
  }

  /** Ids das mensagens assistant do chat (controle remoto: troca o draft pela persistida). */
  assistantIds(chatId: string): string[] {
    return this.sql
      .all<{ id: string }>("SELECT id FROM messages WHERE chat_id = ? AND role = 'assistant'", [
        chatId
      ])
      .map((r) => r.id)
  }

  /** Uma mensagem decodificada (null = ausente, apagada ou ilegível). */
  message(id: string): StoredMessage | null {
    const p = this.getPlain('message', id)
    return p ? messageFromPlain(id, p) : null
  }

  // ---------------- estados de host (§8.2) ----------------

  replaceChatStates(states: ChatState[]): void {
    this.sql.tx(() => {
      this.sql.run('DELETE FROM chat_states')
      for (const s of states) this.upsertChatState(s)
    })
  }

  upsertChatState(s: ChatState): void {
    if (!s?.chat_id) return
    const { event: _event, ...rest } = s
    this.sql.run(
      'INSERT INTO chat_states (chat_id, json) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET json = excluded.json',
      [s.chat_id, JSON.stringify(rest)]
    )
  }

  chatStates(): Map<string, ChatState> {
    const out = new Map<string, ChatState>()
    for (const r of this.sql.all<{ chat_id: string; json: string }>(
      'SELECT chat_id, json FROM chat_states'
    )) {
      const p = parse(r.json)
      if (p) out.set(r.chat_id, p as unknown as ChatState)
    }
    return out
  }

  chatState(chatId: string): ChatState | null {
    const r = this.sql.get<{ json: string }>('SELECT json FROM chat_states WHERE chat_id = ?', [
      chatId
    ])
    return (parse(r?.json ?? null) as unknown as ChatState) ?? null
  }

  // ---------------- escrita local (host no celular, §8.4) ----------------

  /**
   * Grava localmente uma revisão feita AQUI (o host) e a põe na outbox: rev = base + 1, onde base
   * é a última revisão aceita pelo servidor (a da outbox, se já houver uma pendente). O `seq` fica o
   * da última revisão aceita até o push. `patch` (registro `chat`, LWW) acumula os campos mudados
   * aqui, reaplicados sobre a versão do servidor num conflito.
   */
  writeLocal(w: {
    type: string
    id: string
    scope: string | null
    chatId: string
    plain: Plain | null
    patch?: Plain
  }): void {
    this.sql.tx(() => {
      const row = this.sql.get<{ base_rev: number; mark: number; patch: string | null }>(
        'SELECT base_rev, mark, patch FROM outbox WHERE type = ? AND id = ?',
        [w.type, w.id]
      )
      const meta = this.recordMeta(w.type, w.id)
      const base = row ? row.base_rev : (meta?.rev ?? 0)
      const rev = base + 1
      // base do merge 3-way do `chat` (§7.5): a revisão que o servidor tinha antes desta edição
      const basePlain =
        w.type === 'chat' && !row
          ? JSON.stringify((meta && !meta.deleted ? this.getPlain(w.type, w.id) : null) ?? {})
          : null
      const change: Change = {
        type: w.type,
        id: w.id,
        scope: w.scope,
        rev,
        seq: meta?.seq ?? 0,
        deleted: !w.plain,
        size: 0,
        blobs: w.plain ? this.recordBlobs(w.type, w.id) : [],
        device_id: '',
        updated_at: new Date().toISOString()
      }
      if (w.plain) this.putRecord(change, w.plain, RecordState.Ok)
      else this.deleteRecord(change)
      // "Só neste aparelho" (§23.2): NADA deste chat vai para a outbox
      if (this.isLocalOnly(w.chatId)) {
        if (!w.plain && w.type === 'chat') this.purgeChat(w.chatId)
        this.refreshDirtyChats()
        return
      }
      const patch = w.patch ? { ...(parse(row?.patch ?? null) ?? {}), ...w.patch } : null
      if (patch && w.patch?.config && typeof w.patch.config === 'object') {
        const prev = parse(row?.patch ?? null)?.config
        patch.config = { ...(prev && typeof prev === 'object' ? prev : {}), ...w.patch.config }
      }
      this.sql.run(
        `INSERT INTO outbox (type, id, scope, chat_id, base_rev, deleted, plain, patch, mark, base)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT(type, id) DO UPDATE SET deleted = excluded.deleted, plain = excluded.plain,
           patch = excluded.patch, mark = outbox.mark + 1`,
        [
          w.type,
          w.id,
          w.scope,
          w.chatId,
          base,
          w.plain ? 0 : 1,
          w.plain ? JSON.stringify(w.plain) : null,
          patch ? JSON.stringify(patch) : null,
          basePlain
        ]
      )
      this.refreshDirtyChats()
    })
  }

  // ---------------- modo do chat (§23.2) ----------------

  storageOf(chatId: string): ChatStorage {
    const r = this.sql.get<{ storage: string }>(
      'SELECT storage FROM chat_storage WHERE chat_id = ?',
      [chatId]
    )
    return r?.storage === 'live' || r?.storage === 'live_pending' ? r.storage : 'online'
  }

  /** Chat guardado só neste aparelho (nunca enviado nem anunciado pelo celular). */
  isLocalOnly(chatId: string): boolean {
    return this.storageOf(chatId) !== 'online'
  }

  setStorage(chatId: string, storage: ChatStorage, tombRev?: number): void {
    if (storage === 'online') this.sql.run('DELETE FROM chat_storage WHERE chat_id = ?', [chatId])
    else
      this.sql.run(
        `INSERT INTO chat_storage (chat_id, storage, tomb_rev) VALUES (?, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET storage = excluded.storage,
           tomb_rev = COALESCE(?, chat_storage.tomb_rev)`,
        [chatId, storage, tombRev ?? 0, tombRev ?? null]
      )
  }

  /** Ids dos chats só neste aparelho que ainda existem. */
  localOnlyChats(): string[] {
    return this.sql
      .all<{ chat_id: string }>(
        `SELECT s.chat_id FROM chat_storage s JOIN records r ON r.type = 'chat' AND r.id = s.chat_id
         WHERE r.deleted = 0`
      )
      .map((r) => r.chat_id)
  }

  /** Quantas mensagens (todas as versões) o chat tem no aparelho. */
  messageCount(chatId: string): number {
    return (
      this.sql.get<{ n: number }>('SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?', [chatId])
        ?.n ?? 0
    )
  }

  /** Apaga de vez um chat só deste aparelho (sem tombstone: o servidor nunca o viu). */
  purgeChat(chatId: string): void {
    this.sql.tx(() => {
      this.removeRecord('chat', chatId, chatId)
      this.sql.run('DELETE FROM outbox WHERE chat_id = ?', [chatId])
      this.sql.run('DELETE FROM parked_queue WHERE chat_id = ?', [chatId])
      this.sql.run('DELETE FROM chat_storage WHERE chat_id = ?', [chatId])
    })
  }

  /**
   * "Salvar online" (§23.8, ao vivo → online): o chat vira um chat comum CRIADO OFFLINE — o
   * registro `chat` (base = rev do tombstone, se já foi online antes) e todo o conteúdo (base 0)
   * entram na outbox; o envio segue as regras normais (blobs antes, replay com `chat_bases = 0`).
   * Devolve quantos registros vão subir.
   */
  convertToOnline(chatId: string): number {
    return this.sql.tx(() => {
      const plain = this.getPlain('chat', chatId)
      if (!plain) return 0
      const tomb =
        this.sql.get<{ tomb_rev: number }>('SELECT tomb_rev FROM chat_storage WHERE chat_id = ?', [
          chatId
        ])?.tomb_rev ?? 0
      this.sql.run('DELETE FROM chat_storage WHERE chat_id = ?', [chatId])
      this.sql.run('DELETE FROM outbox WHERE chat_id = ?', [chatId])
      this.queueForMerge({ type: 'chat', id: chatId, scope: chatId, baseRev: tomb, seq: 0, plain })
      const content = this.contentRecords(chatId)
      for (const r of content)
        this.queueForMerge({
          type: r.type,
          id: r.id,
          scope: chatId,
          baseRev: 0,
          seq: 0,
          plain: r.plain
        })
      return content.length + 1
    })
  }

  outbox(chatId: string): OutboxRow[] {
    return this.sql
      .all<{
        type: string
        id: string
        scope: string | null
        chat_id: string
        base_rev: number
        deleted: number
        plain: string | null
        patch: string | null
        base: string | null
        mark: number
      }>('SELECT * FROM outbox WHERE chat_id = ?', [chatId])
      .map((r) => ({
        type: r.type,
        id: r.id,
        scope: r.scope,
        chatId: r.chat_id,
        baseRev: r.base_rev,
        deleted: !!r.deleted,
        plain: parse(r.plain),
        patch: parse(r.patch),
        base: parse(r.base),
        mark: r.mark
      }))
  }

  /** Linha pendente do registro `chat` (null = nada a subir dele). */
  chatOutboxRow(chatId: string): OutboxRow | null {
    return this.outbox(chatId).find((r) => r.type === 'chat' && r.id === chatId) ?? null
  }

  /**
   * Chats congelados de uma persona ainda não aceitos pelo servidor (§7.7, desde 1.10.0): a base
   * pendente aponta para ela e a revisão local não. O tombstone da persona espera por eles.
   */
  frozenPending(presetId: string): string[] {
    return this.sql
      .all<{ id: string; base: string | null; plain: string | null }>(
        "SELECT id, base, plain FROM outbox WHERE type = 'chat' AND deleted = 0 AND base IS NOT NULL"
      )
      .filter((r) => {
        const b = parse(r.base)?.config as Plain | undefined
        const p = parse(r.plain)?.config as Plain | undefined
        return b?.presetId === presetId && p?.presetId !== presetId
      })
      .map((r) => r.id)
  }

  /** Chats com conteúdo local ainda não aceito. */
  outboxChats(): string[] {
    return this.sql
      .all<{ chat_id: string }>('SELECT DISTINCT chat_id FROM outbox')
      .map((r) => r.chat_id)
  }

  hasOutbox(chatId: string, types?: string[]): boolean {
    const t = types?.length ? ` AND type IN (${types.map(() => '?').join(', ')})` : ''
    return !!this.sql.get(`SELECT 1 FROM outbox WHERE chat_id = ?${t} LIMIT 1`, [
      chatId,
      ...(types ?? [])
    ])
  }

  /**
   * Push aceito: `seq`/`blobs` da revisão e a linha da outbox sai — salvo se mudou de novo durante o
   * envio (`mark` diferente): aí a base passa a ser a revisão aceita e a local fica rev + 1.
   */
  commitOutbox(
    rows: {
      type: string
      id: string
      mark: number
      rev: number
      seq: number
      blobs: string[]
      /** `chat`: o plaintext enviado (vira a base do merge da edição feita durante o envio). */
      sent?: Plain | null
    }[]
  ): void {
    this.sql.tx(() => {
      for (const r of rows) {
        const cur = this.sql.get<{ mark: number }>(
          'SELECT mark FROM outbox WHERE type = ? AND id = ?',
          [r.type, r.id]
        )
        if (!cur) continue
        if (cur.mark === r.mark) {
          this.sql.run('DELETE FROM outbox WHERE type = ? AND id = ?', [r.type, r.id])
          this.sql.run('UPDATE records SET seq = ?, rev = ?, blobs = ? WHERE type = ? AND id = ?', [
            r.seq,
            r.rev,
            JSON.stringify(r.blobs),
            r.type,
            r.id
          ])
        } else {
          this.sql.run(
            `UPDATE outbox SET base_rev = ?, patch = NULL,
               base = CASE WHEN ? IS NULL THEN base ELSE ? END WHERE type = ? AND id = ?`,
            [r.rev, r.sent ? 1 : null, r.sent ? JSON.stringify(r.sent) : null, r.type, r.id]
          )
          this.sql.run('UPDATE records SET seq = ?, rev = ? WHERE type = ? AND id = ?', [
            r.seq,
            r.rev + 1,
            r.type,
            r.id
          ])
        }
      }
    })
  }

  /**
   * Conflito LWW: a base passa a ser a revisão do servidor (o plaintext local já foi mesclado).
   * `server` (registro `chat`) = o plaintext daquela revisão — a base do próximo merge 3-way.
   */
  rebaseOutbox(type: string, id: string, baseRev: number, plain: Plain, server?: Plain): void {
    this.sql.tx(() => {
      this.sql.run(
        `UPDATE outbox SET base_rev = ?, plain = ?,
           base = CASE WHEN ? IS NULL THEN base ELSE ? END WHERE type = ? AND id = ?`,
        [
          baseRev,
          JSON.stringify(plain),
          server ? 1 : null,
          server ? JSON.stringify(server) : null,
          type,
          id
        ]
      )
      this.sql.run('UPDATE records SET rev = ?, plain = ? WHERE type = ? AND id = ?', [
        baseRev + 1,
        JSON.stringify(plain),
        type,
        id
      ])
    })
  }

  /**
   * Pull de uma revisão mais nova de um `chat` com edição local pendente (§7.5): o cache e a
   * outbox ficam com o merge 3-way (`merged`) sobre a revisão do servidor, que vira a nova base —
   * a edição local não se perde e o próximo envio parte dela.
   */
  rebaseChatOnPull(c: Change, server: Plain, merged: Plain): void {
    this.sql.tx(() => {
      this.putRecord({ ...c, rev: c.rev + 1 }, merged, RecordState.Ok)
      this.sql.run(
        "UPDATE outbox SET base_rev = ?, plain = ?, base = ? WHERE type = 'chat' AND id = ?",
        [c.rev, JSON.stringify(merged), JSON.stringify(server), c.id]
      )
    })
  }

  /** Descarta a outbox de um chat (apagado em outro lugar / divergência descartada). */
  dropOutbox(chatId: string): void {
    this.sql.run('DELETE FROM outbox WHERE chat_id = ?', [chatId])
  }

  // ---------------- escrita LWW local (memória escrita aqui, §7.5) ----------------

  /**
   * Grava localmente uma revisão LWW feita aqui (memória/coleção) e a põe na `lww_outbox`: mesmo
   * esquema de `writeLocal` (rev = base + 1). `patch` acumula os campos mudados aqui — num conflito
   * eles são reaplicados sobre a versão do servidor (LWW por campo). O índice da memória já tem a
   * mudança (não avisa os ouvintes).
   */
  writeLww(w: {
    type: string
    id: string
    scope: string | null
    plain: Plain | null
    patch: Plain
  }) {
    this.sql.tx(() => {
      const row = this.sql.get<{ base_rev: number; patch: string | null }>(
        'SELECT base_rev, patch FROM lww_outbox WHERE type = ? AND id = ?',
        [w.type, w.id]
      )
      const meta = this.recordMeta(w.type, w.id)
      const base = row ? row.base_rev : (meta?.rev ?? 0)
      const change: Change = {
        type: w.type,
        id: w.id,
        scope: w.scope,
        rev: base + 1,
        seq: meta?.seq ?? 0,
        deleted: !w.plain,
        size: 0,
        blobs: [],
        device_id: '',
        updated_at: new Date().toISOString()
      }
      this.quietMemory++
      try {
        if (w.plain) this.putRecord(change, w.plain, RecordState.Ok)
        else this.deleteRecord(change)
      } finally {
        this.quietMemory--
      }
      const patch = { ...(parse(row?.patch ?? null) ?? {}), ...w.patch }
      this.sql.run(
        `INSERT INTO lww_outbox (type, id, scope, base_rev, deleted, plain, patch, mark)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(type, id) DO UPDATE SET scope = excluded.scope, deleted = excluded.deleted,
           plain = excluded.plain, patch = excluded.patch, mark = lww_outbox.mark + 1`,
        [
          w.type,
          w.id,
          w.scope,
          base,
          w.plain ? 0 : 1,
          w.plain ? JSON.stringify(w.plain) : null,
          JSON.stringify(patch)
        ]
      )
    })
  }

  lwwOutbox(): LwwRow[] {
    return this.sql
      .all<{
        type: string
        id: string
        scope: string | null
        base_rev: number
        deleted: number
        plain: string | null
        patch: string | null
        mark: number
      }>('SELECT * FROM lww_outbox')
      .map((r) => ({
        type: r.type,
        id: r.id,
        scope: r.scope,
        baseRev: r.base_rev,
        deleted: !!r.deleted,
        plain: parse(r.plain),
        patch: parse(r.patch) ?? {},
        mark: r.mark
      }))
  }

  /** Campos mudados aqui ainda não aceitos (reaplicados sobre uma revisão recebida). */
  lwwPatch(type: string, id: string): Plain | null {
    const r = this.sql.get<{ patch: string | null; deleted: number }>(
      'SELECT patch, deleted FROM lww_outbox WHERE type = ? AND id = ?',
      [type, id]
    )
    if (!r) return null
    return r.deleted ? { __deleted: true } : (parse(r.patch) ?? {})
  }

  /** Push aceito (mesma regra do `commitOutbox`: mudou de novo durante o envio → base avança). */
  commitLww(rows: { type: string; id: string; mark: number; rev: number; seq: number }[]): void {
    this.sql.tx(() => {
      for (const r of rows) {
        const cur = this.sql.get<{ mark: number }>(
          'SELECT mark FROM lww_outbox WHERE type = ? AND id = ?',
          [r.type, r.id]
        )
        if (!cur) continue
        if (cur.mark === r.mark) {
          this.sql.run('DELETE FROM lww_outbox WHERE type = ? AND id = ?', [r.type, r.id])
          this.sql.run('UPDATE records SET seq = ?, rev = ? WHERE type = ? AND id = ?', [
            r.seq,
            r.rev,
            r.type,
            r.id
          ])
        } else {
          this.sql.run('UPDATE lww_outbox SET base_rev = ? WHERE type = ? AND id = ?', [
            r.rev,
            r.type,
            r.id
          ])
          this.sql.run('UPDATE records SET seq = ?, rev = ? WHERE type = ? AND id = ?', [
            r.seq,
            r.rev + 1,
            r.type,
            r.id
          ])
        }
      }
    })
  }

  /** Conflito LWW: base = revisão do servidor; `plain` = servidor + campos mudados aqui. */
  rebaseLww(type: string, id: string, baseRev: number, plain: Plain): void {
    this.sql.tx(() => {
      this.sql.run('UPDATE lww_outbox SET base_rev = ?, plain = ? WHERE type = ? AND id = ?', [
        baseRev,
        JSON.stringify(plain),
        type,
        id
      ])
      this.sql.run('UPDATE records SET rev = ?, plain = ? WHERE type = ? AND id = ?', [
        baseRev + 1,
        JSON.stringify(plain),
        type,
        id
      ])
    })
    this.memoryChanged(type, id, plain)
  }

  /** Registro com revisão local ainda não aceita (outbox de conteúdo ou LWW). */
  isPending(type: string, id: string): boolean {
    return (
      !!this.sql.get('SELECT 1 FROM outbox WHERE type = ? AND id = ?', [type, id]) ||
      !!this.sql.get('SELECT 1 FROM lww_outbox WHERE type = ? AND id = ?', [type, id])
    )
  }

  /** Descarta só o conteúdo (sessões/mensagens) pendente de um chat — o `chat` LWW continua. */
  dropContentOutbox(chatId: string): void {
    this.sql.run("DELETE FROM outbox WHERE chat_id = ? AND type IN ('session', 'message')", [
      chatId
    ])
  }

  /** Põe uma revisão de conteúdo na outbox sobre uma base conhecida (resolução em partes, §9.3). */
  queueContent(w: {
    type: string
    id: string
    chatId: string
    baseRev: number
    plain: Plain | null
  }): void {
    this.sql.run(
      `INSERT INTO outbox (type, id, scope, chat_id, base_rev, deleted, plain, patch, mark)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 1)
       ON CONFLICT(type, id) DO UPDATE SET base_rev = excluded.base_rev, deleted = excluded.deleted,
         plain = excluded.plain, mark = outbox.mark + 1`,
      [
        w.type,
        w.id,
        w.chatId,
        w.chatId,
        w.baseRev,
        w.plain ? 0 : 1,
        w.plain ? JSON.stringify(w.plain) : null
      ]
    )
  }

  /** Chats marcados "precisa rebaixar" (§9.2). */
  refetchChats(): string[] {
    return this.sql
      .all<{ key: string }>("SELECT key FROM meta WHERE key LIKE 'refetch:%'")
      .map((r) => r.key.slice('refetch:'.length))
  }

  dropLww(type: string, id: string): void {
    this.sql.run('DELETE FROM lww_outbox WHERE type = ? AND id = ?', [type, id])
  }

  // ---------------- fila guardada no segundo plano ----------------

  parkQueue(chatId: string, items: { id: string; sessionId: string; json: string }[]): void {
    this.sql.tx(() => {
      for (const it of items)
        this.sql.run(
          'INSERT OR REPLACE INTO parked_queue (id, chat_id, session_id, json, at) VALUES (?, ?, ?, ?, ?)',
          [it.id, chatId, it.sessionId, it.json, Date.now()]
        )
    })
  }

  /** Tira (e devolve) os itens guardados — de um chat ou de todos. */
  takeParked(chatId?: string): { chatId: string; sessionId: string; json: string }[] {
    return this.sql.tx(() => {
      const rows = this.sql.all<{ chat_id: string; session_id: string; json: string }>(
        `SELECT chat_id, session_id, json FROM parked_queue${chatId ? ' WHERE chat_id = ?' : ''} ORDER BY at, rowid`,
        chatId ? [chatId] : []
      )
      this.sql.run(
        `DELETE FROM parked_queue${chatId ? ' WHERE chat_id = ?' : ''}`,
        chatId ? [chatId] : []
      )
      return rows.map((r) => ({ chatId: r.chat_id, sessionId: r.session_id, json: r.json }))
    })
  }

  // ---------------- conteúdo de um chat (divergência, §9) ----------------

  /** Registros vivos de conteúdo (sessões e mensagens) de um chat, com o plaintext local. */
  contentRecords(chatId: string): { type: string; id: string; rev: number; plain: Plain }[] {
    return this.sql
      .all<{ type: string; id: string; rev: number; plain: string | null }>(
        "SELECT type, id, rev, plain FROM records WHERE scope = ? AND type IN ('session', 'message') AND deleted = 0 AND state = 0",
        [chatId]
      )
      .flatMap((r) => {
        const p = parse(r.plain)
        return p ? [{ type: r.type, id: r.id, rev: r.rev, plain: p }] : []
      })
  }

  /** Remove um registro de conteúdo do cache sem tombstone (versão local descartada / substituída). */
  forgetContent(type: string, id: string, chatId: string): void {
    this.sql.run('DELETE FROM records WHERE type = ? AND id = ?', [type, id])
    this.dropDerived(type, id, chatId)
  }

  /** `seq` da última mudança de conteúdo (sessão/mensagem) deste chat que o aparelho tem (§8.4). */
  contentHead(chatId: string): number {
    return (
      this.sql.get<{ h: number | null }>(
        "SELECT MAX(seq) AS h FROM records WHERE scope = ? AND type IN ('session', 'message')",
        [chatId]
      )?.h ?? 0
    )
  }

  /** Sessões do chat (decodificadas), principal primeiro. */
  sessionsOf(chatId: string): Session[] {
    return this.sql
      .all<{ id: string; plain: string | null }>(
        "SELECT id, plain FROM records WHERE type = 'session' AND scope = ? AND deleted = 0 AND state = 0",
        [chatId]
      )
      .flatMap((r) => {
        const p = parse(r.plain)
        return p ? [sessionFromPlain(r.id, p)] : []
      })
      .sort((a, b) => a.depth - b.depth || a.createdAt - b.createdAt)
  }

  /** Todas as mensagens (todas as versões) de uma sessão, na ordem da sessão. */
  sessionMessages(sessionId: string): StoredMessage[] {
    const rows = this.sql.all<{ id: string; rev: number; plain: string | null }>(
      `SELECT r.id, r.rev, r.plain FROM messages m JOIN records r ON r.type = 'message' AND r.id = m.id
        WHERE m.session_id = ? AND r.deleted = 0 AND r.state = 0`,
      [sessionId]
    )
    const out: StoredMessage[] = []
    for (const r of rows) {
      const hit = this.parsed.get(r.id)
      if (hit && hit.rev === r.rev) {
        out.push(hit.msg)
        continue
      }
      const p = parse(r.plain)
      if (!p) continue
      const msg = messageFromPlain(r.id, p)
      this.parsed.set(r.id, { rev: r.rev, msg })
      out.push(msg)
    }
    return out.sort(cmpMsg)
  }

  /** Comando remoto já visto (§8.6: dedupe por `cmd_id`); marca como visto. Guarda 7 dias. */
  seenCommand(cmdId: string, now = Date.now()): boolean {
    const hit = !!this.sql.get('SELECT 1 FROM commands_seen WHERE cmd_id = ?', [cmdId])
    if (!hit) {
      this.sql.run('INSERT OR IGNORE INTO commands_seen (cmd_id, at) VALUES (?, ?)', [cmdId, now])
      this.sql.run('DELETE FROM commands_seen WHERE at < ?', [now - 7 * 86_400_000])
    }
    return hit
  }

  /** Plaintexts vivos de um tipo (provedores, personas, settings). */
  plainsOf(type: string): { id: string; plain: Plain }[] {
    return this.sql
      .all<{ id: string; plain: string | null }>(
        'SELECT id, plain FROM records WHERE type = ? AND deleted = 0 AND state = 0',
        [type]
      )
      .flatMap((r) => {
        const p = parse(r.plain)
        return p ? [{ id: r.id, plain: p }] : []
      })
  }

  /** `value` de um registro `setting` (§4.3.2); ausente/null = undefined. */
  setting<T = unknown>(id: string): T | undefined {
    const v = this.getPlain('setting', id)?.value
    return v == null ? undefined : (v as T)
  }

  // ---------------- merge do primeiro login (§12) ----------------

  /** Registros do cache (vivos e tombstones) com o plaintext — entrada do merge. */
  allRecords(): {
    type: string
    id: string
    scope: string | null
    rev: number
    seq: number
    deleted: boolean
    state: RecordStateCode
    plain: Plain | null
  }[] {
    return this.sql
      .all<{
        type: string
        id: string
        scope: string | null
        rev: number
        seq: number
        deleted: number
        state: number
        plain: string | null
      }>('SELECT type, id, scope, rev, seq, deleted, state, plain FROM records')
      .map((r) => ({
        type: r.type,
        id: r.id,
        scope: r.scope,
        rev: r.rev,
        seq: r.seq,
        deleted: !!r.deleted,
        state: r.state as RecordStateCode,
        plain: parse(r.plain)
      }))
  }

  /**
   * Troca o id de um registro local pelo da entidade online equivalente (dedupe do merge: o id
   * canônico é sempre o online). Coleção: as memórias dela trocam de escopo junto.
   */
  renameRecord(type: string, oldId: string, newId: string): void {
    this.sql.run('UPDATE records SET id = ? WHERE type = ? AND id = ?', [newId, type, oldId])
    if (type === 'memory_collection')
      this.sql.run("UPDATE records SET scope = ? WHERE type = 'memory' AND scope = ?", [
        newId,
        oldId
      ])
  }

  /** Regrava o plaintext de um registro vivo (merge: referências remapeadas) e refaz os índices. */
  replacePlain(type: string, id: string, plain: Plain): void {
    const r = this.sql.get<{ scope: string | null }>(
      'SELECT scope FROM records WHERE type = ? AND id = ? AND deleted = 0',
      [type, id]
    )
    if (!r) return
    this.sql.run('UPDATE records SET plain = ? WHERE type = ? AND id = ?', [
      JSON.stringify(plain),
      type,
      id
    ])
    this.parsed.delete(id)
    this.indexRecord(type, id, r.scope, plain)
  }

  /** Tira do cache um tombstone local (merge: apagado aqui e nunca enviado — nada a subir). */
  dropTombstone(type: string, id: string): void {
    this.sql.run('DELETE FROM records WHERE type = ? AND id = ? AND deleted = 1', [type, id])
  }

  /** Esvazia as duas outboxes (o merge as refaz a partir do cache). */
  clearOutboxes(): void {
    this.sql.run('DELETE FROM outbox')
    this.sql.run('DELETE FROM lww_outbox')
  }

  /**
   * Põe um registro do cache para subir (merge): `baseRev` = revisão online (0 = novo) e `seq` =
   * o da revisão online (0 = nunca aceito). `plain` null = tombstone. Chat/sessão/mensagem vão na
   * outbox do conteúdo (o `chat` com o registro inteiro como campos mudados); o resto na LWW.
   */
  queueForMerge(w: {
    type: string
    id: string
    scope: string | null
    baseRev: number
    seq: number
    plain: Plain | null
  }): void {
    const content = w.type === 'chat' || w.type === 'session' || w.type === 'message'
    if (content) {
      const chatId = w.type === 'chat' ? w.id : (w.scope ?? '')
      // `chat`: base vazia = todo o registro local conta como mudado (vence no merge, §12.6)
      this.sql.run(
        `INSERT INTO outbox (type, id, scope, chat_id, base_rev, deleted, plain, patch, mark, base)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT(type, id) DO UPDATE SET scope = excluded.scope, chat_id = excluded.chat_id,
           base_rev = excluded.base_rev, deleted = excluded.deleted, plain = excluded.plain,
           patch = excluded.patch, base = excluded.base, mark = outbox.mark + 1`,
        [
          w.type,
          w.id,
          w.scope,
          chatId,
          w.baseRev,
          w.plain ? 0 : 1,
          w.plain ? JSON.stringify(w.plain) : null,
          w.type === 'chat' && w.plain ? JSON.stringify(w.plain) : null,
          w.type === 'chat' ? '{}' : null
        ]
      )
    } else {
      this.sql.run(
        `INSERT INTO lww_outbox (type, id, scope, base_rev, deleted, plain, patch, mark)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(type, id) DO UPDATE SET scope = excluded.scope, base_rev = excluded.base_rev,
           deleted = excluded.deleted, plain = excluded.plain, patch = excluded.patch,
           mark = lww_outbox.mark + 1`,
        [
          w.type,
          w.id,
          w.scope,
          w.baseRev,
          w.plain ? 0 : 1,
          w.plain ? JSON.stringify(w.plain) : null,
          JSON.stringify(w.plain ?? {})
        ]
      )
    }
    this.sql.run('UPDATE records SET rev = ?, seq = ? WHERE type = ? AND id = ?', [
      w.baseRev + 1,
      w.seq,
      w.type,
      w.id
    ])
  }

  /** Índices em memória (mensagens interpretadas, índice da memória) refeitos depois do merge. */
  notifyReset(): void {
    this.parsed.clear()
    for (const fn of this.wipeListeners) fn()
  }

  /** Contagens para diagnóstico (sem conteúdo). */
  stats(): { records: number; chats: number; messages: number } {
    const n = (sql: string) => this.sql.get<{ n: number }>(sql)?.n ?? 0
    return {
      records: n('SELECT COUNT(*) AS n FROM records WHERE deleted = 0'),
      chats: n('SELECT COUNT(*) AS n FROM chats'),
      messages: n('SELECT COUNT(*) AS n FROM messages')
    }
  }
}

/** Busca do usuário → consulta FTS5 segura (cada termo entre aspas, com prefixo). */
export function ftsQuery(q: string): string | null {
  const terms = q
    .split(/[^\p{L}\p{N}_]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .slice(0, 8)
  if (!terms.length) return null
  return terms.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' ')
}
