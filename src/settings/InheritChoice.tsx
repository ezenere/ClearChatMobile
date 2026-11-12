// Grupo de opções com herança (persona/chat) — o desenho do `InheritChoice` do desktop
// (components/ui/InheritChoice.tsx, o de `ChatApprovalSection`): só as opções REAIS, com ★ na opção
// igual ao valor herdado (da persona ou do padrão global). Sem override a ★ aparece selecionada;
// tocar na ★ remove o override (segue herdando); outra opção fixa o valor neste nível. Nunca uma
// opção "Padrão"/"herdar" separada duplicando o padrão. Regra pura em `inherit.ts`.
import Ionicons from '@expo/vector-icons/Ionicons'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { colors, radius } from '@/ui/theme'
import { inheritPick, inheritShown, inheritValueKey } from './inherit'

export interface InheritOption<T> {
  value: T
  label: string
}

export function InheritChoice<T extends string | boolean>({
  label,
  options,
  value,
  inherited,
  inheritedFrom,
  onChange,
  testID
}: {
  /** Nome acessível do grupo. */
  label: string
  options: readonly InheritOption<T>[]
  /** Override deste nível; null = herda. */
  value: T | null | undefined
  /** Valor herdado (persona/global) — a opção dele ganha ★. */
  inherited: T
  /** De onde vem o herdado ("Padrão da persona X" / "Padrão global") — leitor de tela e legenda. */
  inheritedFrom: string
  /** null = volta a herdar (tocou na ★); senão o valor explícito. */
  onChange: (v: T | null) => void
  testID?: string
}) {
  const shown = inheritShown(value ?? null, inherited)
  return (
    <View>
      <View
        style={st.seg}
        testID={testID}
        accessibilityRole="radiogroup"
        accessibilityLabel={label}
        accessibilityHint={
          value == null ? `Segue o ${inheritedFrom.replace(/^Padrão/, 'padrão')}` : undefined
        }
      >
        {options.map((o) => {
          const on = shown === o.value
          const star = inherited === o.value
          const key = inheritValueKey(o.value)
          return (
            <Pressable
              key={key}
              onPress={() => onChange(inheritPick(o.value, inherited))}
              style={[st.item, on && st.on]}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
              accessibilityLabel={star ? `${o.label} (★ ${inheritedFrom})` : o.label}
              testID={testID ? `${testID}-${key}${star ? '-star' : ''}` : undefined}
            >
              <Text style={[st.text, on && st.textOn]} numberOfLines={1}>
                {o.label}
              </Text>
              {star ? (
                <Ionicons
                  name="star"
                  size={10}
                  color={on ? colors.accentStrong : colors.subtle}
                  style={{ marginLeft: 3 }}
                />
              ) : null}
            </Pressable>
          )
        })}
      </View>
      <Text style={st.hint} testID={testID ? `${testID}-source` : undefined}>
        {value == null
          ? `★ ${inheritedFrom}`
          : `Fixado aqui — toque na ★ para seguir o ${inheritedFrom.replace(/^Padrão/, 'padrão')}`}
      </Text>
    </View>
  )
}

const st = StyleSheet.create({
  seg: {
    flexDirection: 'row',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
    padding: 3,
    gap: 3
  },
  item: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    paddingHorizontal: 4,
    borderRadius: radius.sm
  },
  on: { backgroundColor: colors.active },
  text: { color: colors.subtle, fontSize: 13, fontWeight: '500' },
  textOn: { color: colors.fg },
  hint: { color: colors.faint, fontSize: 11.5, lineHeight: 15, marginTop: 4 }
})
