// Ligações React do sync de dados: status, lista de chats (com busca), conteúdo de um chat e anexos.
// Tudo recarrega sozinho com os eventos do motor (pull, `sync.changes` ao vivo, escrita local).
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import { effectiveConfigOf } from './inherit'
import { attachments, engine, firstLoginMerge, store } from './native'
import type { MergeState } from './merge'
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
  /** Chats "Só neste aparelho" (§23.10). */
  localOnly: Set<string>
}

const readList = (query: string): ChatListData => ({
  items: store.listChats(query),
  states: store.chatStates(),
  presets: store.presets(),
  localOnly: new Set(store.localOnlyChats())
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

/**
 * Chat do cache com a config EFETIVA (herança ao vivo da persona, protocolo 1.10.0 — §4.3.6): os
 * campos que o chat não mudou seguem a persona e "Novos chats" deste aparelho, lidos agora.
 */
export function loadEffectiveChat(chatId: string): LoadedChat | null {
  const l = store.loadChat(chatId)
  if (!l) return null
  const config = effectiveConfigOf(store, l.chat.config) as unknown as Record<string, unknown>
  return { ...l, chat: { ...l.chat, config } }
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
    const t = setTimeout(() => setLoaded(loadEffectiveChat(chatId)), 0)
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = engine.subscribe((e) => {
      if (e.kind === 'states' && e.chats.includes(chatId)) setState(store.chatState(chatId))
      if (e.kind !== 'data') return
      // persona, padrões de "Novos chats" ou provedores mudaram: a config efetiva muda junto
      if (!e.all && !e.settings && !e.chats.includes(chatId)) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => setLoaded(loadEffectiveChat(chatId)), 40)
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

/**
 * De onde vêm os anexos exibidos: o store do aparelho (padrão) ou outra fonte — os chats só ao
 * vivo (§23.7) baixam do host para a MEMÓRIA (`memoryOnly`: nada de cache de imagem em disco).
 */
export interface AttachmentSource {
  local(file: string): string | null
  ensure(file: string): Promise<string>
  onReady(fn: (file: string) => void): () => void
  memoryOnly?: boolean
}

export const AttachmentSourceCtx = createContext<AttachmentSource | null>(null)

/** A fonte em uso (para o `cachePolicy` das imagens). */
export function useAttachmentSource(): AttachmentSource {
  return useContext(AttachmentSourceCtx) ?? attachments
}

/** Anexo no aparelho (`auto` = baixa sozinho, ex.: imagens na conversa). */
export function useAttachment(file: string | null, auto: boolean): AttachmentState {
  const src = useAttachmentSource()
  const [ready, setReady] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => src.onReady((f) => f === file && setReady((x) => x + 1)), [file, src])
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `ready` é o gatilho de releitura
  const uri = useMemo(() => (file ? src.local(file) : null), [file, ready, src])
  const load = useCallback(() => {
    if (!file) return
    setLoading(true)
    setError(null)
    src
      .ensure(file)
      .then(() => setReady((x) => x + 1))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Falha ao baixar.'))
      .finally(() => setLoading(false))
  }, [file, src])
  useEffect(() => {
    if (!file || uri || !auto) return
    const t = setTimeout(load, 0)
    return () => clearTimeout(t)
  }, [file, uri, auto, load])
  return { uri, loading, error, load }
}

export { attachments, engine, store }

const IDLE_MERGE: MergeState = { phase: 'idle' }
const noop = () => () => undefined

/** Merge do primeiro login (§12): a pergunta "Priorizar online/local" e o progresso. */
export function useFirstLoginMerge(): MergeState {
  const m = firstLoginMerge()
  return useSyncExternalStore(m ? m.subscribe : noop, m ? m.getState : () => IDLE_MERGE)
}
