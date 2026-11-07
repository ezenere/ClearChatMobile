// Barras do pé da tela de ponta a ponta: o próprio elemento (o botão principal, o composer) é a
// área de baixo — sem caixa com borda por cima de uma faixa de outra cor — e a cor dele desce até a
// borda da tela, cobrindo o recuo da barra de gestos / home indicator (useSafeAreaInsets, Android e
// iOS). Com o teclado aberto esse recuo não existe mais: ele encolhe junto com a animação do teclado
// (react-native-keyboard-controller), então a barra encosta no teclado sem faixa vazia e sem pulo.
import Ionicons from '@expo/vector-icons/Ionicons'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller'
import Animated, { useAnimatedStyle } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { IconName } from './Button'
import { keyboardAwareInset } from './insets'
import { colors, spacing } from './theme'

/**
 * Espaço do recuo inferior (barra de gestos / home indicator) no fim de uma barra do pé da tela,
 * com a cor de quem o contém. Some, animado com o teclado, quando o teclado abre.
 */
export function BottomInset({ extra = 0 }: { extra?: number }) {
  const insets = useSafeAreaInsets()
  const { progress } = useReanimatedKeyboardAnimation()
  const bottom = insets.bottom
  const style = useAnimatedStyle(() => ({
    height: extra + keyboardAwareInset(bottom, progress.value)
  }))
  return <Animated.View style={style} pointerEvents="none" />
}

/** Botão principal no pé da tela: a barra inteira é o botão (roxa, sem borda nem cantos). */
export function BottomBarButton({
  title,
  onPress,
  icon,
  loading,
  disabled,
  testID
}: {
  title: string
  onPress?: () => void
  icon?: IconName
  loading?: boolean
  disabled?: boolean
  testID?: string
}) {
  const inactive = !!disabled || !!loading
  const fg = disabled && !loading ? 'rgba(255,255,255,0.55)' : colors.onAccent
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled: inactive, busy: !!loading }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        st.bar,
        {
          backgroundColor:
            disabled && !loading ? BAR_DISABLED : pressed ? BAR_PRESSED : colors.accent
        }
      ]}
    >
      <View style={st.row}>
        {loading ? (
          <ActivityIndicator size="small" color={colors.onAccent} />
        ) : icon ? (
          <Ionicons name={icon} size={19} color={fg} />
        ) : null}
        <Text numberOfLines={1} style={[st.text, { color: fg }]}>
          {title}
        </Text>
      </View>
      <BottomInset />
    </Pressable>
  )
}

/** Roxo do botão sobre o fundo escuro: pressionado e desativado (sem transparência, que mostraria o que está atrás). */
const BAR_PRESSED = '#7c4ee6'
const BAR_DISABLED = '#45306f'

/** Altura da área tocável do botão (acima do recuo inferior). */
export const BOTTOM_BAR_HEIGHT = 56

const st = StyleSheet.create({
  bar: { alignSelf: 'stretch' },
  row: {
    height: BOTTOM_BAR_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg
  },
  text: { fontSize: 16, fontWeight: '600', letterSpacing: 0.1 }
})
