// Regras do host no celular (SYNC_PROTOCOL.md §8.9): o celular recusa hospedar chats com
// ferramentas locais. A regra vem do desktop (@shared/sync, vendorado).
import type { ToolName } from '@shared/types'
import { LOCAL_TOOLS, usesLocalTools as sharedUsesLocalTools } from '@shared/sync'

export { LOCAL_TOOLS }

/** `config.enabledTools` (ou as tools da chamada de voz) tem tool local, ou skills ligadas. */
export function usesLocalTools(config: Record<string, unknown> | null | undefined): boolean {
  return !!config && sharedUsesLocalTools(config)
}

/** Tools locais ligadas (para o texto que explica a recusa). */
export function localToolsOf(config: Record<string, unknown> | null | undefined): ToolName[] {
  const tools = Array.isArray(config?.enabledTools) ? (config.enabledTools as string[]) : []
  return tools
    .map((t) => (t === 'bash' ? 'shell' : t))
    .filter((t) => LOCAL_TOOLS.includes(t)) as ToolName[]
}

export const LOCAL_TOOLS_REFUSAL =
  'Este chat usa ferramentas locais (arquivos, shell, processos ou skills) — o celular não executa esse tipo de chat. Execute-o num computador.'
