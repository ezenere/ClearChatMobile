// Parâmetros que o modelo aceita (@shared/modelParams: `paramRules`) — Novo chat, personas e as
// configurações do chat. Vazio = padrão do provedor (o parâmetro não vai na request). No chat que
// herda a persona (1.10.0) cada linha ganha a marca de próprio (`wrap`) e, no raciocínio, a ★ marca
// o nível herdado — tocar nela volta a herdar (sem opção "herdar" duplicada).
import Ionicons from '@expo/vector-icons/Ionicons'
import { Fragment, type ReactNode } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { EFFORT_ORDER, PARAM_KEYS, paramRules, type ParamKey } from '@shared/modelParams'
import { providerKind } from '@shared/providerKinds'
import type { ChatParams, ModelInfo, Provider, ReasoningEffort } from '@shared/types'
import { colors, radius } from '@/ui/theme'

const PARAM_UI: Record<
  Exclude<ParamKey, 'reasoning_effort'>,
  { label: string; min: number; max: number; int?: boolean }
> = {
  temperature: { label: 'Temperature', min: 0, max: 2 },
  top_p: { label: 'Top P', min: 0, max: 1 },
  top_k: { label: 'Top K', min: 0, max: 500, int: true },
  max_tokens: { label: 'Máx. de tokens', min: 1, max: 1_000_000, int: true },
  frequency_penalty: { label: 'Frequency penalty', min: -2, max: 2 },
  presence_penalty: { label: 'Presence penalty', min: -2, max: 2 },
  repetition_penalty: { label: 'Repetition penalty', min: 0, max: 2 },
  seed: { label: 'Seed', min: 0, max: 2 ** 31, int: true }
}

export const EFFORT_LABEL: Partial<Record<ReasoningEffort, string>> = {
  none: 'nenhum',
  minimal: 'mínimo',
  low: 'baixo',
  medium: 'médio',
  high: 'alto',
  xhigh: 'muito alto',
  max: 'máximo'
}

/** Parâmetros + raciocínio do modelo. `onParam(k, undefined)` = voltar ao padrão. */
export function ParamsEditor({
  provider,
  model,
  info,
  params,
  onParam,
  wrap,
  inheritedEffort
}: {
  provider: Provider
  model: string
  info: ModelInfo | null
  params: ChatParams
  onParam: (k: ParamKey, v: number | string | undefined) => void
  /** Envolve a linha de cada parâmetro (a marca de próprio do chat). */
  wrap?: (k: ParamKey, row: ReactNode) => ReactNode
  /**
   * Raciocínio herdado da persona: a ★ vai no nível herdado; com o valor próprio, tocar na ★ volta
   * a herdar (`revert`).
   */
  inheritedEffort?: { value: ReasoningEffort | undefined; own: boolean; revert: () => void }
}) {
  const rules = paramRules({ kind: providerKind(provider), model, info })
  const wrapped = (k: ParamKey, row: ReactNode): ReactNode => (
    <Fragment key={k}>{wrap ? wrap(k, row) : row}</Fragment>
  )
  return (
    <View style={st.box}>
      {PARAM_KEYS.filter((k) => k !== 'reasoning_effort' && rules.supported.includes(k)).map(
        (k) => {
          const ui = PARAM_UI[k as Exclude<ParamKey, 'reasoning_effort'>]
          const v = params[k] as number | undefined
          return wrapped(
            k,
            <View style={st.paramRow}>
              <Text style={st.paramLabel}>{ui.label}</Text>
              <TextInput
                testID={`param-${k}`}
                value={v === undefined ? '' : String(v)}
                placeholder="padrão"
                placeholderTextColor={colors.faint}
                keyboardType="decimal-pad"
                onChangeText={(t) => {
                  const n = Number(t.replace(',', '.'))
                  if (!t.trim()) onParam(k, undefined)
                  else if (Number.isFinite(n))
                    onParam(k, Math.min(ui.max, Math.max(ui.min, ui.int ? Math.round(n) : n)))
                }}
                style={st.paramInput}
              />
            </View>
          )
        }
      )}
      {rules.effort
        ? wrapped(
            'reasoning_effort',
            <View style={{ gap: 6 }}>
              <Text style={st.paramLabel}>Raciocínio</Text>
              <View style={st.wrap}>
                {[undefined, ...EFFORT_ORDER.filter((e) => rules.effort!.levels.includes(e))].map(
                  (e) => {
                    const on = params.reasoning_effort === e
                    const star = !!inheritedEffort && inheritedEffort.value === e
                    return (
                      <Pressable
                        key={e ?? 'padrao'}
                        onPress={() =>
                          star && inheritedEffort.own
                            ? inheritedEffort.revert()
                            : onParam('reasoning_effort', e)
                        }
                        style={[st.chip, on && st.chipOn]}
                        accessibilityLabel={`${e ? (EFFORT_LABEL[e] ?? e) : 'padrão'}${star ? ' (★ herdado da persona)' : ''}`}
                        testID={`effort-${e ?? 'padrao'}${star ? '-star' : ''}`}
                      >
                        <Text style={[st.chipText, on && { color: colors.fg }]}>
                          {e ? (EFFORT_LABEL[e] ?? e) : 'padrão'}
                        </Text>
                        {star ? (
                          <Ionicons
                            name="star"
                            size={10}
                            color={on ? colors.accentStrong : colors.subtle}
                          />
                        ) : null}
                      </Pressable>
                    )
                  }
                )}
              </View>
            </View>
          )
        : null}
      {PARAM_KEYS.some((k) => !rules.supported.includes(k)) ? (
        <Text style={st.hint}>
          O modelo não aceita: {PARAM_KEYS.filter((k) => !rules.supported.includes(k)).join(', ')} —
          esses não vão na request.
        </Text>
      ) : null}
    </View>
  )
}

/** Patch de um parâmetro sobre os atuais (undefined/vazio = remove). */
export function withParam(p: ChatParams, k: ParamKey, v: number | string | undefined): ChatParams {
  const next = { ...p } as Record<string, unknown>
  if (v === undefined || v === '') delete next[k]
  else next[k] = v
  return next as ChatParams
}

const st = StyleSheet.create({
  box: {
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    padding: 12,
    gap: 10
  },
  hint: { color: colors.subtle, fontSize: 12.5, lineHeight: 18 },
  paramRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  paramLabel: { flex: 1, color: colors.fg, fontSize: 14 },
  paramInput: {
    width: 110,
    color: colors.fg,
    fontSize: 14,
    textAlign: 'right',
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderStrong
  },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border
  },
  chipOn: { backgroundColor: colors.active, borderColor: colors.accent },
  chipText: { color: colors.muted, fontSize: 13 }
})
