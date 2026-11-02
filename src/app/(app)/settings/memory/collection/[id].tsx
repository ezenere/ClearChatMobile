// Configurações → Memórias → coleção: editar (nome, descrição, ícone), apagar com as memórias
// (confirmação), buscar nela (FTS das tools de memória) e criar memória à mão.
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useState } from 'react'
import { StyleSheet, Text, TextInput, View } from 'react-native'
import { MEMORY_CATEGORY_LABELS } from '@shared/memory'
import { cleanField, matchesMemory, MEMORY_LIMITS, memoryDate } from '@vendor/renderer/memory'
import { describeError } from '@/account/errors'
import { CollectionForm, CollectionIcon, Counter } from '@/settings/memoryUi'
import { readAt, settings, useSettingsVersion } from '@/settings/react'
import { Row, SettingsScreen } from '@/settings/ui'
import { Button, TextButton } from '@/ui/Button'
import { Banner, Card, Divider } from '@/ui/Card'
import { ConfirmDialog } from '@/ui/Dialog'
import { useToast } from '@/ui/Toast'
import { colors, radius, spacing } from '@/ui/theme'

export default function CollectionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const toast = useToast()
  const version = useSettingsVersion()
  const { col, own } = readAt(version, () => {
    try {
      return {
        col: settings.collections().find((c) => c.id === id) ?? null,
        own: settings.memories(id)
      }
    } catch {
      return { col: null, own: [] }
    }
  })
  const [editing, setEditing] = useState(false)
  const [creating, setCreating] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [query, setQuery] = useState('')
  const [title, setTitle] = useState('')
  const [summary, setSummary] = useState('')
  const [error, setError] = useState<string | null>(null)

  if (!col)
    return (
      <SettingsScreen title="Coleção">
        <Banner tone="warning">Esta coleção não existe mais.</Banner>
      </SettingsScreen>
    )

  const list = query.trim()
    ? (() => {
        try {
          return settings.searchMemories(query, id)
        } catch {
          return own.filter((m) => matchesMemory(m, query))
        }
      })()
    : own
  const t = cleanField(title, MEMORY_LIMITS.title, true)
  const s = cleanField(summary, MEMORY_LIMITS.summary)
  const create = () => {
    if (t === null || s === null) return
    try {
      const m = settings.createMemory({ collectionId: id, title: t, summary: s, facts: [] })
      setCreating(false)
      setTitle('')
      setSummary('')
      router.push({ pathname: '/settings/memory/item/[id]', params: { id: m.id } })
    } catch (e) {
      setError(describeError(e))
    }
  }

  return (
    <SettingsScreen title={col.name} testID="screen-collection">
      {editing ? (
        <CollectionForm
          category={col.category}
          collection={col}
          onDone={(saved) => {
            setEditing(false)
            if (saved) toast('Coleção salva')
          }}
        />
      ) : (
        <View style={st.head}>
          <CollectionIcon collection={col} size={44} />
          <View style={{ flex: 1 }}>
            <Text style={st.meta}>
              {MEMORY_CATEGORY_LABELS[col.category]} · {own.length}{' '}
              {own.length === 1 ? 'memória' : 'memórias'}
            </Text>
            {col.description ? <Text style={st.desc}>{col.description}</Text> : null}
          </View>
          <TextButton title="Editar" onPress={() => setEditing(true)} testID="collection-edit" />
        </View>
      )}

      <View style={st.searchRow}>
        <TextInput
          testID="collection-search"
          value={query}
          onChangeText={setQuery}
          placeholder="Buscar nesta coleção"
          placeholderTextColor={colors.faint}
          style={st.search}
        />
        <Button
          title="Nova memória"
          icon="add"
          size="sm"
          full={false}
          variant="secondary"
          onPress={() => setCreating(true)}
          testID="memory-add"
        />
      </View>

      {creating ? (
        <View style={st.form} testID="memory-new-form">
          <View style={st.fieldHead}>
            <Text style={st.label}>Título</Text>
            <Counter text={title} max={MEMORY_LIMITS.title} />
          </View>
          <TextInput
            testID="memory-new-title"
            value={title}
            onChangeText={setTitle}
            autoFocus
            placeholder="Ex.: Trabalho atual"
            placeholderTextColor={colors.faint}
            style={st.input}
          />
          <View style={st.fieldHead}>
            <Text style={st.label}>Resumo (vai no índice)</Text>
            <Counter text={summary} max={MEMORY_LIMITS.summary} />
          </View>
          <TextInput
            testID="memory-new-summary"
            value={summary}
            onChangeText={setSummary}
            placeholder="Resumo de uma linha"
            placeholderTextColor={colors.faint}
            multiline
            style={st.input}
          />
          {error ? <Text style={st.error}>{error}</Text> : null}
          <View style={st.searchRow}>
            <Button
              title="Cancelar"
              variant="secondary"
              size="sm"
              full={false}
              style={{ flex: 1 }}
              onPress={() => setCreating(false)}
            />
            <Button
              title="Criar memória"
              size="sm"
              full={false}
              style={{ flex: 1 }}
              disabled={t === null || s === null}
              onPress={create}
              testID="memory-new-save"
            />
          </View>
        </View>
      ) : null}

      {list.length ? (
        <Card padded={false}>
          {list.map((m, i) => (
            <View key={m.id}>
              {i ? <Divider /> : null}
              <Row
                testID={`memory-row-${m.title}`}
                title={m.title}
                badge={m.pinned ? 'sempre carregar' : null}
                subtitle={`${m.summary ? `${m.summary} · ` : ''}atualizada ${memoryDate(m.updatedAt)}`}
                onPress={() =>
                  router.push({ pathname: '/settings/memory/item/[id]', params: { id: m.id } })
                }
              />
            </View>
          ))}
        </Card>
      ) : (
        <Text style={st.none}>
          {query.trim() ? 'Nada encontrado.' : 'Nenhuma memória nesta coleção.'}
        </Text>
      )}

      <Button
        title={
          own.length
            ? `Apagar a coleção e ${own.length} ${own.length === 1 ? 'memória' : 'memórias'}`
            : 'Apagar a coleção'
        }
        variant="dangerGhost"
        icon="trash-outline"
        onPress={() => setConfirm(true)}
        testID="collection-delete"
      />
      <ConfirmDialog
        visible={confirm}
        title={`Apagar “${col.name}”?`}
        message={
          own.length
            ? `As ${own.length} memórias da coleção também serão apagadas, em todos os seus dispositivos.`
            : 'A coleção some de todos os seus dispositivos.'
        }
        confirmLabel="Apagar"
        destructive
        onClose={() => setConfirm(false)}
        onConfirm={() => {
          settings.deleteCollection(id)
          setConfirm(false)
          toast('Coleção apagada')
          router.back()
        }}
      />
    </SettingsScreen>
  )
}

const st = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  meta: { color: colors.muted, fontSize: 13 },
  desc: { color: colors.subtle, fontSize: 13, lineHeight: 18, marginTop: 2 },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  search: {
    flex: 1,
    color: colors.fg,
    fontSize: 14.5,
    height: 40,
    paddingHorizontal: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface
  },
  form: {
    gap: 6,
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface
  },
  fieldHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  label: { color: colors.muted, fontSize: 12.5 },
  input: {
    color: colors.fg,
    fontSize: 14.5,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.bg
  },
  error: { color: colors.danger, fontSize: 13 },
  none: { color: colors.faint, fontSize: 13, textAlign: 'center', paddingVertical: spacing.lg }
})
