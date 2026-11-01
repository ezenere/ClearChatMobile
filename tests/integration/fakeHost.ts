// Host FALSO para a integração do controle remoto (SYNC_PROTOCOL.md §8, §11): um dispositivo desktop
// (can_host) conectado ao servidor REAL pelo WebSocket, que segue o HostController do desktop
// (ClearChatDesktop/src/main/sync/host.ts) o bastante para exercitar o celular: aceita
// `remote.command` (dedupe por cmd_id, exceto fs.*), executa turnos determinísticos dentro de
// janelas (`host.begin` … `host.end`), grava os registros com `chat_bases` + `host_epochs` (§8.4),
// publica o stream (snapshot + deltas com `n` contíguo, §11) e pede aprovação/questionário/retry.
// Texto do usuário: "/tool" → shell com aprovação; "/ask" → ask_user; "/retry" → falha de rede;
// "/slow" → resposta longa até parar; o resto → "ok: <texto>".
import { RealtimeClient } from '../../src/vendor/desktop/sync/ws'
import { isBranchEditable } from '../../src/vendor/shared/branches'
import type {
  ApiMessage,
  AttachmentInfo,
  ContentPart,
  QuestionAnswer,
  QueuedMessage,
  StreamDraft
} from '../../src/vendor/shared/types'
import { diffDraft, type DraftState } from '../../src/vendor/desktop/sync/stream'
import { blobIdFromSha256, decryptBlob, fromHex, hex, sha256 } from '../../src/crypto'
import { openCommand, sealResult, sealStream, type Envelope } from '../../src/remote/crypto'
import type { PushItem } from '../../src/data/types'
import { rest, sleep, URL_ } from './realServer'
import type { Desktop } from './seed'

interface Msg {
  id: string
  sessionId: string
  seq: number
  parentId: string | null
  message: ApiMessage
  meta: Record<string, unknown>
  createdAt: number
  rev: number
  blobs: string[]
}

interface Sess {
  id: string
  depth: 0 | 1
  parentSessionId: string | null
  status: string
  branchSel: Record<string, string | null>
  rev: number
  title: string
}

type Waiter<T> = { id: string; resolve: (v: T) => void }

export const EDIT_NEEDS_UPDATE =
  'Editar uma mensagem sua agora cria uma nova versão da conversa — atualize o ClearChat neste aparelho para editar.'

/** Arquivos da "raiz do chat" no host falso. */
const ROOT = '/home/host/projeto'
export const HOST_FILES: Record<string, string | null> = {
  [`${ROOT}/README.md`]: '# Projeto\n\nArquivo de teste do **host**.\n',
  [`${ROOT}/src`]: null,
  [`${ROOT}/src/main.ts`]: 'export const answer = 42\n',
  [`${ROOT}/grande.txt`]: Array.from({ length: 30000 }, (_, i) => `linha ${i} — ação`).join('\n')
}

export class FakeHost {
  readonly d: Desktop
  readonly chatId: string
  readonly mainId: string
  readonly ws: RealtimeClient
  epoch = 0
  head = 0
  private n = new Map<number, number>()
  private window: string | null = null
  private sessions = new Map<string, Sess>()
  private messages: Msg[] = []
  private chatRev = 0
  private seq = 0
  private seen = new Set<string>()
  private queue: QueuedMessage[] = []
  private turn: Promise<void> | null = null
  private stopFlag = false
  private approval: Waiter<{ decision: string; items?: unknown }> | null = null
  private question: Waiter<{ answers?: QuestionAnswer[]; cancel?: boolean }> | null = null
  private retry: Waiter<'retry' | 'cancel'> | null = null
  private draft: StreamDraft | null = null
  private draftState: DraftState | null = null
  private toolRun: { callId: string; output?: string } | null = null
  /** Comandos recebidos (kind + plaintext), na ordem. */
  readonly received: { kind: string; payload: Record<string, unknown> }[] = []
  /** Eventos de stream publicados (kind). */
  readonly published: string[] = []
  readonly skills = [{ name: 'deploy', description: 'Publica o projeto' }]
  private chain: Promise<unknown> = Promise.resolve()

  constructor(d: Desktop, chatId: string) {
    this.d = d
    this.chatId = chatId
    this.mainId = `${chatId}-main`
    this.ws = new RealtimeClient({
      url: () => URL_.replace(/^http/, 'ws') + '/ws',
      hello: async () => ({
        access_token: d.token,
        cursor: 0,
        state_cursor: 0,
        active_windows: this.window ? [{ chat_id: chatId, epoch: this.epoch }] : [],
        subscriptions: []
      }),
      onWelcome: (w) => {
        for (const s of (w.chat_states as Record<string, unknown>[]) ?? []) this.onState(s)
      },
      onEvent: (f) => this.onEvent(f),
      onState: () => undefined,
      onUnauthorized: async () => false,
      onFatal: () => undefined,
      timing: { backoffBaseMs: 100, backoffMaxMs: 500 }
    })
  }

  // ---------------- registros (§8.4) ----------------

  private async pushItems(items: PushItem[]): Promise<void> {
    const r = await rest(
      'POST',
      '/api/v1/sync/push',
      {
        push_id: crypto.randomUUID(),
        items,
        chat_bases: { [this.chatId]: this.head },
        ...(this.window ? { host_epochs: { [this.chatId]: this.epoch } } : {})
      },
      this.d.token
    )
    this.head = Number(r.chat_heads?.[this.chatId] ?? r.head ?? this.head)
  }

  private async seal(type: string, id: string, rev: number, plain: Record<string, unknown>) {
    const { sealRecord } = await import('../../src/crypto')
    return sealRecord(this.d.sk.record, this.d.userId, { type, id, scope: this.chatId, rev }, plain)
  }

  private async chatItem(): Promise<PushItem> {
    const rev = ++this.chatRev
    return {
      type: 'chat',
      id: this.chatId,
      scope: this.chatId,
      base_rev: rev - 1,
      rev,
      deleted: false,
      blobs: [],
      env: await this.seal('chat', this.chatId, rev, {
        sv: 1,
        title: 'Chat controlado pelo celular',
        config: {
          providerId: 'prov-falso',
          model: 'fake/agent',
          enabledTools: ['shell', 'ask_user', 'read_file']
        },
        mainSessionId: this.mainId,
        createdAt: 1_760_000_000_000,
        updatedAt: Date.now()
      })
    }
  }

  private async sessionItem(s: Sess): Promise<PushItem> {
    const rev = ++s.rev
    return {
      type: 'session',
      id: s.id,
      scope: this.chatId,
      base_rev: rev - 1,
      rev,
      deleted: false,
      blobs: [],
      env: await this.seal('session', s.id, rev, {
        sv: 1,
        chatId: this.chatId,
        parentSessionId: s.parentSessionId,
        parentToolCallId: null,
        depth: s.depth,
        model: 'fake/agent',
        title: s.title,
        task: null,
        status: s.status,
        createdAt: 1_760_000_000_000,
        branchSel: s.branchSel
      })
    }
  }

  private async messageItem(m: Msg): Promise<PushItem> {
    const rev = ++m.rev
    return {
      type: 'message',
      id: m.id,
      scope: this.chatId,
      base_rev: rev - 1,
      rev,
      deleted: false,
      blobs: m.blobs,
      env: await this.seal('message', m.id, rev, {
        sv: 1,
        sessionId: m.sessionId,
        seq: m.seq,
        message: m.message,
        meta: m.meta,
        createdAt: m.createdAt,
        parentId: m.parentId
      })
    }
  }

  /** Conversa inicial (replay: o desktop vira host do chat sem host). */
  async seed(): Promise<void> {
    const main: Sess = {
      id: this.mainId,
      depth: 0,
      parentSessionId: null,
      status: 'idle',
      branchSel: {},
      rev: 0,
      title: 'Principal'
    }
    const sub: Sess = {
      id: `${this.chatId}-sub`,
      depth: 1,
      parentSessionId: this.mainId,
      status: 'done',
      branchSel: {},
      rev: 0,
      title: 'Subagente de teste'
    }
    this.sessions.set(main.id, main)
    this.sessions.set(sub.id, sub)
    const u = this.newMsg(main.id, null, { role: 'user', content: 'Olá, host!' })
    const a = this.newMsg(main.id, u.id, { role: 'assistant', content: 'Olá! Pronto.' })
    const items = [await this.chatItem(), await this.sessionItem(main), await this.sessionItem(sub)]
    for (const m of [u, a]) items.push(await this.messageItem(m))
    await this.pushItems(items)
    const st = await rest('GET', '/api/v1/chat-states?since=0', undefined, this.d.token)
    for (const s of st.chat_states ?? []) this.onState(s)
  }

  private newMsg(
    sessionId: string,
    parentId: string | null,
    message: ApiMessage,
    meta: Record<string, unknown> = {},
    blobs: string[] = []
  ): Msg {
    const m: Msg = {
      id: `${this.chatId}-m${++this.seq}`,
      sessionId,
      seq: this.seq,
      parentId,
      message,
      meta,
      createdAt: Date.now(),
      rev: 0,
      blobs
    }
    this.messages.push(m)
    return m
  }

  /** Último do caminho ativo da sessão (branchSel; ausente = o filho mais novo). */
  private leaf(sessionId: string): Msg | null {
    const s = this.sessions.get(sessionId)!
    const all = this.messages.filter((m) => m.sessionId === sessionId)
    let parent: string | null = null
    let last: Msg | null = null
    for (;;) {
      const kids = all.filter((m) => m.parentId === parent)
      if (!kids.length) return last
      const key: string = parent ?? 'root'
      const pick: Msg =
        (key in s.branchSel && kids.find((k) => k.id === s.branchSel[key])) || kids.at(-1)!
      last = pick
      parent = pick.id
    }
  }

  messageById(id: string): Msg | undefined {
    return this.messages.find((m) => m.id === id)
  }

  get allMessages(): Msg[] {
    return this.messages
  }

  // ---------------- WebSocket ----------------

  start(): void {
    this.ws.start()
  }

  stop(): void {
    this.ws.stop()
  }

  private onState(s: Record<string, unknown>): void {
    if (s.chat_id !== this.chatId) return
    if (typeof s.epoch === 'number') this.epoch = s.epoch
    if (typeof s.head === 'number' && s.head > this.head) this.head = s.head
  }

  private onEvent(f: Record<string, unknown>): void {
    switch (f.t) {
      case 'chat.state':
        this.onState(f)
        return
      case 'stream.resync_request':
        void this.snapshot()
        return
      case 'remote.command':
        this.chain = this.chain.then(() => this.onCommand(f)).catch(() => undefined)
        return
    }
  }

  // ---------------- janela (§8.3) ----------------

  private async begin(purpose: 'run' | 'edit'): Promise<void> {
    if (this.window) return
    const ack = await this.ws.request('host.begin', {
      chat_id: this.chatId,
      epoch: this.epoch,
      purpose
    })
    this.epoch = Number(ack.epoch)
    if (Number(ack.head) > this.head) this.head = Number(ack.head)
    this.window = purpose
  }

  private async end(): Promise<void> {
    if (!this.window) return
    await this.ws.request('host.end', { chat_id: this.chatId, epoch: this.epoch })
    this.window = null
  }

  // ---------------- stream (§11) ----------------

  private async publish(payload: Record<string, unknown>): Promise<void> {
    const n = (this.n.get(this.epoch) ?? 0) + 1
    this.n.set(this.epoch, n)
    const env = await sealStream(
      this.d.sk.stream,
      this.d.userId,
      this.chatId,
      this.epoch,
      n,
      payload
    )
    this.ws.send('stream.event', { chat_id: this.chatId, epoch: this.epoch, n, env })
    this.published.push(String(payload.kind))
  }

  async snapshot(): Promise<void> {
    const sessions: Record<string, unknown> = {}
    for (const s of this.sessions.values())
      sessions[s.id] = {
        status: s.status,
        draft: s.id === this.mainId ? this.draft : null,
        tools:
          s.id === this.mainId && this.toolRun
            ? { [this.toolRun.callId]: { running: true, output: this.toolRun.output } }
            : {},
        compaction: null
      }
    await this.publish({
      kind: 'snapshot',
      sessions,
      queues: this.queue.length ? { [this.mainId]: this.queue } : {},
      approvals: this.approval ? [this.pendingApproval!] : [],
      questions: this.question ? [this.pendingQuestion!] : [],
      retries: this.retry ? [this.pendingRetry!] : [],
      processes: [],
      skills: this.skills
    })
  }

  private pendingApproval: Record<string, unknown> | null = null
  private pendingQuestion: Record<string, unknown> | null = null
  private pendingRetry: Record<string, unknown> | null = null

  private async setStatus(sid: string, status: string, persist = false): Promise<void> {
    const s = this.sessions.get(sid)!
    s.status = status
    await this.publish({
      kind: 'session',
      session: { id: s.id, chatId: this.chatId, depth: s.depth, status, branchSel: s.branchSel }
    })
    if (persist) await this.pushItems([await this.sessionItem(s)])
  }

  private async streamDraft(sid: string, next: StreamDraft): Promise<void> {
    this.draft = next
    const { delta, state } = diffDraft(sid, this.draftState, next)
    this.draftState = state
    if (delta) await this.publish({ kind: 'draft.delta', ...delta })
  }

  private async endDraft(sid: string): Promise<void> {
    if (this.draftState)
      await this.publish({ kind: 'draft.end', sessionId: sid, streamId: this.draftState.streamId })
    this.draft = null
    this.draftState = null
  }

  /** Resposta do assistente em pedaços; parar = parcial com `interrupted`. */
  private async answer(sid: string, parent: string, text: string, slow = false): Promise<Msg> {
    const words = slow
      ? Array.from({ length: 300 }, (_, i) => `palavra${i} `)
      : text.split(/(?<= )/)
    let content = ''
    await this.streamDraft(sid, { content: '', reasoning: 'pensando no pedido', toolCalls: [] })
    for (const w of words) {
      if (this.stopFlag) break
      content += w
      await this.streamDraft(sid, { content, reasoning: 'pensando no pedido', toolCalls: [] })
      await sleep(slow ? 120 : 60)
    }
    await this.endDraft(sid)
    const interrupted = this.stopFlag
    const m = this.newMsg(
      sid,
      parent,
      { role: 'assistant', content, reasoning: 'pensando no pedido' },
      { model: 'fake/agent', ...(interrupted ? { interrupted: true } : {}) }
    )
    await this.pushItems([await this.messageItem(m), await this.chatItem()])
    return m
  }

  // ---------------- turnos ----------------

  private async runTurn(
    sid: string,
    first: QueuedMessage | null,
    after?: string | null
  ): Promise<void> {
    await this.begin('run')
    this.stopFlag = false
    await this.setStatus(sid, 'running')
    let item: QueuedMessage | null = first
    let parentOverride = after
    for (;;) {
      let parent: string
      if (item) {
        const parts: ContentPart[] = []
        const blobs: string[] = []
        for (const a of item.attachments ?? []) {
          parts.push({
            type: 'image_url',
            image_url: { url: `clearchat-attachment://${a.file}` },
            _attachment: { name: a.name, mime: a.mime, size: a.size, kind: a.kind, file: a.file }
          })
          blobs.push(await blobIdFromSha256(this.d.sk, fromHex(a.sha256)))
        }
        if (item.text) parts.push({ type: 'text', text: item.text })
        const content = parts.length === 1 && parts[0].type === 'text' ? item.text : parts
        const u = this.newMsg(
          sid,
          parentOverride !== undefined ? parentOverride : (this.leaf(sid)?.id ?? null),
          { role: 'user', content },
          item.meta ? { ...item.meta } : {},
          blobs
        )
        if (parentOverride !== undefined) {
          const s = this.sessions.get(sid)!
          s.branchSel[parentOverride ?? 'root'] = u.id
          await this.pushItems([await this.sessionItem(s)])
        }
        parentOverride = undefined
        await this.pushItems([await this.messageItem(u)])
        parent = u.id
      } else parent = this.leaf(sid)!.id
      const text = item?.text ?? ''
      await this.script(sid, parent, text)
      // parou/forçou: o que estiver na fila vai depois (drainQueue)
      if (this.stopFlag) break
      item = this.queue.shift() ?? null
      if (!item) break
      await this.publish({ kind: 'queue', sessionId: sid, queue: this.queue })
    }
    await this.setStatus(sid, this.stopFlag ? 'interrupted' : 'done', true)
    this.stopFlag = false
    await this.end()
  }

  private async script(sid: string, parent: string, text: string): Promise<void> {
    if (text.startsWith('/tool')) {
      const callId = `call-${this.seq + 1}`
      const args = JSON.stringify({ command: 'echo remoto > saida.txt' })
      await this.streamDraft(sid, {
        content: 'Vou rodar um comando.',
        reasoning: '',
        toolCalls: [{ id: callId, name: 'shell', arguments: args }]
      })
      await this.endDraft(sid)
      const a = this.newMsg(sid, parent, {
        role: 'assistant',
        content: 'Vou rodar um comando.',
        tool_calls: [{ id: callId, type: 'function', function: { name: 'shell', arguments: args } }]
      })
      await this.pushItems([await this.messageItem(a)])
      this.pendingApproval = {
        id: `ap-${callId}`,
        chatId: this.chatId,
        sessionId: sid,
        toolCallId: callId,
        toolName: 'shell',
        args: { command: 'echo remoto > saida.txt' },
        createdAt: Date.now(),
        check: {
          item: 'commands',
          items: [
            { text: 'echo remoto', verdict: 'allow', entry: 'echo *', suggestion: 'echo *' },
            {
              text: '> saida.txt',
              verdict: 'ask',
              reason: 'redirecionamento para arquivo',
              suggestion: ''
            }
          ]
        }
      }
      await this.setStatus(sid, 'awaiting_approval')
      await this.publish({ kind: 'approval.requested', request: this.pendingApproval })
      const d = await new Promise<{ decision: string; items?: unknown }>((resolve) => {
        this.approval = { id: String(this.pendingApproval!.id), resolve }
      })
      await this.publish({ kind: 'approval.resolved', id: this.pendingApproval.id })
      this.approval = null
      this.pendingApproval = null
      await this.setStatus(sid, 'running')
      const allowed = d.decision === 'allow'
      if (allowed) {
        this.toolRun = { callId, output: 'executando…' }
        await this.publish({
          kind: 'tool',
          sessionId: sid,
          toolCallId: callId,
          running: true,
          output: 'executando…'
        })
        await sleep(300)
        await this.publish({ kind: 'tool', sessionId: sid, toolCallId: callId, running: false })
        this.toolRun = null
      }
      const t = this.newMsg(
        sid,
        a.id,
        { role: 'tool', tool_call_id: callId, content: allowed ? 'ok' : 'Negado pelo usuário.' },
        {
          toolStatus: allowed ? 'ok' : 'denied',
          approval: allowed
            ? { item: 'commands', mode: 'lists', userAllowed: ['> saida.txt'] }
            : { item: 'commands', mode: 'lists', denied: '> saida.txt' }
        }
      )
      await this.pushItems([await this.messageItem(t)])
      await this.answer(sid, t.id, allowed ? 'Comando executado.' : 'Tudo bem, não rodei.')
      return
    }
    if (text.startsWith('/ask')) {
      const callId = `call-${this.seq + 1}`
      const questions = [
        {
          title: 'Qual linguagem?',
          multiple: false,
          options: [
            { title: 'TypeScript', icon: { kind: 'lucide', name: 'code' } },
            { title: 'Python', description: 'com tipos', help: { kind: 'text', text: 'py' } }
          ]
        }
      ]
      const a = this.newMsg(sid, parent, {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: callId,
            type: 'function',
            function: { name: 'ask_user', arguments: JSON.stringify({ questions }) }
          }
        ]
      })
      await this.pushItems([await this.messageItem(a)])
      this.pendingQuestion = {
        id: `q-${callId}`,
        chatId: this.chatId,
        sessionId: sid,
        toolCallId: callId,
        questions,
        createdAt: Date.now()
      }
      await this.setStatus(sid, 'awaiting_input')
      await this.publish({ kind: 'question.requested', request: this.pendingQuestion })
      const r = await new Promise<{ answers?: QuestionAnswer[]; cancel?: boolean }>((resolve) => {
        this.question = { id: String(this.pendingQuestion!.id), resolve }
      })
      await this.publish({ kind: 'question.resolved', id: this.pendingQuestion.id })
      this.question = null
      this.pendingQuestion = null
      await this.setStatus(sid, 'running')
      const t = this.newMsg(
        sid,
        a.id,
        {
          role: 'tool',
          tool_call_id: callId,
          content: r.cancel
            ? '[O usuário não respondeu ao questionário]'
            : JSON.stringify(r.answers)
        },
        {
          askUser: {
            questions,
            outcome: r.cancel ? 'cancelled' : 'answered',
            ...(r.answers ? { answers: r.answers } : {})
          }
        }
      )
      await this.pushItems([await this.messageItem(t)])
      await this.answer(
        sid,
        t.id,
        r.cancel ? 'Sem resposta.' : `Escolhido: ${r.answers?.[0]?.selected.join(',')}`
      )
      return
    }
    if (text.startsWith('/retry')) {
      await this.streamDraft(sid, { content: 'parcial que', reasoning: '', toolCalls: [] })
      // falha de rede: o runner encerra o draft (draft null → draft.end) e abre o retry
      await this.endDraft(sid)
      this.pendingRetry = {
        id: `r-${this.seq}`,
        chatId: this.chatId,
        sessionId: sid,
        error: 'ECONNRESET',
        model: 'fake/agent',
        providerName: 'LLM falso',
        createdAt: Date.now()
      }
      await this.setStatus(sid, 'awaiting_retry')
      await this.publish({ kind: 'retry.requested', request: this.pendingRetry })
      const r = await new Promise<'retry' | 'cancel'>((resolve) => {
        this.retry = { id: String(this.pendingRetry!.id), resolve }
      })
      await this.publish({ kind: 'retry.resolved', id: this.pendingRetry.id })
      this.retry = null
      this.pendingRetry = null
      if (r === 'cancel') {
        this.stopFlag = true
        return
      }
      await this.setStatus(sid, 'running')
      await this.answer(sid, parent, 'Deu certo na segunda tentativa.')
      return
    }
    await this.answer(sid, parent, `ok: ${text || 'de novo'}`, text.startsWith('/slow'))
  }

  // ---------------- comandos (§8.6) ----------------

  private async onCommand(f: Record<string, unknown>): Promise<void> {
    const cmdId = String(f.cmd_id)
    const kind = String(f.kind)
    const reply = async (r: Record<string, unknown>) => {
      await this.ws.request('remote.result', {
        chat_id: this.chatId,
        cmd_id: cmdId,
        env: await sealResult(this.d.sk.stream, this.d.userId, this.chatId, cmdId, r)
      })
    }
    const isFs = kind.startsWith('fs.')
    if (!isFs) {
      if (this.seen.has(cmdId)) return reply({ status: 'duplicate' })
      this.seen.add(cmdId)
    }
    let p: Record<string, unknown>
    try {
      p = await openCommand(
        this.d.sk.stream,
        this.d.userId,
        String(f.chat_id),
        cmdId,
        f.env as Envelope
      )
    } catch (e) {
      return reply({ status: 'rejected', error: `comando ilegível: ${(e as Error).message}` })
    }
    if (p.kind !== kind) return reply({ status: 'rejected', error: 'kind divergente' })
    this.received.push({ kind, payload: p })
    try {
      const r = await this.execute(kind, p)
      await reply({ status: 'accepted', ...r })
    } catch (e) {
      await reply({
        status: 'rejected',
        error: (e as Error).message,
        ...((e as { code?: string }).code ? { code: (e as { code?: string }).code } : {})
      })
    }
  }

  private busy(): boolean {
    return !!this.turn
  }

  private startTurn(fn: () => Promise<void>): void {
    this.turn = fn()
      .catch((e: unknown) => console.warn('[host falso] turno falhou', (e as Error).message))
      .finally(() => {
        this.turn = null
      })
  }

  async idle(): Promise<void> {
    while (this.turn) await this.turn
  }

  private async execute(
    kind: string,
    p: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const sid = String(p.sessionId ?? this.mainId)
    switch (kind) {
      case 'send':
      case 'force': {
        if (!this.sessions.has(sid)) throw new Error('Sessão não pertence a este chat.')
        const atts = (p.attachments ?? []) as AttachmentInfo[]
        for (const a of atts) {
          const blobId = await blobIdFromSha256(this.d.sk, fromHex(a.sha256))
          const r = await fetch(`${URL_}/api/v1/blobs/${blobId}`, {
            headers: { Authorization: `Bearer ${this.d.token}` }
          })
          if (!r.ok) throw new Error('attachment_missing')
          const plain = await decryptBlob(
            this.d.sk,
            this.d.userId,
            blobId,
            new Uint8Array(await r.arrayBuffer())
          )
          if (hex(await sha256(plain)) !== a.sha256) throw new Error('attachment_missing')
        }
        const item: QueuedMessage = {
          id: `q-${crypto.randomUUID().slice(0, 8)}`,
          sessionId: sid,
          text: String(p.text ?? ''),
          createdAt: Number(p.createdAt ?? Date.now()),
          ...(atts.length ? { attachments: atts } : {})
        }
        if (this.busy()) {
          if (kind === 'force') {
            this.queue.unshift({ ...item, meta: { kind: 'forced' } as never })
            this.stopFlag = true
            await this.publish({ kind: 'queue', sessionId: sid, queue: this.queue })
            // o turno atual para e o forçado vai em seguida
            void this.turn?.then(() => this.drainQueue(sid))
            return { queued: true }
          }
          this.queue.push(item)
          await this.publish({ kind: 'queue', sessionId: sid, queue: this.queue })
          return { queued: true }
        }
        this.startTurn(() => this.runTurn(sid, item))
        return { queued: false }
      }
      case 'queue.force': {
        const i = this.queue.findIndex((q) => q.id === p.queuedId)
        if (i < 0) throw new Error('Item não está mais na fila.')
        const [it] = this.queue.splice(i, 1)
        this.queue.unshift({ ...it, meta: { kind: 'forced' } as never })
        this.stopFlag = true
        await this.publish({ kind: 'queue', sessionId: sid, queue: this.queue })
        void this.turn?.then(() => this.drainQueue(sid))
        return {}
      }
      case 'queue.remove':
        this.queue = this.queue.filter((q) => q.id !== p.queuedId)
        await this.publish({ kind: 'queue', sessionId: sid, queue: this.queue })
        return {}
      case 'stop':
        this.stopFlag = true
        this.approval?.resolve({ decision: 'deny' })
        this.question?.resolve({ cancel: true })
        this.retry?.resolve('cancel')
        return {}
      case 'stop_subagents':
        return {}
      case 'approval':
        if (!this.approval || this.approval.id !== p.requestId)
          throw new Error('Aprovação não encontrada.')
        this.approval.resolve({ decision: String(p.decision), items: p.items })
        return {}
      case 'smart_override':
        return {}
      case 'question':
        if (!this.question || this.question.id !== p.requestId)
          throw new Error('Questionário não encontrado.')
        this.question.resolve(
          p.cancel ? { cancel: true } : { answers: p.answers as QuestionAnswer[] }
        )
        return {}
      case 'retry':
        if (!this.retry || this.retry.id !== p.requestId) throw new Error('Pedido não encontrado.')
        this.retry.resolve(p.action === 'cancel' ? 'cancel' : 'retry')
        return {}
      case 'regenerate':
      case 'branch.regenerate': {
        if (this.busy()) throw new Error('A sessão está ocupada — espere o turno terminar.')
        const target =
          typeof p.messageId === 'string' ? this.messageById(p.messageId) : this.leaf(sid)
        let u = target
        while (u && !(u.message.role === 'user'))
          u = u.parentId ? this.messageById(u.parentId) : undefined
        if (!u) throw new Error('Nada para regenerar.')
        const user = u
        this.startTurn(async () => {
          await this.begin('run')
          await this.setStatus(sid, 'running')
          const a = await this.answer(
            sid,
            user.id,
            `nova versão para: ${typeof user.message.content === 'string' ? user.message.content : ''}`
          )
          const s = this.sessions.get(sid)!
          s.branchSel[user.id] = a.id
          await this.setStatus(sid, 'done', true)
          await this.end()
        })
        return {}
      }
      case 'branch.edit': {
        const m = this.messageById(String(p.messageId))
        if (!m || !isBranchEditable(m as never, 0))
          throw new Error('Só mensagens digitadas na conversa principal viram nova versão.')
        if (this.busy()) throw new Error('A sessão está ocupada — espere o turno terminar.')
        const msg = p.message as ApiMessage
        const text = msg.role === 'user' && typeof msg.content === 'string' ? msg.content : ''
        this.startTurn(() =>
          this.runTurn(
            m.sessionId,
            { id: 'edit', sessionId: m.sessionId, text, createdAt: Date.now() },
            m.parentId
          )
        )
        return {}
      }
      case 'branch.select': {
        const m = this.messageById(String(p.messageId))
        if (!m) throw new Error('Mensagem não pertence a este chat.')
        if (this.busy()) throw new Error('Não dá para trocar de versão com a sessão ocupada.')
        await this.begin('edit')
        const s = this.sessions.get(m.sessionId)!
        s.branchSel[m.parentId ?? 'root'] = m.id
        await this.pushItems([await this.sessionItem(s)])
        await this.setStatus(s.id, s.status)
        await this.end()
        return {}
      }
      case 'message.edit': {
        const m = this.messageById(String(p.messageId))
        if (!m) throw new Error('Mensagem não pertence a este chat.')
        if (isBranchEditable(m as never, 0)) throw new Error(EDIT_NEEDS_UPDATE)
        await this.begin('edit')
        m.message = p.message as ApiMessage
        await this.pushItems([await this.messageItem(m)])
        await this.end()
        return {}
      }
      case 'message.delete': {
        const m = this.messageById(String(p.messageId))
        if (!m) throw new Error('Mensagem não pertence a este chat.')
        await this.begin('edit')
        const rev = ++m.rev
        await this.pushItems([
          {
            type: 'message',
            id: m.id,
            scope: this.chatId,
            base_rev: rev - 1,
            rev,
            deleted: true,
            blobs: []
          }
        ])
        this.messages = this.messages.filter((x) => x !== m)
        await this.end()
        return {}
      }
      case 'compact':
        return { queued: true }
      case 'memory.extract':
        return {}
      case 'fs.list': {
        if (p.chatId !== this.chatId)
          throw Object.assign(new Error('Pedido inválido (chat).'), { code: 'invalid' })
        const dir = p.path ? String(p.path) : ROOT
        if (!dir.startsWith(ROOT))
          throw Object.assign(new Error('Fora da raiz do chat.'), { code: 'denied' })
        const entries = Object.entries(HOST_FILES)
          .filter(([k]) => k.slice(0, k.lastIndexOf('/')) === dir)
          .map(([k, v]) => ({
            name: k.slice(k.lastIndexOf('/') + 1),
            kind: v === null ? 'dir' : 'file',
            ...(v !== null ? { size: new TextEncoder().encode(v).length } : {}),
            mtime: 1_760_000_000_000
          }))
          .sort((a, b) =>
            a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1
          )
        return { dir, root: ROOT, confine: true, truncated: false, entries }
      }
      case 'fs.read': {
        const path = String(p.path)
        if (!path.startsWith(ROOT))
          throw Object.assign(new Error('Fora da raiz do chat.'), { code: 'denied' })
        const v = HOST_FILES[path]
        if (v === undefined || v === null)
          throw Object.assign(new Error('Arquivo não encontrado.'), { code: 'missing' })
        const bytes = new TextEncoder().encode(v)
        const off = Number(p.offset)
        const len = Math.min(Number(p.length), 512 * 1024)
        const data = Buffer.from(bytes.subarray(off, off + len)).toString('base64')
        return {
          size: bytes.length,
          mtime: 1_760_000_000_000,
          ...(off === 0 ? { mime: 'text/plain' } : {}),
          offset: off,
          data
        }
      }
    }
    throw new Error(`comando desconhecido: ${kind}`)
  }

  private async drainQueue(sid: string): Promise<void> {
    const next = this.queue.shift()
    if (!next) return
    await this.publish({ kind: 'queue', sessionId: sid, queue: this.queue })
    this.startTurn(() => this.runTurn(sid, next))
  }
}
