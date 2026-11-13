// Repositório do conteúdo de um chat hospedado no celular: lê do cache (LocalStore) e grava pela
// ContentWriter (cache na hora + outbox). Mesma semântica de árvore/versões dos repos do desktop
// (ClearChatDesktop/src/main/repo.ts: append/branch/addSibling/select/remove), com `parentId`
// sempre explícito e `branchSel` sempre enviado (§4.3.7–4.3.8). Sem React Native.
import {
  activeLeaf,
  activePath,
  buildTree,
  pruneSel,
  selectionToReach,
  selEquals,
  selKey,
  type BranchSel
} from '@shared/branches'
import { newInheritingChatConfig, type InheritConfig } from '@shared/chatInherit'
import type {
  ApiMessage,
  Chat,
  ChatConfig,
  MessageMeta,
  Session,
  SessionStatus,
  StoredMessage
} from '@shared/types'
import { chatFromPlain, sessionFromPlain } from '@/data/decode'
import {
  chatRecordFrom,
  effectiveOf,
  inheritEnvOf,
  patchedRecord,
  presetConfigOf
} from '@/data/inherit'
import type { ChatStorage, LocalStore } from '@/data/store'
import type { Plain } from '@/data/types'
import type { ContentWriter } from './writer'

/** `meta` local → registro (§4.3.8: o marcador de chamada vai como `memory-extraction`). */
export function metaToWire(meta: MessageMeta): MessageMeta {
  if (meta.kind === 'voice-call' && meta.voiceCall)
    return { ...meta, kind: 'memory-extraction' } as MessageMeta
  return meta
}

export function messagePlain(m: StoredMessage, prev?: Plain | null): Plain {
  return {
    ...(prev ?? {}),
    sv: 1,
    sessionId: m.sessionId,
    seq: m.seq,
    message: m.message,
    meta: metaToWire(m.meta),
    createdAt: m.createdAt,
    parentId: m.parentId ?? null
  }
}

export function sessionPlain(s: Session, prev?: Plain | null): Plain {
  const out: Plain = {
    ...(prev ?? {}),
    sv: 1,
    chatId: s.chatId,
    parentSessionId: s.parentSessionId,
    parentToolCallId: s.parentToolCallId,
    depth: s.depth,
    model: s.model,
    providerId: s.providerId,
    title: s.title,
    task: s.task,
    status: s.status,
    createdAt: s.createdAt,
    branchSel: s.branchSel ?? {}
  }
  if (!('memory' in out)) out.memory = null
  return out
}

export interface MessageRemoval {
  message: StoredMessage
  reparented: StoredMessage[]
  selChanged: boolean
}

export class ChatRepo {
  constructor(
    private readonly store: LocalStore,
    private readonly writer: ContentWriter,
    private readonly now: () => number = Date.now,
    private readonly uuid: () => string = () => crypto.randomUUID()
  ) {}

  // ---------------- chat ----------------

  /**
   * Chat com a config EFETIVA (herança ao vivo da persona, protocolo 1.10.0 — §4.3.6): os valores
   * próprios do registro e, nas unidades herdadas, os da persona e de "Novos chats" deste aparelho
   * lidos agora. É o que roda (agente, subagentes, compactação, memória, voz) e o que a tela mostra;
   * `config.overrides` vai junto. O registro gravado é `record`.
   */
  chat(chatId: string): Chat | null {
    const p = this.store.getPlain('chat', chatId)
    if (!p) return null
    const c = chatFromPlain(chatId, p)
    return {
      id: chatId,
      title: c.title,
      config: effectiveOf(this.store, chatRecordFrom(this.store, c.config)),
      mainSessionId: c.mainSessionId,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt
    }
  }

  /** Registro do chat (próprios + cópia das herdadas + `overrides`), normalizado; null = não existe. */
  record(chatId: string): InheritConfig | null {
    const p = this.store.getPlain('chat', chatId)
    return p ? chatRecordFrom(this.store, chatFromPlain(chatId, p).config) : null
  }

  /** Grava a `config` inteira do registro (sem `cwd`, local do aparelho — §4.4). */
  writeRecord(chatId: string, config: InheritConfig, extra: Plain = {}): void {
    const { cwd: _cwd, ...rest } = config
    void _cwd
    this.writer.writeChatConfig(chatId, rest as Plain, extra)
  }

  /** Cria o chat (registro + sessão principal) — o push leva o chat antes do conteúdo. */
  createChat(input: {
    config: Partial<ChatConfig>
    title?: string
    /** "Só neste aparelho" (§23.10): nada do chat vai ao servidor. Padrão: online. */
    storage?: ChatStorage
  }): {
    chat: Chat
    session: Session
  } {
    const chatId = this.uuid()
    const now = this.now()
    // o modo vem ANTES da primeira escrita (a outbox nunca vê um chat só deste aparelho)
    if (input.storage && input.storage !== 'online') this.store.setStorage(chatId, input.storage)
    const { cwd: _cwd, ...config } = this.newConfig(input.config)
    void _cwd
    const sid = this.uuid()
    this.writer.writeChat(
      chatId,
      {},
      {
        sv: 1,
        title: input.title ?? '',
        config,
        mainSessionId: sid,
        createdAt: now,
        updatedAt: now,
        hostCwd: null
      }
    )
    const session: Session = {
      id: sid,
      chatId,
      parentSessionId: null,
      parentToolCallId: null,
      depth: 0,
      model: typeof config.model === 'string' ? config.model : '',
      providerId: null,
      title: 'Principal',
      task: null,
      status: 'idle',
      createdAt: now,
      branchSel: {}
    }
    this.writer.write(chatId, [{ type: 'session', id: sid, plain: sessionPlain(session) }])
    return { chat: this.chat(chatId)!, session }
  }

  /**
   * Config de um chat novo (§4.3.6): com uma persona que existe aqui, o chat HERDA ao vivo —
   * `overrides` = os enviados ou, sem eles, as unidades em que a config do formulário difere do
   * valor efetivo da persona (o que o usuário mudou e o que o celular desliga para poder rodar:
   * tools locais, skills); a `config` sai completa (cópia das herdadas). A voz só vai se vier (cada
   * campo herda a persona ao vivo). Sem persona (ou persona que não existe aqui): como veio, sem
   * `overrides` — a migração decide quando ela chegar.
   */
  private newConfig(input: Partial<InheritConfig>): Partial<InheritConfig> {
    const persona = presetConfigOf(this.store, input.presetId)
    if (input.presetId && persona)
      return newInheritingChatConfig(
        { ...input, cwd: '', presetId: input.presetId },
        persona,
        inheritEnvOf(this.store)
      )
    const { overrides: _ov, ...rest } = input
    void _ov
    return rest
  }

  /**
   * Título/config. A config é um patch com a semântica da herança (@shared/chatInherit →
   * `applyChatConfigPatch`): sem `overrides` = edição (as unidades tocadas viram próprias); com
   * `overrides` = como enviado (voltar a herdar); `presetId` = trocar de persona (null = congelar).
   * Grava o REGISTRO (a cópia das herdadas não é regravada numa edição comum).
   */
  updateChat(
    chatId: string,
    patch: {
      title?: string
      config?: Partial<InheritConfig> & { presetId?: string | null }
      updatedAt?: boolean
    }
  ): void {
    const p: Plain = patch.updatedAt === false ? {} : { updatedAt: this.now() }
    if (patch.title !== undefined) p.title = patch.title
    if (!patch.config) {
      this.writer.writeChat(chatId, p)
      return
    }
    const record = this.record(chatId)
    if (!record) return
    const { cwd: _c, ...cfg } = patch.config
    void _c
    this.writeRecord(chatId, patchedRecord(this.store, record, cfg), p)
  }

  /** Ordem da lista (§4.3.6: o host reenvia o `chat` a cada mensagem). */
  touch(chatId: string): void {
    this.writer.writeChat(chatId, { updatedAt: this.now() })
  }

  // ---------------- sessões ----------------

  sessions(chatId: string): Session[] {
    return this.store.sessionsOf(chatId)
  }

  session(id: string): Session | null {
    const p = this.store.getPlain('session', id)
    return p ? sessionFromPlain(id, p) : null
  }

  private saveSession(s: Session): Session {
    const prev = this.store.getPlain('session', s.id)
    this.writer.write(s.chatId, [{ type: 'session', id: s.id, plain: sessionPlain(s, prev) }])
    return s
  }

  setStatus(id: string, status: SessionStatus): Session | null {
    const s = this.session(id)
    if (!s || s.status === status) return s
    return this.saveSession({ ...s, status })
  }

  /** Campo `memory` do registro `session` (snapshot do índice + lastExtractedSeq, §4.3.7). */
  sessionMemory(id: string): unknown {
    return this.store.getPlain('session', id)?.memory ?? null
  }

  setSessionMemory(id: string, memory: unknown): void {
    const prev = this.store.getPlain('session', id)
    const s = prev ? sessionFromPlain(id, prev) : null
    if (!s) return
    const plain = sessionPlain(s, prev)
    plain.memory = memory ?? null
    this.writer.write(s.chatId, [{ type: 'session', id, plain }])
  }

  /** Subsessão nova (delegate_task): registro `session` com depth/modelo/provedor fixados. */
  createSession(input: Omit<Session, 'id' | 'createdAt' | 'branchSel'>): Session {
    const s: Session = { ...input, id: this.uuid(), createdAt: this.now(), branchSel: {} }
    this.writer.write(s.chatId, [{ type: 'session', id: s.id, plain: sessionPlain(s) }])
    return s
  }

  /** Apaga sessões (subsessões órfãs) com as mensagens delas. */
  deleteSessions(chatId: string, ids: string[]): void {
    const items: { type: 'session' | 'message'; id: string; plain: Plain | null }[] = []
    for (const id of ids) {
      for (const m of this.listAll(id)) items.push({ type: 'message', id: m.id, plain: null })
      items.push({ type: 'session', id, plain: null })
    }
    if (items.length) this.writer.write(chatId, items)
  }

  setBranchSel(id: string, sel: BranchSel): Session | null {
    const s = this.session(id)
    if (!s) return null
    return this.saveSession({ ...s, branchSel: sel })
  }

  // ---------------- mensagens ----------------

  listAll(sessionId: string): StoredMessage[] {
    return this.store.sessionMessages(sessionId)
  }

  path(sessionId: string): StoredMessage[] {
    return activePath(this.listAll(sessionId), this.session(sessionId)?.branchSel ?? {})
  }

  get(id: string): StoredMessage | null {
    return this.store.message(id)
  }

  private nextSeq(sessionId: string): number {
    let max = 0
    for (const m of this.listAll(sessionId)) if (m.seq > max) max = m.seq
    return max + 1
  }

  private saveMessages(chatId: string, msgs: StoredMessage[], session?: Session | null): void {
    const items: { type: 'session' | 'message'; id: string; plain: Plain | null }[] = msgs.map(
      (m) => ({
        type: 'message',
        id: m.id,
        plain: messagePlain(m, this.store.getPlain('message', m.id))
      })
    )
    if (session)
      items.push({
        type: 'session',
        id: session.id,
        plain: sessionPlain(session, this.store.getPlain('session', session.id))
      })
    this.writer.write(chatId, items)
  }

  /**
   * Acrescenta no fim. Pai = `parentId` explícito (null = raiz) ou a folha do caminho ativo. Um
   * `null` na seleção sob esse pai (ramo novo do regenerate) é limpo — a mensagem vira o caminho.
   */
  append(
    sessionId: string,
    message: ApiMessage,
    meta: MessageMeta = {},
    parentId?: string | null
  ): StoredMessage {
    const s = this.session(sessionId)
    if (!s) throw new Error('Sessão não encontrada.')
    const all = this.listAll(sessionId)
    const tree = buildTree(all)
    const sel = { ...(s.branchSel ?? {}) }
    let parent: string | null
    if (parentId === undefined) parent = activeLeaf(tree, sel)?.id ?? null
    else {
      if (parentId !== null && !tree.byId.has(parentId))
        throw new Error(`Mensagem pai não encontrada na sessão: ${parentId}`)
      parent = parentId
    }
    const msg: StoredMessage = {
      id: this.uuid(),
      sessionId,
      seq: this.nextSeq(sessionId),
      parentId: parent,
      message,
      meta,
      createdAt: this.now()
    }
    const k = selKey(parent)
    let session: Session | null = null
    if (Object.prototype.hasOwnProperty.call(sel, k) && sel[k] === null) {
      delete sel[k]
      session = { ...s, branchSel: sel }
    }
    // mensagem + sessão no MESMO lote (§4.3.7)
    this.saveMessages(s.chatId, [msg], session)
    return msg
  }

  /** Novo ramo: filho de `parentId` (irmã das versões existentes), já selecionado. */
  branch(
    sessionId: string,
    parentId: string | null,
    message: ApiMessage,
    meta: MessageMeta = {}
  ): StoredMessage {
    const s = this.session(sessionId)
    if (!s) throw new Error('Sessão não encontrada.')
    const all = this.listAll(sessionId)
    if (parentId !== null && !all.some((m) => m.id === parentId))
      throw new Error(`Mensagem pai não encontrada na sessão: ${parentId}`)
    const msg: StoredMessage = {
      id: this.uuid(),
      sessionId,
      seq: this.nextSeq(sessionId),
      parentId,
      message,
      meta,
      createdAt: this.now()
    }
    const tree = buildTree([...all, msg])
    const sel = s.branchSel ?? {}
    const next = pruneSel(tree, selectionToReach(tree, sel, msg.id))
    this.saveMessages(s.chatId, [msg], selEquals(sel, next) ? null : { ...s, branchSel: next })
    return msg
  }

  addSibling(messageId: string, message: ApiMessage, meta: MessageMeta = {}): StoredMessage {
    const cur = this.get(messageId)
    if (!cur) throw new Error(`Mensagem não encontrada: ${messageId}`)
    const parent = buildTree(this.listAll(cur.sessionId)).parentOf.get(messageId) ?? null
    return this.branch(cur.sessionId, parent, message, meta)
  }

  /** Troca de versão: seleção mínima para o caminho passar por `messageId`. */
  select(messageId: string): Session {
    const cur = this.get(messageId)
    if (!cur) throw new Error(`Mensagem não encontrada: ${messageId}`)
    const s = this.session(cur.sessionId)
    if (!s) throw new Error('Sessão não encontrada.')
    const tree = buildTree(this.listAll(cur.sessionId))
    const sel = s.branchSel ?? {}
    const next = pruneSel(tree, selectionToReach(tree, sel, messageId))
    if (selEquals(sel, next)) return s
    return this.saveSession({ ...s, branchSel: next })
  }

  /**
   * Insere em `seq` deslocando as seguintes (+1) — fronteira da compactação antes das mensagens
   * pendentes (= insertAt do desktop): a nova fica com a mãe da 1ª pendente e passa a ser a mãe
   * dela; a seleção que apontava para a pendente passa para a nova. Tudo no mesmo lote.
   */
  insertAt(
    sessionId: string,
    seq: number,
    message: ApiMessage,
    meta: MessageMeta = {}
  ): { message: StoredMessage; shifted: StoredMessage[]; selChanged: boolean } {
    const s = this.session(sessionId)
    if (!s) throw new Error('Sessão não encontrada.')
    const all = this.listAll(sessionId)
    const tree = buildTree(all)
    const sel = { ...(s.branchSel ?? {}) }
    const pending0 = all.find((m) => m.seq === seq) ?? null
    const parent = pending0
      ? (tree.parentOf.get(pending0.id) ?? null)
      : (activeLeaf(tree, sel)?.id ?? null)
    const msg: StoredMessage = {
      id: this.uuid(),
      sessionId,
      seq,
      parentId: parent,
      message,
      meta,
      createdAt: this.now()
    }
    const shifted = all
      .filter((m) => m.seq >= seq)
      .map((m) => ({
        ...m,
        seq: m.seq + 1,
        // a mãe efetiva vira explícita (a derivada mudaria com o deslocamento)
        parentId: pending0 && m.id === pending0.id ? msg.id : (tree.parentOf.get(m.id) ?? null)
      }))
    let selChanged = false
    if (pending0) {
      const k = selKey(parent)
      if (sel[k] === pending0.id) {
        sel[k] = msg.id
        selChanged = true
      }
    }
    this.saveMessages(s.chatId, [msg, ...shifted], selChanged ? { ...s, branchSel: sel } : null)
    return { message: msg, shifted, selChanged }
  }

  update(id: string, message: ApiMessage, meta?: MessageMeta): StoredMessage {
    const cur = this.get(id)
    if (!cur) throw new Error(`Mensagem não encontrada: ${id}`)
    const s = this.session(cur.sessionId)
    if (!s) throw new Error('Sessão não encontrada.')
    const next = { ...cur, message, meta: meta ?? cur.meta }
    this.saveMessages(s.chatId, [next])
    return next
  }

  /**
   * Apaga uma mensagem: os filhos passam para a mãe dela e a seleção é ajustada para o caminho
   * continuar o mesmo, sem a apagada (igual ao desktop).
   */
  remove(id: string): MessageRemoval | null {
    const cur = this.get(id)
    if (!cur) return null
    const s = this.session(cur.sessionId)
    if (!s) return null
    const all = this.listAll(cur.sessionId)
    const tree = buildTree(all)
    const sel = s.branchSel ?? {}
    const oldLeaf = activeLeaf(tree, sel)
    const parent = tree.parentOf.get(id) ?? null
    const kids = new Set((tree.children.get(id) ?? []).map((k) => k.id))
    const reparented = all.filter((m) => kids.has(m.id)).map((m) => ({ ...m, parentId: parent }))
    const rest = all
      .filter((m) => m.id !== id)
      .map((m) => (kids.has(m.id) ? { ...m, parentId: parent } : m))
    const tree2 = buildTree(rest)
    let next: BranchSel = { ...sel }
    const pk = selKey(parent)
    const has = Object.prototype.hasOwnProperty.call(next, id)
    const inner = has ? next[id] : undefined
    delete next[id]
    if (next[pk] === id) {
      if (inner === undefined) delete next[pk]
      else next[pk] = inner
    }
    const target = oldLeaf && oldLeaf.id !== id ? oldLeaf.id : parent
    if (target) next = selectionToReach(tree2, next, target)
    next = pruneSel(tree2, next)
    const selChanged = !selEquals(sel, next)
    const items: { type: 'session' | 'message'; id: string; plain: Plain | null }[] = [
      ...reparented.map((m) => ({
        type: 'message' as const,
        id: m.id,
        plain: messagePlain(m, this.store.getPlain('message', m.id))
      })),
      { type: 'message', id, plain: null }
    ]
    if (selChanged)
      items.push({
        type: 'session',
        id: s.id,
        plain: sessionPlain({ ...s, branchSel: next }, this.store.getPlain('session', s.id))
      })
    this.writer.write(s.chatId, items)
    return { message: cur, reparented, selChanged }
  }
}
