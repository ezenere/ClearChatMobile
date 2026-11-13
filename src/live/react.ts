// Ligações React dos chats só ao vivo: a lista agrupada por host, o chat aberto (inscrição +
// histórico em memória enquanto a tela está montada) e os avisos (saiu da lista, epoch novo).
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { effectiveConfigOf } from '@/data/inherit'
import { store } from '@/data/native'
import type { LoadedChat } from '@/data/store'
import { useSettingsVersion } from '@/settings/react'
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

/**
 * Chat ao vivo aberto na tela: inscrição no stream + histórico enquanto montado. O host manda o
 * registro do chat (próprios + cópia + `overrides`, §4.3.6): a config mostrada é a EFETIVA, com as
 * personas e os padrões DESTE aparelho (sincronizados — iguais aos do host).
 */
export function useLiveChat(chatId: string): LiveChatView {
  useEffect(() => {
    live.open(chatId)
    return () => live.close(chatId)
  }, [chatId])
  const v = useLiveVersion()
  const sv = useSettingsVersion()
  return useMemo(() => {
    void sv
    const h = live.history(chatId)
    const l = h?.loaded ?? null
    return {
      entry: live.entry(chatId),
      phase: h ? h.phase : 'none',
      error: h?.error ?? null,
      loaded: l
        ? {
            ...l,
            chat: {
              ...l.chat,
              config: effectiveConfigOf(store, l.chat.config) as unknown as Record<string, unknown>
            }
          }
        : null,
      progress: h?.progress ?? 0
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `v`/`sv` são os gatilhos de releitura
  }, [chatId, v, sv])
}

export function useLiveNotices(fn: (n: LiveNotice) => void): void {
  useEffect(() => live.onNotice(fn), [fn])
}

export { live }
