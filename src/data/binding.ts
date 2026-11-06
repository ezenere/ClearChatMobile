// Liga o sync de dados ao ciclo da conta: cofre aberto → sincroniza; bloqueado → para (o cache fica);
// saiu/revogado/conta apagada/chaves redefinidas/outra conta ou servidor → apaga o cache e os anexos
// (§3.13, §10.2). Sem conta ("Usar sem conta") o cache é do dono `local`: nada sincroniza, nada é
// apagado ao sair do login, e o primeiro desbloqueio de uma conta faz o merge do §12 antes de ligar
// o sync. Sem React Native (testável com o AccountService real no Node).
import type { AccountService } from '@/account/service'
import type { AttachmentStore } from './attachments'
import type { SyncEngine } from './engine'
import { FirstLoginMerge, type MergeHttp } from './merge'
import type { LocalStore } from './store'

/** Dono do cache criado sem conta (dados só deste aparelho, ainda não unidos a uma conta). */
export const LOCAL_OWNER = 'local'

/**
 * O cache pode sincronizar? Não com dados sem conta ainda não unidos (§12): até o merge, nenhuma
 * outbox sobe e nada do servidor é aplicado por cima. As chaves de cada módulo passam por aqui.
 */
export function syncAllowed(store: LocalStore): boolean {
  return store.getMeta('owner') !== LOCAL_OWNER
}

export interface BindOptions {
  /** HTTP do merge do primeiro login (padrão: `account.http`). */
  http?: MergeHttp
  /** Merge aplicado e sync ligado: retomar as outboxes (conteúdo e LWW). */
  afterMerge?: () => void
  log?: (msg: string) => void
}

export interface AccountBinding {
  merge: FirstLoginMerge
  unbind: () => void
}

export function bindAccount(
  account: AccountService,
  engine: SyncEngine,
  attachments: AttachmentStore | null,
  opts: BindOptions = {}
): AccountBinding {
  const store = engine.store
  account.helloCursor = () => store.cursor
  let prev = account.getState().phase
  let chain: Promise<void> = Promise.resolve()

  const ownerOf = (): string => {
    const s = account.getState()
    return `${s.server.url}|${s.account?.userId ?? ''}`
  }

  const merge = new FirstLoginMerge({
    store,
    http: opts.http ?? account.http,
    keys: () => {
      const sk = account.subkeys
      const userId = account.accountUserId
      return sk && userId ? { userId, sk } : null
    },
    owner: ownerOf,
    onDone: () => {
      account.clearLocalMode()
      if (account.getState().phase === 'unlocked') engine.start()
      opts.afterMerge?.()
    },
    log: opts.log
  })

  const wipe = async () => {
    attachments?.clear()
    await engine.wipe()
  }

  const step = async () => {
    const s = account.getState()
    const phase = s.phase
    const had = store.getMeta('owner')
    if (phase === 'unlocked') {
      const owner = ownerOf()
      if (had === LOCAL_OWNER) {
        // dados criados sem conta: merge do primeiro login (§12) antes de sincronizar
        engine.stop()
        if (!merge.active) void merge.begin()
      } else {
        if (had !== owner) {
          engine.stop()
          if (had) await wipe()
          store.setMeta('owner', owner)
        }
        if (account.getState().phase === 'unlocked') engine.start()
      }
    } else if (phase === 'local') {
      engine.stop()
      merge.cancel()
      // "Usar sem conta" depois de uma conta (cache dela ainda aqui): começa do zero
      if (had && had !== LOCAL_OWNER) await wipe()
      if (store.getMeta('owner') !== LOCAL_OWNER) store.setMeta('owner', LOCAL_OWNER)
    } else {
      engine.stop()
      merge.cancel()
      // fim da sessão (logout/revogação/conta apagada) ou chaves redefinidas (keys.reset → setup);
      // dados sem conta ainda não unidos nunca são apagados aqui
      const accountData = !!had && had !== LOCAL_OWNER
      const signedOut = phase === 'signed-out' && accountData
      const keysReset =
        phase === 'needs-setup' && (prev === 'unlocked' || prev === 'locked') && accountData
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
  return {
    merge,
    unbind: () => {
      offState()
      offRt()
      merge.cancel()
      engine.stop()
    }
  }
}
