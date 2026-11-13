// Tools compactadas (protocolo 1.11.0, §4.3.6 — "Tools compactadas e `datetime`"; @shared/
// compactTools) e a busca nativa de tools (1.12.0, @shared/toolSearch) nas listas de tools do
// celular (configurações do chat, persona, Novo chat, tools da chamada) — = `ToolFullChip`,
// `CompactToolsInfo`, `ToolDefInfo` e a linha do modo do desktop, no jeito do celular:
// - "Enviar tools compactadas" (`toolsCompact`) com uma linha curta e, na versão local, a marca curta
//   em aviso; a folha "O que vai junto" traz no topo a explicação, o modo efetivo deste chat + modelo
//   (busca nativa da Anthropic / do OpenRouter / versão local do app), o motivo e, na versão local, o
//   aviso (= o (?) do desktop) e depois, na versão local, o prompt fixo e a `tool_search`; num modo
//   nativo a entrada de busca do provedor, exatamente como vão (só leitura);
// - em cada tool, o chip "compacta"/"completa" ("adiada"/"carregada" nos modos nativos; `toolsFull`,
//   com a marca "↺ neste chat" da unidade `toolsFull.<tool>` no chat que herda) e o "</> Definição",
//   que mostra o que vai no modo atual (compacta, completa como ESTE celular a manda, ou o item exato
//   da Messages API com `defer_loading`).
// Nada oculto vai ao modelo: tudo que a compactação acrescenta aparece aqui.
import Ionicons from '@expo/vector-icons/Ionicons'
import { useState, type ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import {
  COMPACT_TOOLS_HELP,
  COMPACT_TOOLS_PROMPT,
  compactToolsOn,
  isCompactable,
  NATIVE_TOOL_SEARCH_HELP,
  SEARCH_TOOL_DEFINITION,
  sendsCompact,
  sentToolDefinition,
  shortToolDescription,
  withFullTool
} from '@shared/compactTools'
import { isNativeMode, SEARCH_ENTRY_NOTE } from '@shared/toolSearch'
import { MEMORY_TOOL_NAMES, SKILL_TOOL_NAMES, TOOL_LABELS } from '@shared/tools'
import type { ChatConfig } from '@shared/types'
import { phoneToolDefinition } from '@/agent/request'
import { toolLabel } from '@/agent/toolLabels'
import { InheritChip, RevertPanel } from '@/chat/InheritMark'
import { Card, Divider, ToggleRow } from '@/ui/Card'
import { Sheet } from '@/ui/Sheet'
import { colors, font, radius, spacing } from '@/ui/theme'
import { compactStatusText, type CompactCfg } from './compactUi'
import {
  nativeToolState,
  toolChipText,
  toolSearchLine,
  type ToolSearchModeView
} from './toolSearchUi'
import { FieldLabel, Note } from './ui'

export type { CompactCfg, ToolSearchModeView }
type Patch = (p: Partial<ChatConfig>) => void

/** Explicação de "Enviar tools compactadas" (no topo da folha "O que vai junto"). */
const COMPACT_TOOLS_EXPLAIN =
  'Economiza contexto. Onde o provedor tem busca nativa de ferramentas (Anthropic; OpenRouter pela Messages API), cada tool vai completa mas adiada e o modelo a encontra pela busca do provedor. Nos outros endpoints, a versão local do app: cada tool vai só com o nome e uma descrição curta e o modelo lê a definição completa com tool_search. Marque “completa”/“carregada” nas que devem ir inteiras desde o início.'

/**
 * "Enviar tools compactadas": o interruptor (com a marca da herança, via `wrap`), na versão local a
 * marca curta em aviso, e a folha "O que vai junto" — com a explicação e o modo efetivo (busca nativa
 * do provedor ou versão local, com o motivo e o aviso) no topo e o que vai junto, exatamente como vai.
 */
export function CompactToolsCard({
  cfg,
  onChange,
  sent,
  view,
  wrap,
  testID = 'tools-compact'
}: {
  cfg: CompactCfg
  onChange: (on: boolean) => void
  /** Tools ligadas que o celular manda (contagem da linha de estado sem o modo resolvido). */
  sent: readonly string[]
  /** Modo efetivo deste chat/persona + modelo (1.12.0 — `toolSearchViewOf`). */
  view?: ToolSearchModeView | null
  /** Envolve o interruptor (ex.: a marca "↺ neste chat" de `toolsCompact`). */
  wrap?: (row: ReactNode) => ReactNode
  testID?: string
}) {
  const [info, setInfo] = useState(false)
  const on = compactToolsOn(cfg)
  const native = on && isNativeMode(view?.mode)
  const local = on && !!view && view.mode !== 'off' && !native
  const row = (
    <ToggleRow
      title="Enviar tools compactadas"
      subtitle="Economiza contexto."
      value={on}
      onChange={onChange}
      testID={testID}
    />
  )
  return (
    <>
      <Card padded={false} testID={`${testID}-card`}>
        <View style={st.pad}>
          {wrap ? wrap(row) : row}
          {local ? (
            <Text style={st.localMark} testID={`${testID}-local-mark`}>
              Versão local do app — este endpoint não tem busca nativa (detalhes em “O que vai
              junto”).
            </Text>
          ) : null}
        </View>
        <Pressable
          onPress={() => setInfo(true)}
          style={({ pressed }) => [st.infoRow, pressed && { backgroundColor: colors.hover }]}
          accessibilityRole="button"
          accessibilityLabel={
            native
              ? 'O que vai junto: a entrada de busca do provedor'
              : 'O que vai junto: o prompt fixo e a definição da tool_search'
          }
          testID={`${testID}-info`}
        >
          <Ionicons name="code-slash-outline" size={17} color={colors.accentStrong} />
          <View style={{ flex: 1 }}>
            <Text style={st.infoTitle}>O que vai junto</Text>
            <Text style={st.infoSub}>
              {native
                ? 'Entrada de busca do provedor, exatamente como vai'
                : 'Prompt fixo e tool_search, exatamente como vão'}
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={17} color={colors.subtle} />
        </Pressable>
      </Card>
      <CompactToolsSheet
        visible={info}
        onClose={() => setInfo(false)}
        view={on ? (view ?? null) : null}
        status={
          on && view ? 'Agora: todas as ligadas vão completas.' : compactStatusText(cfg, sent)
        }
        modeTestID={testID}
      />
    </>
  )
}

/**
 * Topo da folha "O que vai junto" (= o (?) do desktop): a explicação de "Enviar tools compactadas" e
 * o modo efetivo deste chat + modelo — "Agora — rótulo: estado", o motivo e, na versão local, o aviso
 * do protocolo (§4.3.6). Sem modo resolvido (ou desligado): só o estado (`status`).
 */
function CompactModeDetails({
  view,
  status,
  testID
}: {
  view: ToolSearchModeView | null
  status: string
  testID: string
}) {
  const line = view ? toolSearchLine(view) : null
  return (
    <View style={st.details}>
      <Text style={st.p} testID={`${testID}-explain`}>
        {COMPACT_TOOLS_EXPLAIN}
      </Text>
      {line ? (
        <View style={{ gap: 6 }} testID={`${testID}-mode`}>
          <Text style={st.p} testID={`${testID}-status`}>
            <Text style={st.strong} testID={`${testID}-mode-${view!.mode}`}>
              {`Agora — ${line.label}`}
            </Text>
            {`: ${line.status}`}
          </Text>
          {line.reason ? (
            <Text style={st.p} testID={`${testID}-reason`}>
              {line.reason}
            </Text>
          ) : null}
          {line.notice ? (
            <View style={st.notice} testID={`${testID}-local-notice`}>
              <Ionicons name="information-circle-outline" size={15} color={colors.warning} />
              <Text style={st.noticeText}>{line.notice}</Text>
            </View>
          ) : null}
        </View>
      ) : (
        <Text style={[st.p, st.strong]} testID={`${testID}-status`}>
          {status}
        </Text>
      )}
    </View>
  )
}

/**
 * Folha "Tools compactadas": no topo a explicação e o modo efetivo (`CompactModeDetails`); depois o
 * que vai, exatamente, nesse modo. Versão local (1.11.0): o prompt fixo e a `tool_search` (textos do
 * app, não editáveis). Busca nativa (1.12.0): a entrada de busca do servidor como vai (descrição do
 * provedor) — sem prompt do app e sem `tool_search`.
 */
export function CompactToolsSheet({
  visible,
  onClose,
  view = null,
  status,
  modeTestID = 'tools-compact'
}: {
  visible: boolean
  onClose: () => void
  view?: ToolSearchModeView | null
  /** Estado sem modo resolvido (ou desligado), no lugar do modo. */
  status: string
  /** Prefixo dos testIDs do modo (`-mode`, `-status`, `-reason`, `-local-notice`). */
  modeTestID?: string
}) {
  const details = <CompactModeDetails view={view} status={status} testID={modeTestID} />
  if (view && isNativeMode(view.mode)) {
    return (
      <Sheet
        visible={visible}
        onClose={onClose}
        title={`Tools compactadas · ${view.label}`}
        subtitle="O que vai, exatamente."
        maxHeight="90%"
        testID="compact-tools-sheet"
      >
        <View style={st.sheetBody}>
          {details}
          <Text style={st.p} testID="compact-tools-native">
            {NATIVE_TOOL_SEARCH_HELP}
          </Text>
          <Text style={st.p}>
            Cada tool que não está marcada “carregada” vai com a definição completa e defer_loading:
            true; as marcadas (e end_call) vão carregadas, e a última carregada leva o ponto de
            cache. A entrada de busca abaixo vai por último. {SEARCH_ENTRY_NOTE[view.mode]} Não há
            tool_search do app. Havendo alguma adiada, vai o prompt fixo nativo no fim do system
            prompt (depois de uma linha em branco; texto do app que nomeia a busca e lista as tools
            adiadas desta request, exatamente como vai).
            {view.mode === 'native-openrouter'
              ? ' Enquanto houver tools adiadas, a request vai para /messages (Messages API do OpenRouter) em vez de /chat/completions.'
              : ''}{' '}
            A “Definição” de cada tool mostra o item exato.
          </Text>
          {view.prompt ? (
            <>
              <Text style={st.codeLabel}>
                Prompt fixo nativo — no fim do system prompt, depois de uma linha em branco:
              </Text>
              <Code testID="compact-tools-native-prompt">{view.prompt}</Code>
            </>
          ) : null}
          <Text style={st.codeLabel}>Entrada de busca — último item do array tools:</Text>
          <Code testID="compact-tools-search-entry">
            {JSON.stringify(view.searchEntry, null, 2)}
          </Code>
        </View>
      </Sheet>
    )
  }
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
        {details}
        <Text style={st.p}>{COMPACT_TOOLS_HELP}</Text>
        <Text style={st.p}>
          Cada tool que não está marcada “completa” vai só com o nome e a descrição curta do app,
          com parâmetros vazios. Havendo pelo menos uma compacta, vão também a tool_search (abaixo)
          e o prompt fixo no fim do system prompt; sem nenhuma compacta, nenhum dos dois. Vale para
          memória, subagentes e a chamada de voz (menos end_call, sempre completa).
        </Text>
        <Text style={st.codeLabel}>
          Prompt fixo — no fim do system prompt, depois de uma linha em branco:
        </Text>
        <Code testID="compact-tools-prompt">{COMPACT_TOOLS_PROMPT}</Code>
        <Text style={st.codeLabel}>
          tool_search — último item do array tools (sempre completa):
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
 * Linha do envio de uma tool (embaixo da linha dela): o chip "compacta"/"completa" ("adiada"/
 * "carregada" num modo de busca nativa; compactação ligada e tool ligada; `patch` ausente = só
 * leitura), a marca "↺ neste chat" de `toolsFull.<tool>` e o "</> Definição" (o que vai, no modo
 * atual). `def` = false esconde a definição (tools que o celular não manda — as do computador).
 */
export function ToolSendLine({
  name,
  cfg,
  patch,
  enabled,
  def = true,
  chip: withChip = true,
  dim,
  view = null,
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
  /** Modo efetivo do chat/persona (1.12.0): nos nativos, "adiada"/"carregada" e o item exato. */
  view?: ToolSearchModeView | null
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
  const native = compactToolsOn(cfg) && isNativeMode(view?.mode)
  const text = toolChipText(native, full)
  const other = toolChipText(native, !full)
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
            accessibilityLabel={`${label}: vai ${text}.${patch ? ` Toque para mandar ${other}.` : ''}`}
            testID={`${id}-chip`}
          >
            <Text style={[st.chipText, full && st.chipTextFull]}>{text}</Text>
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
          view={native ? view : null}
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
  view = null,
  testID = 'tools-other-compact'
}: {
  cfg: CompactCfg
  patch?: Patch
  /** Modo efetivo (1.12.0): "adiada"/"carregada" e o item exato nos modos nativos. */
  view?: ToolSearchModeView | null
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
              <ToolSendLine
                name={t}
                cfg={cfg}
                patch={patch}
                enabled
                def={!skill}
                dim={skill}
                view={view}
              />
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

/**
 * Folha da definição que vai de uma tool (compacta ou completa, conforme a config; num modo de busca
 * nativa, o item exato da Messages API — adiado ou carregado).
 */
export function ToolDefinitionSheet({
  name,
  cfg,
  fullDef,
  view = null,
  visible,
  onClose
}: {
  name: string
  cfg: CompactCfg
  fullDef: NonNullable<ReturnType<typeof phoneToolDefinition>>
  /** Modo nativo (1.12.0): mostra o item exato de `tools[]`. */
  view?: ToolSearchModeView | null
  visible: boolean
  onClose: () => void
}) {
  const compact = sendsCompact(name, cfg)
  const native = cfg.nativeTools !== false
  if (view && isNativeMode(view.mode) && isCompactable(name))
    return (
      <NativeToolDefinitionSheet
        name={name}
        fullDef={fullDef}
        configDeferred={compact}
        nativeTools={native}
        view={view}
        visible={visible}
        onClose={onClose}
      />
    )
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
              vazios. A definição completa volta ao modelo pela tool_search (e no erro, se ele a
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

/** Definição de uma tool num modo de busca nativa: o item exato da Messages API (adiada ou carregada). */
function NativeToolDefinitionSheet({
  name,
  fullDef,
  configDeferred,
  nativeTools,
  view,
  visible,
  onClose
}: {
  name: string
  fullDef: NonNullable<ReturnType<typeof phoneToolDefinition>>
  /** Adiada pela config (`toolsFull`); vale quando a tool não está na request. */
  configDeferred: boolean
  nativeTools: boolean
  view: ToolSearchModeView
  visible: boolean
  onClose: () => void
}) {
  // o estado DESTA request (uma adiada já usada no histórico sem a busca vai carregada)
  const { deferred, forced, item } = nativeToolState(view, name, fullDef, configDeferred)
  const who = view.mode === 'native-anthropic' ? 'da Anthropic' : 'do OpenRouter'
  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title={toolLabel(name)}
      subtitle={`${name} · vai ${deferred ? 'adiada' : 'carregada'}`}
      maxHeight="90%"
      testID={`tool-def-sheet-${name}`}
    >
      {visible ? (
        <View style={st.sheetBody}>
          {deferred ? (
            <Text style={st.p} testID="tool-def-mode-deferred">
              <Text style={st.strong}>Vai adiada</Text> (defer_loading: true): a definição completa
              vai na request, mas o modelo só a vê depois de encontrá-la pela busca nativa {who}.
              Marque “carregada” para ele vê-la desde o início.
            </Text>
          ) : (
            <Text
              style={st.p}
              testID={forced ? 'tool-def-mode-force-loaded' : 'tool-def-mode-loaded'}
            >
              <Text style={st.strong}>Vai carregada</Text> desde o início (sem defer_loading)
              {forced
                ? ' nesta request: já foi usada no histórico enviado sem a busca que a encontrou junto.'
                : '.'}
              {item.cache_control
                ? ' Leva o ponto de cache (cache_control): é a última tool carregada.'
                : ''}
            </Text>
          )}
          {!nativeTools ? (
            <Text style={st.p}>“Tools nativas” está desligado: o campo tools não é enviado.</Text>
          ) : null}
          <Text style={st.codeLabel}>Item exato do array tools (formato da Messages API):</Text>
          <Code testID="tool-def-json">{JSON.stringify(item, null, 2)}</Code>
        </View>
      ) : null}
    </Sheet>
  )
}

const st = StyleSheet.create({
  pad: { paddingHorizontal: spacing.lg, paddingTop: 2, paddingBottom: 10, gap: 4 },
  localMark: { color: colors.warning, fontSize: 12.5, lineHeight: 17 },
  details: {
    gap: 10,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border
  },
  notice: {
    flexDirection: 'row',
    gap: 6,
    alignItems: 'flex-start',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: 'rgba(245, 181, 68, 0.32)',
    backgroundColor: colors.warningSoft,
    paddingHorizontal: 8,
    paddingVertical: 6
  },
  noticeText: { flex: 1, color: colors.warning, fontSize: 12.5, lineHeight: 17 },
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
