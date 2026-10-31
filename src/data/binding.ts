// Liga o sync de dados ao ciclo da conta: cofre aberto → sincroniza; bloqueado → para (o cache fica);
// saiu/revogado/conta apagada/chaves redefinidas/outra conta ou servidor → apaga o cache e os anexos
// (§3.13, §10.2). Sem React Native (testável com o AccountService real no Node).
import type { AccountService } from '@/account/service'
import type { AttachmentStore } from './attachments'
import type { SyncEngine } from './engine'

export function bindAccount(
  account: AccountService,
  engine: SyncEngine,
  attachments: AttachmentStore | null
): () => void {
  const store = engine.store
  account.helloCursor = () => store.cursor
  let prev = account.getState().phase
  let chain: Promise<void> = Promise.resolve()

  const wipe = async () => {
    attachments?.clear()
    await engine.wipe()
  }

  const step = async () => {
    const s = account.getState()
    const phase = s.phase
    if (phase === 'unlocked') {
      const owner = `${s.server.url}|${s.account?.userId ?? ''}`
      const had = store.getMeta('owner')
      if (had !== owner) {
        engine.stop()
        if (had) await wipe()
        store.setMeta('owner', owner)
      }
      if (account.getState().phase === 'unlocked') engine.start()
    } else {
      engine.stop()
      // fim da sessão (logout/revogação/conta apagada) ou chaves redefinidas (keys.reset → setup)
      const signedOut = phase === 'signed-out' && !!store.getMeta('owner')
      const keysReset = phase === 'needs-setup' && (prev === 'unlocked' || prev === 'locked')
      if (signedOut || keysReset) await wipe()
    }
    prev = phase
  }

  // serializado: cada mudança de fase espera a anterior (o wipe termina antes de recomeçar)
  const apply = () => {
    chain = chain.then(step, step)
  }

  const offState = account.subscribe(apply)
  const offRt = account.addRealtimeListener({
    onWelcome: (w) => engine.onWelcome(w),
    onEvent: (f) => engine.onEvent(f),
    onState: (online) => engine.onConnection(online)
  })
  apply()
  return () => {
    offState()
    offRt()
    engine.stop()
  }
}
