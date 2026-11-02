// Montagem do host no celular para os testes (Node): cache real (node:sqlite), servidor de sync
// falso, WebSocket falso (host.begin/end/takeover/release, remote.result, stream.event), arquivos
// em memória e o provedor LLM falso (HTTP local, SSE de verdade pelo streamChat vendorado).
import { SyncApiError } from '../src/vendor/desktop/sync/http'
import { SyncEngine } from '../src/data/engine'
import { LocalStore } from '../src/data/store'
import { hex, sha256, type Subkeys } from '../src/crypto'
import { createHostStack, type HostStack } from '../src/host/stack'
import type { HostWs } from '../src/host/host'
import { WsRequestError } from '../src/vendor/desktop/sync/ws'
import { setSearchBases } from '../src/agent/tools/web'
import { invalidateModels } from '../src/agent/providers'
import { DesktopWriter, FakeSync } from './fakeSync'
import { openNodeSql } from './nodeSql'
import { startFakeLlm, type FakeLlm } from './fakes/fakeLlm'
import type { InterChatSendMeta } from '@shared/interChat'

export class FakeWs implements HostWs {
  epoch = 0
  host: string | null = null
  windowOpen = false
  head = 0
  requests: { t: string; fields: Record<string, unknown> }[] = []
  online = true
  /** Respostas forçadas por tipo (erro do servidor). */
  fail = new Map<string, { code: string; details?: Record<string, unknown> }>()

  constructor(readonly me: string) {}

  async request(t: string, fields: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (!this.online) throw new WsRequestError('Sem conexão com o servidor.', 'disconnected')
    this.requests.push({ t, fields })
    const f = this.fail.get(t)
    if (f) throw new WsRequestError(f.code, f.code, f.details ?? {})
    switch (t) {
      case 'host.begin': {
        let became = false
        if (!this.host) {
          this.host = this.me
          this.epoch++
          became = true
        } else if (this.host !== this.me) throw new WsRequestError('not_host', 'not_host', {})
        this.windowOpen = true
        return { epoch: this.epoch, head: this.head, became_host: became }
      }
      case 'host.end':
        this.windowOpen = false
        return { handover_pending: false }
      case 'host.takeover':
        this.host = this.me
        this.epoch++
        this.windowOpen = false
        return { status: 'granted', epoch: this.epoch, head: this.head }
      case 'host.release':
        this.host = null
        this.epoch++
        return {}
      default:
        return {}
    }
  }

  count(t: string): number {
    return this.requests.filter((r) => r.t === t).length
  }
}

export interface Harness {
  server: FakeSync
  desk: DesktopWriter
  store: LocalStore
  engine: SyncEngine
  ws: FakeWs
  llm: FakeLlm
  stack: HostStack
  files: Map<string, Uint8Array>
  providerId: string
  /** Avisos do host (pt-BR) na ordem. */
  notices: string[]
  /** send_to_chat ao host remoto (o teste troca). */
  remoteSend:
    | ((
        chatId: string,
        sessionId: string,
        text: string,
        meta: InterChatSendMeta
      ) => Promise<{ queued?: boolean }>)
    | null
  close(): Promise<void>
}

export async function makeHarness(opts: { kind?: 'openai' | 'anthropic' } = {}): Promise<Harness> {
  const server = new FakeSync()
  const desk = await new DesktopWriter(server).init()
  const store = new LocalStore(openNodeSql())
  const keys = () => ({ userId: server.userId, sk: desk.sk as Subkeys })
  const engine = new SyncEngine({ store, http: server, keys, yieldToUi: async () => undefined })
  const llm = await startFakeLlm(0, { delay: 5 })
  setSearchBases({ ddg: `${llm.url}/ddg` })
  invalidateModels()
  const providerId = 'prov-fake'
  await desk.put('provider', providerId, null, {
    sv: 1,
    name: 'LLM falso',
    kind: opts.kind ?? 'openai',
    baseUrl: opts.kind === 'anthropic' ? `${llm.url}/v1` : `${llm.url}/v1`,
    apiKey: 'sk-fake-123456789',
    headers: {},
    createdAt: 1
  })
  engine.start()
  await engine.sync()
  const ws = new FakeWs('dev-mobile')
  const files = new Map<string, Uint8Array>()
  const notices: string[] = []
  const box: { remoteSend: Harness['remoteSend'] } = { remoteSend: null }
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
    deviceId: () => 'dev-mobile',
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
    notice: (n) => notices.push(n.text),
    remoteSend: (c, s, t, m) =>
      box.remoteSend ? box.remoteSend(c, s, t, m) : Promise.reject(new Error('sem host remoto')),
    interChatPollMs: 30
  })
  stack.host.onConnection(true)
  stack.host.start()
  return {
    server,
    desk,
    store,
    engine,
    ws,
    llm,
    stack,
    files,
    providerId,
    notices,
    get remoteSend() {
      return box.remoteSend
    },
    set remoteSend(fn) {
      box.remoteSend = fn
    },
    close: async () => {
      stack.host.stop()
      engine.stop()
      await llm.close()
    }
  }
}

export async function until(fn: () => boolean, ms = 8000, what = 'condição'): Promise<void> {
  const t0 = Date.now()
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout esperando ${what}`)
    await new Promise((r) => setTimeout(r, 15))
  }
}

export { SyncApiError }
