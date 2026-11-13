// Partes "avançadas" do editor de persona (= desktop: SignatureSection, ContextSettingsSection e
// RootOptions do painel/persona): janela de contexto e compactação, assinatura do app (headers
// HTTP-Referer / X-Title), as opções que só valem no computador (raiz, sandbox) e o bloco de
// ambiente (celular e computador; o texto do celular aparece por inteiro).
// O diretório raiz da persona é local de cada dispositivo (§4.3.3/§4.4) — não aparece aqui.
// Também nas configurações do chat (herança ao vivo da persona, 1.10.0): `label` desenha os
// rótulos com a marca de campo próprio e, na assinatura, a ★ marca a herdada.
import Ionicons from '@expo/vector-icons/Ionicons'
import { useState, type ReactNode } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import {
  APP_SIGNATURES,
  normalizeAppSignatureId,
  resolveAppSignatureHeaders
} from '@shared/appSignatures'
import { DEFAULT_COMPACT_PROMPT, DEFAULT_COMPACT_THRESHOLD } from '@shared/defaults'
import type { ChatConfig } from '@shared/types'
import { environmentBlock } from '@/agent/request'
import { FieldLabel, Multiline, Note, NumberField, Row } from '@/settings/ui'
import { TextButton } from '@/ui/Button'
import { Card, Divider, ToggleRow } from '@/ui/Card'
import { TextField } from '@/ui/TextField'
import { colors, font, radius, spacing } from '@/ui/theme'

type Patch = (p: Partial<ChatConfig>) => void
/** Rótulo de uma seção (`units` = as unidades da herança que ela cobre). */
export type LabelFn = (title: string, units: readonly string[], right?: ReactNode) => ReactNode
interface Props {
  cfg: Partial<ChatConfig>
  patch: Patch
  /** Rótulos (padrão: o FieldLabel simples). */
  label?: LabelFn
  /** "nesta persona" / "neste chat" (as notas). */
  where?: string
}

const plainLabel: LabelFn = (title, _units, right) => (
  <FieldLabel key={title} right={right}>
    {title}
  </FieldLabel>
)

/** Janela de contexto (manual), limite da compactação e prompt de compactação. */
export function ContextEditor({ cfg, patch, label = plainLabel, where = 'nesta persona' }: Props) {
  const override = cfg.contextWindow != null && cfg.contextWindow > 0
  const pct = Math.round((cfg.compactThreshold ?? DEFAULT_COMPACT_THRESHOLD) * 100)
  const [promptOpen, setPromptOpen] = useState(cfg.compactPrompt != null)
  return (
    <>
      {label('Janela e compactação', ['contextWindow', 'compactThreshold', 'autoCompact'])}
      <Card padded={false}>
        <View style={st.row}>
          <ToggleRow
            title="Definir janela manualmente"
            subtitle="Para endpoints que não informam o tamanho do contexto."
            value={override}
            onChange={(v) => patch({ contextWindow: v ? 128_000 : null })}
            testID="persona-window-override"
          />
        </View>
        {override ? (
          <View style={st.row}>
            <NumberField
              label="Janela (tokens)"
              value={cfg.contextWindow ?? null}
              min={1}
              max={10_000_000}
              onChange={(v) => v && patch({ contextWindow: v })}
              testID="persona-window"
            />
          </View>
        ) : null}
        <Divider />
        <View style={st.row}>
          <NumberField
            label="Sugerir compactação em"
            value={pct}
            min={10}
            max={100}
            suffix="%"
            onChange={(v) =>
              patch({ compactThreshold: v == null ? DEFAULT_COMPACT_THRESHOLD : v / 100 })
            }
            testID="persona-compact-threshold"
          />
        </View>
        <View style={st.row}>
          <ToggleRow
            title="Compactar automaticamente"
            subtitle="Sessão principal, ao atingir o limite. Subagentes: sempre."
            value={!!cfg.autoCompact}
            onChange={(autoCompact) => patch({ autoCompact })}
            testID="persona-autocompact"
          />
        </View>
      </Card>
      {label(
        'Prompt de compactação',
        ['compactPrompt'],
        cfg.compactPrompt != null ? (
          <TextButton
            title="Restaurar padrão"
            icon="arrow-undo-outline"
            onPress={() => patch({ compactPrompt: null })}
            testID="persona-compact-prompt-reset"
          />
        ) : !promptOpen ? (
          <TextButton title="Editar" icon="create-outline" onPress={() => setPromptOpen(true)} />
        ) : undefined
      )}
      {promptOpen || cfg.compactPrompt != null ? (
        <Multiline
          testID="persona-compact-prompt"
          value={cfg.compactPrompt ?? DEFAULT_COMPACT_PROMPT}
          onChangeText={(compactPrompt) => patch({ compactPrompt })}
          minHeight={140}
        />
      ) : null}
      <Note>
        {cfg.compactPrompt != null
          ? `Personalizado ${where}.`
          : 'Padrão do app (o resumo que substitui o histórico ao compactar).'}
      </Note>
    </>
  )
}

/**
 * Assinatura do app: headers de atribuição de cada request (o OpenRouter usa; outros ignoram).
 * `inherited` (chat que herda a persona): a ★ vai na assinatura herdada; com a própria, tocar na ★
 * volta a herdar.
 */
export function SignatureEditor({
  cfg,
  patch,
  label = plainLabel,
  inherited
}: Props & { inherited?: { id: string; own: boolean; revert: () => void } }) {
  const id = normalizeAppSignatureId(cfg.appSignature)
  const custom = cfg.appSignatureCustom ?? { referer: '', title: '' }
  const headers = resolveAppSignatureHeaders(id, cfg.appSignatureCustom)
  const lines = Object.entries(headers).map(([k, v]) => `${k}: ${v}`)
  return (
    <>
      {label('Assinatura do app', ['appSignature'])}
      <Card padded={false}>
        {APP_SIGNATURES.map((s, i) => {
          const star = !!inherited && normalizeAppSignatureId(inherited.id) === s.id
          return (
            <View key={s.id}>
              {i ? <Divider /> : null}
              <Row
                title={s.label}
                subtitle={s.referer ?? (s.id === 'none' ? 'Não envia os headers' : null)}
                onPress={() =>
                  star && inherited.own && s.id !== 'custom'
                    ? inherited.revert()
                    : patch(
                        s.id === 'custom'
                          ? { appSignature: s.id, appSignatureCustom: custom }
                          : { appSignature: s.id }
                      )
                }
                right={
                  <View style={st.rowRight}>
                    {star ? (
                      <Ionicons
                        name="star"
                        size={12}
                        color={id === s.id ? colors.accentStrong : colors.subtle}
                        accessibilityLabel="herdada da persona"
                      />
                    ) : null}
                    {id === s.id ? <Text style={st.check}>✓</Text> : null}
                  </View>
                }
                testID={`persona-signature-${s.id}${star ? '-star' : ''}`}
              />
            </View>
          )
        })}
      </Card>
      {id === 'custom' ? (
        <>
          <TextField
            label="HTTP-Referer"
            value={custom.referer}
            onChangeText={(referer) => patch({ appSignatureCustom: { ...custom, referer } })}
            autoCapitalize="none"
            placeholder="https://…"
            testID="persona-signature-referer"
          />
          <TextField
            label="X-Title"
            value={custom.title}
            onChangeText={(title) => patch({ appSignatureCustom: { ...custom, title } })}
            placeholder="Nome do app"
            testID="persona-signature-title"
          />
        </>
      ) : null}
      <Note>
        {lines.length
          ? `Enviados em cada request: ${lines.join(' · ')}`
          : 'Nenhum header de atribuição será enviado.'}
      </Note>
    </>
  )
}

/** Opções que só fazem diferença no computador (ferramentas locais). */
export function ComputerOptions({ cfg, patch, label = plainLabel }: Props) {
  return (
    <>
      {label('No computador', ['confineToRoot', 'sandboxBash'])}
      <Card padded={false}>
        <View style={st.row}>
          <ToggleRow
            title="Confinar ferramentas à raiz"
            subtitle="Tools de arquivo recusam caminhos fora dela."
            value={cfg.confineToRoot !== false}
            onChange={(confineToRoot) => patch({ confineToRoot })}
            testID="persona-confine"
          />
        </View>
        <View style={st.row}>
          <ToggleRow
            title="Shell em sandbox"
            subtitle="Linux com bubblewrap: só a raiz é gravável."
            value={!!cfg.sandboxBash}
            onChange={(sandboxBash) => patch({ sandboxBash })}
            testID="persona-sandbox"
          />
        </View>
      </Card>
      <Note>
        O diretório raiz da persona é escolhido em cada computador (não sincroniza); no celular os
        chats não têm pasta.
      </Note>
    </>
  )
}

/** "Bloco de ambiente" (`envInPrompt`): vale no celular E no computador — cada um manda o seu.
 *  No celular é exatamente `environmentBlock()` (sistema Android + aviso de que não há shell nem
 *  arquivos), mostrado aqui por inteiro (nada de texto oculto no system prompt). */
export function EnvironmentOption({ cfg, patch, label = plainLabel }: Props) {
  return (
    <>
      {label('Ambiente no system prompt', ['envInPrompt'])}
      <Card padded={false}>
        <View style={st.row}>
          <ToggleRow
            title="Bloco de ambiente"
            subtitle="Sistema (Android) e o aviso de que o celular não tem shell nem arquivos."
            value={!!cfg.envInPrompt}
            onChange={(envInPrompt) => patch({ envInPrompt })}
            testID="persona-env"
          />
        </View>
      </Card>
      <Note>
        Ligado, o celular acrescenta ao system prompt exatamente este texto (num computador, o bloco
        de lá traz raiz, SO, shell e regras):
      </Note>
      <Text style={st.block} testID="persona-env-text">
        {environmentBlock()}
      </Text>
    </>
  )
}

const st = StyleSheet.create({
  row: { paddingHorizontal: spacing.lg, paddingVertical: 2 },
  check: { color: colors.accentStrong, fontSize: 16, fontWeight: '700' },
  rowRight: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  block: {
    color: colors.muted,
    fontSize: 12.5,
    lineHeight: 18,
    fontFamily: font.mono,
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    paddingHorizontal: 10,
    paddingVertical: 8
  }
})
