// `voice/evalLog.ts` do desktop no celular (shim gerado em src/vendor/desktop/voice/evalLog.ts): o
// desktop grava cada decisão de preâmbulo num JSONL em disco (log de diagnóstico); no celular só o
// tipo é usado — as decisões vão para o log de desenvolvimento (nada em disco).

/** Uma decisão de preâmbulo registrada no log (= `VoiceEvalEvent` do desktop). */
export interface VoiceEvalEvent {
  /** Momento da decisão (ms desde epoch). */
  ts: number
  /** Origem da decisão (só o preâmbulo pós-turno). */
  kind: 'filler'
  /** Frase decidida: posição 1-based no pool de preâmbulos (`FILLER_<n>`). */
  variant: number
  /** Tocou de fato (false = descartada — clipe ausente, a resposta chegou antes…). */
  played: boolean
  /** Latência decisão→emissão (ms — carga do clipe incluída). */
  latencyMs: number
  /** Motivo/regra (ex.: 'delay/question', 'tools/command', 'delay/no-clip', 'delay/spoken'). */
  reason: string
}
