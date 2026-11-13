// Configurações → Novos chats (= desktop): persona padrão do Novo chat, modelo padrão (o par
// provedor + modelo), system prompt padrão, título automático (modelo, memórias, limite de tokens,
// prompt) e o limite de saída das ferramentas. Settings `defaultPresetId`, `defaultModel`,
// `defaultSystemPrompt`, `autoTitle` e `toolOutputSpillChars` (sincronizados). A pasta de
// trabalho padrão é do computador (§4.4) e não aparece aqui.
import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import {
  AUTO_TITLE_DEFAULTS,
  normalizeAutoTitleSettings,
  type AutoTitleSettings
} from '@shared/autoTitle'
import { DEFAULT_AUTO_TITLE_PROMPT, DEFAULT_SYSTEM_PROMPT } from '@shared/defaults'
import { clampSpillChars, LIMITS, TOOL_SPILL_SETTING } from '@shared/limits'
import { ChatAvatar } from '@/chat/ChatBits'
import { ModelField } from '@/settings/ModelPicker'
import { readAt, settings, useSettingsVersion } from '@/settings/react'
import { FieldLabel, Multiline, Note, NumberField, SettingsScreen } from '@/settings/ui'
import { TextButton } from '@/ui/Button'
import { Card, Divider, ToggleRow } from '@/ui/Card'
import { colors, spacing } from '@/ui/theme'

function read() {
  const def = settings.setting<{ providerId?: string | null; model?: string | null }>(
    'defaultModel'
  )
  return {
    providers: settings.providers(),
    presets: settings.presets(),
    defaultPresetId: settings.setting<string>('defaultPresetId') ?? null,
    defaultModel:
      def?.providerId && def?.model ? { providerId: def.providerId, model: def.model } : null,
    prompt: settings.setting<string>('defaultSystemPrompt') ?? DEFAULT_SYSTEM_PROMPT,
    autoTitle: normalizeAutoTitleSettings(settings.setting('autoTitle')),
    spill: clampSpillChars(settings.setting(TOOL_SPILL_SETTING))
  }
}

/** Texto longo salvo ao sair do campo; muda de fora (outro dispositivo) → acompanha. */
function useDraft(value: string): [string, (v: string) => void] {
  const [text, setText] = useState(value)
  const [seen, setSeen] = useState(value)
  if (value !== seen) {
    setSeen(value)
    setText(value)
  }
  return [text, setText]
}

export default function DefaultsSettings() {
  const version = useSettingsVersion()
  const d = readAt(version, read)
  const [prompt, setPrompt] = useDraft(d.prompt)
  const [titlePrompt, setTitlePrompt] = useDraft(d.autoTitle.prompt ?? DEFAULT_AUTO_TITLE_PROMPT)
  const setAutoTitle = (p: Partial<AutoTitleSettings>) =>
    settings.setSetting('autoTitle', normalizeAutoTitleSettings({ ...d.autoTitle, ...p }))
  const defaultPresetValid = d.presets.some((p) => p.id === d.defaultPresetId)

  return (
    <SettingsScreen title="Novos chats" testID="screen-defaults">
      <FieldLabel>Persona padrão do Novo chat</FieldLabel>
      <Card padded={false}>
        {[
          ...d.presets.map((p) => ({ id: p.id, name: p.name, icon: p.icon, desc: p.description })),
          null
        ].map((p, i) => {
          const on = p ? p.id === d.defaultPresetId : !defaultPresetValid
          return (
            <View key={p?.id ?? 'none'}>
              {i ? <Divider /> : null}
              <Pressable
                onPress={() => settings.setSetting('defaultPresetId', p?.id ?? null)}
                style={({ pressed }) => [st.option, pressed && { backgroundColor: colors.hover }]}
                accessibilityRole="radio"
                accessibilityState={{ checked: on }}
                testID={`default-preset-${p?.name ?? 'nenhuma'}`}
              >
                {p ? <ChatAvatar icon={p.icon} size={30} /> : <View style={{ width: 30 }} />}
                <View style={{ flex: 1 }}>
                  <Text style={st.optTitle} numberOfLines={1}>
                    {p ? p.name : 'Nenhuma (só os padrões abaixo)'}
                  </Text>
                  {p?.desc ? (
                    <Text style={st.optSub} numberOfLines={1}>
                      {p.desc}
                    </Text>
                  ) : null}
                </View>
                <View style={[st.radio, on && st.radioOn]}>
                  {on ? <View style={st.radioDot} /> : null}
                </View>
              </Pressable>
            </View>
          )
        })}
      </Card>
      <Note>
        Os padrões abaixo valem para os campos que a persona não define (a persona “Padrão” não
        define nenhum) e quando não há persona.
      </Note>
      <Note style={{ marginTop: -spacing.sm }}>
        <Text testID="defaults-inherit-note">
          Personas que não definem um campo usam estes padrões — e os chats delas também, ao vivo:
          mudar aqui muda esses chats (menos os campos que um chat mudou para si).
        </Text>
      </Note>

      <FieldLabel>Modelo padrão</FieldLabel>
      <ModelField
        providers={d.providers}
        value={d.defaultModel}
        onChange={(v) => settings.setSetting('defaultModel', v ? v : null)}
        placeholder="Não definido"
        noneLabel="Não definido"
        testID="default-model"
      />

      <FieldLabel
        right={
          prompt !== DEFAULT_SYSTEM_PROMPT ? (
            <TextButton
              title="Restaurar padrão"
              icon="refresh-outline"
              onPress={() => {
                setPrompt(DEFAULT_SYSTEM_PROMPT)
                settings.setSetting('defaultSystemPrompt', DEFAULT_SYSTEM_PROMPT)
              }}
            />
          ) : undefined
        }
      >
        System prompt padrão
      </FieldLabel>
      <Multiline
        testID="default-system-prompt"
        value={prompt}
        onChangeText={setPrompt}
        onBlur={() => prompt !== d.prompt && settings.setSetting('defaultSystemPrompt', prompt)}
        minHeight={120}
      />

      <FieldLabel>Título automático</FieldLabel>
      <ModelField
        providers={d.providers}
        value={
          d.autoTitle.providerId
            ? { providerId: d.autoTitle.providerId, model: d.autoTitle.model }
            : null
        }
        onChange={(v) =>
          setAutoTitle({ providerId: v?.providerId ?? null, model: v?.model ?? null })
        }
        placeholder="Nenhum (desligado)"
        noneLabel="Nenhum (desligado)"
        testID="auto-title-model"
      />
      <Card>
        <ToggleRow
          title="Usar as memórias"
          subtitle="Manda um índice compacto das memórias ativas do chat junto com a 1ª mensagem."
          value={d.autoTitle.useMemory}
          onChange={(useMemory) => setAutoTitle({ useMemory })}
          testID="auto-title-memory"
        />
        <NumberField
          label="Limite de tokens"
          value={d.autoTitle.maxTokens}
          min={AUTO_TITLE_DEFAULTS.minMaxTokens}
          max={AUTO_TITLE_DEFAULTS.maxMaxTokens}
          onChange={(v) => setAutoTitle({ maxTokens: v ?? AUTO_TITLE_DEFAULTS.maxTokens })}
          testID="auto-title-tokens"
        />
      </Card>
      <FieldLabel
        right={
          d.autoTitle.prompt ? (
            <TextButton
              title="Restaurar padrão"
              icon="refresh-outline"
              onPress={() => {
                setTitlePrompt(DEFAULT_AUTO_TITLE_PROMPT)
                setAutoTitle({ prompt: null })
              }}
            />
          ) : undefined
        }
      >
        Prompt de geração do título
      </FieldLabel>
      <Multiline
        testID="auto-title-prompt"
        value={titlePrompt}
        onChangeText={setTitlePrompt}
        onBlur={() =>
          setAutoTitle({
            prompt:
              titlePrompt.trim() && titlePrompt !== DEFAULT_AUTO_TITLE_PROMPT ? titlePrompt : null
          })
        }
        minHeight={110}
      />
      <Note>
        Uma chamada separada, quando um chat novo recebe a primeira mensagem digitada — fora do
        histórico e sem atrasar o turno.
      </Note>

      <FieldLabel>Ferramentas</FieldLabel>
      <Card>
        <NumberField
          label="Saída grande vai para arquivo acima de"
          value={d.spill}
          min={LIMITS.spillThresholdMin}
          max={LIMITS.spillThresholdMax}
          suffix="car."
          onChange={(v) => settings.setSetting(TOOL_SPILL_SETTING, v ?? null)}
          testID="tool-spill"
        />
        <Note>
          No computador, saídas de ferramentas maiores que isso são guardadas em arquivo e o modelo
          recebe um trecho. No celular as saídas são cortadas no limite do chat.
        </Note>
      </Card>
      <View style={{ height: spacing.lg }} />
    </SettingsScreen>
  )
}

const st = StyleSheet.create({
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: 11
  },
  optTitle: { color: colors.fg, fontSize: 15 },
  optSub: { color: colors.subtle, fontSize: 12.5 },
  radio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center'
  },
  radioOn: { borderColor: colors.accent },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.accent }
})
