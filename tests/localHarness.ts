// Celular "sem conta" para os testes (Node): o mesmo cache (node:sqlite, em arquivo se pedido), o
// motor, o host e as Configurações do aparelho, com o modo sem conta ligado — nenhuma chave, um
// WebSocket que recusa tudo e o servidor falso que conta as chamadas (nada pode chegar lá). Depois,
// "entrar numa conta" = chaves + WebSocket online + o binding real da conta (merge do §12) com uma
// conta de mentira que só troca de fase.
import type { AccountService } from '../src/account/service'
import type { Phase, SessionState } from '../src/account/session'
import { bindAccount, syncAllowed, type AccountBinding } from '../src/data/binding'
import { SyncEngine } from '../src/data/engine'
import { LocalStore } from '../src/data/store'
import { createHostStack, type HostStack } from '../src/host/stack'
import { SettingsService } from '../src/settings/service'
import { invalidateModels } from '../src/agent/providers'
import { setSearchBases } from '../src/agent/tools/web'
import { hex, sha256, type Subkeys } from '../src/crypto'
import { DEFAULT_CHAT_CONFIG } from '../src/vendor/shared/defaults'
import { FakeWs, until } from './hostHarness'
import { DesktopWriter, FakeSync } from './fakeSync'
import { openNodeSql } from './nodeSql'
import { startFakeLlm, type FakeLlm } from './fakes/fakeLlm'

/** Conta de mentira para o `bindAccount`: só a fase, o dono e as chaves. */
export class StubAccount {
  phase: Phase = 'local'
  server = { kind: 'self' as const, url: 'http://fake', name: 'falso' }
  userId: string | null = null
  sk: Subkeys | null = null
  localModeCleared = 0
  helloCursor: () => number = () => 0
  private listeners = new Set<() => void>()
  constructor(readonly http: FakeSync) {}
  getState = (): SessionState =>
    ({
      phase: this.phase,
      server: this.server,
      account: this.userId ? { userId: this.userId, email: 'x@y.z', name: 'X' } : null,
      device: this.userId ? { id: 'dev-mobile', name: 'Pixel' } : null,
      connection: 'offline',
      remember: true,
      biometric: false,
      login: null,
      notice: null
    }) as SessionState
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  setPhase(p: Phase): void {
    this.phase = p
    for (const fn of this.listeners) fn()
  }
  get subkeys(): Subkeys | null {
    return this.sk
  }
  get accountUserId(): string | null {
    return this.userId
  }
  clearLocalMode(): void {
    this.localModeCleared++
  }
  addRealtimeListener(): () => void {
    return () => undefined
  }
}

export interface LocalPhone {
  server: FakeSync
  desk: DesktopWriter
  store: LocalStore
  engine: SyncEngine
  ws: FakeWs
  stack: HostStack
  settings: SettingsService
  account: StubAccount
  binding: AccountBinding
  files: Map<string, Uint8Array>
  llm: FakeLlm
  /** Sem conta? (o host e as outboxes leem isto). */
  mode: { local: boolean }
  /** Entra na conta do servidor falso (chaves + WebSocket) e abre o cofre: o binding faz o merge. */
  signIn(): void
  newChat(): { chatId: string; sid: string }
  idle(sid: string): Promise<void>
  close(): Promise<void>
}

export async function makeLocalPhone(
  opts: { server?: FakeSync; desk?: DesktopWriter; dbPath?: string; llm?: FakeLlm } = {}
): Promise<LocalPhone> {
  const server = opts.server ?? new FakeSync()
  const desk = opts.desk ?? (await new DesktopWriter(server).init())
  const store = new LocalStore(openNodeSql(opts.dbPath))
  const account = new StubAccount(server)
  const mode = { local: true }
  const keys = () => {
    const sk = account.subkeys
    const userId = account.accountUserId
    return sk && userId && syncAllowed(store) ? { userId, sk } : null
  }
  const engine = new SyncEngine({ store, http: server, keys, yieldToUi: async () => undefined })
  const llm = opts.llm ?? (await startFakeLlm(0, { delay: 2 }))
  setSearchBases({ ddg: `${llm.url}/ddg` })
  invalidateModels()
  const ws = new FakeWs('dev-mobile')
  ws.online = false
  const files = new Map<string, Uint8Array>()
  const stack = createHostStack({
    store,
    engine,
    http: {
      get: (path) => server.get(path),
      post: (path, json) => server.post(path, json),
      putBlob: async (blobId, ct) => {
        server.blobs.set(blobId, ct)
      }
    },
    keys,
    openMemorySql: () => openNodeSql(),
    ws,
    deviceId: () => account.getState().device?.id ?? null,
    deviceName: () => 'Pixel de teste',
    files: {
      ensure: async (f) => {
        if (!files.has(f)) throw new Error('ausente')
      },
      readBase64: async (f) => Buffer.from(files.get(f) ?? new Uint8Array()).toString('base64'),
      readText: async (f) => new TextDecoder().decode(files.get(f) ?? new Uint8Array()),
      size: (f) => files.get(f)?.length ?? null,
      save: async (data, ext) => {
        const f = `${hex(await sha256(data))}.${ext}`
        files.set(f, data)
        return f
      },
      bytes: async (f) => files.get(f) ?? null
    },
    timing: { idleTickMs: 30, idleCloseMs: 60, draftMs: 20 },
    writerTiming: { debounceMs: 10, retryMs: 50 },
    localOnly: () => mode.local
  })
  const settings = new SettingsService({
    store,
    writer: stack.memory.writer,
    memory: stack.memory.index,
    notify: (list) => engine.notifySettings(list),
    freezePresetChats: (id) => void stack.freezePresetChats(id)
  })
  const binding = bindAccount(account as unknown as AccountService, engine, null, {
    http: server,
    afterMerge: () => {
      stack.writer.resume()
      stack.memory.writer.resume()
    }
  })
  stack.host.start()
  // o binding é assíncrono (cadeia de passos): espera o dono `local` ser gravado
  await until(() => store.getMeta('owner') === 'local', 2000, 'dono local')
  return {
    server,
    desk,
    store,
    engine,
    ws,
    stack,
    settings,
    account,
    binding,
    files,
    llm,
    mode,
    signIn: () => {
      account.userId = server.userId
      account.sk = desk.sk
      mode.local = false
      ws.online = true
      stack.host.onConnection(true)
      account.setPhase('unlocked')
    },
    newChat: () => {
      const providerId = stack.providers()[0]?.id ?? ''
      const { chat, session } = stack.repo.createChat({
        config: {
          ...DEFAULT_CHAT_CONFIG(''),
          providerId,
          model: 'fake/agent',
          enabledTools: ['web_search']
        }
      })
      return { chatId: chat.id, sid: session.id }
    },
    idle: (sid) => until(() => !stack.runner.isRunning(sid), 10_000, 'turno terminar'),
    close: async () => {
      binding.unbind()
      stack.host.stop()
      stack.memory.writer.stop()
      engine.stop()
      if (!opts.llm) await llm.close()
    }
  }
}
