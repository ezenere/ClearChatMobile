// Ligações React dos chats só ao vivo: a lista agrupada por host, o chat aberto (inscrição +
// histórico em memória enquanto a tela está montada) e os avisos (saiu da lista, epoch novo).
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { LoadedChat } from '@/data/store'
import type { HistoryPhase } from './history'
import type { LiveEntry, LiveGroup } from './list'
import { live } from './native'
import type { LiveNotice } from './service'

export function useLiveVersion(): number {
  return useSyncExternalStore(live.subscribe, live.getVersion)
}

/** Grupos "Ao vivo em <host>" (vazio sem suporte/sem chats). */
export function useLiveGroups(): LiveGroup[] {
  const v = useLiveVersion()
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `v` é o gatilho de releitura
  return useMemo(() => live.list.groups(), [v])
}

/** A instância suporta chats ao vivo (null = ainda não deu para saber). */
export function useLiveSupported(): boolean | null {
  const v = useLiveVersion()
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `v` é o gatilho de releitura
  return useMemo(() => live.supported, [v])
}

export interface LiveChatView {
  entry: LiveEntry | null
  phase: HistoryPhase | 'none'
  error: string | null
  loaded: LoadedChat | null
  progress: number
}

/** Chat ao vivo aberto na tela: inscrição no stream + histórico enquanto montado. */
export function useLiveChat(chatId: string): LiveChatView {
  useEffect(() => {
    live.open(chatId)
    return () => live.close(chatId)
  }, [chatId])
  const v = useLiveVersion()
  return useMemo(() => {
    const h = live.history(chatId)
    return {
      entry: live.entry(chatId),
      phase: h ? h.phase : 'none',
      error: h?.error ?? null,
      loaded: h?.loaded ?? null,
      progress: h?.progress ?? 0
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `v` é o gatilho de releitura
  }, [chatId, v])
}

export function useLiveNotices(fn: (n: LiveNotice) => void): void {
  useEffect(() => live.onNotice(fn), [fn])
}

export { live }
