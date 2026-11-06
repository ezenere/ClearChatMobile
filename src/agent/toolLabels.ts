// Rótulo curto (pt-BR) de qualquer tool: as do desktop (TOOL_LABELS vendorado) e as só do celular
// (localização).
import { TOOL_LABELS } from '@shared/tools'
import type { ToolName } from '@shared/types'
import { LOCATION_TOOL_HELP, LOCATION_TOOL_LABELS, isLocationTool } from '@/location/service'

export const toolLabel = (name: string): string =>
  isLocationTool(name) ? LOCATION_TOOL_LABELS[name] : (TOOL_LABELS[name as ToolName] ?? name)

/** Explicação de uma linha das tools do celular que têm uma (lista de tools da tela). */
export const locationToolHelp = (name: string): string | undefined =>
  isLocationTool(name) ? LOCATION_TOOL_HELP[name] : undefined
