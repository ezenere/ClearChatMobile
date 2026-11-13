// Tools compactadas (protocolo 1.11.0, §4.3.6 — "Tools compactadas e `datetime`"; @shared/
// compactTools) nas listas de tools do celular (configurações do chat, persona, Novo chat, tools da
// chamada) — = `ToolFullChip`, `CompactToolsInfo` e `ToolDefInfo` do desktop, no jeito do celular:
// - "Enviar tools compactadas" (`toolsCompact`) com a linha de estado e a folha "O que vai junto":
//   o prompt fixo e a definição da `search_tool`, exatamente como vão (textos do app, só leitura);
// - em cada tool, o chip "compacta"/"completa" (`toolsFull`, com a marca "↺ neste chat" da unidade
//   `toolsFull.<tool>` no chat que herda) e o "</> Definição", que mostra a definição que vai no modo
//   atual (compacta, ou a completa como ESTE celular a manda).
// Nada oculto vai ao modelo: tudo que a compactação acrescenta aparece aqui.
import Ionicons from '@expo/vector-icons/Ionicons'
import { useState, type ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import {
  COMPACT_TOOLS_HELP,
  COMPACT_TOOLS_PROMPT,
  compactToolsOn,
  isCompactable,
  SEARCH_TOOL_DEFINITION,
  sendsCompact,
  sentToolDefinition,
  shortToolDescription,
  withFullTool
} from '@shared/compactTools'
import { MEMORY_TOOL_NAMES, SKILL_TOOL_NAMES, TOOL_LABELS } from '@shared/tools'
import type { ChatConfig } from '@shared/types'
import { phoneToolDefinition } from '@/agent/request'
import { toolLabel } from '@/agent/toolLabels'
import { InheritChip, RevertPanel } from '@/chat/InheritMark'
import { Card, Divider, ToggleRow } from '@/ui/Card'
import { Sheet } from '@/ui/Sheet'
import { colors, font, radius, spacing } from '@/ui/theme'
import { compactStatusText, type CompactCfg } from './compactUi'
import { FieldLabel, Note } from './ui'

export type { CompactCfg }
type Patch = (p: Partial<ChatConfig>) => void

/**
 * "Enviar tools compactadas": o interruptor (com a marca da herança, via `wrap`), a linha de estado e
 * a folha com o prompt fixo e a `search_tool` exatamente como vão.
 */
export function CompactToolsCard({
  cfg,
  onChange,
  sent,
  wrap,
  testID = 'tools-compact'
}: {
  cfg: CompactCfg
  onChange: (on: boolean) => void
  /** Tools ligadas que o celular manda (contagem da linha de estado). */
  sent: readonly string[]
  /** Envolve o interruptor (ex.: a marca "↺ neste chat" de `toolsCompact`). */
  wrap?: (row: ReactNode) => ReactNode
  testID?: string
}) {
  const [info, setInfo] = useState(false)
  const row = (
    <ToggleRow
      title="Enviar tools compactadas"
      subtitle="Cada tool vai só com o nome e uma descrição curta; o modelo lê a definição completa com search_tool antes de usar. Marque “completa” nas que devem ir inteiras."
      value={compactToolsOn(cfg)}
      onChange={onChange}
      testID={testID}
    />
  )
  return (
    <>
      <Card padded={false} testID={`${testID}-card`}>
        <View style={st.pad}>
          {wrap ? wrap(row) : row}
          <Text style={st.status} testID={`${testID}-status`}>
            {compactStatusText(cfg, sent)}
          </Text>
        </View>
        <Pressable
          onPress={() => setInfo(true)}
          style={({ pressed }) => [st.infoRow, pressed && { backgroundColor: colors.hover }]}
          accessibilityRole="button"
          accessibilityLabel="O que vai junto: o prompt fixo e a definição da search_tool"
          testID={`${testID}-info`}
        >
          <Ionicons name="code-slash-outline" size={17} color={colors.accentStrong} />
          <View style={{ flex: 1 }}>
            <Text style={st.infoTitle}>O que vai junto</Text>
            <Text style={st.infoSub}>Prompt fixo e search_tool, exatamente como vão</Text>
          </View>
          <Ionicons name="chevron-forward" size={17} color={colors.subtle} />
        </Pressable>
      </Card>
      <CompactToolsSheet visible={info} onClose={() => setInfo(false)} />
    </>
  )
}

/** Folha "Tools compactadas": o que a compactação faz, o prompt fixo e a `search_tool`. */
export function CompactToolsSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="Tools compactadas"
      subtitle="Textos do app, não editáveis — vão exatamente assim."
      maxHeight="90%"
      testID="compact-tools-sheet"
    >
      <View style={st.sheetBody}>
        <Text style={st.p}>{COMPACT_TOOLS_HELP}</Text>
        <Text style={st.p}>
          Cada tool que não está marcada “completa” vai só com o nome e a descrição curta do app,
          com parâmetros vazios. Havendo pelo menos uma compacta, vão também a search_tool (abaixo)
          e o prompt fixo no fim do system prompt; sem nenhuma compacta, nenhum dos dois. Vale para
          memória, subagentes e a chamada de voz (menos end_call, sempre completa).
        </Text>
        <Text style={st.codeLabel}>
          Prompt fixo — no fim do system prompt, depois de uma linha em branco:
        </Text>
        <Code testID="compact-tools-prompt">{COMPACT_TOOLS_PROMPT}</Code>
        <Text style={st.codeLabel}>
          search_tool — último item do array tools (sempre completa):
        </Text>
        <Code testID="compact-tools-search-tool">
          {JSON.stringify(SEARCH_TOOL_DEFINITION, null, 2)}
        </Code>
      </View>
    </Sheet>
  )
}

function Code({ children, testID }: { children: string; testID?: string }) {
  return (
    <View style={st.code}>
      <Text style={st.codeText} selectable testID={testID}>
        {children}
      </Text>
    </View>
  )
}

/**
 * Linha do envio de uma tool (embaixo da linha dela): o chip "compacta"/"completa" (compactação
 * ligada e tool ligada; `patch` ausente = só leitura), a marca "↺ neste chat" de `toolsFull.<tool>`
 * e o "</> Definição" (o que vai, no modo atual). `def` = false esconde a definição (tools que o
 * celular não manda — as do computador).
 */
export function ToolSendLine({
  name,
  cfg,
  patch,
  enabled,
  def = true,
  chip: withChip = true,
  dim,
  testID
}: {
  name: string
  cfg: CompactCfg
  patch?: Patch
  /** A tool está ligada (sem ela o chip não aparece). */
  enabled: boolean
  def?: boolean
  /** false = sem o chip (tools da chamada: a compactação é a do chat). */
  chip?: boolean
  dim?: boolean
  testID?: string
}) {
  const [open, setOpen] = useState(false)
  const [mark, setMark] = useState(false)
  const id = testID ?? `tool-send-${name}`
  const chip = withChip && compactToolsOn(cfg) && enabled && isCompactable(name)
  const full = !sendsCompact(name, cfg)
  const fullDef = def ? phoneToolDefinition(name) : null
  if (!chip && !fullDef) return null
  const label = toolLabel(name)
  return (
    <View style={[st.lineWrap, dim && { opacity: 0.6 }]}>
      <View style={st.line}>
        {chip ? (
          <Pressable
            onPress={
              patch
                ? () => patch({ toolsFull: withFullTool(cfg.toolsFull, name, !full) })
                : undefined
            }
            disabled={!patch}
            hitSlop={6}
            style={({ pressed }) => [
              st.chip,
              full ? st.chipFull : st.chipCompact,
              pressed && { opacity: 0.7 }
            ]}
            accessibilityRole="button"
            accessibilityState={{ selected: full }}
            accessibilityLabel={`${label}: vai ${full ? 'completa' : 'compacta'}.${patch ? ` Toque para mandar ${full ? 'compacta' : 'completa'}.` : ''}`}
            testID={`${id}-chip`}
          >
            <Text style={[st.chipText, full && st.chipTextFull]}>
              {full ? 'completa' : 'compacta'}
            </Text>
          </Pressable>
        ) : null}
        {chip ? (
          <InheritChip
            units={[`toolsFull.${name}`]}
            open={mark}
            onPress={() => setMark((v) => !v)}
            testID={`inherit-mark-toolsFull-${name}`}
          />
        ) : null}
        <View style={{ flex: 1 }} />
        {fullDef ? (
          <Pressable
            onPress={() => setOpen(true)}
            hitSlop={8}
            style={({ pressed }) => [st.defBtn, pressed && { opacity: 0.6 }]}
            accessibilityRole="button"
            accessibilityLabel={`Definição de ${label} que vai ao modelo`}
            testID={`${id}-def`}
          >
            <Ionicons name="code-slash-outline" size={14} color={colors.subtle} />
            <Text style={st.defText}>Definição</Text>
          </Pressable>
        ) : null}
      </View>
      {mark ? <RevertPanel units={[`toolsFull.${name}`]} onDone={() => setMark(false)} /> : null}
      {fullDef ? (
        <ToolDefinitionSheet
          name={name}
          cfg={cfg}
          fullDef={fullDef}
          visible={open}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </View>
  )
}

/**
 * Memória e skills (ligadas nas seções delas, fora de `enabledTools`): só como vão (o chip e, nas de
 * memória — que o celular manda —, a definição). As skills só vão de um computador. Só com a
 * compactação ligada (= `OtherToolsGroup` do desktop).
 */
export function OtherToolsGroup({
  cfg,
  patch,
  testID = 'tools-other-compact'
}: {
  cfg: CompactCfg
  patch?: Patch
  testID?: string
}) {
  if (!compactToolsOn(cfg)) return null
  const names = [...MEMORY_TOOL_NAMES, ...SKILL_TOOL_NAMES]
  return (
    <>
      <FieldLabel>Memória e skills — como vão</FieldLabel>
      <Card padded={false} testID={testID}>
        {names.map((t, i) => {
          const skill = SKILL_TOOL_NAMES.includes(t)
          return (
            <View key={t} style={st.otherRow}>
              {i ? <Divider /> : null}
              <View style={[st.otherHead, skill && { opacity: 0.55 }]}>
                <Text style={st.otherTitle} numberOfLines={1}>
                  {TOOL_LABELS[t]}
                </Text>
                <Text style={st.otherName}>{t}</Text>
              </View>
              <ToolSendLine name={t} cfg={cfg} patch={patch} enabled def={!skill} dim={skill} />
            </View>
          )
        })}
      </Card>
      <Note>
        Vão quando a memória (seção Memória) ou as skills estão ligadas; as skills só num
        computador.
      </Note>
    </>
  )
}

/** Folha da definição que vai de uma tool (compacta ou completa, conforme a config). */
export function ToolDefinitionSheet({
  name,
  cfg,
  fullDef,
  visible,
  onClose
}: {
  name: string
  cfg: CompactCfg
  fullDef: NonNullable<ReturnType<typeof phoneToolDefinition>>
  visible: boolean
  onClose: () => void
}) {
  const compact = sendsCompact(name, cfg)
  const native = cfg.nativeTools !== false
  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title={toolLabel(name)}
      subtitle={`${name} · vai ${compact ? 'compacta' : 'completa'}`}
      maxHeight="90%"
      testID={`tool-def-sheet-${name}`}
    >
      {visible ? (
        <View style={st.sheetBody}>
          {compact ? (
            <Text style={st.p} testID="tool-def-mode-compact">
              <Text style={st.strong}>Vai compacta</Text>: só o nome e a descrição curta (“
              {shortToolDescription(name, fullDef.function.description)}”), com os parâmetros
              vazios. A definição completa volta ao modelo pela search_tool (e no erro, se ele a
              chamar com argumentos inválidos). Marque “completa” para mandá-la inteira.
            </Text>
          ) : (
            <Text style={st.p} testID="tool-def-mode-full">
              <Text style={st.strong}>Vai completa</Text>: descrição e parâmetros, como este celular
              a manda.
            </Text>
          )}
          <Text style={st.p}>
            {native
              ? 'Ligada: vai como um item do array tools da request.'
              : '“Tools nativas” está desligado: o campo tools não é enviado. A tool só chega ao modelo se o texto das tools no system prompt estiver ligado.'}
          </Text>
          <Text style={st.codeLabel}>
            {compact
              ? 'Definição exata, compacta (um item do array tools):'
              : 'Definição exata (um item do array tools):'}
          </Text>
          <Code testID="tool-def-json">
            {JSON.stringify(sentToolDefinition(fullDef, cfg), null, 2)}
          </Code>
        </View>
      ) : null}
    </Sheet>
  )
}

const st = StyleSheet.create({
  pad: { paddingHorizontal: spacing.lg, paddingTop: 2, paddingBottom: 10 },
  status: { color: colors.subtle, fontSize: 12.5, lineHeight: 17 },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: 11,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border
  },
  infoTitle: { color: colors.fg, fontSize: 14.5 },
  infoSub: { color: colors.subtle, fontSize: 12, lineHeight: 16 },
  sheetBody: { paddingHorizontal: 8, gap: 10, paddingBottom: 8 },
  p: { color: colors.muted, fontSize: 13.5, lineHeight: 19 },
  strong: { color: colors.fg, fontWeight: '600' },
  codeLabel: { color: colors.subtle, fontSize: 12, fontWeight: '600', marginTop: 4 },
  code: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.codeBg
  },
  codeText: {
    color: '#d4d4dc',
    fontFamily: font.mono,
    fontSize: 11.5,
    lineHeight: 17,
    padding: 10
  },
  otherRow: { paddingHorizontal: spacing.lg },
  otherHead: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: spacing.sm,
    paddingTop: 10,
    paddingBottom: 4
  },
  otherTitle: { color: colors.fg, fontSize: 14.5, flexShrink: 1 },
  otherName: { color: colors.faint, fontSize: 11.5, fontFamily: font.mono },
  lineWrap: { gap: 6, paddingBottom: 8, marginTop: -2 },
  line: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 24 },
  chip: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radius.sm,
    borderWidth: 1
  },
  chipCompact: { borderColor: colors.borderStrong },
  chipFull: { borderColor: colors.accentBorder, backgroundColor: colors.accentSoft },
  chipText: { color: colors.subtle, fontSize: 11.5, fontWeight: '500' },
  chipTextFull: { color: colors.accentStrong },
  defBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 2 },
  defText: { color: colors.subtle, fontSize: 12 }
})
