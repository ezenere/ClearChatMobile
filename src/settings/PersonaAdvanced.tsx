// Partes "avançadas" do editor de persona (= desktop: SignatureSection, ContextSettingsSection e
// RootOptions do painel/persona): janela de contexto e compactação, assinatura do app (headers
// HTTP-Referer / X-Title) e as opções que só valem no computador (raiz, sandbox, bloco de ambiente).
// O diretório raiz da persona é local de cada dispositivo (§4.3.3/§4.4) — não aparece aqui.
import { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import {
  APP_SIGNATURES,
  normalizeAppSignatureId,
  resolveAppSignatureHeaders
} from '@shared/appSignatures'
import { DEFAULT_COMPACT_PROMPT, DEFAULT_COMPACT_THRESHOLD } from '@shared/defaults'
import type { ChatConfig } from '@shared/types'
import { FieldLabel, Multiline, Note, NumberField, Row } from '@/settings/ui'
import { TextButton } from '@/ui/Button'
import { Card, Divider, ToggleRow } from '@/ui/Card'
import { TextField } from '@/ui/TextField'
import { colors, spacing } from '@/ui/theme'

type Patch = (p: Partial<ChatConfig>) => void
interface Props {
  cfg: Partial<ChatConfig>
  patch: Patch
}

/** Janela de contexto (manual), limite da compactação e prompt de compactação. */
export function ContextEditor({ cfg, patch }: Props) {
  const override = cfg.contextWindow != null && cfg.contextWindow > 0
  const pct = Math.round((cfg.compactThreshold ?? DEFAULT_COMPACT_THRESHOLD) * 100)
  const [promptOpen, setPromptOpen] = useState(cfg.compactPrompt != null)
  return (
    <>
      <FieldLabel>Janela e compactação</FieldLabel>
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
      <FieldLabel
        right={
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
        }
      >
        Prompt de compactação
      </FieldLabel>
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
          ? 'Personalizado nesta persona.'
          : 'Padrão do app (o resumo que substitui o histórico ao compactar).'}
      </Note>
    </>
  )
}

/** Assinatura do app: headers de atribuição de cada request (o OpenRouter usa; outros ignoram). */
export function SignatureEditor({ cfg, patch }: Props) {
  const id = normalizeAppSignatureId(cfg.appSignature)
  const custom = cfg.appSignatureCustom ?? { referer: '', title: '' }
  const headers = resolveAppSignatureHeaders(id, cfg.appSignatureCustom)
  const lines = Object.entries(headers).map(([k, v]) => `${k}: ${v}`)
  return (
    <>
      <FieldLabel>Assinatura do app</FieldLabel>
      <Card padded={false}>
        {APP_SIGNATURES.map((s, i) => (
          <View key={s.id}>
            {i ? <Divider /> : null}
            <Row
              title={s.label}
              subtitle={s.referer ?? (s.id === 'none' ? 'Não envia os headers' : null)}
              onPress={() =>
                patch(
                  s.id === 'custom'
                    ? { appSignature: s.id, appSignatureCustom: custom }
                    : { appSignature: s.id }
                )
              }
              right={id === s.id ? <Text style={st.check}>✓</Text> : null}
              testID={`persona-signature-${s.id}`}
            />
          </View>
        ))}
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
export function ComputerOptions({ cfg, patch }: Props) {
  return (
    <>
      <FieldLabel>No computador</FieldLabel>
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
        <View style={st.row}>
          <ToggleRow
            title="Bloco de ambiente"
            subtitle="Raiz, SO, shell e regras no system prompt."
            value={!!cfg.envInPrompt}
            onChange={(envInPrompt) => patch({ envInPrompt })}
            testID="persona-env"
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

const st = StyleSheet.create({
  row: { paddingHorizontal: spacing.lg, paddingVertical: 2 },
  check: { color: colors.accentStrong, fontSize: 16, fontWeight: '700' }
})
