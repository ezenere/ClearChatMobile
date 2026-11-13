// Rótulo curto (pt-BR) de qualquer tool: as do desktop (TOOL_LABELS vendorado) e as só do celular
// (localização) — `toolLabel` de @shared/deviceTools (o desktop usa o mesmo).
import { isPhoneTool, PHONE_TOOL_HELP } from '@shared/deviceTools'

export { toolLabel } from '@shared/deviceTools'

/** Explicação de uma linha das tools do celular que têm uma (lista de tools da tela). */
export const locationToolHelp = (name: string): string | undefined =>
  isPhoneTool(name) ? PHONE_TOOL_HELP[name] : undefined
