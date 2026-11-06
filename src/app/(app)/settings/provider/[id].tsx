// Configurações → Provedores → editar/adicionar: tipo (adaptador), nome, base URL, API key
// (mascarada, nunca logada; tela com FLAG_SECURE), headers extras, "Testar conexão" (lista os
// modelos; no OpenRouter valida a chave em /key), ver os modelos e usar um como padrão, apagar.
import Ionicons from '@expo/vector-icons/Ionicons'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { isChatProviderKind, PROVIDER_KINDS, type ProviderKind } from '@shared/providerKinds'
import { describeError } from '@/account/errors'
import { testProvider, type ProviderTestResult } from '@/agent/providers'
import {
  draftToInput,
  draftWithBaseUrl,
  draftWithKind,
  KIND_DESCRIPTION,
  KIND_SHORT,
  parseHeaders,
  providerDraft,
  providerInputOf,
  type ProviderDraft
} from '@/settings/records'
import { settings } from '@/settings/react'
import { useSession } from '@/account/react'
import { FieldLabel, Multiline, Note, SettingsScreen } from '@/settings/ui'
import { Button } from '@/ui/Button'
import { Banner, Card } from '@/ui/Card'
import { ConfirmDialog } from '@/ui/Dialog'
import { useSecureScreen } from '@/ui/secure'
import { Sheet } from '@/ui/Sheet'
import { TextField } from '@/ui/TextField'
import { useToast } from '@/ui/Toast'
import { colors, radius, spacing } from '@/ui/theme'

const KEY_HINT: Record<ProviderKind, string> = {
  openai: 'Enviada em Authorization: Bearer <chave>.',
  openrouter: 'Enviada em Authorization: Bearer <chave>.',
  anthropic: 'Enviada em x-api-key: <chave>.',
  elevenlabs: 'Enviada em xi-api-key: <chave>.'
}

export default function ProviderEditor() {
  useSecureScreen()
  const { id } = useLocalSearchParams<{ id: string }>()
  const isNew = id === 'new'
  const local = useSession().phase === 'local'
  const router = useRouter()
  const toast = useToast()
  const [initial] = useState(() => (isNew ? null : settings.provider(id)))
  const [draft, setDraft] = useState<ProviderDraft>(() => providerDraft(initial))
  const [error, setError] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<ProviderTestResult | null>(null)
  const [showModels, setShowModels] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const [advanced, setAdvanced] = useState(() => !!draft.headersText)
  const headersErr = typeof parseHeaders(draft.headersText) === 'string'

  const edit = (d: ProviderDraft) => {
    setDraft(d)
    setResult(null)
    setError(null)
  }

  const test = async () => {
    const input = draftToInput(draft)
    if (typeof input === 'string') {
      setResult({ ok: false, error: input })
      return
    }
    setTesting(true)
    setResult(null)
    try {
      setResult(await testProvider(input))
    } finally {
      setTesting(false)
    }
  }

  const save = () => {
    const input = draftToInput(draft)
    if (typeof input === 'string') return setError(input)
    try {
      const pid = settings.saveProvider(
        input,
        isNew ? undefined : id,
        initial ? providerInputOf(initial) : undefined
      )
      toast(isNew ? `Provedor “${input.name}” adicionado` : `Provedor “${input.name}” salvo`)
      if (isNew) router.replace({ pathname: '/settings/provider/[id]', params: { id: pid } })
      else router.back()
    } catch (e) {
      setError(describeError(e))
    }
  }

  const makeDefault = (model: string) => {
    if (isNew) return
    settings.setSetting('defaultModel', { providerId: id, model })
    setShowModels(false)
    toast(`Modelo padrão: ${model}`)
  }

  if (!isNew && !initial)
    return (
      <SettingsScreen title="Provedor">
        <Banner tone="warning">Este provedor não existe mais (pode ter sido apagado).</Banner>
      </SettingsScreen>
    )

  return (
    <SettingsScreen
      title={isNew ? 'Novo provedor' : 'Provedor'}
      testID="screen-provider"
      footer={
        <Button
          title={isNew ? 'Adicionar' : 'Salvar'}
          icon="checkmark"
          onPress={save}
          disabled={!draft.name.trim() || headersErr}
          testID="provider-save"
        />
      }
    >
      <FieldLabel>Tipo / API</FieldLabel>
      <View style={st.kinds}>
        {PROVIDER_KINDS.map((k) => {
          const on = draft.kind === k
          return (
            <Pressable
              key={k}
              onPress={() => edit(draftWithKind(draft, k))}
              style={[st.kind, on && st.kindOn]}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
              testID={`provider-kind-${k}`}
            >
              <Text style={[st.kindText, on && { color: colors.fg }]}>{KIND_SHORT[k]}</Text>
            </Pressable>
          )
        })}
      </View>
      <Note>{KIND_DESCRIPTION[draft.kind]}</Note>

      <TextField
        testID="provider-name"
        label="Nome"
        value={draft.name}
        onChangeText={(name) => edit({ ...draft, name })}
        icon="pricetag-outline"
      />
      <TextField
        testID="provider-url"
        label="Base URL"
        value={draft.baseUrl}
        onChangeText={(v) => edit(draftWithBaseUrl(draft, v))}
        icon="link-outline"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        mono
        hint={
          draft.kind === 'elevenlabs'
            ? 'Fala: POST {baseUrl}/v1/text-to-speech/… · teste: GET {baseUrl}/v1/models'
            : draft.kind === 'anthropic'
              ? 'Chat: POST {baseUrl}/messages · modelos: GET {baseUrl}/models'
              : 'Chat: POST {baseUrl}/chat/completions · modelos: GET {baseUrl}/models'
        }
      />
      <TextField
        testID="provider-key"
        label="API key"
        value={draft.apiKey}
        onChangeText={(apiKey) => edit({ ...draft, apiKey })}
        secure
        mono
        icon="key-outline"
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        importantForAutofill="no"
        placeholder={
          draft.kind === 'anthropic' ? 'sk-ant-…' : draft.kind === 'elevenlabs' ? 'sk_…' : 'sk-…'
        }
        hint={`${KEY_HINT[draft.kind]} ${local ? 'Fica só neste celular' : 'Fica cifrada no sync'}; nos previews de request aparece mascarada.`}
      />

      <Pressable
        onPress={() => setAdvanced((v) => !v)}
        style={st.advanced}
        accessibilityRole="button"
        testID="provider-advanced"
      >
        <Ionicons
          name={advanced ? 'chevron-down' : 'chevron-forward'}
          size={16}
          color={colors.subtle}
        />
        <Text style={st.advancedText}>Headers extras (opcional)</Text>
      </Pressable>
      {advanced ? (
        <>
          <Multiline
            testID="provider-headers"
            value={draft.headersText}
            onChangeText={(headersText) => edit({ ...draft, headersText })}
            placeholder='{ "X-Custom": "valor" }'
            minHeight={80}
            mono
          />
          <Note>
            {headersErr
              ? `JSON inválido: ${String(parseHeaders(draft.headersText))}`
              : 'Objeto JSON de strings mesclado aos headers de todas as requests deste provedor.'}
          </Note>
        </>
      ) : null}

      {error ? <Banner tone="danger">{error}</Banner> : null}
      {result ? (
        <Banner
          tone={result.ok ? 'success' : 'danger'}
          title={result.ok ? 'Conexão ok' : undefined}
        >
          {result.ok
            ? `${result.modelCount ?? 0} modelos disponíveis.`
            : (result.error ?? 'Falha na conexão.')}
        </Banner>
      ) : null}
      <View style={st.row}>
        <Button
          title="Testar conexão"
          variant="secondary"
          icon="flash-outline"
          size="sm"
          full={false}
          style={{ flex: 1 }}
          loading={testing}
          onPress={() => void test()}
          testID="provider-test"
        />
        {result?.models?.length ? (
          <Button
            title={`Ver ${result.models.length} modelos`}
            variant="ghost"
            icon="list-outline"
            size="sm"
            full={false}
            style={{ flex: 1 }}
            onPress={() => setShowModels(true)}
            testID="provider-models"
          />
        ) : null}
      </View>

      {!isNew ? (
        <Card padded={false} style={{ marginTop: spacing.md }}>
          <Button
            title="Apagar provedor"
            variant="dangerGhost"
            icon="trash-outline"
            onPress={() => setConfirmDel(true)}
            testID="provider-delete"
          />
        </Card>
      ) : null}

      <Sheet
        visible={showModels}
        onClose={() => setShowModels(false)}
        title="Modelos"
        subtitle={
          !isNew && isChatProviderKind(draft.kind)
            ? 'Toque num modelo para usá-lo como o modelo padrão dos chats novos.'
            : undefined
        }
        maxHeight="85%"
        testID="provider-models-sheet"
      >
        {(result?.models ?? []).slice(0, 400).map((m) => (
          <Pressable
            key={m.id}
            onPress={() => !isNew && isChatProviderKind(draft.kind) && makeDefault(m.id)}
            style={st.model}
            testID={`provider-model-${m.id}`}
          >
            <Text style={st.modelId} numberOfLines={1}>
              {m.id}
            </Text>
            {m.name && m.name !== m.id ? (
              <Text style={st.modelSub} numberOfLines={1}>
                {m.name}
                {m.contextLength ? ` · ${Math.round(m.contextLength / 1000)}k` : ''}
              </Text>
            ) : null}
          </Pressable>
        ))}
      </Sheet>
      <ConfirmDialog
        visible={confirmDel}
        title={`Apagar “${draft.name}”?`}
        message="O provedor some de todos os seus dispositivos. Chats e personas que usam um modelo dele ficam sem modelo até você escolher outro."
        confirmLabel="Apagar"
        destructive
        onClose={() => setConfirmDel(false)}
        onConfirm={() => {
          settings.deleteProvider(id)
          setConfirmDel(false)
          toast('Provedor apagado')
          router.back()
        }}
      />
    </SettingsScreen>
  )
}

const st = StyleSheet.create({
  kinds: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  kind: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface
  },
  kindOn: { backgroundColor: colors.active, borderColor: colors.accent },
  kindText: { color: colors.muted, fontSize: 13.5 },
  advanced: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 4 },
  advancedText: { color: colors.muted, fontSize: 14 },
  row: { flexDirection: 'row', gap: spacing.sm },
  model: {
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border
  },
  modelId: { color: colors.fg, fontSize: 14.5 },
  modelSub: { color: colors.subtle, fontSize: 12.5 }
})
