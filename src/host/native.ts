// Instância do host no aparelho: cache, motor, conta (WebSocket/REST) e o store de anexos
// (expo-file-system). Nunca loga conteúdo nem chaves.
import { Directory, File, Paths } from 'expo-file-system'
import { AppState, Platform } from 'react-native'
import { account } from '@/account/native'
import { attachments, engine, store } from '@/data/native'
import { hex, sha256 } from '@/crypto'
import { setEnvSource } from '@/agent/request'
import { setSearchBases } from '@/agent/tools/web'
import { openNativeSql } from '@/data/sqlNative'
import { remote } from '@/remote/native'
import { bindHost } from './binding'
import { createHostStack } from './stack'

const log = (msg: string): void => {
  if (__DEV__) console.log(`[clearchat:host] ${msg}`)
}

const keys = () => {
  const sk = account.subkeys
  const userId = account.accountUserId
  return sk && userId ? { userId, sk } : null
}

const dir = new Directory(Paths.document, 'attachments')
const fileOf = (name: string): File => new File(dir, name)

setEnvSource(() => ({ os: `Android ${String(Platform.Version)}` }))
// desenvolvimento/E2E: buscador falso local (nunca em produção — só com a variável definida)
if (process.env.EXPO_PUBLIC_CLEARCHAT_SEARCH_BASE_DDG)
  setSearchBases({ ddg: process.env.EXPO_PUBLIC_CLEARCHAT_SEARCH_BASE_DDG })

const listeners = new Set<
  (n: { chatId: string; tone: 'info' | 'danger' | 'success'; text: string }) => void
>()
export function onHostNotice(
  fn: (n: { chatId: string; tone: 'info' | 'danger' | 'success'; text: string }) => void
): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export const hostStack = createHostStack({
  store,
  engine,
  http: {
    get: (path) => account.http.get(path),
    post: (path, json) => account.http.post(path, json),
    putBlob: async (blobId, ct, sha) => {
      await account.http.req('PUT', `/api/v1/blobs/${encodeURIComponent(blobId)}`, {
        body: ct,
        headers: { 'Content-Type': 'application/octet-stream', 'X-Content-SHA256': sha },
        timeoutMs: 10 * 60_000
      })
    }
  },
  keys,
  openMemorySql: () => openNativeSql(':memory:'),
  remoteSend: (chatId, sessionId, text) => remote.send(chatId, sessionId, text, [], []),
  ws: { request: (t, f, ms) => account.wsRequest(t, f, ms) },
  deviceId: () => account.getState().device?.id ?? null,
  deviceName: () => account.getState().device?.name ?? 'Celular',
  files: {
    ensure: async (f) => {
      await attachments.ensure(f)
    },
    readBase64: (f) => fileOf(f).base64(),
    readText: (f) => fileOf(f).text(),
    size: (f) => {
      const x = fileOf(f)
      return x.exists ? x.size : null
    },
    save: async (data, ext) => {
      const f = `${hex(await sha256(data))}.${ext}`
      attachments.put(f, data)
      return f
    },
    bytes: async (f) => {
      const x = fileOf(f)
      return x.exists ? x.bytes() : null
    }
  },
  notice: (n) => {
    for (const fn of listeners) fn(n)
  },
  log
})

export const host = hostStack.host

let started = false

/** Liga o host (depois do `startData` e do `startRemote`). */
export function startHost(): void {
  if (started) return
  started = true
  bindHost(account, host, hostStack.runner)
  AppState.addEventListener('change', (s) => {
    if (s === 'active') host.onForeground()
  })
}
