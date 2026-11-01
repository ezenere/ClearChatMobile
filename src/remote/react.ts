// Ligações React do controle remoto: modo do host + espelho ao vivo do chat aberto (inscreve no
// stream ao abrir e cancela ao sair) e avisos do host ("caiu", "voltou").
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { ChatState } from '@/data/types'
import type { MirrorView } from './mirror'
import { remote, uploadDeps } from './native'
import type { HostMode, RemoteNotice } from './types'

export interface RemoteChat {
  mode: HostMode
  view: MirrorView | null
  connected: boolean
}

/** Chat aberto na tela: inscrição no stream enquanto montado. `state` só dispara o re-render. */
export function useRemoteChat(chatId: string, state: ChatState | null): RemoteChat {
  useEffect(() => {
    remote.setActive(chatId)
    return () => {
      if (remote.activeChat === chatId) remote.setActive(null)
    }
  }, [chatId])
  const version = useSyncExternalStore(remote.subscribe, remote.getVersion)
  // `version`/`state` são os gatilhos de releitura (o React Compiler memoiza chamadas a objetos externos)
  return useMemo(
    () => ({ mode: remote.mode(chatId), view: remote.view(chatId), connected: remote.isConnected }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chatId, state, version]
  )
}

export function useRemoteNotices(chatId: string, fn: (n: RemoteNotice) => void): void {
  useEffect(() => remote.onNotice((n) => n.chatId === chatId && fn(n)), [chatId, fn])
}

export { remote, uploadDeps }
