// Toast curto (confirmações como "Copiado"): provider no layout raiz + useToast().
import Ionicons from '@expo/vector-icons/Ionicons'
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import Animated, { FadeInDown, FadeOutDown } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { colors, radius, spacing, toneColors, type Tone } from './theme'

interface ToastMsg {
  id: number
  text: string
  tone: Tone
}

const Ctx = createContext<(text: string, tone?: Tone) => void>(() => undefined)

export const useToast = () => useContext(Ctx)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<ToastMsg | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const seq = useRef(0)
  const insets = useSafeAreaInsets()
  const show = useCallback((text: string, tone: Tone = 'success') => {
    if (timer.current) clearTimeout(timer.current)
    setMsg({ id: ++seq.current, text, tone })
    timer.current = setTimeout(() => setMsg(null), 2600)
  }, [])
  return (
    <Ctx.Provider value={show}>
      {children}
      {msg ? (
        <Animated.View
          key={msg.id}
          entering={FadeInDown.duration(180)}
          exiting={FadeOutDown.duration(160)}
          pointerEvents="none"
          style={[styles.wrap, { bottom: insets.bottom + spacing.xl }]}
        >
          <View style={styles.toast} accessibilityLiveRegion="polite">
            <Ionicons
              name={msg.tone === 'success' ? 'checkmark-circle' : 'information-circle'}
              size={18}
              color={toneColors[msg.tone].fg}
            />
            <Text style={styles.text}>{msg.text}</Text>
          </View>
        </Animated.View>
      ) : null}
    </Ctx.Provider>
  )
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: colors.active,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    maxWidth: '90%'
  },
  text: { color: colors.fg, fontSize: 14, fontWeight: '500' }
})
