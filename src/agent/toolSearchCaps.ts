// Falhas lembradas da busca nativa de tools NESTE celular (protocolo 1.12.0, §4.4 — setting LOCAL
// `toolSearchCaps`, NUNCA sincronizado; = `src/main/toolSearchCaps.ts` do desktop). Fica no
// KeyValueStore do aparelho (o mesmo das marcas locais que sobrevivem ao logout), como JSON. Uma
// recusa do modo nativo só é lembrada (24 h, por provedor+modelo) quando a repetição na versão local
// deu certo (runner). Sem React Native.
import {
  TOOL_SEARCH_CAPS_SETTING,
  normalizeToolSearchCaps,
  withFailure,
  type NativeToolSearchMode,
  type ToolSearchCaps
} from '@shared/toolSearch'

/** Chave/valor do aparelho (o `kv` da conta no app; nos testes, em memória ou a tabela `meta`). */
export interface DeviceKv {
  get(key: string): string | null
  set(key: string, value: string | null): void
}

export class ToolSearchCapsStore {
  private listeners = new Set<() => void>()

  constructor(
    private readonly kv: DeviceKv,
    private readonly now: () => number = Date.now
  ) {}

  /** As falhas lembradas (leitura tolerante: valor inválido = nenhuma). */
  get = (): ToolSearchCaps => {
    try {
      const raw = this.kv.get(TOOL_SEARCH_CAPS_SETTING)
      return normalizeToolSearchCaps(raw ? JSON.parse(raw) : null)
    } catch {
      return {}
    }
  }

  /** Lembra a recusa do modo nativo (e tira as vencidas). */
  markFailure(
    providerId: string,
    model: string,
    mode: NativeToolSearchMode,
    error: string
  ): ToolSearchCaps {
    const at = this.now()
    const next = withFailure(this.get(), providerId, model, { mode, failedAt: at, error }, at)
    this.kv.set(TOOL_SEARCH_CAPS_SETTING, JSON.stringify(next))
    for (const fn of this.listeners) fn()
    return next
  }

  /** Avisa quando uma falha é lembrada (as telas de tools recalculam o modo). */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }
}
