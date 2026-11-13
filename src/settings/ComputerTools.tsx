// Tools só do computador (protocolo 1.10.0, §4.3.6 — "Tools de um tipo de aparelho") nas listas de
// tools do celular (configurações do chat, persona, Novo chat, tools da chamada): ficam na lista do
// chat — a mesma em todo aparelho —, esmaecidas e alternáveis, com a nota de que o celular não as
// manda ao modelo (nada escondido vai ao modelo). Valem quando o chat roda num computador. Com a
// compactação ligada (1.11.0), cada uma ligada ganha o chip "compacta"/"completa" (vale quando o chat
// roda num computador; a definição de lá depende do computador e não aparece aqui).
import type { ReactNode } from 'react'
import { View } from 'react-native'
import { COMPUTER_TOOL_NAMES, DEVICE_ONLY_NOTE, DEVICE_ONLY_TITLE } from '@shared/deviceTools'
import { TOOL_LABELS } from '@shared/tools'
import type { ChatConfig, ToolName } from '@shared/types'
import { Card, Divider, ToggleRow } from '@/ui/Card'
import { spacing } from '@/ui/theme'
import { ToolSendLine, type CompactCfg } from './ToolsSend'
import { FieldLabel, Note } from './ui'

export function ComputerToolsGroup({
  tools,
  onToggle,
  wrap,
  testID = 'tools-device-computer',
  rowTestID = (t) => `tool-${t}`,
  send
}: {
  /** A lista inteira (`enabledTools`). */
  tools: readonly string[]
  onToggle: (tool: ToolName, on: boolean) => void
  /** Envolve cada linha (ex.: a marca "↺ neste chat" da herança). */
  wrap?: (tool: ToolName, row: ReactNode) => ReactNode
  testID?: string
  rowTestID?: (tool: ToolName) => string
  /** Compactação (1.11.0): o chip "compacta"/"completa" de cada uma ligada. */
  send?: { cfg: CompactCfg; patch?: (p: Partial<ChatConfig>) => void }
}) {
  return (
    <>
      <FieldLabel>{DEVICE_ONLY_TITLE.computer}</FieldLabel>
      <Card padded={false} testID={testID}>
        {COMPUTER_TOOL_NAMES.map((t, i) => {
          const row = (
            <>
              <ToggleRow
                dim
                title={TOOL_LABELS[t]}
                value={tools.includes(t)}
                onChange={(v) => onToggle(t, v)}
                testID={rowTestID(t)}
              />
              {send ? (
                <ToolSendLine
                  name={t}
                  cfg={send.cfg}
                  patch={send.patch}
                  enabled={tools.includes(t)}
                  def={false}
                  dim
                />
              ) : null}
            </>
          )
          return (
            <View key={t} style={{ paddingHorizontal: spacing.lg, paddingVertical: 2 }}>
              {i ? <Divider /> : null}
              {wrap ? wrap(t, row) : row}
            </View>
          )
        })}
      </Card>
      <Note>{DEVICE_ONLY_NOTE.computer}</Note>
    </>
  )
}
