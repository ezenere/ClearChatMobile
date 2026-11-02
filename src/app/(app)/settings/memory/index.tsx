// Configurações → Memórias (= desktop, global): por categoria, as coleções (criar, editar, abrir) e
// a busca em todas as memórias. Chats e personas só escolhem quais coleções o modelo lê e onde grava
// (a persona "Padrão" define a memória dos chats novos). Tudo o que se edita aqui vale para todos os
// dispositivos (registros `memory_collection`/`memory`, outbox LWW).
import Ionicons from '@expo/vector-icons/Ionicons'
import { useRouter } from 'expo-router'
import { useState } from 'react'
import { StyleSheet, Text, TextInput, View } from 'react-native'
import {
  MEMORY_CATEGORIES,
  MEMORY_CATEGORY_HINTS,
  MEMORY_CATEGORY_LABELS,
  type MemoryCategory
} from '@shared/memory'
import { matchesMemory, sharedCollections } from '@vendor/renderer/memory'
import { CollectionForm, CollectionIcon } from '@/settings/memoryUi'
import { readAt, settings, useSettingsVersion } from '@/settings/react'
import { Note, Row, SettingsScreen } from '@/settings/ui'
import { TextButton } from '@/ui/Button'
import { Card, Divider } from '@/ui/Card'
import { useToast } from '@/ui/Toast'
import { colors, radius, spacing } from '@/ui/theme'

function read() {
  try {
    return { cols: settings.collections(), all: settings.memories(), error: null }
  } catch (e) {
    return { cols: [], all: [], error: (e as Error).message }
  }
}

export default function MemorySettings() {
  const router = useRouter()
  const toast = useToast()
  const version = useSettingsVersion()
  const { cols, all } = readAt(version, read)
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState<MemoryCategory | null>(null)
  const results = query.trim() ? all.filter((m) => matchesMemory(m, query)) : null
  const colName = (id: string) => cols.find((c) => c.id === id)?.name ?? 'coleção apagada'

  return (
    <SettingsScreen title="Memórias" testID="screen-memory">
      <Note>
        Coleções globais, cada uma de uma categoria. Os chats e as personas escolhem quais o modelo
        lê e em qual ele grava (menu do chat → Memória…, ou a aba Memória da persona).
      </Note>
      <View style={st.search}>
        <Ionicons name="search" size={16} color={colors.subtle} />
        <TextInput
          testID="memory-search"
          value={query}
          onChangeText={setQuery}
          placeholder="Buscar em todas as memórias"
          placeholderTextColor={colors.faint}
          autoCorrect={false}
          style={st.searchInput}
        />
      </View>

      {results ? (
        <>
          <Text style={st.count}>
            {results.length} {results.length === 1 ? 'resultado' : 'resultados'}
          </Text>
          {results.length ? (
            <Card padded={false}>
              {results.map((m, i) => (
                <View key={m.id}>
                  {i ? <Divider /> : null}
                  <Row
                    title={m.title}
                    subtitle={`${MEMORY_CATEGORY_LABELS[m.category]} · ${colName(m.collectionId)}${m.summary ? ` — ${m.summary}` : ''}`}
                    onPress={() =>
                      router.push({ pathname: '/settings/memory/item/[id]', params: { id: m.id } })
                    }
                  />
                </View>
              ))}
            </Card>
          ) : null}
        </>
      ) : (
        MEMORY_CATEGORIES.map((cat) => {
          const list = sharedCollections(cols, cat)
          return (
            <View key={cat} style={{ gap: spacing.sm }} testID={`memory-cat-${cat}`}>
              <View style={st.catHead}>
                <Text style={st.cat}>{MEMORY_CATEGORY_LABELS[cat]}</Text>
                <Text style={st.catHint} numberOfLines={1}>
                  {MEMORY_CATEGORY_HINTS[cat]}
                </Text>
                <TextButton
                  title="Nova"
                  icon="add"
                  onPress={() => setCreating(cat)}
                  testID={`memory-new-${cat}`}
                />
              </View>
              {creating === cat ? (
                <CollectionForm
                  category={cat}
                  onDone={(saved) => {
                    setCreating(null)
                    if (saved) toast(`Coleção “${saved.name}” criada`)
                  }}
                />
              ) : null}
              {list.length ? (
                <Card padded={false}>
                  {list.map((c, i) => (
                    <View key={c.id}>
                      {i ? <Divider /> : null}
                      <Row
                        testID={`memory-collection-${c.name}`}
                        left={<CollectionIcon collection={c} />}
                        title={c.name}
                        subtitle={`${c.count ?? 0} ${(c.count ?? 0) === 1 ? 'memória' : 'memórias'}${c.description ? ` · ${c.description}` : ''}`}
                        onPress={() =>
                          router.push({
                            pathname: '/settings/memory/collection/[id]',
                            params: { id: c.id }
                          })
                        }
                        right={<Ionicons name="chevron-forward" size={18} color={colors.subtle} />}
                      />
                    </View>
                  ))}
                </Card>
              ) : creating !== cat ? (
                <Text style={st.none}>Nenhuma coleção.</Text>
              ) : null}
            </View>
          )
        })
      )}
    </SettingsScreen>
  )
}

const st = StyleSheet.create({
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    height: 44,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border
  },
  searchInput: { flex: 1, color: colors.fg, fontSize: 15, paddingVertical: 0 },
  count: { color: colors.subtle, fontSize: 12 },
  catHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: spacing.sm },
  cat: { color: colors.fg, fontSize: 15, fontWeight: '600' },
  catHint: { flex: 1, color: colors.subtle, fontSize: 12 },
  none: { color: colors.faint, fontSize: 12.5, paddingHorizontal: 4 }
})
