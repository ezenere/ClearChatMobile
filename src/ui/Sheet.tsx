// Folha inferior (bottom sheet) no tema do app: desliza de baixo, fundo escurecido que fecha ao
// tocar, alça, título opcional e área segura embaixo. Conteúdo longo rola dentro da folha.
import Ionicons from '@expo/vector-icons/Ionicons'
import type { ReactNode } from 'react'
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle
} from 'react-native'
import { KeyboardAvoidingView } from 'react-native-keyboard-controller'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { IconName } from './Button'
import { colors, radius } from './theme'

export function Sheet({
  visible,
  onClose,
  title,
  subtitle,
  children,
  scroll = true,
  maxHeight = '86%',
  testID,
  footer
}: {
  visible: boolean
  onClose: () => void
  title?: string
  subtitle?: string
  children: ReactNode
  /** Conteúdo dentro de um ScrollView (padrão). */
  scroll?: boolean
  maxHeight?: `${number}%` | number
  testID?: string
  /** Fixo embaixo (botões). */
  footer?: ReactNode
}) {
  const insets = useSafeAreaInsets()
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}
    >
      <View style={st.root}>
        <Pressable style={st.backdrop} onPress={onClose} accessibilityLabel="Fechar" />
        <KeyboardAvoidingView behavior="padding" style={{ maxHeight }}>
          <View style={[st.sheet, { paddingBottom: insets.bottom + 10 }]} testID={testID}>
            <View style={st.handle} />
            {title ? (
              <View style={st.head}>
                <Text style={st.title} numberOfLines={2} accessibilityRole="header">
                  {title}
                </Text>
                {subtitle ? (
                  <Text style={st.subtitle} numberOfLines={3}>
                    {subtitle}
                  </Text>
                ) : null}
              </View>
            ) : null}
            {scroll ? (
              <ScrollView
                style={{ flexGrow: 0 }}
                contentContainerStyle={st.body}
                keyboardShouldPersistTaps="handled"
              >
                {children}
              </ScrollView>
            ) : (
              <View style={st.body}>{children}</View>
            )}
            {footer ? <View style={st.footer}>{footer}</View> : null}
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  )
}

/** Linha de ação de uma folha (ícone + rótulo + detalhe opcional). */
export function SheetItem({
  icon,
  label,
  detail,
  onPress,
  danger,
  disabled,
  testID,
  right,
  style
}: {
  icon: IconName
  label: string
  detail?: string
  onPress: () => void
  danger?: boolean
  disabled?: boolean
  testID?: string
  right?: ReactNode
  style?: StyleProp<ViewStyle>
}) {
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        st.item,
        pressed && { backgroundColor: colors.hover },
        disabled && { opacity: 0.4 },
        style
      ]}
    >
      <Ionicons name={icon} size={20} color={danger ? colors.danger : colors.muted} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[st.itemText, danger && { color: colors.danger }]}>{label}</Text>
        {detail ? (
          <Text style={st.itemDetail} numberOfLines={2}>
            {detail}
          </Text>
        ) : null}
      </View>
      {right}
    </Pressable>
  )
}

const st = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.55)'
  },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    borderBottomWidth: 0
  },
  handle: {
    alignSelf: 'center',
    width: 38,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.borderStrong,
    marginTop: 8,
    marginBottom: 6
  },
  head: { paddingHorizontal: 20, paddingTop: 6, paddingBottom: 8, gap: 3 },
  title: { color: colors.fg, fontSize: 16.5, fontWeight: '600' },
  subtitle: { color: colors.subtle, fontSize: 12.5, lineHeight: 17 },
  body: { paddingHorizontal: 12, paddingBottom: 6 },
  footer: { flexDirection: 'row', gap: 10, paddingHorizontal: 16, paddingTop: 8 },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 10,
    paddingVertical: 13,
    borderRadius: 12
  },
  itemText: { color: colors.fg, fontSize: 15.5 },
  itemDetail: { color: colors.subtle, fontSize: 12 }
})
