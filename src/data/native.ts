// Instâncias do aparelho: banco (expo-sqlite), motor do sync, store de anexos (expo-file-system) e a
// ligação com a conta. Volta ao primeiro plano → puxa (o WebSocket é refeito pela conta).
import { Directory, File, Paths } from 'expo-file-system'
import { AppState } from 'react-native'
import { account } from '@/account/native'
import { AttachmentStore, type AttachmentFs } from './attachments'
import { bindAccount, syncAllowed, type AccountBinding } from './binding'
import { SyncEngine } from './engine'
import { openNativeSql } from './sqlNative'
import { LocalStore } from './store'

const log = (msg: string): void => {
  // só tipos/ids/contagens — nunca conteúdo
  if (__DEV__) console.log(`[clearchat:data] ${msg}`)
}

class NativeAttachmentFs implements AttachmentFs {
  private dir = new Directory(Paths.document, 'attachments')
  private file(name: string): File {
    return new File(this.dir, name)
  }
  exists(name: string): boolean {
    return this.file(name).exists
  }
  uri(name: string): string {
    return this.file(name).uri
  }
  write(name: string, data: Uint8Array): void {
    if (!this.dir.exists) this.dir.create({ intermediates: true })
    const tmp = this.file(`${name}.part`)
    tmp.create({ overwrite: true })
    tmp.writeSync(data)
    tmp.moveSync(this.file(name), { overwrite: true })
  }
  clear(): void {
    if (this.dir.exists) this.dir.delete()
  }
}

export const store = new LocalStore(openNativeSql('clearchat-cache.db'))

/**
 * Chaves da conta para o sync (motor, outboxes, controle remoto). null = bloqueado, sem conta ou
 * com dados sem conta ainda não unidos (§12): nada sobe nem desce até o merge.
 */
export const syncKeys = () => {
  const sk = account.subkeys
  const userId = account.accountUserId
  return sk && userId && syncAllowed(store) ? { userId, sk } : null
}
const keys = syncKeys

/** Usando sem conta: os dados ficam só neste aparelho (nenhum servidor). */
export const isLocalMode = (): boolean => account.getState().phase === 'local'

const mergeListeners = new Set<() => void>()
/** Merge do primeiro login aplicado: as outboxes (conteúdo e LWW) retomam o envio. */
export function onAfterMerge(fn: () => void): () => void {
  mergeListeners.add(fn)
  return () => mergeListeners.delete(fn)
}

export const engine = new SyncEngine({ store, http: account.http, keys, log })

export const attachments = new AttachmentStore({
  fs: new NativeAttachmentFs(),
  keys,
  fetchBlob: (id) => engine.fetchBlob(id),
  log
})

let binding: AccountBinding | null = null

/** Merge do primeiro login (§12) — a tela da pergunta observa. */
export const firstLoginMerge = () => binding?.merge ?? null

/** Liga o sync à conta (uma vez). */
export function startData(): void {
  if (binding) return
  binding = bindAccount(account, engine, attachments, {
    afterMerge: () => {
      for (const fn of mergeListeners) fn()
    },
    log
  })
  AppState.addEventListener('change', (s) => {
    if (s === 'active' && engine.isRunning) void engine.sync()
  })
}
