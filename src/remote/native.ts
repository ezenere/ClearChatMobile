// Instância do controle remoto no aparelho (WebSocket da conta, cache de dados, store de anexos).
import { account } from '@/account/native'
import { attachments, engine, store } from '@/data/native'
import { bindRemote } from './binding'
import { RemoteController } from './controller'
import type { UploadDeps } from './upload'

const log = (msg: string): void => {
  // só tipos/ids — nunca conteúdo
  if (__DEV__) console.log(`[clearchat:remote] ${msg}`)
}

const keys = () => {
  const sk = account.subkeys
  const userId = account.accountUserId
  return sk && userId ? { userId, sk } : null
}

export const remote = new RemoteController({
  ws: { request: (t, f, ms) => account.wsRequest(t, f, ms) },
  keys,
  deviceId: () => account.getState().device?.id ?? null,
  chatState: (id) => store.chatState(id),
  post: (path, json) => account.http.post(path, json),
  assistantIds: (id) => store.assistantIds(id),
  loadMessage: (id) => store.message(id),
  log
})

export const uploadDeps: UploadDeps = {
  keys,
  put: (file, data) => void attachments.put(file, data),
  post: (path, json) => account.http.post(path, json),
  putBlob: async (blobId, ct, sha) => {
    await account.http.req('PUT', `/api/v1/blobs/${encodeURIComponent(blobId)}`, {
      body: ct,
      headers: { 'Content-Type': 'application/octet-stream', 'X-Content-SHA256': sha },
      timeoutMs: 10 * 60_000
    })
  }
}

let started = false

/** Liga o controle remoto (depois do `startData`). */
export function startRemote(): void {
  if (started) return
  started = true
  bindRemote(account, engine, remote)
}
