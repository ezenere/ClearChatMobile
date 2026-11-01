// Ações de uma mensagem (toque longo → folha): copiar, selecionar texto, editar no lugar
// (`message.edit` — nunca a mensagem digitada na principal, §8.6), editar como nova versão
// (`branch.edit`), apagar (`message.delete`), regenerar (`branch.regenerate`) e, num erro no fim
// do caminho, tentar de novo / compactar e tentar de novo.
import * as Clipboard from 'expo-clipboard'
import { useState } from 'react'
import { StyleSheet, Text, TextInput, View } from 'react-native'
import { isBranchEditable } from '@shared/branches'
import { contentText } from '@shared/attachments'
import type { ApiMessage, ContentPart, StoredMessage } from '@shared/types'
import { Button } from '@/ui/Button'
import { ConfirmDialog } from '@/ui/Dialog'
import { Sheet, SheetItem } from '@/ui/Sheet'
import { useToast } from '@/ui/Toast'
import { colors } from '@/ui/theme'

/** Texto editável da mensagem (só o que o usuário/modelo escreveu; anexos e skills ficam). */
export function editableText(m: ApiMessage): string {
  if (m.role === 'assistant') return m.content ?? ''
  if (m.role === 'tool') return ''
  if (typeof m.content === 'string') return m.content
  return m.content
    .filter((p) => p.type === 'text' && !p._attachment && !p._skill)
    .map((p) => (p as { text: string }).text)
    .join('\n')
}

/** A mesma mensagem com o texto trocado (anexos, skills e campos privados preservados). */
export function withText(m: ApiMessage, text: string): ApiMessage {
  if (m.role === 'assistant') return { ...m, content: text }
  if (m.role === 'tool') return m
  if (typeof m.content === 'string') return { ...m, content: text } as ApiMessage
  const parts: ContentPart[] = []
  let placed = false
  for (const p of m.content) {
    if (p.type === 'text' && !p._attachment && !p._skill) {
      if (!placed) parts.push({ ...p, text })
      placed = true
      continue
    }
    parts.push(p)
  }
  if (!placed) parts.push({ type: 'text', text })
  return { ...m, content: parts } as ApiMessage
}

export interface MessageActionHandlers {
  editInPlace: (msg: StoredMessage, message: ApiMessage) => Promise<boolean>
  editBranch: (msg: StoredMessage, message: ApiMessage) => Promise<boolean>
  remove: (msg: StoredMessage) => Promise<boolean>
  regenerate: (msg: StoredMessage) => Promise<boolean>
  compactRetry: () => Promise<boolean>
}

export function MessageActionsSheet({
  msg,
  depth,
  canAct,
  canRegenerate,
  trailingError,
  onClose,
  h
}: {
  msg: StoredMessage | null
  depth: number
  /** Host online e sessão ociosa: dá para mudar o conteúdo. */
  canAct: string | null
  canRegenerate: boolean
  trailingError: boolean
  onClose: () => void
  h: MessageActionHandlers
}) {
  const toast = useToast()
  const [editing, setEditing] = useState<{ msg: StoredMessage; branch: boolean } | null>(null)
  const [draft, setDraft] = useState('')
  const [selecting, setSelecting] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<StoredMessage | null>(null)
  const [busy, setBusy] = useState(false)
  const text = msg ? editableText(msg.message) || contentText(msg.message.content as never) : ''
  const branch = !!msg && isBranchEditable(msg, depth)
  const role = msg?.message.role
  const editable = !!msg && (role === 'assistant' || role === 'user') && msg.meta.kind !== 'error'
  const run = async (fn: () => Promise<boolean>) => {
    setBusy(true)
    const ok = await fn()
    setBusy(false)
    return ok
  }
  const disabledNote = canAct ?? undefined
  return (
    <>
      <Sheet
        visible={!!msg}
        onClose={onClose}
        title="Mensagem"
        subtitle={disabledNote}
        testID="message-actions"
      >
        {msg ? (
          <>
            {text ? (
              <SheetItem
                icon="copy-outline"
                label="Copiar"
                onPress={() => {
                  void Clipboard.setStringAsync(text).then(() => toast('Copiado'))
                  onClose()
                }}
                testID="msg-action-copy"
              />
            ) : null}
            {text ? (
              <SheetItem
                icon="text-outline"
                label="Selecionar texto"
                onPress={() => {
                  setSelecting(text)
                  onClose()
                }}
                testID="msg-action-select"
              />
            ) : null}
            {editable && branch ? (
              <SheetItem
                icon="git-branch-outline"
                label="Editar como nova versão"
                detail="A atual continua salva (‹ › para alternar) e o turno roda de novo no host."
                disabled={!!canAct}
                onPress={() => {
                  setDraft(editableText(msg.message))
                  setEditing({ msg, branch: true })
                  onClose()
                }}
                testID="msg-action-edit-branch"
              />
            ) : null}
            {editable && !branch ? (
              <SheetItem
                icon="create-outline"
                label="Editar"
                detail="Muda o texto no lugar, sem rodar de novo."
                disabled={!!canAct}
                onPress={() => {
                  setDraft(editableText(msg.message))
                  setEditing({ msg, branch: false })
                  onClose()
                }}
                testID="msg-action-edit"
              />
            ) : null}
            {canRegenerate && role === 'assistant' ? (
              <SheetItem
                icon="refresh-outline"
                label="Regenerar resposta"
                detail="Cria uma nova versão; a atual continua salva."
                disabled={!!canAct}
                onPress={() => {
                  onClose()
                  void h.regenerate(msg)
                }}
                testID="msg-action-regenerate"
              />
            ) : null}
            {trailingError && msg.meta.kind === 'error' ? (
              <>
                <SheetItem
                  icon="refresh-outline"
                  label="Tentar de novo"
                  disabled={!!canAct}
                  onPress={() => {
                    onClose()
                    void h.regenerate(msg)
                  }}
                  testID="msg-action-retry"
                />
                <SheetItem
                  icon="layers-outline"
                  label="Compactar e tentar de novo"
                  detail="Para erros de contexto excedido."
                  disabled={!!canAct}
                  onPress={() => {
                    onClose()
                    void h.compactRetry()
                  }}
                  testID="msg-action-compact-retry"
                />
              </>
            ) : null}
            <SheetItem
              icon="trash-outline"
              label="Apagar mensagem"
              danger
              disabled={!!canAct}
              onPress={() => {
                setDeleting(msg)
                onClose()
              }}
              testID="msg-action-delete"
            />
          </>
        ) : null}
      </Sheet>
      <Sheet
        visible={!!editing}
        onClose={() => !busy && setEditing(null)}
        title={editing?.branch ? 'Editar como nova versão' : 'Editar mensagem'}
        subtitle={
          editing?.branch
            ? 'Envia como nova versão — a atual continua salva.'
            : 'O texto muda no lugar, no host e em todos os aparelhos.'
        }
        footer={
          <>
            <Button
              title="Cancelar"
              variant="secondary"
              full={false}
              style={{ flex: 1 }}
              onPress={() => setEditing(null)}
            />
            <Button
              title={editing?.branch ? 'Enviar como nova versão' : 'Salvar'}
              full={false}
              style={{ flex: 1.4 }}
              loading={busy}
              disabled={
                !draft.trim() ||
                draft === editableText(editing?.msg.message ?? { role: 'user', content: '' })
              }
              testID="edit-save"
              onPress={() => {
                if (!editing) return
                const m = withText(editing.msg.message, draft)
                void run(() =>
                  editing.branch ? h.editBranch(editing.msg, m) : h.editInPlace(editing.msg, m)
                ).then((ok) => ok && setEditing(null))
              }}
            />
          </>
        }
      >
        <TextInput
          testID="edit-input"
          value={draft}
          onChangeText={setDraft}
          multiline
          autoFocus
          style={st.input}
          textAlignVertical="top"
        />
      </Sheet>
      <Sheet visible={!!selecting} onClose={() => setSelecting(null)} title="Selecionar texto">
        <View style={{ padding: 8 }}>
          <Text selectable style={st.select}>
            {selecting}
          </Text>
        </View>
      </Sheet>
      <ConfirmDialog
        visible={!!deleting}
        title="Apagar mensagem?"
        message="A mensagem some no host e em todos os seus aparelhos. Não dá para desfazer."
        confirmLabel="Apagar"
        destructive
        busy={busy}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (!deleting) return
          void run(() => h.remove(deleting)).then(() => setDeleting(null))
        }}
      />
    </>
  )
}

const st = StyleSheet.create({
  input: {
    color: colors.fg,
    fontSize: 15,
    lineHeight: 21,
    minHeight: 120,
    maxHeight: 320,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 12,
    padding: 12,
    margin: 4,
    backgroundColor: colors.bg
  },
  select: { color: colors.fg, fontSize: 15, lineHeight: 22 }
})
