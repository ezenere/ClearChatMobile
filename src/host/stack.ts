// Monta o host no celular (repo + outbox + runner + HostService) sobre o cache e a conta — o mesmo
// código no aparelho (native.ts) e nos testes de integração (Node). Sem React Native.
import {
  APPROVAL_LISTS_SETTING,
  normalizeApprovalLists,
  validateListEntry
} from '@shared/approvalPolicy'
import type { InheritConfig } from '@shared/chatInherit'
import { isChatProvider } from '@shared/providerKinds'
import type { ApprovalListItem, ModelInfo, Provider } from '@shared/types'
import type { InterChatSendMeta } from '@shared/interChat'
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
import {
  effectiveConfigOf,
  freezesOfPreset,
  inheritanceMigrations,
  inheritEnvOf
} from '@/data/inherit'
import { historyStore } from '@/agent/historyStore'
import { listModels as fetchModels } from '@/agent/providers'
import {
  setLocationSource,
  setMemorySources,
  setProviderNamesSource,
  setSiblingsSource
} from '@/agent/request'
import type { LocationService } from '@/location/service'
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
  remoteSend?: (
    chatId: string,
    sessionId: string,
    text: string,
    meta: InterChatSendMeta
  ) => Promise<{ queued?: boolean }>
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
  /** Sem conta ("Usar sem conta"): tudo roda e grava só aqui (§12 sobe depois, no merge). */
  localOnly?: () => boolean
  /** get_location / nearby_places (src/location); ausente = sem as tools de localização. */
  location?: LocationService
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
  /**
   * Renomear/apagar um chat sem conta (só neste aparelho; com conta a lista usa o motor, online).
   * Apagar para o turno em andamento antes.
   */
  renameChatLocal: (chatId: string, title: string) => void
  deleteChatLocal: (chatId: string) => Promise<void>
  /** "Salvar online" de um chat só deste aparelho (§23.8). */
  saveOnline: (chatId: string) => number
  /**
   * Migração única dos chats antigos para a herança ao vivo da persona (§4.3.6): depois de um
   * pull completo (o motor chama) e na inicialização sem conta. Devolve os ids migrados.
   */
  migrateInheritance: () => string[]
  /**
   * Persona saindo (apagada aqui ou tombstone recebido, §7.7): congela os chats locais dela antes
   * — os frozen sobem antes do tombstone (a outbox LWW espera por eles). Devolve os ids.
   */
  freezePresetChats: (presetId: string) => string[]
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
    writerTiming: d.writerTiming,
    // §7.7 (1.10.0): o tombstone de uma persona só sobe depois dos chats congelados dela
    hold: (row) => row.type === 'preset' && row.deleted && d.store.frozenPending(row.id).length > 0
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
  const location = d.location
  setLocationSource(
    location ? { tools: () => location.tools(), definition: (n) => location.definition(n) } : null
  )
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
    listChats: () => {
      const env = inheritEnvOf(d.store)
      return d.store.listChats().map((c) => {
        // o modelo efetivo (herança ao vivo da persona, §4.3.6)
        const raw = d.store.getPlain('chat', c.id)?.config
        return {
          id: c.id,
          title: chatTitle(c.title),
          model: raw === undefined ? '' : effectiveConfigOf(d.store, raw, env).model || '',
          updatedAt: c.updatedAt
        }
      })
    },
    interChat: bridge,
    location
  })
  const addListEntries = async (
    entries: { item: ApprovalListItem; list: 'allow' | 'deny'; entry: string }[]
  ): Promise<void> => {
    const mutate = (cur: Plain | null): Plain => {
      const lists = normalizeApprovalLists(cur?.value)
      for (const { item, list, entry } of entries) {
        const e = entry.replace(/\s+/g, ' ').trim()
        if (validateListEntry(item, e)) continue
        const other = list === 'allow' ? 'deny' : 'allow'
        lists[item][other] = lists[item][other].filter((x) => x !== e)
        if (!lists[item][list].includes(e)) lists[item][list].push(e)
      }
      return { ...(cur ?? {}), sv: 1, value: lists }
    }
    if (d.localOnly?.()) {
      // sem conta: a outbox LWW (sobe só depois do merge do primeiro login)
      const plain = mutate(d.store.getPlain('setting', APPROVAL_LISTS_SETTING))
      memory.writer.write({
        type: 'setting',
        id: APPROVAL_LISTS_SETTING,
        scope: null,
        plain,
        patch: plain
      })
      d.engine.notifySettings()
      return
    }
    await d.engine.saveLww({ type: 'setting', id: APPROVAL_LISTS_SETTING, scope: null }, mutate)
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
    divergence: () => divergence,
    localOnly: d.localOnly
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
  // herança ao vivo da persona (1.10.0): grava o registro sem mexer no `updatedAt` (a ordem da
  // lista não muda) — o chat sobe pela outbox (nos "Só neste aparelho", fica aqui)
  const writeRecords = (list: { chatId: string; config: InheritConfig }[]): string[] => {
    for (const { chatId, config } of list) repo.writeRecord(chatId, config)
    return list.map((x) => x.chatId)
  }
  const migrateInheritance = (): string[] => {
    try {
      const ids = writeRecords(inheritanceMigrations(d.store))
      if (ids.length) d.log?.(`herança da persona: ${ids.length} chats migrados`)
      return ids
    } catch (e) {
      d.log?.(`herança da persona: migração falhou (${(e as Error).message})`)
      return []
    }
  }
  const freezePresetChats = (presetId: string): string[] => {
    const ids = writeRecords(freezesOfPreset(d.store, presetId))
    if (ids.length) d.log?.(`herança da persona: ${ids.length} chats congelados`)
    return ids
  }
  d.engine.setHooks({
    beforePresetGone: freezePresetChats,
    chatRebased: (chatId) => writer.schedule(chatId),
    caughtUp: () => void migrateInheritance()
  })
  const renameChatLocal = (chatId: string, title: string): void => {
    const t = title.trim().slice(0, 200)
    if (!t) throw new Error('Dê um nome ao chat.')
    if (!d.store.getPlain('chat', chatId)) throw new Error('Este chat não existe mais.')
    writer.writeChat(chatId, { title: t })
  }
  const deleteChatLocal = async (chatId: string): Promise<void> => {
    if (runner.busyChats().has(chatId))
      await runner.stopChat(chatId, true, 'interrupted').catch(() => undefined)
    writer.deleteChat(chatId)
  }
  /**
   * "Salvar online" de um chat só deste aparelho (§23.8, ao vivo → online): vira um chat comum
   * criado offline — tudo na outbox e o envio pelas regras normais (blobs antes, `chat` no primeiro
   * lote, conteúdo em replay com `chat_bases = 0`; o aparelho vira o host). Sem conexão, espera na
   * outbox. Devolve quantos registros vão subir.
   */
  const saveOnline = (chatId: string): number => {
    if (d.localOnly?.()) throw new Error('Entre numa conta para salvar chats online.')
    if (!d.store.isLocalOnly(chatId)) return 0
    if (runner.busyChats().has(chatId))
      throw new Error('Espere o agente terminar para salvar o chat online.')
    const n = d.store.convertToOnline(chatId)
    d.engine.notifyLocal([chatId])
    writer.schedule(chatId, 0)
    return n
  }
  return {
    repo,
    writer,
    runner,
    host,
    memory,
    divergence,
    providers,
    renameChatLocal,
    deleteChatLocal,
    saveOnline,
    migrateInheritance,
    freezePresetChats
  }
}
