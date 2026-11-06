// Instância do visualizador de chats só ao vivo no aparelho (SYNC_PROTOCOL.md §23.10): WebSocket da
// conta, controle remoto (stream/comandos) e `features.liveChats` de `/api/info`. A única coisa
// guardada é o booleano "esta instância suporta chats ao vivo" (para o Novo chat offline); o
// conteúdo dos chats fica só em memória. Arquivos que o usuário abre no app do sistema (PDF/áudio de
// um chat ao vivo) passam por uma pasta temporária apagada ao sair do chat, ao bloquear e ao abrir.
import { Directory, File, Paths } from 'expo-file-system'
import { account, kv } from '@/account/native'
import { syncKeys } from '@/data/native'
import { accountWs, remote, setLiveHook } from '@/remote/native'
import { bindLive } from './binding'
import { LiveService } from './service'

const log = (msg: string): void => {
  // só ids/contagens — nunca conteúdo
  if (__DEV__) console.log(`[clearchat:live] ${msg}`)
}

const TEMP_DIR = 'live-view'
const KV_SUPPORT = 'live.support'

/** Pasta temporária dos arquivos de chats ao vivo abertos no app do sistema. */
export function liveTempDir(): Directory {
  return new Directory(Paths.cache, TEMP_DIR)
}

export function wipeLiveTemp(): void {
  try {
    const d = liveTempDir()
    if (d.exists) d.delete()
  } catch {
    /* nada para apagar */
  }
}

/** Grava um anexo de chat ao vivo na pasta temporária (só para abrir no app do sistema). */
export function liveTempFile(name: string, bytes: Uint8Array): File {
  const d = liveTempDir()
  if (!d.exists) d.create({ intermediates: true })
  const f = new File(d, name)
  f.create({ overwrite: true })
  f.writeSync(bytes)
  return f
}

async function fetchFeature(): Promise<boolean | null> {
  try {
    const res = await fetch(`${account.baseUrl()}/api/info`, {
      signal: AbortSignal.timeout(10_000)
    })
    if (!res.ok) return null
    const j = (await res.json()) as { features?: { liveChats?: unknown } }
    return j?.features?.liveChats === true
  } catch {
    return null
  }
}

const supportKey = () => `${KV_SUPPORT}:${account.baseUrl()}`

export const live: LiveService = new LiveService({
  ws: accountWs,
  remote,
  keys: syncKeys,
  deviceId: () => account.getState().device?.id ?? null,
  fetchFeature: (): Promise<boolean | null> =>
    live.devForceCaps ? Promise.resolve(true) : fetchFeature(),
  rememberSupport: (v) => kv.set(supportKey(), v ? '1' : '0'),
  recallSupport: () => {
    const v = kv.get(supportKey())
    return v === '1' ? true : v === '0' ? false : null
  },
  wipeTemp: wipeLiveTemp,
  log
})

let started = false

/** Liga o visualizador (depois do `startRemote`). */
export function startLive(): void {
  if (started) return
  started = true
  wipeLiveTemp()
  setLiveHook(live.hook)
  bindLive(account, live)
}
