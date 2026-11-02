// Monta o host no celular (repo + outbox + runner + HostService) sobre o cache e a conta — o mesmo
// código no aparelho (native.ts) e nos testes de integração (Node). Sem React Native.
import {
  APPROVAL_LISTS_SETTING,
  normalizeApprovalLists,
  validateListEntry
} from '@shared/approvalPolicy'
import { isChatProvider } from '@shared/providerKinds'
import type { ApprovalListItem, ModelInfo, Provider } from '@shared/types'
import type { streamChat } from '@vendor/desktop/agent/llm'
import {
  blobIdFromSha256,
  encryptBlob,
  fromHex,
  hex,
  randomBytes,
  sha256,
  type Subkeys
} from '@/crypto'
import type { SyncEngine } from '@/data/engine'
import type { LocalStore } from '@/data/store'
import type { Plain } from '@/data/types'
import type { Sql } from '@/data/sql'
import { chatTitle } from '@/data/decode'
import { historyStore } from '@/agent/historyStore'
import { listModels as fetchModels } from '@/agent/providers'
import { setMemorySources, setProviderNamesSource, setSiblingsSource } from '@/agent/request'
import { Runner, type RunnerFiles } from '@/agent/runner'
import { createMemorySystem, type MemorySystem } from '@/memory/system'
import { DivergenceService } from './divergence'
import { HostService, type HostDeps, type HostWs } from './host'
import { InterChatBridge } from './interChat'
import { ChatRepo } from './repo'
import { ContentWriter } from './writer'

export interface HostStackDeps {
  store: LocalStore
  engine: SyncEngine
  http: {
    get<T = unknown>(path: string): Promise<T>
    post<T = unknown>(path: string, json?: unknown): Promise<T>
    putBlob(blobId: string, ciphertext: Uint8Array, sha256Hex: string): Promise<void>
  }
  /** Banco em memória do índice da memória (expo-sqlite `:memory:` / node:sqlite). */
  openMemorySql: () => Sql
  /** send_to_chat para um chat executado em outro dispositivo: comando `send` ao host (§8.6). */
  remoteSend?: (chatId: string, sessionId: string, text: string) => Promise<{ queued?: boolean }>
  keys: () => { userId: string; sk: Subkeys } | null
  ws: HostWs
  deviceId: () => string | null
  deviceName: () => string
  /** Arquivos do store de anexos (download sob demanda, leitura, gravação). */
  files: RunnerFiles & { bytes(file: string): Promise<Uint8Array | null> }
  notice?: HostDeps['notice']
  log?: (msg: string) => void
  /** Testes: provedor falso / tempos curtos. */
  stream?: typeof streamChat
  listModels?: (p: Provider) => Promise<ModelInfo[]>
  timing?: HostDeps['timing']
  writerTiming?: { debounceMs?: number; retryMs?: number }
  interChatPollMs?: number
}

/** Registro `provider` (§4.3.1) → Provider (a chave fica só em memória/no cache privado). */
export function providerFromPlain(id: string, p: Plain): Provider {
  const headers =
    p.headers && typeof p.headers === 'object' && !Array.isArray(p.headers)
      ? Object.fromEntries(
          Object.entries(p.headers as Record<string, unknown>).filter(
            (e): e is [string, string] => typeof e[1] === 'string'
          )
        )
      : {}
  return {
    id,
    name: typeof p.name === 'string' ? p.name : '',
    ...(typeof p.kind === 'string' ? { kind: p.kind as Provider['kind'] } : {}),
    baseUrl: typeof p.baseUrl === 'string' ? p.baseUrl : '',
    apiKey: typeof p.apiKey === 'string' ? p.apiKey : '',
    headers,
    createdAt: typeof p.createdAt === 'number' ? p.createdAt : 0
  }
}

export interface HostStack {
  repo: ChatRepo
  writer: ContentWriter
  runner: Runner
  host: HostService
  memory: MemorySystem
  divergence: DivergenceService
  providers: () => Provider[]
}

export function createHostStack(d: HostStackDeps): HostStack {
  const providers = (): Provider[] =>
    d.store
      .plainsOf('provider')
      .map((r) => providerFromPlain(r.id, r.plain))
      .sort((a, b) => a.createdAt - b.createdAt)
  const chatProviders = () => providers().filter(isChatProvider)
  setProviderNamesSource(() => chatProviders().map((p) => p.name))
  let host: HostService | null = null
  const ensureBlobs = async (list: string[]): Promise<void> => {
    const keys = d.keys()
    if (!keys || !list.length) return
    const ids = new Map<string, string>()
    for (const f of list) ids.set(await blobIdFromSha256(keys.sk, fromHex(f.slice(0, 64))), f)
    const r = await d.http.post<{ missing?: string[] }>('/api/v1/blobs/check', {
      ids: [...ids.keys()]
    })
    for (const blobId of r?.missing ?? []) {
      const file = ids.get(blobId)
      const data = file ? await d.files.bytes(file) : null
      if (!data) {
        d.log?.(`blob ausente no servidor e no aparelho: ${blobId}`)
        continue
      }
      const ct = await encryptBlob(keys.sk, keys.userId, blobId, data, randomBytes(16))
      await d.http.putBlob(blobId, ct, hex(await sha256(ct)))
    }
  }
  const writer = new ContentWriter({
    store: d.store,
    http: d.http,
    keys: d.keys,
    pushMode: (chatId) => host?.pushMode(chatId) ?? Promise.resolve(null),
    notify: (chats) => d.engine.notifyLocal(chats),
    onPushError: (chatId, code) => host?.onPushError(chatId, code),
    ensureBlobs,
    pull: () => d.engine.sync(),
    log: d.log,
    ...d.writerTiming
  })
  const repo = new ChatRepo(d.store, writer)
  const memory = createMemorySystem({
    cache: d.store,
    open: d.openMemorySql,
    http: d.http,
    keys: d.keys,
    sessions: {
      read: (sid) => repo.sessionMemory(sid),
      write: (sid, state) => repo.setSessionMemory(sid, state)
    },
    notify: () => d.engine.notifyLocal([], false),
    log: d.log,
    writerTiming: d.writerTiming
  })
  // fontes da request: índice congelado/help no system prompt e tools de memória (= desktop)
  setMemorySources({
    prompt: (chat, session) => {
      try {
        return memory.service.promptParts(chat, session)
      } catch (e) {
        d.log?.(`memória (prompt): ${(e as Error).message}`)
        return null
      }
    },
    tools: (chat, session) => {
      try {
        return memory.service.active(chat, session).tools
      } catch (e) {
        d.log?.(`memória (tools): ${(e as Error).message}`)
        return []
      }
    }
  })
  setSiblingsSource(({ id, parentSessionId }) => {
    const parent = repo.session(parentSessionId)
    return (
      !!parent &&
      repo.sessions(parent.chatId).some((s) => s.parentSessionId === parentSessionId && s.id !== id)
    )
  })
  const bridge = new InterChatBridge({
    store: d.store,
    me: () => d.deviceId() ?? '',
    connected: () => !!host?.isConnected,
    state: (chatId) => host?.state(chatId) ?? d.store.chatState(chatId),
    ensureWindow: (chatId) => host!.ensureWindow(chatId, 'run'),
    remoteSend: d.remoteSend,
    pollMs: d.interChatPollMs
  })
  const runner = new Runner({
    repo,
    provider: (id) => providers().find((p) => p.id === id) ?? null,
    chatProviders,
    setting: (id) => d.store.setting(id),
    addListEntries: (entries) =>
      void addListEntries(entries).catch((e) => d.log?.(`listas: ${(e as Error).message}`)),
    files: d.files,
    listModels: d.listModels ?? fetchModels,
    stream: d.stream,
    log: d.log,
    memory: memory.service,
    historyStore: () => historyStore(d.store),
    listChats: () =>
      d.store.listChats().map((c) => {
        const cfg = d.store.getPlain('chat', c.id)?.config as Record<string, unknown> | undefined
        return {
          id: c.id,
          title: chatTitle(c.title),
          model: typeof cfg?.model === 'string' ? cfg.model : '',
          updatedAt: c.updatedAt
        }
      }),
    interChat: bridge
  })
  const addListEntries = async (
    entries: { item: ApprovalListItem; list: 'allow' | 'deny'; entry: string }[]
  ): Promise<void> => {
    await d.engine.saveLww({ type: 'setting', id: APPROVAL_LISTS_SETTING, scope: null }, (cur) => {
      const lists = normalizeApprovalLists(cur?.value)
      for (const { item, list, entry } of entries) {
        const e = entry.replace(/\s+/g, ' ').trim()
        if (validateListEntry(item, e)) continue
        const other = list === 'allow' ? 'deny' : 'allow'
        lists[item][other] = lists[item][other].filter((x) => x !== e)
        if (!lists[item][list].includes(e)) lists[item][list].push(e)
      }
      return { ...(cur ?? {}), sv: 1, value: lists }
    })
  }
  host = new HostService({
    ws: d.ws,
    keys: d.keys,
    deviceId: d.deviceId,
    deviceName: d.deviceName,
    store: d.store,
    repo,
    writer,
    runner,
    pull: () => d.engine.sync(),
    notice: d.notice,
    log: d.log,
    timing: d.timing,
    divergence: () => divergence
  })
  const divergence = new DivergenceService({
    store: d.store,
    http: d.http,
    keys: d.keys,
    deviceId: d.deviceId,
    state: (chatId) => host?.state(chatId) ?? d.store.chatState(chatId),
    onState: (chatId, state) => host?.applyState(chatId, state),
    blobsOf: (plain) => writer.blobsFor(plain),
    ensureBlobs: async (plains) => {
      const files = new Set<string>()
      for (const p of plains)
        for (const m of JSON.stringify(p).matchAll(
          /clearchat-attachment:\/\/([0-9a-f]{64}(?:\.[a-z0-9]{1,10})?)/g
        ))
          files.add(m[1])
      await ensureBlobs([...files])
    },
    notify: (chats) => d.engine.notifyLocal(chats),
    resume: (chatId) => writer.schedule(chatId, 0),
    log: d.log
  })
  d.engine.setHoldContent((chatId) => divergence.hold(chatId))
  return { repo, writer, runner, host, memory, divergence, providers }
}
