// Host FALSO de chats só ao vivo (SYNC_PROTOCOL.md §23), determinístico e em memória — para os
// testes unitários (tests/fakeServer.ts liga um relé do servidor nele) e para a rota de
// desenvolvimento `clearchat://dev/live` (só __DEV__), que mostra no aparelho a seção "Ao vivo" e o
// visualizador sem depender de um desktop. Faz o papel do app do PC: anuncia (`live.announce`
// cifrado com a AAD live-announce), responde `history.*` (páginas, `large` + pedaços, `omitted`,
// `changes` com `reset`), `attach.put`/`attach.get` (pedaços, offset, sha256), `chat.update`, `send`
// (mensagem do usuário + resposta "ok: <texto>" com draft e `rec`), "/tool" → aprovação, "/ask" →
// pergunta, e publica `snapshot` com `live.lseq`. NUNCA usar fora de testes/dev.
import type { AttachmentInfo } from '@shared/types'
import { fromUtf8, hex, sha256, utf8, type Subkeys } from '@/crypto'
import { openCommand, sealResult, sealStream, type Envelope } from '@/remote/crypto'
import { toStdB64 } from './attach'
import { sealAnnounce } from './crypto'
import { fromStdB64 } from './history'
import type { LiveItem, LiveItemType } from './types'

export interface DevHostTimers {
  setTimeout: (fn: () => void, ms: number) => unknown
}

export interface DevHostOptions {
  userId: string
  deviceId: string
  sk: Pick<Subkeys, 'stream'>
  /** Frames host → servidor (`live.announce`, `live.withdraw`, `stream.event`, `remote.result`). */
  emit: (frame: Record<string, unknown>) => void
  now?: () => number
  timers?: DevHostTimers
  /** Atraso da resposta do "assistente" (ms). */
  replyMs?: number
  /** Item acima disso (JSON de data) vai como `large` (padrão §17.1: 256 KiB). */
  inlineMax?: number
  /** Item acima disso num `rec` vai `omitted` (padrão 128 KiB). */
  recInlineMax?: number
  /** Pedaço do `history.item { piece }` (padrão 512 KiB). */
  chunk?: number
  /** Itens por página do `history.list` (padrão 200). */
  pageMax?: number
}

interface Rec {
  type: LiveItemType
  id: string
  data: Record<string, unknown> | null
}

interface HostChat {
  id: string
  epoch: number
  arev: number
  lseq: number
  n: number
  running: boolean
  pending: { approvals: number; questions: number; retries: number }
  items: Map<string, Rec>
  changes: Map<string, number>
  /** Changes esquecidas até aqui (`since` abaixo → reset). */
  floor: number
  uploads: Map<
    string,
    {
      name: string
      mime: string
      size: number
      sha256: string
      received: number
      parts: Uint8Array[]
    }
  >
  files: Map<string, { bytes: Uint8Array; mime: string }>
  approval: { id: string; sessionId: string; toolCallId: string } | null
  question: { id: string; sessionId: string; toolCallId: string } | null
  seq: number
  seenCmds: Set<string>
}

const k = (type: string, id: string) => `${type}\u0000${id}`

export class DevLiveHost {
  readonly o: DevHostOptions
  readonly chats = new Map<string, HostChat>()
  /** Comandos recebidos (kind), para os testes conferirem. */
  readonly received: { kind: string; payload: Record<string, unknown> }[] = []
  private ids = 0

  constructor(o: DevHostOptions) {
    this.o = o
  }

  private now(): number {
    return this.o.now?.() ?? Date.now()
  }

  private uid(p: string): string {
    this.ids++
    return `${p}-${this.ids.toString(16).padStart(8, '0')}-0000-4000-8000-${String(this.ids).padStart(12, '0')}`
  }

  private later(fn: () => void, ms: number): void {
    const t = this.o.timers ?? { setTimeout: (f: () => void, m: number) => setTimeout(f, m) }
    t.setTimeout(fn, ms)
  }

  // ---------------- conteúdo ----------------

  /** Cria um chat ao vivo com `messages` pares usuário/assistente na sessão principal. */
  createChat(opts: {
    id?: string
    title: string
    epoch?: number
    messages?: { role: 'user' | 'assistant'; content: string }[]
    subagent?: boolean
    hostCwd?: string | null
  }): string {
    const id = opts.id ?? this.uid('c')
    const now = this.now()
    const c: HostChat = {
      id,
      epoch: opts.epoch ?? now,
      arev: 0,
      lseq: 0,
      n: 0,
      running: false,
      pending: { approvals: 0, questions: 0, retries: 0 },
      items: new Map(),
      changes: new Map(),
      floor: 0,
      uploads: new Map(),
      files: new Map(),
      approval: null,
      question: null,
      seq: 0,
      seenCmds: new Set()
    }
    this.chats.set(id, c)
    const sid = `${id}-main`
    this.put(c, 'chat', id, {
      sv: 1,
      title: opts.title,
      config: { providerId: 'prov-1', model: 'fake/model', presetId: null },
      mainSessionId: sid,
      createdAt: now,
      updatedAt: now,
      hostCwd: opts.hostCwd ?? null
    })
    this.put(c, 'session', sid, this.sessionPlain(id, sid, 0, 'idle'))
    let parent: string | null = null
    for (const m of opts.messages ?? []) parent = this.addMessage(c, sid, m.role, m.content, parent)
    if (opts.subagent) {
      const sub = `${id}-sub`
      this.put(c, 'session', sub, {
        ...this.sessionPlain(id, sub, 1, 'idle'),
        parentSessionId: sid,
        title: 'Pesquisa',
        task: 'pesquisar'
      })
      this.addMessage(c, sub, 'user', 'tarefa do subagente', null)
      this.addMessage(c, sub, 'assistant', 'resultado do subagente', null)
    }
    // o histórico inicial não conta como mudança do epoch (lseq 0)
    c.lseq = 0
    c.changes.clear()
    for (const r of c.items.values()) c.changes.set(k(r.type, r.id), 0)
    return id
  }

  private sessionPlain(chatId: string, sid: string, depth: number, status: string) {
    return {
      sv: 1,
      chatId,
      parentSessionId: null,
      parentToolCallId: null,
      depth,
      model: 'fake/model',
      providerId: 'prov-1',
      title: depth ? 'Subagente' : 'Principal',
      task: null,
      status,
      createdAt: this.now() + depth,
      branchSel: {}
    }
  }

  private put(c: HostChat, type: LiveItemType, id: string, data: Record<string, unknown> | null) {
    c.items.set(k(type, id), { type, id, data })
  }

  private addMessage(
    c: HostChat,
    sid: string,
    role: 'user' | 'assistant',
    content: unknown,
    parentId: string | null
  ): string {
    const id = this.uid('m')
    c.seq++
    this.put(c, 'message', id, {
      sv: 1,
      sessionId: sid,
      seq: c.seq,
      message: { role, content },
      meta: {},
      createdAt: this.now() + c.seq,
      parentId
    })
    return id
  }

  /** Mensagem grande (para `large` + pedaços). */
  addBigMessage(chatId: string, bytes: number): string {
    const c = this.chats.get(chatId)!
    const sid = `${chatId}-main`
    return this.addMessage(c, sid, 'assistant', 'x'.repeat(bytes), this.lastMain(c))
  }

  /** Muda algo e emite o `rec` (um lseq por chamada). */
  change(chatId: string, items: Rec[], opts: { silent?: boolean } = {}): number {
    const c = this.chats.get(chatId)!
    c.lseq++
    for (const it of items) {
      if (it.data) this.put(c, it.type, it.id, it.data)
      else c.items.set(k(it.type, it.id), { ...it, data: null })
      c.changes.set(k(it.type, it.id), c.lseq)
    }
    if (!opts.silent) void this.emitRec(c, items)
    return c.lseq
  }

  private lastMain(c: HostChat): string | null {
    let best: { id: string; seq: number } | null = null
    for (const r of c.items.values())
      if (r.type === 'message' && r.data && r.data.sessionId === `${c.id}-main`) {
        const seq = Number(r.data.seq)
        if (!best || seq > best.seq) best = { id: r.id, seq }
      }
    return best?.id ?? null
  }

  private liveItem(c: HostChat, r: Rec, max: number): LiveItem {
    const lseq = c.changes.get(k(r.type, r.id)) ?? 0
    if (!r.data) return { type: r.type, id: r.id, lseq, deleted: true }
    const size = utf8(JSON.stringify(r.data)).length
    if (size > max) return { type: r.type, id: r.id, lseq, large: size }
    return { type: r.type, id: r.id, lseq, data: r.data }
  }

  // ---------------- anúncio / stream ----------------

  private info(c: HostChat): Record<string, unknown> {
    const chat = c.items.get(k('chat', c.id))?.data ?? {}
    const status =
      c.pending.approvals || c.pending.questions ? 'waiting' : c.running ? 'running' : 'idle'
    return {
      sv: 1,
      chatId: c.id,
      title: String(chat.title ?? ''),
      persona: { id: 'preset-default', name: 'Padrão', icon: 'sparkles' },
      model: {
        providerId: 'prov-1',
        providerName: 'Provedor',
        model: String((chat.config as Record<string, unknown> | undefined)?.model ?? '')
      },
      status,
      pending: { ...c.pending },
      usesLocalTools: true,
      hostCwd: (chat.hostCwd as string | null) ?? null,
      createdAt: Number(chat.createdAt ?? 0),
      updatedAt: Number(chat.updatedAt ?? 0),
      messageCount: [...c.items.values()].filter((r) => r.type === 'message' && r.data).length
    }
  }

  /** Frame `live.announce` (`full` = todos os chats deste host). */
  async announce(full: boolean, only?: string[]): Promise<Record<string, unknown>> {
    const chats: Record<string, unknown>[] = []
    for (const c of this.chats.values()) {
      if (only && !only.includes(c.id)) continue
      c.arev++
      const env = await sealAnnounce(
        this.o.sk.stream,
        this.o.userId,
        this.o.deviceId,
        c.id,
        c.epoch,
        c.arev,
        this.info(c)
      )
      chats.push({ chat_id: c.id, epoch: c.epoch, arev: c.arev, running: c.running, env })
    }
    const f = { t: 'live.announce', full, chats }
    this.o.emit(f)
    return f
  }

  private async event(c: HostChat, payload: Record<string, unknown>): Promise<void> {
    c.n++
    const n = c.n
    const env = await sealStream(this.o.sk.stream, this.o.userId, c.id, c.epoch, n, payload)
    this.o.emit({ t: 'stream.event', chat_id: c.id, epoch: c.epoch, n, env })
  }

  private async emitRec(c: HostChat, items: Rec[]): Promise<void> {
    const max = this.o.recInlineMax ?? 128 * 1024
    const lseq = c.lseq
    await this.event(c, {
      kind: 'rec',
      lseq,
      items: items.map((r) => {
        const it = this.liveItem(c, r, max)
        return it.large ? { type: it.type, id: it.id, lseq: it.lseq, omitted: true } : it
      })
    })
  }

  /** `stream.resync_request` → snapshot com `live.lseq`. */
  async snapshot(chatId: string): Promise<void> {
    const c = this.chats.get(chatId)
    if (!c) return
    const sessions: Record<string, unknown> = {}
    for (const r of c.items.values())
      if (r.type === 'session' && r.data)
        sessions[r.id] = {
          status: r.data.status,
          draft: null,
          tools: {},
          compaction: null
        }
    await this.event(c, {
      kind: 'snapshot',
      sessions,
      queues: {},
      approvals: c.approval
        ? [
            {
              id: c.approval.id,
              chatId: c.id,
              sessionId: c.approval.sessionId,
              toolCallId: c.approval.toolCallId,
              toolName: 'shell',
              args: { command: 'npm test' },
              createdAt: this.now()
            }
          ]
        : [],
      questions: [],
      retries: [],
      processes: [],
      skills: [{ name: 'deploy', description: 'Publica o projeto' }],
      live: { lseq: c.lseq }
    })
  }

  // ---------------- comandos ----------------

  async onCommand(f: Record<string, unknown>): Promise<void> {
    const chatId = String(f.chat_id ?? '')
    const cmdId = String(f.cmd_id ?? '')
    const kind = String(f.kind ?? '')
    const c = this.chats.get(chatId)
    const reply = async (r: Record<string, unknown>) => {
      const env = await sealResult(this.o.sk.stream, this.o.userId, chatId, cmdId, r)
      this.o.emit({ t: 'remote.result', chat_id: chatId, cmd_id: cmdId, env })
    }
    let p: Record<string, unknown>
    try {
      p = await openCommand(this.o.sk.stream, this.o.userId, chatId, cmdId, f.env as Envelope)
    } catch {
      return reply({ status: 'rejected', error: 'comando ilegível' })
    }
    this.received.push({ kind, payload: p })
    if (!c)
      return reply({ status: 'rejected', error: 'Este chat não é ao vivo aqui.', code: 'not_live' })
    if (
      (kind.startsWith('history.') || kind.startsWith('attach.') || kind === 'chat.update') &&
      p.chatId !== chatId
    )
      return reply({ status: 'rejected', error: 'chatId diferente', code: 'invalid' })
    const base = { status: 'accepted', epoch: c.epoch, lseq: c.lseq }
    switch (kind) {
      case 'history.list':
        return reply({ ...base, ...this.list(c, p) })
      case 'history.changes': {
        const since = Number(p.since)
        if (since < c.floor) return reply({ ...base, reset: true })
        const changes = [...c.changes.entries()]
          .filter(([, l]) => l > since)
          .sort((a, b) => a[1] - b[1])
          .map(([key, lseq]) => {
            const r = c.items.get(key)!
            return { type: r.type, id: r.id, lseq, ...(r.data ? {} : { deleted: true }) }
          })
        return reply({ ...base, changes })
      }
      case 'history.item':
        return reply(this.item(c, p, base))
      case 'chat.update': {
        const cur = c.items.get(k('chat', chatId))!.data!
        const next: Record<string, unknown> = { ...cur, updatedAt: this.now() }
        if (typeof p.title === 'string') next.title = p.title
        if (p.config && typeof p.config === 'object')
          next.config = { ...(cur.config as object), ...(p.config as object) }
        this.change(chatId, [{ type: 'chat', id: chatId, data: next }])
        await this.announce(false, [chatId])
        return reply({ status: 'accepted' })
      }
      case 'attach.put':
        return reply(await this.attachPut(c, p))
      case 'attach.get':
        return reply(this.attachGet(c, p))
      case 'send':
      case 'force': {
        if (c.seenCmds.has(cmdId)) return reply({ status: 'duplicate' })
        c.seenCmds.add(cmdId)
        await reply({ status: 'accepted', queued: false })
        await this.turn(
          c,
          String(p.sessionId),
          String(p.text ?? ''),
          (p.attachments as AttachmentInfo[]) ?? []
        )
        return
      }
      case 'approval': {
        if (!c.approval || c.approval.id !== p.requestId)
          return reply({ status: 'rejected', error: 'Aprovação não encontrada.' })
        const a = c.approval
        c.approval = null
        c.pending.approvals = 0
        await reply({ status: 'accepted' })
        await this.event(c, { kind: 'approval.resolved', id: a.id })
        await this.finish(
          c,
          a.sessionId,
          p.decision === 'allow' ? 'executei: npm test' : 'não executei'
        )
        return
      }
      case 'question': {
        if (!c.question) return reply({ status: 'rejected', error: 'Pergunta não encontrada.' })
        const q = c.question
        c.question = null
        c.pending.questions = 0
        await reply({ status: 'accepted' })
        await this.event(c, { kind: 'question.resolved', id: q.id })
        await this.finish(
          c,
          q.sessionId,
          p.cancel ? 'pergunta cancelada' : 'obrigado pela resposta'
        )
        return
      }
      case 'stop':
        c.running = false
        await reply({ status: 'accepted' })
        await this.announce(false, [chatId])
        return
      case 'message.delete': {
        const r = [...c.items.values()].find((x) => x.type === 'message' && x.id === p.messageId)
        if (!r) return reply({ status: 'rejected', error: 'Mensagem não encontrada.' })
        this.change(chatId, [{ type: 'message', id: r.id, data: null }])
        return reply({ status: 'accepted' })
      }
      case 'fs.list':
        return reply({
          status: 'accepted',
          dir: '/home/host/projeto',
          root: '/home/host/projeto',
          confine: true,
          truncated: false,
          entries: [{ name: 'README.md', kind: 'file', size: 18, mtime: 1 }]
        })
      case 'fs.read': {
        const data = utf8('# Projeto ao vivo\n')
        return reply({
          status: 'accepted',
          size: data.length,
          mtime: 1,
          offset: 0,
          data: toStdB64(data)
        })
      }
      default:
        // fila, regenerar, versões, compactar, memória, subagentes… aceitos sem efeito visível
        return reply({ status: 'accepted' })
    }
  }

  private list(c: HostChat, p: Record<string, unknown>): Record<string, unknown> {
    const type = p.type as LiveItemType
    const limit = Math.min(Number(p.limit) || 200, this.o.pageMax ?? 200)
    let rows = [...c.items.values()].filter((r) => r.type === type && r.data)
    if (type === 'chat') rows = rows.filter((r) => r.id === c.id)
    if (type === 'message') rows = rows.filter((r) => r.data!.sessionId === p.sessionId)
    rows.sort((a, b) =>
      type === 'message'
        ? Number(a.data!.seq) - Number(b.data!.seq) || a.id.localeCompare(b.id)
        : Number(a.data!.createdAt) - Number(b.data!.createdAt) || a.id.localeCompare(b.id)
    )
    const after = typeof p.after === 'string' ? Number(p.after.slice(2)) : 0
    const page = rows.slice(after, after + limit)
    const max = this.o.inlineMax ?? 256 * 1024
    const next = after + page.length < rows.length ? `p:${after + page.length}` : null
    return { items: page.map((r) => this.liveItem(c, r, max)), next }
  }

  private item(
    c: HostChat,
    p: Record<string, unknown>,
    base: Record<string, unknown>
  ): Record<string, unknown> {
    const max = this.o.inlineMax ?? 256 * 1024
    if (p.piece && typeof p.piece === 'object') {
      const pc = p.piece as { type: LiveItemType; id: string; offset: number }
      const r = c.items.get(k(pc.type, pc.id))
      if (!r?.data) return { status: 'rejected', error: 'Item não existe.', code: 'missing' }
      const all = utf8(JSON.stringify(r.data))
      const chunk = this.o.chunk ?? 512 * 1024
      const part = all.subarray(pc.offset, pc.offset + chunk)
      return {
        ...base,
        piece: {
          type: pc.type,
          id: pc.id,
          lseq: c.changes.get(k(pc.type, pc.id)) ?? 0,
          total: all.length,
          offset: pc.offset,
          data: toStdB64(part)
        }
      }
    }
    const want = (p.items as { type: LiveItemType; id: string }[]) ?? []
    return {
      ...base,
      items: want.map((w) => {
        const r = c.items.get(k(w.type, w.id))
        if (!r) return { type: w.type, id: w.id, lseq: c.lseq, deleted: true }
        return this.liveItem(c, r, max)
      })
    }
  }

  private async attachPut(
    c: HostChat,
    p: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const uploadId = String(p.uploadId ?? '')
    if (p.cancel === true) {
      c.uploads.delete(uploadId)
      return { status: 'accepted', cancelled: true }
    }
    const offset = Number(p.offset)
    const size = Number(p.size)
    const sha = String(p.sha256 ?? '')
    const name = String(p.name ?? '')
    const mime = String(p.mime ?? 'application/octet-stream')
    let up = c.uploads.get(uploadId)
    if (!up) {
      if (offset !== 0) return { status: 'rejected', error: 'Envio expirou.', code: 'expired' }
      if (size > 20 * 1024 * 1024)
        return { status: 'rejected', error: 'Grande demais.', code: 'too_large' }
      const ext = name.split('.').pop()?.toLowerCase() ?? 'bin'
      const file = `${sha}.${ext}`
      if (c.files.has(file))
        return {
          status: 'accepted',
          received: size,
          done: true,
          attachment: this.info_(name, mime, size, sha, file)
        }
      up = { name, mime, size, sha256: sha, received: 0, parts: [] }
      c.uploads.set(uploadId, up)
    }
    const data = fromStdB64(String(p.data ?? ''))
    if (offset < up.received && offset + data.length <= up.received)
      return { status: 'accepted', received: up.received, done: false }
    if (offset !== up.received)
      return { status: 'rejected', error: 'offset errado', code: 'offset', received: up.received }
    up.parts.push(data)
    up.received += data.length
    if (up.received < up.size) return { status: 'accepted', received: up.received, done: false }
    const all = new Uint8Array(up.received)
    let at = 0
    for (const b of up.parts) {
      all.set(b, at)
      at += b.length
    }
    c.uploads.delete(uploadId)
    if (hex(await sha256(all)) !== up.sha256)
      return { status: 'rejected', error: 'Hash diferente.', code: 'hash' }
    const ext = up.name.split('.').pop()?.toLowerCase() ?? 'bin'
    const file = `${up.sha256}.${ext}`
    c.files.set(file, { bytes: all, mime: up.mime })
    return {
      status: 'accepted',
      received: up.size,
      done: true,
      attachment: this.info_(up.name, up.mime, up.size, up.sha256, file)
    }
  }

  private info_(
    name: string,
    mime: string,
    size: number,
    sha: string,
    file: string
  ): AttachmentInfo {
    const kind = mime.startsWith('image/')
      ? 'image'
      : mime === 'application/pdf'
        ? 'pdf'
        : mime.startsWith('audio/')
          ? 'audio'
          : 'text'
    return { name, mime, size, kind, file, sha256: sha } as AttachmentInfo
  }

  /** Põe um arquivo no store do host (anexo já citado no histórico). */
  addFile(chatId: string, file: string, bytes: Uint8Array, mime: string): void {
    this.chats.get(chatId)!.files.set(file, { bytes, mime })
  }

  private attachGet(c: HostChat, p: Record<string, unknown>): Record<string, unknown> {
    const file = String(p.file ?? '')
    const f = c.files.get(file)
    if (!f) return { status: 'rejected', error: 'Anexo não encontrado.', code: 'missing' }
    const offset = Number(p.offset) || 0
    const length = Math.min(Number(p.length) || 0, 512 * 1024)
    const part = f.bytes.subarray(offset, offset + length)
    return {
      status: 'accepted',
      file,
      size: f.bytes.length,
      ...(offset === 0 ? { mime: f.mime } : {}),
      offset,
      data: toStdB64(part)
    }
  }

  // ---------------- turno falso ----------------

  private async setStatus(c: HostChat, sid: string, status: string): Promise<void> {
    const cur = c.items.get(k('session', sid))?.data
    if (!cur) return
    this.change(c.id, [{ type: 'session', id: sid, data: { ...cur, status } }])
    await this.event(c, { kind: 'session', session: { id: sid, ...cur, status } })
  }

  private async turn(
    c: HostChat,
    sid: string,
    text: string,
    attachments: AttachmentInfo[]
  ): Promise<void> {
    const parts = attachments.length
      ? [
          { type: 'text', text },
          ...attachments.map((a) => ({
            type: a.kind === 'image' ? 'image_url' : 'file',
            ...(a.kind === 'image'
              ? { image_url: { url: `clearchat-attachment://${a.file}` } }
              : { file: { filename: a.name, file_data: `clearchat-attachment://${a.file}` } }),
            _attachment: a
          }))
        ]
      : text
    const userId = this.addMessage(c, sid, 'user', parts, this.lastMain(c))
    this.change(c.id, [c.items.get(k('message', userId))!])
    c.running = true
    await this.announce(false, [c.id])
    await this.setStatus(c, sid, 'running')
    if (text.startsWith('/tool')) {
      c.approval = { id: this.uid('ap'), sessionId: sid, toolCallId: this.uid('tc') }
      c.pending.approvals = 1
      await this.event(c, {
        kind: 'approval.requested',
        request: {
          id: c.approval.id,
          chatId: c.id,
          sessionId: sid,
          toolCallId: c.approval.toolCallId,
          toolName: 'shell',
          args: { command: 'npm test' },
          createdAt: this.now()
        }
      })
      await this.setStatus(c, sid, 'awaiting_approval')
      await this.announce(false, [c.id])
      return
    }
    if (text.startsWith('/ask')) {
      c.question = { id: this.uid('q'), sessionId: sid, toolCallId: this.uid('tc') }
      c.pending.questions = 1
      await this.event(c, {
        kind: 'question.requested',
        request: {
          id: c.question.id,
          chatId: c.id,
          sessionId: sid,
          toolCallId: c.question.toolCallId,
          questions: [
            {
              title: 'Qual cor?',
              multiple: false,
              options: [{ title: 'Azul' }, { title: 'Verde' }]
            }
          ],
          createdAt: this.now()
        }
      })
      await this.setStatus(c, sid, 'awaiting_input')
      await this.announce(false, [c.id])
      return
    }
    const answer = `ok: ${text}${attachments.length ? ` (${attachments.length} anexo${attachments.length > 1 ? 's' : ''})` : ''}`
    this.later(() => void this.finish(c, sid, answer), this.o.replyMs ?? 10)
  }

  private async finish(c: HostChat, sid: string, answer: string): Promise<void> {
    const streamId = this.uid('st')
    await this.event(c, {
      kind: 'draft.delta',
      sessionId: sid,
      streamId,
      off: { content: 0, reasoning: 0 },
      append: { content: answer }
    })
    await this.event(c, { kind: 'draft.end', sessionId: sid, streamId })
    const id = this.addMessage(c, sid, 'assistant', answer, this.lastMain(c))
    const chat = c.items.get(k('chat', c.id))!.data!
    this.change(c.id, [
      c.items.get(k('message', id))!,
      { type: 'chat', id: c.id, data: { ...chat, updatedAt: this.now() } }
    ])
    await this.setStatus(c, sid, 'idle')
    c.running = false
    await this.announce(false, [c.id])
  }

  /** Esquece as mudanças até `lseq` (o próximo `history.changes` abaixo disso → `reset`). */
  forgetChanges(chatId: string, upTo: number): void {
    const c = this.chats.get(chatId)!
    c.floor = upTo
  }

  /** Texto de uma mensagem do host (testes). */
  text(chatId: string, id: string): string | null {
    const r = this.chats.get(chatId)?.items.get(k('message', id))
    const m = r?.data?.message as { content?: unknown } | undefined
    return typeof m?.content === 'string'
      ? m.content
      : r?.data
        ? fromUtf8(utf8(JSON.stringify(m)))
        : null
  }
}
