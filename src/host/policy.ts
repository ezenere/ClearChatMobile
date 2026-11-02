// Regras do host no celular (SYNC_PROTOCOL.md §8.9): o celular recusa hospedar chats com
// ferramentas locais. Cópia da regra do desktop (`usesLocalTools` em src/main/sync/records.ts, que
// não é vendorável por depender do banco) — mover para src/shared no desktop e vendorar.
import type { ToolName } from '@shared/types'

export const LOCAL_TOOLS: readonly string[] = [
  'list_dir',
  'read_file',
  'search_files',
  'find_files',
  'write_file',
  'edit_file',
  'shell',
  'process_start',
  'process_logs',
  'process_list',
  'process_stop'
]

/** `config.enabledTools` (ou as tools da chamada de voz) tem tool local, ou skills ligadas. */
export function usesLocalTools(config: Record<string, unknown> | null | undefined): boolean {
  if (!config) return false
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : []
  const voice = (config.voice ?? {}) as { tools?: { enabledTools?: unknown } | null }
  const tools = [...list(config.enabledTools), ...list(voice?.tools?.enabledTools)]
  const skills = (config.skills ?? {}) as { enabled?: unknown }
  return (
    tools.some((t) => LOCAL_TOOLS.includes(t === 'bash' ? 'shell' : t)) || skills?.enabled === true
  )
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
