// Ferramentas locais no celular (SYNC_PROTOCOL.md §8.9 e §4.3.6 — "Tools de um tipo de aparelho",
// desde 1.10.0): o celular HOSPEDA chats com ferramentas locais, sem elas — só manda ao modelo as
// tools que executa (`availableTools`); as do computador ficam na lista do chat, esmaecidas na tela.
// Ao assumir um chat assim, um aviso forte (com confirmação) diz que elas ficam desligadas enquanto
// o celular for o host. A regra de "usa ferramentas locais" vem do desktop (@shared/sync, vendorado).
import { LOCAL_TOOLS, usesLocalTools as sharedUsesLocalTools } from '@shared/sync'

export { LOCAL_TOOLS }

/** `config.enabledTools` (ou as tools da chamada de voz) tem tool local, ou skills ligadas. */
export function usesLocalTools(config: Record<string, unknown> | null | undefined): boolean {
  return !!config && sharedUsesLocalTools(config)
}

/**
 * Aviso forte ao assumir (ou "Executar neste dispositivo") um chat com ferramentas locais (§8.9):
 * elas ficam desligadas enquanto o celular for o host.
 */
export function localToolsTakeoverText(
  /** `chat.hostCwd` do registro (`{ deviceId, path }`, informativo — §4.3.6). */
  hostCwd: unknown,
  hostName: string | null | undefined
): string {
  const p = hostCwd && typeof hostCwd === 'object' ? (hostCwd as { path?: unknown }).path : null
  const path = typeof p === 'string' && p ? p : null
  const host = hostName || 'computador'
  const where = path ? ` (diretório raiz ${path} no ${host})` : hostName ? ` no ${hostName}` : ''
  return `Este chat usa ferramentas locais${where}; no celular ele roda sem elas.`
}
