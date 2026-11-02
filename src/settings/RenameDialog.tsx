// Diálogo "renomear" (este aparelho, outro dispositivo da conta): até 64 caracteres.
import { useState } from 'react'
import { useAction } from '@/account/react'
import { Button } from '@/ui/Button'
import { Dialog } from '@/ui/Dialog'
import { TextField } from '@/ui/TextField'

export function RenameDialog({
  title,
  initial,
  onSave,
  onClose,
  hint = 'Aparece na lista de dispositivos da conta.'
}: {
  title: string
  initial: string
  onSave: (name: string) => Promise<void>
  onClose: () => void
  hint?: string
}) {
  const [name, setName] = useState(initial)
  const { busy, error, run } = useAction()
  return (
    <Dialog
      visible
      withInput
      title={title}
      onClose={onClose}
      actions={
        <>
          <Button
            title="Cancelar"
            variant="secondary"
            full={false}
            style={{ flex: 1 }}
            onPress={onClose}
          />
          <Button
            testID="rename-save"
            title="Salvar"
            full={false}
            style={{ flex: 1 }}
            loading={busy}
            disabled={!name.trim()}
            onPress={() =>
              void run(async () => {
                await onSave(name)
                onClose()
              })
            }
          />
        </>
      }
    >
      <TextField
        testID="rename-input"
        value={name}
        onChangeText={(v) => setName(v.slice(0, 64))}
        icon="phone-portrait-outline"
        autoFocus
        error={error}
        hint={hint}
      />
    </Dialog>
  )
}
