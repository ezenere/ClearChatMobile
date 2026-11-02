// MemoryService no celular — a mesma API de ClearChatDesktop/src/main/memory/service.ts (o shim
// `src/vendor/desktop/memory/service.ts` reexporta daqui para a extração vendorada): repositório
// (MemoryStore do desktop sobre o índice local), resolução da config do chat, snapshot do índice por
// sessão (token caching) e preview. Diferença: o estado por sessão (snapshot + lastExtractedSeq) fica
// no campo `memory` do registro `session` (§4.3.7) — sincronizado de propósito: o próximo host
// continua com o mesmo prefixo e não re-extrai. Gravar esse estado é conteúdo do chat (janela).
import { DEFAULT_MEMORY_HELP_PROMPT } from '@shared/defaults'
import type { MemoryPreview } from '@shared/memory'
import type { Chat, Session } from '@shared/types'
import { activeMemory, type ActiveMemory } from '@vendor/desktop/memory/config'
import { indexGroups, renderIndex, type RenderOptions } from '@vendor/desktop/memory/render'
import type { MemoryStore } from '@vendor/desktop/memory/store'

/** Estado de memória da sessão (registro `session`, campo `memory`). */
export interface SessionMemoryState {
  /** Snapshot do índice: tirado no 1º request; renovado em compactação / "Atualizar memória". */
  snapshot?: { at: number; key: string; index: string }
  /** Maior seq já considerado por uma extração bem-sucedida. */
  lastExtractedSeq?: number
}

/** O que a memória acrescenta à request (system prompt). */
export interface MemoryPromptParts {
  index: string | null
  help: string | null
  /** Quando o snapshot usado foi tirado (null = índice atual, ainda não congelado). */
  snapshotAt: number | null
}

/** Leitura/gravação do campo `memory` do registro `session` (o ChatRepo). */
export interface SessionMemoryIO {
  read(sessionId: string): unknown
  write(sessionId: string, state: SessionMemoryState | null): void
}

export class MemoryService {
  constructor(
    private readonly storeOf: () => MemoryStore,
    private readonly io: SessionMemoryIO,
    private readonly now: () => number = Date.now
  ) {}

  get store(): MemoryStore {
    return this.storeOf()
  }

  active(chat: Pick<Chat, 'config'>, session: Pick<Session, 'depth'>): ActiveMemory {
    return activeMemory(this.store, chat, session)
  }

  /** Índice atual (sem snapshot) das coleções ativas. */
  renderIndex(am: ActiveMemory, opts: RenderOptions = {}): string {
    return renderIndex(indexGroups(this.store, am), opts)
  }

  // ---------------- estado por sessão ----------------

  readState(sessionId: string): SessionMemoryState {
    const v = this.io.read(sessionId)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as SessionMemoryState) : {}
  }

  writeState(sessionId: string, patch: Partial<SessionMemoryState>): SessionMemoryState {
    const next = { ...this.readState(sessionId), ...patch }
    for (const k of Object.keys(next) as (keyof SessionMemoryState)[])
      if (next[k] === undefined) delete next[k]
    this.io.write(sessionId, Object.keys(next).length ? next : null)
    return next
  }

  /** Snapshot salvo ainda válido (mesma chave de config)? */
  private validSnapshot(
    sessionId: string | undefined,
    am: ActiveMemory
  ): SessionMemoryState['snapshot'] | null {
    if (!sessionId) return null
    const s = this.readState(sessionId).snapshot
    return s && s.key === am.key && typeof s.index === 'string' ? s : null
  }

  /**
   * Partes do system prompt (só sessão principal com memória ativa; senão null — nada vai).
   * Usa o snapshot da sessão se válido; senão o índice atual (sem gravar — ver ensureSnapshot).
   */
  promptParts(
    chat: Pick<Chat, 'config'>,
    session: Pick<Session, 'depth'> & { id?: string }
  ): MemoryPromptParts | null {
    const am = this.active(chat, session)
    if (!am.active || !am.main) return null
    const snap = this.validSnapshot(session.id, am)
    const cfg = am.config
    return {
      index: snap ? snap.index : this.renderIndex(am),
      help: cfg.helpPrompt.enabled ? (cfg.helpPrompt.text ?? DEFAULT_MEMORY_HELP_PROMPT) : null,
      snapshotAt: snap ? snap.at : null
    }
  }

  /** Antes de cada chamada da sessão principal: tira o snapshot se não houver (ou se a config mudou). */
  ensureSnapshot(chat: Pick<Chat, 'config'>, session: Pick<Session, 'id' | 'depth'>): void {
    const am = this.active(chat, session)
    if (!am.active || !am.main) return
    if (this.validSnapshot(session.id, am)) return
    this.writeState(session.id, {
      snapshot: { at: this.now(), key: am.key, index: this.renderIndex(am) }
    })
  }

  /** Compactação: o próximo request tira um snapshot novo. */
  clearSnapshot(sessionId: string): void {
    if (this.readState(sessionId).snapshot) this.writeState(sessionId, { snapshot: undefined })
  }

  /** "Atualizar memória": renova o snapshot agora (memória inativa → limpa). */
  refreshSnapshot(chat: Pick<Chat, 'config'>, session: Pick<Session, 'id' | 'depth'>): void {
    this.clearSnapshot(session.id)
    this.ensureSnapshot(chat, session)
  }

  /** O que vai para a API na próxima request desta sessão. */
  preview(chat: Pick<Chat, 'config'>, session: Pick<Session, 'id' | 'depth'>): MemoryPreview {
    const am = this.active(chat, session)
    const parts = this.promptParts(chat, session)
    return {
      active: am.active,
      index: parts?.index ?? null,
      help: parts?.help ?? null,
      tools: am.tools,
      snapshotAt: parts?.snapshotAt ?? null
    }
  }
}
