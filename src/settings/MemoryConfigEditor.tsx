// Memória de um chat/persona (= aba Memória do desktop, enxuta): ligar/desligar, coleções ativas
// por categoria (categoria desligada ignora as coleções sem perder a seleção), ONDE o agente grava
// (uma coleção de escrita por categoria), extração automática depois da compactação e subagentes
// consultando. Usado na folha "Memória…" do chat e no editor de personas — é a persona (a
// "Padrão" nos chats novos) que define quais coleções vêm ativas.
import Ionicons from '@expo/vector-icons/Ionicons'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import {
  MEMORY_CATEGORIES,
  MEMORY_CATEGORY_HINTS,
  MEMORY_CATEGORY_LABELS,
  type MemoryCategory,
  type MemoryCollection,
  type MemoryConfig
} from '@shared/memory'
import {
  setWriteTarget,
  sharedCollections,
  toggleCategory,
  toggleCollection
} from '@vendor/renderer/memory'
import { Checkbox, ToggleRow } from '@/ui/Card'
import { colors, radius } from '@/ui/theme'

export function MemoryConfigEditor({
  cfg,
  cols,
  onChange,
  emptyText = 'Nenhuma coleção de memória. Crie coleções em Configurações → Memórias (aqui ou no computador).'
}: {
  cfg: MemoryConfig
  cols: MemoryCollection[]
  onChange: (next: MemoryConfig) => void
  emptyText?: string
}) {
  const counts: Record<string, number> = Object.fromEntries(cols.map((c) => [c.id, c.count ?? 0]))

  // mesmas regras do desktop (lib/memory.ts vendorado): ligar coleção numa categoria desligada
  // liga a categoria; desligar a de escrita limpa a escrita; gravar exige a coleção ativa (ativa
  // junto, como a folha fazia)
  const toggleCol = (c: MemoryCollection, on: boolean): void =>
    onChange(toggleCollection(cfg, c, on))
  const setWrite = (c: MemoryCollection): void => {
    const cur = cfg.writeTo[c.category]
    const base = cur === c.id ? cfg : toggleCollection(cfg, c, true)
    onChange(setWriteTarget(base, cols, c.category, cur === c.id ? null : c.id).mem)
  }
  const toggleCat = (cat: MemoryCategory, on: boolean): void =>
    onChange(toggleCategory(cfg, cat, on))

  const byCat = MEMORY_CATEGORIES.map((cat) => ({
    cat,
    list: sharedCollections(cols, cat)
  })).filter((g) => g.list.length)

  return (
    <View style={st.body}>
      <ToggleRow
        title="Memória ligada"
        subtitle="Desligada, nada de memória vai ao modelo (sem índice, sem tools)."
        value={cfg.enabled}
        onChange={(v) => onChange({ ...cfg, enabled: v })}
        testID="memory-enabled"
      />
      {!cols.length ? (
        <Text style={st.empty} testID="memory-no-collections">
          {emptyText}
        </Text>
      ) : null}
      {byCat.map(({ cat, list }) => {
        const catOn = cfg.categories.includes(cat)
        return (
          <View key={cat} style={st.group}>
            <View style={st.catRow}>
              <Text style={[st.cat, { flex: 1 }]}>
                {MEMORY_CATEGORY_LABELS[cat]}
                <Text style={st.hint}> · {MEMORY_CATEGORY_HINTS[cat]}</Text>
              </Text>
              <Pressable
                onPress={() => toggleCat(cat, !catOn)}
                hitSlop={8}
                accessibilityRole="switch"
                accessibilityState={{ checked: catOn }}
                accessibilityLabel={`Categoria ${MEMORY_CATEGORY_LABELS[cat]}`}
                testID={`memory-cat-${cat}`}
              >
                <Text style={[st.catToggle, !catOn && { color: colors.faint }]}>
                  {catOn ? 'ligada' : 'desligada'}
                </Text>
              </Pressable>
            </View>
            {list.map((c) => {
              const active = cfg.collections.includes(c.id)
              const writes = cfg.writeTo[cat] === c.id
              return (
                <View key={c.id} style={[st.row, (!cfg.enabled || !catOn) && st.dim]}>
                  <View style={{ flex: 1 }}>
                    <Checkbox
                      label={`${c.name} (${counts[c.id] ?? 0})`}
                      value={active}
                      onChange={(v) => toggleCol(c, v)}
                      testID={`memory-col-${c.id}`}
                    />
                  </View>
                  <Pressable
                    onPress={() => setWrite(c)}
                    style={[st.pill, writes && st.pillOn]}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: writes }}
                    accessibilityLabel={`Gravar em ${c.name}`}
                    testID={`memory-write-${c.id}`}
                    hitSlop={6}
                  >
                    <Ionicons
                      name={writes ? 'create' : 'create-outline'}
                      size={13}
                      color={writes ? colors.onAccent : colors.subtle}
                    />
                    <Text style={[st.pillText, writes && { color: colors.onAccent }]}>
                      {writes ? 'grava aqui' : 'só leitura'}
                    </Text>
                  </Pressable>
                </View>
              )
            })}
          </View>
        )
      })}
      <ToggleRow
        title="Extrair memórias depois de compactar"
        subtitle="O modelo de extração lê o resumo e grava o que for durável."
        value={cfg.extraction.auto}
        onChange={(v) => onChange({ ...cfg, extraction: { ...cfg.extraction, auto: v } })}
        testID="memory-extract-auto"
      />
      <ToggleRow
        title="Subagentes consultam a memória"
        subtitle="Só busca e leitura; subagentes nunca gravam."
        value={cfg.subagents}
        onChange={(v) => onChange({ ...cfg, subagents: v })}
        testID="memory-subagents"
      />
    </View>
  )
}

const st = StyleSheet.create({
  body: { gap: 4 },
  empty: { color: colors.muted, fontSize: 13, lineHeight: 19, padding: 10 },
  group: { paddingHorizontal: 10, paddingTop: 10, gap: 4 },
  catRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cat: { color: colors.fg, fontSize: 13.5, fontWeight: '600' },
  catToggle: { color: colors.accentStrong, fontSize: 12 },
  hint: { color: colors.subtle, fontWeight: '400' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  dim: { opacity: 0.45 },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border
  },
  pillOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  pillText: { color: colors.subtle, fontSize: 12 }
})
