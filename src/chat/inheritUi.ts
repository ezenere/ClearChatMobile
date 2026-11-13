// Herança ao vivo da persona nas telas do chat (protocolo 1.10.0, §4.3.6) — a parte pura: o que a
// tela mostra (campos próprios × herdados, o valor que voltaria e de onde vem) e os patches das
// ações (voltar a herdar, trocar de persona, "Nenhuma"). Os mesmos patches valem para o registro
// local (`ChatRepo.updateChat`) e para o `chat.update` de um chat só ao vivo de outro host (§23.7):
// quem guarda o chat os interpreta com `applyChatConfigPatch`. = `panel/inherit.tsx` do desktop.
// Sem React Native.
import {
  hasOverrides,
  inheritanceActive,
  inheritedUnitValue,
  isOwn,
  ownUnits,
  personaDefines,
  withoutUnits,
  type InheritConfig,
  type InheritEnv
} from '@shared/chatInherit'
import type { PresetConfig } from '@shared/presets'
import { unitLabel, unitValueText } from '@vendor/renderer/inherit'

export { unitLabel, unitValueText }

/** "Voltar a herdar": o mapa novo sem as unidades (a cópia é recalculada por quem guarda o chat). */
export function revertPatch(
  record: Pick<InheritConfig, 'overrides'>,
  units: readonly string[]
): { overrides: Record<string, true> } {
  return { overrides: withoutUnits(record.overrides, units) }
}

/**
 * Trocar de persona (as próprias ficam); `null` = "Nenhuma" — congela os valores atuais (o null
 * vai como está: `applyChatConfigPatch` e o `chat.update` do §23.7 o tratam como "nenhuma").
 */
export function personaPatch(presetId: string | null): Partial<InheritConfig> {
  return { presetId: presetId as string }
}

export interface InheritView {
  /** A herança vale aqui (persona existente neste aparelho + `overrides`). */
  active: boolean
  presetId: string | null
  personaName: string | null
  /** Chat antigo (cópia da persona, sem `overrides`) — migra na próxima sincronização. */
  legacy: boolean
  /** `presetId` de uma persona que não existe neste aparelho. */
  missing: boolean
  /** Unidades próprias conhecidas. */
  own: string[]
  isOwn: (unit: string) => boolean
  /** Valor que a unidade teria herdando. */
  inherited: (unit: string) => unknown
  /** Texto curto do valor herdado. */
  inheritedText: (unit: string) => string
  /** De onde vem o herdado. */
  source: (unit: string) => string
}

/**
 * O que a tela do chat mostra sobre a herança: `record` = o registro (próprios + cópia +
 * `overrides`); `persona` = a de `presetId` NESTE aparelho (null = sem persona ou não existe aqui).
 */
export function inheritView(
  record: InheritConfig,
  persona: { name: string; config: PresetConfig } | null,
  env: InheritEnv,
  providerName?: (id: string) => string | null
): InheritView {
  const presetId = record.presetId ?? null
  const active = !!persona && inheritanceActive(record, persona.config)
  const name = persona?.name || (persona ? 'Persona' : null)
  const inherited = (u: string): unknown =>
    active ? inheritedUnitValue(record, u, persona!.config, env) : undefined
  return {
    active,
    presetId,
    personaName: name,
    legacy: !!presetId && !!persona && !hasOverrides(record),
    missing: !!presetId && !persona,
    own: active ? ownUnits(record) : [],
    isOwn: (u) => active && isOwn(record, u),
    inherited,
    inheritedText: (u) => unitValueText(u, inherited(u), providerName),
    source: (u) =>
      active && personaDefines(persona!.config, u)
        ? `persona “${name}”`
        : `padrão de “Novos chats” (a persona “${name}” não define)`
  }
}

/** "1 campo é" / "N campos são" deste chat. */
export function ownCountText(n: number): string {
  return n === 1 ? '1 campo é deste chat' : `${n} campos são deste chat`
}
