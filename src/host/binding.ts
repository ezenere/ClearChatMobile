// Liga o host no celular à conta (WebSocket: chat.state, host.*, remote.command; hello com as
// janelas abertas; segundo plano) e ao ciclo do cofre (bloqueou/saiu → para os turnos). Registrar
// DEPOIS do `bindAccount` (o cache de estados já tem o `chat.state` quando o host o vê).
import type { AccountService } from '@/account/service'
import type { HostService } from './host'
import type { Runner } from '@/agent/runner'

export function bindHost(account: AccountService, host: HostService, runner: Runner): () => void {
  account.helloActiveWindows = () => host.activeWindows()
  account.beforeBackground = () => host.onBackground()
  const offRt = account.addRealtimeListener({
    onWelcome: (w) => host.onWelcome(w),
    onEvent: (f) => host.onEvent(f),
    onState: (online) => host.onConnection(online)
  })
  let running = false
  const sync = () => {
    // sem conta o celular também executa os chats dele (só aqui)
    const p = account.getState().phase
    const unlocked = p === 'unlocked' || p === 'local'
    if (unlocked && !running) {
      running = true
      host.start()
    } else if (!unlocked && running) {
      running = false
      for (const chatId of runner.busyChats()) void runner.stopChat(chatId, true, 'interrupted')
      host.stop()
    }
  }
  const offState = account.subscribe(sync)
  sync()
  return () => {
    offRt()
    offState()
    account.helloActiveWindows = () => []
    account.beforeBackground = null
    host.stop()
  }
}
