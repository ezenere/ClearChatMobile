// Tools só do computador (protocolo 1.10.0, §4.3.6 — "Tools de um tipo de aparelho") nas listas de
// tools do celular (configurações do chat, persona, Novo chat, tools da chamada): ficam na lista do
// chat — a mesma em todo aparelho —, esmaecidas e alternáveis, com a nota de que o celular não as
// manda ao modelo (nada escondido vai ao modelo). Valem quando o chat roda num computador.
import type { ReactNode } from 'react'
import { View } from 'react-native'
import { COMPUTER_TOOL_NAMES, DEVICE_ONLY_NOTE, DEVICE_ONLY_TITLE } from '@shared/deviceTools'
import { TOOL_LABELS } from '@shared/tools'
import type { ToolName } from '@shared/types'
import { Card, Divider, ToggleRow } from '@/ui/Card'
import { spacing } from '@/ui/theme'
import { FieldLabel, Note } from './ui'

export function ComputerToolsGroup({
  tools,
  onToggle,
  wrap,
  testID = 'tools-device-computer',
  rowTestID = (t) => `tool-${t}`
}: {
  /** A lista inteira (`enabledTools`). */
  tools: readonly string[]
  onToggle: (tool: ToolName, on: boolean) => void
  /** Envolve cada linha (ex.: a marca "↺ neste chat" da herança). */
  wrap?: (tool: ToolName, row: ReactNode) => ReactNode
  testID?: string
  rowTestID?: (tool: ToolName) => string
}) {
  return (
    <>
      <FieldLabel>{DEVICE_ONLY_TITLE.computer}</FieldLabel>
      <Card padded={false} testID={testID}>
        {COMPUTER_TOOL_NAMES.map((t, i) => {
          const row = (
            <ToggleRow
              dim
              title={TOOL_LABELS[t]}
              value={tools.includes(t)}
              onChange={(v) => onToggle(t, v)}
              testID={rowTestID(t)}
            />
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
