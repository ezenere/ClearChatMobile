// Instância do controle remoto no aparelho (WebSocket da conta, cache de dados, store de anexos).
import { account } from '@/account/native'
import { attachments, engine, isLocalMode, store, syncKeys } from '@/data/native'
import { bindRemote } from './binding'
import { RemoteController, type LiveHook } from './controller'
import type { UploadDeps } from './upload'

const log = (msg: string): void => {
  // só tipos/ids — nunca conteúdo
  if (__DEV__) console.log(`[clearchat:remote] ${msg}`)
}

const keys = syncKeys

type WsRequest = (
  t: string,
  fields?: Record<string, unknown>,
  timeoutMs?: number
) => Promise<Record<string, unknown>>
let devWs: WsRequest | null = null
/** Só __DEV__ (rota clearchat://dev/live): um relé falso na frente do WebSocket da conta. */
export function setDevWs(fn: WsRequest | null): void {
  if (__DEV__) devWs = fn
}
/** WebSocket da conta (ou o relé de desenvolvimento, se ligado). */
export const accountWs = {
  request: (t: string, f?: Record<string, unknown>, ms?: number) =>
    devWs ? devWs(t, f, ms) : account.wsRequest(t, f, ms)
}

let liveHook: LiveHook | null = null
/** O visualizador de chats ao vivo se liga aqui (src/live/native.ts). */
export function setLiveHook(h: LiveHook | null): void {
  liveHook = h
}

export const remote = new RemoteController({
  ws: accountWs,
  keys,
  deviceId: () => account.getState().device?.id ?? null,
  chatState: (id) => store.chatState(id),
  post: (path, json) => account.http.post(path, json),
  assistantIds: (id) => store.assistantIds(id),
  loadMessage: (id) => store.message(id),
  live: () => liveHook,
  log
})

export const uploadDeps: UploadDeps = {
  keys,
  localOnly: isLocalMode,
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
