// Peças das telas de Memórias: ícone da coleção (o escolhido ou o da categoria), formulário de
// coleção (criar/editar: ícone, nome, descrição — a categoria não muda) e o contador de caracteres.
import Ionicons from '@expo/vector-icons/Ionicons'
import { useState } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { MEMORY_CATEGORY_LABELS, type MemoryCategory, type MemoryCollection } from '@shared/memory'
import { counter, MEMORY_LIMITS } from '@vendor/renderer/memory'
import { describeError } from '@/account/errors'
import { ChatAvatar } from '@/chat/ChatBits'
import { settings } from './react'
import { IconPicker } from './ui'
import { Button } from '@/ui/Button'
import type { IconName } from '@/ui/Button'
import { colors, radius, spacing } from '@/ui/theme'

export const CATEGORY_ICON: Record<MemoryCategory, IconName> = {
  profile: 'person-outline',
  topics: 'bulb-outline',
  areas: 'folder-open-outline',
  people: 'people-outline',
  preferences: 'options-outline'
}

export function CollectionIcon({
  collection,
  size = 36
}: {
  collection: Pick<MemoryCollection, 'icon' | 'category'>
  size?: number
}) {
  if (collection.icon) return <ChatAvatar icon={collection.icon} size={size} />
  return (
    <View style={[st.catIcon, { width: size, height: size, borderRadius: size * 0.3 }]}>
      <Ionicons name={CATEGORY_ICON[collection.category]} size={size * 0.5} color={colors.muted} />
    </View>
  )
}

export function Counter({ text, max }: { text: string; max: number }) {
  const c = counter(text, max)
  return (
    <Text
      style={[
        st.counter,
        c.over ? { color: colors.danger } : c.near ? { color: colors.warning } : null
      ]}
    >
      {c.label}
    </Text>
  )
}

export function CollectionForm({
  category,
  collection,
  onDone
}: {
  category: MemoryCategory
  collection?: MemoryCollection
  onDone: (saved: MemoryCollection | null) => void
}) {
  const [name, setName] = useState(collection?.name ?? '')
  const [description, setDescription] = useState(collection?.description ?? '')
  const [icon, setIcon] = useState<string | null>(collection?.icon ?? null)
  const [icons, setIcons] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = () => {
    const n = name.trim()
    if (!n) return
    try {
      const saved = collection
        ? settings.updateCollection(collection.id, {
            name: n,
            description: description.trim(),
            icon
          })
        : settings.createCollection({ category, name: n, description: description.trim(), icon })
      onDone(saved)
    } catch (e) {
      setError(describeError(e))
    }
  }
  return (
    <View style={st.form} testID="memory-collection-form">
      <View style={st.formRow}>
        <Pressable onPress={() => setIcons((v) => !v)} accessibilityLabel="Escolher ícone">
          <CollectionIcon collection={{ icon, category }} size={40} />
        </Pressable>
        <TextInput
          testID="collection-name"
          value={name}
          onChangeText={setName}
          autoFocus={!collection}
          placeholder={`Nome — ex.: ${category === 'areas' ? 'Projeto TCC' : category === 'people' ? 'Família' : 'Pessoal'}`}
          placeholderTextColor={colors.faint}
          maxLength={MEMORY_LIMITS.collectionName}
          style={[st.input, { flex: 1 }]}
        />
      </View>
      {icons ? (
        <IconPicker
          value={icon}
          allowNone="Usar o ícone da categoria"
          onChange={(v) => {
            setIcon(v)
            setIcons(false)
          }}
        />
      ) : null}
      <TextInput
        testID="collection-description"
        value={description}
        onChangeText={setDescription}
        placeholder="Descrição — vai no índice para o modelo saber o que há aqui"
        placeholderTextColor={colors.faint}
        maxLength={MEMORY_LIMITS.collectionDescription}
        multiline
        style={st.input}
      />
      <Text style={st.cat}>Categoria: {MEMORY_CATEGORY_LABELS[category]} (não muda depois)</Text>
      {error ? <Text style={st.error}>{error}</Text> : null}
      <View style={st.formRow}>
        <Button
          title="Cancelar"
          variant="secondary"
          size="sm"
          full={false}
          style={{ flex: 1 }}
          onPress={() => onDone(null)}
        />
        <Button
          title={collection ? 'Salvar' : 'Criar coleção'}
          size="sm"
          full={false}
          style={{ flex: 1 }}
          disabled={!name.trim()}
          onPress={save}
          testID="collection-save"
        />
      </View>
    </View>
  )
}

const st = StyleSheet.create({
  catIcon: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.elevated,
    borderWidth: 1,
    borderColor: colors.border
  },
  counter: { color: colors.faint, fontSize: 11, fontVariant: ['tabular-nums'] },
  form: {
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface
  },
  formRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
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
  cat: { color: colors.subtle, fontSize: 12 },
  error: { color: colors.danger, fontSize: 13 }
})
