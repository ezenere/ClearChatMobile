// Memória de um chat executado neste celular (= aba Memória do desktop, enxuta): ligar/desligar,
// coleções ativas por categoria e ONDE o agente grava (uma coleção de escrita por categoria),
// extração automática depois da compactação, subagentes consultando e "Atualizar índice agora" (o
// índice vai congelado por sessão). Grava `config.memory` do chat (LWW por chave, §4.3.6).
import Ionicons from '@expo/vector-icons/Ionicons'
import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import {
  MEMORY_CATEGORIES,
  MEMORY_CATEGORY_HINTS,
  MEMORY_CATEGORY_LABELS,
  normalizeMemoryConfig,
  type MemoryCollection,
  type MemoryConfig
} from '@shared/memory'
import { describeError } from '@/account/errors'
import { store } from '@/data/native'
import { hostStack } from '@/host/native'
import { Button } from '@/ui/Button'
import { Checkbox, ToggleRow } from '@/ui/Card'
import { Sheet } from '@/ui/Sheet'
import { useToast } from '@/ui/Toast'
import { colors, radius } from '@/ui/theme'

export function MemorySheet({
  chatId,
  sessionId,
  visible,
  onClose
}: {
  chatId: string
  sessionId: string
  visible: boolean
  onClose: () => void
}) {
  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="Memória deste chat"
      subtitle="O agente lê as coleções ativas e grava só nas marcadas com “grava aqui”. Desligada, nada de memória vai ao modelo."
      testID="memory-sheet"
    >
      {visible ? <MemoryBody chatId={chatId} sessionId={sessionId} /> : null}
    </Sheet>
  )
}

/** Lê a config e as coleções ao abrir (montado só com a folha visível). */
function loadMemory(chatId: string): { cfg: MemoryConfig; cols: MemoryCollection[] } {
  const config = store.getPlain('chat', chatId)?.config as Record<string, unknown> | undefined
  let cols: MemoryCollection[] = []
  try {
    cols = hostStack.memory.service.store.listCollections()
  } catch {
    cols = []
  }
  return { cfg: normalizeMemoryConfig(config?.memory), cols }
}

function MemoryBody({ chatId, sessionId }: { chatId: string; sessionId: string }) {
  const toast = useToast()
  const [initial] = useState(() => loadMemory(chatId))
  const [cfg, setCfg] = useState<MemoryConfig | null>(initial.cfg)
  const cols = initial.cols
  const counts: Record<string, number> = Object.fromEntries(cols.map((c) => [c.id, c.count ?? 0]))
  const [refreshing, setRefreshing] = useState(false)

  const save = (next: MemoryConfig): void => {
    setCfg(next)
    try {
      hostStack.repo.updateChat(chatId, { config: { memory: next } })
    } catch (e) {
      toast(describeError(e), 'danger')
    }
  }

  const toggleCol = (c: MemoryCollection, on: boolean): void => {
    if (!cfg) return
    const collections = on
      ? [...new Set([...cfg.collections, c.id])]
      : cfg.collections.filter((x) => x !== c.id)
    const writeTo = { ...cfg.writeTo }
    if (!on && writeTo[c.category] === c.id) writeTo[c.category] = null
    save({ ...cfg, collections, writeTo })
  }

  const setWrite = (c: MemoryCollection): void => {
    if (!cfg) return
    const cur = cfg.writeTo[c.category]
    const writeTo = { ...cfg.writeTo, [c.category]: cur === c.id ? null : c.id }
    const collections = [...new Set([...cfg.collections, c.id])]
    save({ ...cfg, collections, writeTo })
  }

  const refresh = async (): Promise<void> => {
    setRefreshing(true)
    try {
      await hostStack.host.ensureWindow(chatId, 'edit')
      const chat = hostStack.repo.chat(chatId)
      const session = hostStack.repo.session(sessionId)
      if (chat && session) hostStack.memory.service.refreshSnapshot(chat, session)
      toast('Índice da memória atualizado para esta sessão.')
    } catch (e) {
      toast(describeError(e), 'danger')
    } finally {
      setRefreshing(false)
    }
  }

  const byCat = MEMORY_CATEGORIES.map((cat) => ({
    cat,
    list: cols.filter((c) => c.category === cat)
  })).filter((g) => g.list.length)

  return (
    <>
      {cfg ? (
        <View style={st.body}>
          <ToggleRow
            title="Memória ligada"
            value={cfg.enabled}
            onChange={(v) => save({ ...cfg, enabled: v })}
            testID="memory-enabled"
          />
          {!cols.length ? (
            <Text style={st.empty} testID="memory-no-collections">
              Nenhuma coleção de memória sincronizada. Crie coleções no ClearChat do computador
              (Configurações → Memória).
            </Text>
          ) : null}
          {byCat.map(({ cat, list }) => {
            const catOn = cfg.categories.includes(cat)
            return (
              <View key={cat} style={st.group}>
                <Text style={st.cat}>
                  {MEMORY_CATEGORY_LABELS[cat]}
                  <Text style={st.hint}> · {MEMORY_CATEGORY_HINTS[cat]}</Text>
                </Text>
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
            onChange={(v) => save({ ...cfg, extraction: { ...cfg.extraction, auto: v } })}
            testID="memory-extract-auto"
          />
          <ToggleRow
            title="Subagentes consultam a memória"
            subtitle="Só busca e leitura; subagentes nunca gravam."
            value={cfg.subagents}
            onChange={(v) => save({ ...cfg, subagents: v })}
            testID="memory-subagents"
          />
          <View style={{ paddingHorizontal: 6, paddingTop: 6 }}>
            <Button
              title="Atualizar índice agora"
              variant="secondary"
              size="sm"
              icon="refresh-outline"
              loading={refreshing}
              disabled={!cfg.enabled}
              onPress={() => void refresh()}
              testID="memory-refresh"
            />
            <Text style={st.note}>
              O índice vai congelado por sessão (para o cache do provedor); o que o agente grava
              depois aparece nas buscas, e no índice só depois de compactar ou atualizar.
            </Text>
          </View>
        </View>
      ) : null}
    </>
  )
}

const st = StyleSheet.create({
  body: { gap: 4 },
  empty: { color: colors.muted, fontSize: 13, lineHeight: 19, padding: 10 },
  group: { paddingHorizontal: 10, paddingTop: 10, gap: 4 },
  cat: { color: colors.fg, fontSize: 13.5, fontWeight: '600' },
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
  pillText: { color: colors.subtle, fontSize: 12 },
  note: { color: colors.subtle, fontSize: 12, lineHeight: 17, paddingTop: 8 }
})
