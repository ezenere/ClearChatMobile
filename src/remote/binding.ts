// Liga o controle remoto ao WebSocket da conta e ao motor de dados: eventos `chat.state`,
// `stream.*` e `remote.*`, o welcome (resync do chat aberto) e os registros novos do chat aberto
// (trocam o draft pela mensagem persistida). Registrar DEPOIS do `bindAccount` (o cache de estados
// já está atualizado quando o controle remoto vê o `chat.state`). Sem React Native.
import type { AccountService } from '@/account/service'
import type { SyncEngine } from '@/data/engine'
import type { RemoteController } from './controller'

export function bindRemote(
  account: AccountService,
  engine: SyncEngine,
  remote: RemoteController
): () => void {
  account.helloSubscriptions = () => remote.subscriptions()
  const offRt = account.addRealtimeListener({
    onWelcome: (w) => remote.onWelcome(w),
    onEvent: (f) => remote.onEvent(f),
    onState: (online) => remote.onConnection(online)
  })
  const offData = engine.subscribe((e) => {
    const active = remote.activeChat
    if (!active) return
    if (e.kind === 'data' && (e.all || e.chats.includes(active))) remote.onChatData(active)
  })
  const offState = account.subscribe(() => {
    // bloqueou/saiu: nada de espelho nem inscrição
    if (account.getState().phase !== 'unlocked') remote.setActive(null)
  })
  return () => {
    offRt()
    offData()
    offState()
    account.helloSubscriptions = () => []
  }
}
