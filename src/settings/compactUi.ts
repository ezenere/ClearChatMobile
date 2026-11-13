// Tools compactadas (protocolo 1.11.0, @shared/compactTools) nas telas do celular — a parte pura
// (sem React Native): o tipo da config que decide como uma tool vai e a linha de estado de
// "Enviar tools compactadas". As peças visuais ficam em `ToolsSend.tsx`.
import { compactToolsOn, sendsCompact } from '@shared/compactTools'
import type { ChatConfig } from '@shared/types'

/** O que decide como uma tool vai (o chat/persona; na chamada de voz, o do chat). */
export type CompactCfg = Pick<ChatConfig, 'toolsCompact' | 'toolsFull'> & {
  nativeTools?: boolean
}

/** Linha de estado da compactação sobre as tools ligadas que o celular manda. */
export function compactStatusText(cfg: CompactCfg, sent: readonly string[]): string {
  if (!compactToolsOn(cfg)) return 'Desligado: todas vão completas, sem search_tool nem instrução.'
  const n = sent.filter((t) => sendsCompact(t, cfg)).length
  if (!n) return 'Todas as ligadas vão completas (sem search_tool nem instrução).'
  return `${n === 1 ? '1 das ligadas vai compacta' : `${n} das ligadas vão compactas`} (+ search_tool e uma instrução curta no fim do system prompt).`
}
