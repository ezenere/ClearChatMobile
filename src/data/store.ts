// Cache local do sync no SQLite do app: registros (plaintext decifrado uma vez — ver README § "Cache
// local"), cursor, índices derivados para a lista de chats, a busca (FTS5) e a prévia, e os estados de
// host (§8.2). Sem rede e sem cripto: quem decifra e decide o que aplicar é o SyncEngine.
import { activePath, buildTree, type TreeMessage } from '@shared/branches'
import type { Session, StoredMessage } from '@shared/types'
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

export interface LoadedChat {
  chat: ChatPlain & { id: string }
  sessions: Session[]
  /** Todas as versões, por sessão, na ordem da sessão (seq, id). */
  messages: Map<string, StoredMessage[]>
  /** Registros do chat que não decifraram (não exibidos). */
  broken: number
}

const SCHEMA_VERSION = 2

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
  2: `UPDATE chats SET dirty = 1;`
}

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

  constructor(sql: Sql) {
    this.sql = sql
    this.migrate()
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
      for (const t of ['records', 'chats', 'messages', 'chat_states', 'meta'])
        this.sql.run(`DELETE FROM ${t}`)
      this.sql.run(`INSERT INTO messages_fts(messages_fts) VALUES ('delete-all')`)
    })
    this.parsed.clear()
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
      return
    }
    this.indexRecord(c.type, c.id, c.scope, plain)
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
  }

  /** Remove o registro do cache (resync: sumiu do servidor) com a mesma cascata. */
  removeRecord(type: string, id: string, scope: string | null): void {
    this.sql.run('DELETE FROM records WHERE type = ? AND id = ?', [type, id])
    this.dropDerived(type, id, scope)
    if (type === 'chat') this.cascadeChat(id)
    if (type === 'memory_collection')
      this.sql.run("DELETE FROM records WHERE type = 'memory' AND scope = ?", [id])
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
