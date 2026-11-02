// Memória de um chat executado neste celular (= aba Memória do desktop, enxuta): ligar/desligar,
// coleções ativas por categoria e ONDE o agente grava (uma coleção de escrita por categoria),
// extração automática depois da compactação, subagentes consultando e "Atualizar índice agora" (o
// índice vai congelado por sessão). Grava `config.memory` do chat (LWW por chave, §4.3.6).
import { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { normalizeMemoryConfig, type MemoryCollection, type MemoryConfig } from '@shared/memory'
import { describeError } from '@/account/errors'
import { store } from '@/data/native'
import { hostStack } from '@/host/native'
import { MemoryConfigEditor } from '@/settings/MemoryConfigEditor'
import { Button } from '@/ui/Button'
import { Sheet } from '@/ui/Sheet'
import { useToast } from '@/ui/Toast'
import { colors } from '@/ui/theme'

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
  const [refreshing, setRefreshing] = useState(false)

  const save = (next: MemoryConfig): void => {
    setCfg(next)
    try {
      hostStack.repo.updateChat(chatId, { config: { memory: next } })
    } catch (e) {
      toast(describeError(e), 'danger')
    }
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

  return (
    <>
      {cfg ? (
        <View style={st.body}>
          <MemoryConfigEditor cfg={cfg} cols={cols} onChange={save} />
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
  note: { color: colors.subtle, fontSize: 12, lineHeight: 17, paddingTop: 8 }
})
