// Ligações React do sync de dados: status, lista de chats (com busca), conteúdo de um chat e anexos.
// Tudo recarrega sozinho com os eventos do motor (pull, `sync.changes` ao vivo, escrita local).
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { attachments, engine, store } from './native'
import type { DataEvent, SyncStatus } from './engine'
import type { ChatListItem, LoadedChat } from './store'
import type { ChatState } from './types'

const subscribeAll = (fn: () => void) => engine.subscribe(fn)

export function useSyncStatus(): SyncStatus {
  return useSyncExternalStore(subscribeAll, engine.getStatus)
}

export interface ChatListData {
  items: ChatListItem[]
  states: Map<string, ChatState>
  presets: Map<string, { name: string; icon: string }>
}

const readList = (query: string): ChatListData => ({
  items: store.listChats(query),
  states: store.chatStates(),
  presets: store.presets()
})

/** Versão que sobe a cada evento do motor que pode mudar a lista (com um pequeno debounce). */
function useDataVersion(filter: (e: DataEvent) => boolean, delay: number): number {
  const [v, setV] = useState(0)
  const f = useRef(filter)
  useEffect(() => {
    f.current = filter
  })
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = engine.subscribe((e) => {
      if (!f.current(e)) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => setV((x) => x + 1), delay)
    })
    return () => {
      off()
      if (timer) clearTimeout(timer)
    }
  }, [delay])
  return v
}

/** Lista de chats (mais recentes primeiro); `query` filtra por título e conteúdo (FTS). */
export function useChatList(query: string): ChatListData {
  const version = useDataVersion((e) => e.kind !== 'status', 60)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `version` é o gatilho de recarga
  return useMemo(() => readList(query), [query, version])
}

/** "Agora", atualizado a cada minuto (tempos relativos e separadores de dia). */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])
  return now
}

/** Conteúdo de um chat (undefined = carregando; null = não existe/apagado). */
export function useChat(chatId: string): {
  loaded: LoadedChat | null | undefined
  state: ChatState | null
} {
  const [loaded, setLoaded] = useState<LoadedChat | null | undefined>(undefined)
  const [state, setState] = useState<ChatState | null>(() => store.chatState(chatId))
  useEffect(() => {
    // carrega fora do render inicial (a tela abre na hora e mostra o "carregando")
    const t = setTimeout(() => setLoaded(store.loadChat(chatId)), 0)
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = engine.subscribe((e) => {
      if (e.kind === 'states' && e.chats.includes(chatId)) setState(store.chatState(chatId))
      if (e.kind !== 'data') return
      if (!e.all && !e.chats.includes(chatId)) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => setLoaded(store.loadChat(chatId)), 40)
    })
    return () => {
      clearTimeout(t)
      if (timer) clearTimeout(timer)
      off()
    }
  }, [chatId])
  return { loaded, state }
}

export interface AttachmentState {
  uri: string | null
  loading: boolean
  error: string | null
  load: () => void
}

/** Anexo no aparelho (`auto` = baixa sozinho, ex.: imagens na conversa). */
export function useAttachment(file: string | null, auto: boolean): AttachmentState {
  const [ready, setReady] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => attachments.onReady((f) => f === file && setReady((x) => x + 1)), [file])
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `ready` é o gatilho de releitura
  const uri = useMemo(() => (file ? attachments.local(file) : null), [file, ready])
  const load = useCallback(() => {
    if (!file) return
    setLoading(true)
    setError(null)
    attachments
      .ensure(file)
      .then(() => setReady((x) => x + 1))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Falha ao baixar.'))
      .finally(() => setLoading(false))
  }, [file])
  useEffect(() => {
    if (!file || uri || !auto) return
    const t = setTimeout(load, 0)
    return () => clearTimeout(t)
  }, [file, uri, auto, load])
  return { uri, loading, error, load }
}

export { attachments, engine, store }
