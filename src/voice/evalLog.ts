// `voice/evalLog.ts` do desktop no celular (shim gerado em src/vendor/desktop/voice/evalLog.ts): o
// desktop grava as decisões de filler/interjeição num JSONL em disco (calibração do modo sombra);
// no celular só o tipo é usado — as decisões vão para o log de desenvolvimento (nada em disco).

/** Uma decisão de ato de fala registrada no log de avaliação (= `VoiceEvalEvent` do desktop). */
export interface VoiceEvalEvent {
  ts: number
  kind: 'interjection' | 'filler'
  class: string
  variant: number
  played: boolean
  shadow: boolean
  speechMs: number | null
  pauseMs: number | null
  tail: string | null
  latencyMs: number
  reason: string
}
