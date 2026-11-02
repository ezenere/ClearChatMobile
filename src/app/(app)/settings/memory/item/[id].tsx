// Configurações → Memórias → memória (= detalhe do desktop): título, resumo e detalhes (tópicos:
// adicionar, editar, subir/descer, remover — até o limite), "Sempre carregar", mover para outra
// coleção da mesma categoria, origem (quem atualizou, quando), substitui/substituída e apagar.
// Cada mudança vira revisão do registro `memory` com `updatedBy: 'user'`.
import Ionicons from '@expo/vector-icons/Ionicons'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useState } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import type { MemoryPatch } from '@shared/memory'
import {
  canAddFact,
  cleanField,
  MEMORY_LIMITS,
  memoryDate,
  moveFact,
  moveTargets,
  removeFact,
  replaceFact,
  UPDATED_BY_LABEL
} from '@vendor/renderer/memory'
import { describeError } from '@/account/errors'
import { store } from '@/data/native'
import { Counter } from '@/settings/memoryUi'
import { readAt, settings, useSettingsVersion } from '@/settings/react'
import { FieldLabel, Note, SettingsScreen } from '@/settings/ui'
import { Button, TextButton } from '@/ui/Button'
import { Banner, Card, ToggleRow } from '@/ui/Card'
import { ConfirmDialog } from '@/ui/Dialog'
import { useToast } from '@/ui/Toast'
import { colors, radius, spacing } from '@/ui/theme'

/** Campo que edita no lugar: toque → caixa de texto com contador; salvar/cancelar. */
function InlineEdit({
  value,
  max,
  required,
  multiline,
  placeholder,
  onSave,
  testID,
  big
}: {
  value: string
  max: number
  required?: boolean
  multiline?: boolean
  placeholder?: string
  onSave: (v: string) => boolean
  testID?: string
  big?: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(value)
  const v = cleanField(text, max, required)
  if (!editing)
    return (
      <Pressable
        onPress={() => {
          setText(value)
          setEditing(true)
        }}
        style={st.inline}
        accessibilityRole="button"
        testID={testID}
      >
        <Text style={[big ? st.title : st.body, !value && { color: colors.faint }]}>
          {value || placeholder}
        </Text>
        <Ionicons name="pencil-outline" size={14} color={colors.faint} />
      </Pressable>
    )
  return (
    <View style={{ gap: 6 }}>
      <TextInput
        testID={testID ? `${testID}-input` : undefined}
        value={text}
        onChangeText={setText}
        autoFocus
        multiline={multiline}
        placeholder={placeholder}
        placeholderTextColor={colors.faint}
        style={[st.input, big && { fontSize: 17, fontWeight: '600' }]}
      />
      <View style={st.editRow}>
        <Counter text={text} max={max} />
        <View style={{ flex: 1 }} />
        <TextButton title="Cancelar" tone="muted" onPress={() => setEditing(false)} />
        <TextButton
          title="Salvar"
          disabled={v === null}
          onPress={() => {
            if (v === null) return
            if (v === value.trim() || onSave(v)) setEditing(false)
          }}
          testID={testID ? `${testID}-save` : undefined}
        />
      </View>
    </View>
  )
}

export default function MemoryItem() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const toast = useToast()
  const version = useSettingsVersion()
  const { m, cols, all } = readAt(version, () => {
    try {
      return { m: settings.memory(id), cols: settings.collections(), all: settings.memories() }
    } catch {
      return { m: null, cols: [], all: [] }
    }
  })
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState('')
  const [editingFact, setEditingFact] = useState<number | null>(null)
  const [factText, setFactText] = useState('')
  const [confirm, setConfirm] = useState(false)

  if (!m)
    return (
      <SettingsScreen title="Memória">
        <Banner tone="warning">Esta memória não existe mais (pode ter sido apagada).</Banner>
      </SettingsScreen>
    )

  const col = cols.find((c) => c.id === m.collectionId)
  const supersedes = m.supersedesId ? all.find((x) => x.id === m.supersedesId) : undefined
  const supersededBy = all.find((x) => x.supersedesId === m.id)
  const chatTitle = m.updatedByChatId ? (store.chatSummary(m.updatedByChatId)?.title ?? null) : null
  const targets = moveTargets(m, cols)

  const save = (patch: MemoryPatch): boolean => {
    try {
      settings.updateMemory(m.id, patch)
      setError(null)
      return true
    } catch (e) {
      setError(describeError(e))
      return false
    }
  }
  const addFact = () => {
    const f = cleanField(adding, MEMORY_LIMITS.fact, true)
    if (f === null || !canAddFact(m.facts)) return
    if (save({ facts: [...m.facts, f] })) setAdding('')
  }
  const openMem = (mid: string) =>
    router.push({ pathname: '/settings/memory/item/[id]', params: { id: mid } })

  return (
    <SettingsScreen title={col?.name ?? 'Memória'} testID="screen-memory-item">
      <InlineEdit
        value={m.title}
        max={MEMORY_LIMITS.title}
        required
        big
        onSave={(title) => save({ title })}
        testID="memory-title"
      />
      <Text style={st.meta} testID="memory-updated">
        Última atualização: {memoryDate(m.updatedAt)} · {UPDATED_BY_LABEL[m.updatedBy]}
        {chatTitle ? ` · no chat “${chatTitle}”` : ''}
      </Text>
      {error ? <Banner tone="danger">{error}</Banner> : null}

      {supersedes || supersededBy || m.supersedesId ? (
        <Card>
          {m.supersedesId ? (
            <Text style={st.body}>
              Substitui:{' '}
              {supersedes ? (
                <Text style={st.link} onPress={() => openMem(supersedes.id)}>
                  {supersedes.title}
                </Text>
              ) : (
                <Text style={{ color: colors.faint }}>memória apagada</Text>
              )}
            </Text>
          ) : null}
          {supersededBy ? (
            <Text style={st.body}>
              Substituída por:{' '}
              <Text style={st.link} onPress={() => openMem(supersededBy.id)}>
                {supersededBy.title}
              </Text>{' '}
              — onde as duas coleções estão ativas, o modelo vê só a substituta.
            </Text>
          ) : null}
        </Card>
      ) : null}

      <FieldLabel>Resumo</FieldLabel>
      <InlineEdit
        value={m.summary}
        max={MEMORY_LIMITS.summary}
        multiline
        placeholder="Sem resumo — toque para escrever"
        onSave={(summary) => save({ summary })}
        testID="memory-summary"
      />

      <FieldLabel
        right={
          <Text style={[st.meta, !canAddFact(m.facts) && { color: colors.warning }]}>
            {m.facts.length}/{MEMORY_LIMITS.facts}
          </Text>
        }
      >
        Detalhes
      </FieldLabel>
      <Card padded={false}>
        {m.facts.map((f, i) =>
          editingFact === i ? (
            <View key={i} style={st.factEdit}>
              <TextInput
                value={factText}
                onChangeText={setFactText}
                autoFocus
                multiline
                style={st.input}
                testID="memory-fact-input"
              />
              <View style={st.editRow}>
                <Counter text={factText} max={MEMORY_LIMITS.fact} />
                <View style={{ flex: 1 }} />
                <TextButton title="Cancelar" tone="muted" onPress={() => setEditingFact(null)} />
                <TextButton
                  title="Salvar"
                  disabled={cleanField(factText, MEMORY_LIMITS.fact, true) === null}
                  onPress={() => {
                    const v = cleanField(factText, MEMORY_LIMITS.fact, true)
                    if (v !== null && save({ facts: replaceFact(m.facts, i, v) }))
                      setEditingFact(null)
                  }}
                />
              </View>
            </View>
          ) : (
            <View key={i} style={[st.fact, i > 0 && st.factSep]} testID={`memory-fact-${i}`}>
              <Text style={st.bullet}>•</Text>
              <Pressable
                style={{ flex: 1 }}
                onPress={() => {
                  setEditingFact(i)
                  setFactText(f)
                }}
              >
                <Text style={st.body}>{f}</Text>
              </Pressable>
              <Pressable
                onPress={() => save({ facts: moveFact(m.facts, i, -1) })}
                disabled={i === 0}
                hitSlop={6}
                accessibilityLabel="Subir"
              >
                <Ionicons
                  name="arrow-up"
                  size={16}
                  color={i === 0 ? colors.faint : colors.subtle}
                />
              </Pressable>
              <Pressable
                onPress={() => save({ facts: moveFact(m.facts, i, 1) })}
                disabled={i === m.facts.length - 1}
                hitSlop={6}
                accessibilityLabel="Descer"
              >
                <Ionicons
                  name="arrow-down"
                  size={16}
                  color={i === m.facts.length - 1 ? colors.faint : colors.subtle}
                />
              </Pressable>
              <Pressable
                onPress={() => save({ facts: removeFact(m.facts, i) })}
                hitSlop={6}
                accessibilityLabel="Remover"
                testID={`memory-fact-remove-${i}`}
              >
                <Ionicons name="close" size={18} color={colors.subtle} />
              </Pressable>
            </View>
          )
        )}
        {m.facts.length === 0 ? <Text style={st.none}>Nenhum detalhe.</Text> : null}
      </Card>
      {canAddFact(m.facts) ? (
        <View style={st.addRow}>
          <TextInput
            testID="memory-fact-new"
            value={adding}
            onChangeText={setAdding}
            placeholder="Novo detalhe"
            placeholderTextColor={colors.faint}
            onSubmitEditing={addFact}
            style={[st.input, { flex: 1 }]}
          />
          <Button
            title="Adicionar"
            size="sm"
            full={false}
            disabled={cleanField(adding, MEMORY_LIMITS.fact, true) === null}
            onPress={addFact}
            testID="memory-fact-add"
          />
        </View>
      ) : (
        <Note>Limite de detalhes atingido.</Note>
      )}

      <Card>
        <ToggleRow
          title="Sempre carregar"
          subtitle="Vai no índice com os detalhes (o modelo vê sem precisar buscar)."
          value={m.pinned}
          onChange={(pinned) => save({ pinned })}
          testID="memory-pinned"
        />
      </Card>

      {targets.length ? (
        <>
          <FieldLabel>Mover para</FieldLabel>
          <View style={st.chips}>
            {targets.map((c) => (
              <Pressable
                key={c.id}
                onPress={() => {
                  if (save({ collectionId: c.id })) toast(`Movida para “${c.name}”`)
                }}
                style={st.chip}
                testID={`memory-move-${c.name}`}
              >
                <Text style={st.chipText}>{c.name}</Text>
              </Pressable>
            ))}
          </View>
        </>
      ) : null}

      <Button
        title="Apagar memória"
        variant="dangerGhost"
        icon="trash-outline"
        onPress={() => setConfirm(true)}
        testID="memory-delete"
      />
      <ConfirmDialog
        visible={confirm}
        title={`Apagar “${m.title}”?`}
        message="A memória some de todos os seus dispositivos."
        confirmLabel="Apagar"
        destructive
        onClose={() => setConfirm(false)}
        onConfirm={() => {
          try {
            settings.deleteMemory(m.id)
            setConfirm(false)
            toast('Memória apagada')
            router.back()
          } catch (e) {
            setConfirm(false)
            setError(describeError(e))
          }
        }}
      />
    </SettingsScreen>
  )
}

const st = StyleSheet.create({
  inline: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingVertical: 4 },
  title: { flex: 1, color: colors.fg, fontSize: 20, fontWeight: '600' },
  body: { flex: 1, color: colors.fg, fontSize: 14.5, lineHeight: 21 },
  meta: { color: colors.subtle, fontSize: 12.5 },
  link: { color: colors.accentStrong },
  input: {
    color: colors.fg,
    fontSize: 14.5,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.accent,
    backgroundColor: colors.elevated
  },
  editRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  fact: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    paddingHorizontal: spacing.md,
    paddingVertical: 10
  },
  factSep: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  factEdit: { padding: spacing.md, gap: 6 },
  bullet: { color: colors.subtle, fontSize: 14.5, lineHeight: 21 },
  none: { color: colors.faint, fontSize: 13, padding: spacing.md },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface
  },
  chipText: { color: colors.muted, fontSize: 13 }
})
