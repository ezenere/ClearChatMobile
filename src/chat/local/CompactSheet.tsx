// Compactar um chat executado neste celular (= medidor de contexto + compactar do desktop): uso do
// contexto da sessão principal contra a janela do modelo, "Compactar agora" e a compactação
// automática perto do limite (`config.autoCompact`, limiar `compactThreshold`).
import { useEffect, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { describeError } from '@/account/errors'
import { ChatInheritProvider, InheritInline } from '@/chat/InheritMark'
import { useCacheChatInherit } from '@/chat/useChatInherit'
import { hostStack } from '@/host/native'
import { Button } from '@/ui/Button'
import { ToggleRow } from '@/ui/Card'
import { Sheet } from '@/ui/Sheet'
import { useToast } from '@/ui/Toast'
import { colors, radius } from '@/ui/theme'

const fmt = (n: number): string => n.toLocaleString('pt-BR')

export function CompactSheet({
  chatId,
  sessionId,
  visible,
  busy,
  onClose,
  onCompact
}: {
  chatId: string
  sessionId: string
  visible: boolean
  busy: boolean
  onClose: () => void
  onCompact: () => void
}) {
  const toast = useToast()
  const [info, setInfo] = useState<{
    used: number | null
    window: number | null
    threshold: number
    auto: boolean
  } | null>(null)

  useEffect(() => {
    if (!visible) return
    let live = true
    hostStack.runner
      .contextInfo(sessionId)
      .then((i) => live && setInfo(i))
      .catch((e: unknown) => toast(describeError(e), 'danger'))
    return () => {
      live = false
    }
  }, [visible, sessionId, toast])

  const pct = info?.used != null && info.window ? Math.min(1, info.used / info.window) : null
  // herança ao vivo da persona (1.10.0): "↺ neste chat" no que o chat mudou para si
  const inherit = useCacheChatInherit(chatId)
  const auto = hostStack.repo.chat(chatId)?.config.autoCompact

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="Compactar conversa"
      subtitle="Resume o histórico com o modelo do chat para liberar contexto. As mensagens continuam salvas (read_history as encontra)."
      testID="compact-sheet"
    >
      <View style={st.body}>
        <View style={st.meter} testID="context-meter">
          <Text style={st.meterText}>
            {info?.used != null
              ? `Contexto: ${fmt(info.used)}${info.window ? ` de ${fmt(info.window)} tokens (${Math.round((pct ?? 0) * 100)}%)` : ' tokens'}`
              : 'Contexto: ainda sem medida (nenhuma resposta com uso de tokens).'}
          </Text>
          {pct != null ? (
            <View style={st.bar}>
              <View
                style={[
                  st.fill,
                  {
                    width: `${Math.round(pct * 100)}%`,
                    backgroundColor:
                      pct >= (info?.threshold ?? 0.8) ? colors.warning : colors.accent
                  }
                ]}
              />
            </View>
          ) : null}
        </View>
        {info ? (
          <ChatInheritProvider value={inherit}>
            <View style={{ paddingHorizontal: 6 }}>
              <InheritInline units={['autoCompact']}>
                <ToggleRow
                  title="Compactar automaticamente"
                  subtitle={`Ao passar de ${Math.round(info.threshold * 100)}% da janela de contexto, no próximo passo do agente.`}
                  value={auto ?? info.auto}
                  onChange={(v) => {
                    setInfo({ ...info, auto: v })
                    try {
                      hostStack.repo.updateChat(chatId, { config: { autoCompact: v } })
                    } catch (e) {
                      toast(describeError(e), 'danger')
                    }
                  }}
                  testID="compact-auto"
                />
              </InheritInline>
            </View>
          </ChatInheritProvider>
        ) : null}
        <View style={{ paddingHorizontal: 6, paddingTop: 8 }}>
          <Button
            title={busy ? 'Compactar no próximo passo' : 'Compactar agora'}
            icon="layers-outline"
            onPress={onCompact}
            testID="compact-now"
          />
        </View>
      </View>
    </Sheet>
  )
}

const st = StyleSheet.create({
  body: { gap: 6 },
  meter: { paddingHorizontal: 10, paddingVertical: 8, gap: 8 },
  meterText: { color: colors.muted, fontSize: 13.5 },
  bar: {
    height: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.active,
    overflow: 'hidden'
  },
  fill: { height: 6, borderRadius: radius.pill }
})
