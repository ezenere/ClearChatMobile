// Diálogo no tema do app (o AlertDialog nativo do Android segue o tema claro do sistema).
import type { ReactNode } from 'react'
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native'
import { Button } from './Button'
import { colors, radius, spacing } from './theme'

export function Dialog({
  visible,
  title,
  children,
  onClose,
  actions,
  withInput
}: {
  visible: boolean
  title: string
  children?: ReactNode
  onClose: () => void
  actions: ReactNode
  /** Tem campo de texto: fica no alto da tela para o teclado não cobrir (o Modal é outra janela). */
  withInput?: boolean
}) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}
    >
      <Pressable
        style={[styles.bg, withInput && styles.bgTop]}
        onPress={onClose}
        accessibilityLabel="Fechar"
      >
        <Pressable style={styles.box} onPress={() => undefined} accessible={false}>
          <Text style={styles.title} accessibilityRole="header">
            {title}
          </Text>
          {typeof children === 'string' ? <Text style={styles.text}>{children}</Text> : children}
          <View style={styles.actions}>{actions}</View>
        </Pressable>
      </Pressable>
    </Modal>
  )
}

/** Confirmação simples (ex.: "Sair da conta?"). */
export function ConfirmDialog({
  visible,
  title,
  message,
  confirmLabel,
  onConfirm,
  onClose,
  destructive,
  busy
}: {
  visible: boolean
  title: string
  message: string
  confirmLabel: string
  onConfirm: () => void
  onClose: () => void
  destructive?: boolean
  busy?: boolean
}) {
  return (
    <Dialog
      visible={visible}
      title={title}
      onClose={onClose}
      actions={
        <>
          <Button
            title="Cancelar"
            variant="secondary"
            full={false}
            style={styles.action}
            onPress={onClose}
            testID="dialog-cancel"
          />
          <Button
            title={confirmLabel}
            variant={destructive ? 'danger' : 'primary'}
            full={false}
            style={styles.action}
            loading={busy}
            onPress={onConfirm}
            testID="dialog-confirm"
          />
        </>
      }
    >
      {message}
    </Dialog>
  )
}

const styles = StyleSheet.create({
  bg: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.62)',
    justifyContent: 'center',
    padding: spacing.xl
  },
  bgTop: { justifyContent: 'flex-start', paddingTop: '22%' },
  box: {
    backgroundColor: colors.elevated,
    borderRadius: radius.xl,
    padding: spacing.xl,
    gap: spacing.lg,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    width: '100%',
    maxWidth: 480,
    alignSelf: 'center'
  },
  title: { color: colors.fg, fontSize: 18, fontWeight: '600' },
  text: { color: colors.muted, fontSize: 15, lineHeight: 22 },
  actions: { flexDirection: 'row', gap: spacing.sm },
  action: { flex: 1 }
})
