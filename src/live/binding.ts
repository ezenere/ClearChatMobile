// Liga o visualizador de chats só ao vivo ao WebSocket da conta (SYNC_PROTOCOL.md §23): declara
// `live_chats` no `hello` (§10.3), repassa welcome/eventos/conexão e descarta tudo ao bloquear ou
// sair (§23.5: só em memória). Registrar DEPOIS do `bindRemote`. Sem React Native.
import type { AccountService } from '@/account/service'
import type { LiveService } from './service'
import { LIVE_CAP } from './types'

export function bindLive(account: AccountService, live: LiveService): () => void {
  account.helloCaps = () => [LIVE_CAP]
  const offRt = account.addRealtimeListener({
    onWelcome: (w) => live.onWelcome(w),
    onEvent: (f) => live.onEvent(f),
    onState: (online) => live.onConnection(online)
  })
  let unlocked = account.getState().phase === 'unlocked'
  const offState = account.subscribe(() => {
    const now = account.getState().phase === 'unlocked'
    if (unlocked && !now) live.wipe()
    // cofre aberto com o socket já conectado: os anúncios agora decifram
    if (!unlocked && now) live.relist()
    unlocked = now
  })
  return () => {
    offRt()
    offState()
    account.helloCaps = () => []
  }
}
