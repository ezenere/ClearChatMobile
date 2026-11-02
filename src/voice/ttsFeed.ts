// `voice/elevenlabsStream.ts` do desktop no celular (shim gerado em
// src/vendor/desktop/voice/elevenlabsStream.ts). O desktop usa o WebSocket multi-contexto da
// ElevenLabs (texto em streaming) na chamada; ele depende de `Buffer` e de headers no construtor do
// WebSocket do Node. No celular a fala da chamada vai por HTTP POR FRASE (REST da ElevenLabs ou
// `/audio/speech`) — a chamada só precisa do TIPO do gancho (`ttsFeed` ausente = só o `synth`).

/** Ganchos de texto da chamada para um TTS de entrada em streaming (= desktop). */
export interface TtsTextFeed {
  begin(): void
  partial(text: string): void
  cut(sentence: string): void
  end?(): void
  reset(): void
  close(): void
}
