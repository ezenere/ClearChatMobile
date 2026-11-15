// Raciocínio na conversa (= MessageList do desktop → Reasoning/DraftView), a parte pura: o
// cabeçalho "Pensando… · N s" do rascunho — com o texto do raciocínio ou, sem texto, com o bloco de
// raciocínio da Messages API aberto (o padrão `display: "omitted"` dos Claude ≥ 4.7 manda o bloco
// vazio: só o tempo aparece, sem caixa nem expandir) — e "Raciocínio · N s" na mensagem gravada
// (`meta.reasoningMs`), mesmo sem texto. O relógio vem do espelho (`MirrorView.reasoningClocks`).
import type { StoredMessage, StreamDraft } from '@shared/types'
import { reasoningHeader, type ReasoningClock } from '@vendor/renderer/reasoning'

export interface ReasoningHeaderUi {
  /** "Pensando…" ou "Raciocínio". */
  label: string
  /** "8 s", "1,2 mil tokens"… (separados por " · "). */
  details: string[]
  /** Sem texto de raciocínio: só o cabeçalho com o tempo (sem caixa nem expandir). */
  empty: boolean
}

export interface DraftReasoningUi extends ReasoningHeaderUi {
  /** Mostra o raciocínio (o texto dele ou o relógio do bloco sem texto). */
  show: boolean
  /** Pensando agora: nada de resposta ainda e o bloco de raciocínio não fechou. */
  live: boolean
  /** O indicador "Gerando resposta…" (sem texto, sem tool call e sem "Pensando…"). */
  typing: boolean
}

/** Raciocínio do rascunho ao vivo: o que mostrar e o cabeçalho, `now` = relógio da tela. */
export function draftReasoningUi(
  draft: StreamDraft,
  clock: ReasoningClock | undefined,
  now: number
): DraftReasoningUi {
  const answering = !!draft.content || draft.toolCalls.length > 0
  // raciocínio: o texto dele ou, sem texto (bloco omitido da Messages API), o relógio
  const show = !!draft.reasoning || clock != null
  const live = show && !answering && clock?.end == null
  const h = reasoningHeader({
    live,
    elapsedMs: live && clock ? Math.max(0, now - clock.start) : undefined,
    durationMs: clock?.end != null ? clock.end - clock.start : undefined
  })
  return {
    show,
    live,
    label: h.label,
    details: h.details,
    empty: !draft.reasoning,
    typing: !answering && !live
  }
}

/** A sessão está pensando (o status "Pensando…" da tela)? */
export function draftThinking(
  draft: StreamDraft | null,
  clock: ReasoningClock | undefined
): boolean {
  return !!draft && draftReasoningUi(draft, clock, 0).live
}

/**
 * Raciocínio de uma resposta gravada: com texto (recolhível) ou só o tempo (`meta.reasoningMs` —
 * o provedor omitiu o texto). null = nada a mostrar.
 */
export function savedReasoningUi(msg: StoredMessage): ReasoningHeaderUi | null {
  const text = msg.message.role === 'assistant' ? (msg.message.reasoning ?? '') : ''
  if (!text && !((msg.meta.reasoningMs ?? 0) > 0)) return null
  const h = reasoningHeader({
    durationMs: msg.meta.reasoningMs,
    tokens: msg.meta.usage?.reasoningTokens
  })
  return { label: h.label, details: h.details, empty: !text }
}
