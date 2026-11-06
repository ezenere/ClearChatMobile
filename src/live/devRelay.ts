// Relé FALSO do servidor para chats só ao vivo (SYNC_PROTOCOL.md §23.3–§23.4) — testes e a rota de
// desenvolvimento `clearchat://dev/live` (só __DEV__): guarda o vínculo de cada chat só em memória,
// atende `live.list`/`live.refresh`, manda `live.update`/`live.removed`/`live.host` ao visualizador,
// roteia `remote.send`/`stream.*` pelo vínculo ao host falso (./devHost.ts) e simula a tolerância de
// queda, o host saindo e o "salvo online". Nunca abre um envelope. NUNCA usar fora de testes/dev.
import type { Subkeys } from '@/crypto'
import { WsRequestError } from '@vendor/desktop/sync/ws'
import { DevLiveHost, type DevHostOptions } from './devHost'

interface Binding {
  chat_id: string
  host: string
  epoch: number
  arev: number
  running: boolean
  env: unknown
  announced_at: string
}

interface RelayHost {
  name: string
  platform: string
  status: 'online' | 'grace'
  dev: DevLiveHost
}

/**
 * O servidor do ponto de vista de UM visualizador (o celular) e dos hosts falsos: guarda o vínculo
 * de cada chat ao vivo só em memória e repassa tudo cifrado (nunca abre um envelope). `request` é o
 * `ws.request` do celular; os eventos para ele saem por `onViewer`.
 */
export class DevLiveRelay {
  bindings = new Map<string, Binding>()
  hosts = new Map<string, RelayHost>()
  subscribed = new Set<string>()
  sent: { t: string; fields: Record<string, unknown> }[] = []
  settling = 0
  /** Servidor < 1.8.0: o `live.*` não existe (kind desconhecido → invalid_request). */
  legacy = false
  onViewer: (f: Record<string, unknown>) => void = () => undefined
  /** Faz o próximo frame do host → visualizador se perder (testes de buraco). */
  dropNext = 0

  /**
   * `passthrough` = o `ws.request` de verdade (rota de desenvolvimento): o que não é de um chat
   * deste relé vai ao servidor real.
   */
  constructor(
    readonly userId: string,
    readonly passthrough?: (
      t: string,
      fields?: Record<string, unknown>,
      timeoutMs?: number
    ) => Promise<Record<string, unknown>>
  ) {}

  addHost(
    deviceId: string,
    name: string,
    sk: Pick<Subkeys, 'stream'>,
    opts: Partial<DevHostOptions> = {}
  ): DevLiveHost {
    const dev = new DevLiveHost({
      userId: this.userId,
      deviceId,
      sk,
      ...opts,
      emit: (f) => this.fromHost(deviceId, f)
    })
    this.hosts.set(deviceId, { name, platform: 'linux', status: 'online', dev })
    return dev
  }

  private toViewer(f: Record<string, unknown>): void {
    if (this.dropNext > 0 && f.t === 'stream.event') {
      this.dropNext--
      return
    }
    // assíncrono como a rede (e na ordem)
    void Promise.resolve().then(() => this.onViewer(f))
  }

  private wire(b: Binding): Record<string, unknown> {
    const h = this.hosts.get(b.host)!
    return {
      chat_id: b.chat_id,
      epoch: b.epoch,
      arev: b.arev,
      running: b.running,
      env: b.env,
      host: { device_id: b.host, name: h.name, platform: h.platform, status: h.status },
      announced_at: b.announced_at
    }
  }

  private fromHost(deviceId: string, f: Record<string, unknown>): void {
    switch (f.t) {
      case 'live.announce': {
        const changed: Binding[] = []
        const listed = new Set<string>()
        for (const raw of f.chats as Record<string, unknown>[]) {
          const id = String(raw.chat_id)
          listed.add(id)
          const cur = this.bindings.get(id)
          if (cur && cur.host !== deviceId) continue // other_host
          const epoch = Number(raw.epoch)
          const arev = Number(raw.arev)
          if (cur && cur.epoch === epoch && arev <= cur.arev) continue
          const b: Binding = {
            chat_id: id,
            host: deviceId,
            epoch,
            arev,
            running: raw.running === true,
            env: raw.env,
            announced_at: new Date().toISOString()
          }
          this.bindings.set(id, b)
          changed.push(b)
        }
        if (f.full) {
          const gone = [...this.bindings.values()].filter(
            (b) => b.host === deviceId && !listed.has(b.chat_id)
          )
          for (const b of gone) this.bindings.delete(b.chat_id)
          if (gone.length)
            this.toViewer({
              t: 'live.removed',
              host_device_id: deviceId,
              chat_ids: gone.map((b) => b.chat_id),
              reason: 'withdrawn'
            })
        }
        if (changed.length)
          this.toViewer({ t: 'live.update', chats: changed.map((b) => this.wire(b)) })
        return
      }
      case 'live.withdraw': {
        const ids =
          (f.chat_ids as string[] | null) ??
          [...this.bindings.values()].filter((b) => b.host === deviceId).map((b) => b.chat_id)
        for (const id of ids) this.bindings.delete(id)
        this.toViewer({
          t: 'live.removed',
          host_device_id: deviceId,
          chat_ids: ids,
          reason: f.reason === 'quit' ? 'host_quit' : String(f.reason ?? 'withdrawn')
        })
        return
      }
      case 'stream.event': {
        const b = this.bindings.get(String(f.chat_id))
        if (!b || b.host !== deviceId || b.epoch !== f.epoch) return
        if (this.subscribed.has(b.chat_id)) this.toViewer({ ...f, device_id: deviceId })
        return
      }
      case 'remote.result':
        this.toViewer(f)
        return
    }
  }

  /** O `ws.request` do celular. */
  request = async (
    t: string,
    fields: Record<string, unknown> = {},
    timeoutMs?: number
  ): Promise<Record<string, unknown>> => {
    if (this.passthrough && !this.mine(t, fields)) return this.passthrough(t, fields, timeoutMs)
    this.sent.push({ t, fields })
    await Promise.resolve()
    if (
      this.legacy &&
      (t.startsWith('live.') || /^(history|attach|chat)\./.test(String(fields.kind ?? '')))
    )
      throw new WsRequestError('kind desconhecido', 'invalid_request')
    switch (t) {
      case 'live.list':
        return {
          chats: [...this.bindings.values()].map((b) => this.wire(b)),
          settling_s: this.settling
        }
      case 'live.refresh':
        for (const h of this.hosts.values()) void h.dev.announce(true)
        return {}
      case 'stream.subscribe':
        for (const id of (fields.chat_ids as string[]) ?? []) {
          this.subscribed.add(id)
          const b = this.bindings.get(id)
          if (b) void this.hosts.get(b.host)?.dev.snapshot(id)
        }
        return {}
      case 'stream.unsubscribe':
        for (const id of (fields.chat_ids as string[]) ?? []) this.subscribed.delete(id)
        return {}
      case 'stream.resync': {
        const b = this.bindings.get(String(fields.chat_id))
        if (b) void this.hosts.get(b.host)?.dev.snapshot(b.chat_id)
        return {}
      }
      case 'remote.send': {
        const b = this.bindings.get(String(fields.chat_id))
        if (!b) throw new WsRequestError('sem host', 'no_host')
        const h = this.hosts.get(b.host)!
        if (h.status !== 'online') throw new WsRequestError('host offline', 'host_offline')
        void Promise.resolve().then(() =>
          h.dev.onCommand({
            ...fields,
            from_device_id: 'phone',
            created_at: new Date().toISOString()
          })
        )
        return { status: 'delivered' }
      }
    }
    return {}
  }

  /** É um pedido que este relé atende (live.* ou um chat vinculado aqui)? */
  private mine(t: string, fields: Record<string, unknown>): boolean {
    if (t === 'live.list' || t === 'live.refresh') return true
    if (t === 'stream.subscribe' || t === 'stream.unsubscribe') {
      const ids = (fields.chat_ids as string[]) ?? []
      return ids.length > 0 && ids.every((id) => this.isOurs(id))
    }
    if (t === 'stream.resync' || t === 'remote.send') return this.isOurs(String(fields.chat_id))
    return false
  }

  private isOurs(chatId: string): boolean {
    for (const h of this.hosts.values()) if (h.dev.chats.has(chatId)) return true
    return false
  }

  /** O host perdeu a conexão: tolerância (§23.3). */
  hostGrace(deviceId: string): void {
    this.hosts.get(deviceId)!.status = 'grace'
    this.toViewer({ t: 'live.host', host_device_id: deviceId, status: 'grace' })
  }

  /** Tolerância expirou: todos os vínculos do host somem. */
  hostDropped(deviceId: string): void {
    const ids = [...this.bindings.values()].filter((b) => b.host === deviceId).map((b) => b.chat_id)
    for (const id of ids) this.bindings.delete(id)
    this.toViewer({
      t: 'live.removed',
      host_device_id: deviceId,
      chat_ids: ids,
      reason: 'host_dropped'
    })
  }

  /** O host fechou o app (`live.withdraw { reason: 'quit' }`): some na hora. */
  hostQuit(deviceId: string): void {
    const ids = [...this.bindings.values()].filter((b) => b.host === deviceId).map((b) => b.chat_id)
    for (const id of ids) this.bindings.delete(id)
    if (ids.length)
      this.toViewer({
        t: 'live.removed',
        host_device_id: deviceId,
        chat_ids: ids,
        reason: 'host_quit'
      })
  }

  hostBack(deviceId: string): void {
    this.hosts.get(deviceId)!.status = 'online'
    this.toViewer({ t: 'live.host', host_device_id: deviceId, status: 'online' })
  }

  /** O chat virou online (§23.8): o commit do `chat` apaga o vínculo. */
  savedOnline(chatId: string): void {
    const b = this.bindings.get(chatId)
    if (!b) return
    this.bindings.delete(chatId)
    this.toViewer({
      t: 'live.removed',
      host_device_id: b.host,
      chat_ids: [chatId],
      reason: 'saved_online'
    })
  }

  /** Reinício do servidor: os vínculos somem (os hosts reanunciam no welcome). */
  restart(settling: number): void {
    this.bindings.clear()
    this.subscribed.clear()
    this.settling = settling
  }

  of(t: string): { t: string; fields: Record<string, unknown> }[] {
    return this.sent.filter((s) => s.t === t)
  }
}
