// Fonte do read_history para OUTROS chats (chat_id / scope "all") no celular — a mesma interface de
// ClearChatDesktop/src/main/historyStore.ts (o shim `src/vendor/desktop/historyStore.ts` reexporta
// daqui para o tools/history.ts vendorado), sobre o cache local: chats/sessões/mensagens dos
// registros sincronizados e o índice `history_fts` (corpo × tools, bm25 3:1, como o searchIndex do
// desktop; texto pesquisável = `searchableText` vendorado). Todos os chats sincronizados contam,
// rodem onde rodarem. Sem React Native.
import { activePath } from '@shared/branches'
import type { StoredMessage } from '@shared/types'
import type { SearchFilter, SearchHit } from '@vendor/desktop/searchIndex'
import type { LocalStore } from '@/data/store'

export interface StoreChat {
  id: string
  title: string
  mainSessionId: string
  updatedAt: number
}

export interface StoreSession {
  id: string
  chatId: string
  title: string
  depth: number
}

export interface HistoryStore {
  /** Índice FTS disponível (senão, só a busca por substring na sessão principal). */
  indexReady: boolean
  chats(): StoreChat[]
  chat(id: string): StoreChat | null
  sessions(chatId: string): StoreSession[]
  /** Caminho ativo da sessão (o ramo selecionado — o que o agente daquele chat vê). */
  messages(sessionId: string): StoredMessage[]
  message(id: string): StoredMessage | null
  /** Nome da tool chamada por `toolCallId` (mensagem assistant anterior a `seq` na sessão). */
  toolName(sessionId: string, seq: number, toolCallId: string): string | null
  search(query: string, f: SearchFilter): SearchHit[]
  countByChat(query: string, f: Omit<SearchFilter, 'limit'>): Map<string, number>
}

function whereOf(f: Omit<SearchFilter, 'limit'>): { sql: string; params: (string | number)[] } {
  const c: string[] = []
  const params: (string | number)[] = []
  if (f.fromSeq != null) {
    c.push('m.seq >= ?')
    params.push(f.fromSeq)
  }
  if (f.toSeq != null) {
    c.push('m.seq <= ?')
    params.push(f.toSeq)
  }
  if (f.chatId) {
    c.push('m.chat_id = ?')
    params.push(f.chatId)
  }
  if (f.sessionId) {
    c.push('m.session_id = ?')
    params.push(f.sessionId)
  }
  if (f.excludeChatId) {
    c.push('m.chat_id <> ?')
    params.push(f.excludeChatId)
  }
  return { sql: c.length ? ` AND ${c.join(' AND ')}` : '', params }
}

const FROM = `FROM history_fts JOIN messages m ON m.rowid = history_fts.rowid
  WHERE history_fts MATCH ?`

export function historyStore(store: LocalStore): HistoryStore {
  const sql = store.sql
  const chatRow = (r: {
    id: string
    title: string
    main_session_id: string | null
    updated_at: number
  }): StoreChat => ({
    id: r.id,
    title: r.title,
    mainSessionId: r.main_session_id ?? '',
    updatedAt: r.updated_at
  })
  return {
    indexReady: true,
    chats: () =>
      sql
        .all<{ id: string; title: string; main_session_id: string | null; updated_at: number }>(
          'SELECT id, title, main_session_id, updated_at FROM chats ORDER BY updated_at DESC'
        )
        .map(chatRow),
    chat: (id) => {
      const r = sql.get<{
        id: string
        title: string
        main_session_id: string | null
        updated_at: number
      }>('SELECT id, title, main_session_id, updated_at FROM chats WHERE id = ?', [id])
      return r ? chatRow(r) : null
    },
    sessions: (chatId) =>
      store
        .sessionsOf(chatId)
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((s) => ({ id: s.id, chatId: s.chatId, title: s.title, depth: s.depth })),
    messages: (sessionId) => {
      const p = store.getPlain('session', sessionId)
      const sel =
        p?.branchSel && typeof p.branchSel === 'object'
          ? (p.branchSel as Record<string, string | null>)
          : {}
      return activePath(store.sessionMessages(sessionId), sel)
    },
    message: (id) => store.message(id),
    toolName: (sessionId, seq, toolCallId) => {
      const msgs = store.sessionMessages(sessionId).filter((m) => m.seq < seq)
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i].message
        if (m.role !== 'assistant') continue
        const tc = m.tool_calls?.find((t) => t.id === toolCallId)
        if (tc) return tc.function.name
      }
      return null
    },
    search: (q, f) => {
      const w = whereOf(f)
      return sql.all<SearchHit>(
        `SELECT history_fts.rowid AS docid, m.id AS messageId, m.session_id AS sessionId,
          m.chat_id AS chatId, m.seq AS seq, bm25(history_fts, 3.0, 1.0) AS score
         ${FROM}${w.sql} ORDER BY score LIMIT ?`,
        [q, ...w.params, f.limit]
      )
    },
    countByChat: (q, f) => {
      const w = whereOf(f)
      const rows = sql.all<{ chatId: string; n: number }>(
        `SELECT m.chat_id AS chatId, COUNT(*) AS n ${FROM}${w.sql} GROUP BY m.chat_id`,
        [q, ...w.params]
      )
      return new Map(rows.map((r) => [r.chatId, r.n]))
    }
  }
}
