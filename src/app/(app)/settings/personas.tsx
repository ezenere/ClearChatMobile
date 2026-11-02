// Configurações → Personas (= desktop): presets de chat sincronizados — modelo, system prompt,
// parâmetros, tools, memória. Escolhidas no Novo chat; a estrela define a que vem selecionada
// (setting `defaultPresetId`). Toque longo: duplicar, definir como padrão, apagar.
import Ionicons from '@expo/vector-icons/Ionicons'
import { useRouter } from 'expo-router'
import { useState } from 'react'
import { Pressable, View } from 'react-native'
import type { Preset } from '@shared/types'
import { ChatAvatar } from '@/chat/ChatBits'
import { resolvePresetConfig } from '@/settings/records'
import { readAt, settings, useSettingsVersion } from '@/settings/react'
import { Note, Row, SettingsScreen } from '@/settings/ui'
import { Button } from '@/ui/Button'
import { Card, Divider } from '@/ui/Card'
import { ConfirmDialog } from '@/ui/Dialog'
import { Sheet, SheetItem } from '@/ui/Sheet'
import { useToast } from '@/ui/Toast'
import { colors } from '@/ui/theme'

/** "Define modelo, tools…" quando não há descrição (= `presetSummary` do desktop). */
const LABELS: Record<string, string> = {
  providerId: 'modelo',
  model: 'modelo',
  systemPrompt: 'system prompt',
  params: 'parâmetros',
  enabledTools: 'tools',
  nativeTools: 'tools',
  toolsInPrompt: 'tools',
  toolsPromptText: 'tools',
  approvalModes: 'aprovação',
  subagentSystemPrompt: 'subagentes',
  memory: 'memória',
  voice: 'voz',
  contextWindow: 'contexto',
  compactThreshold: 'contexto',
  autoCompact: 'contexto',
  compactPrompt: 'contexto'
}
function summary(p: Preset): string {
  const labels = [...new Set(Object.keys(p.config).map((k) => LABELS[k] ?? k))]
  if (!labels.length) return 'Segue os padrões de “Novos chats”'
  return `Define ${labels.slice(0, 3).join(', ')}${labels.length > 3 ? ` e mais ${labels.length - 3}` : ''}`
}

function read() {
  const def = {
    defaultModel: settings.setting<{ providerId?: string | null; model?: string | null }>(
      'defaultModel'
    ),
    defaultSystemPrompt: settings.setting<string>('defaultSystemPrompt') ?? null
  }
  const providers = settings.providers()
  return {
    defaultId: settings.setting<string>('defaultPresetId') ?? null,
    list: settings.presets().map((p) => ({
      p,
      model: resolvePresetConfig(def, providers, p.config).cfg.model
    }))
  }
}

export default function Personas() {
  const router = useRouter()
  const toast = useToast()
  const version = useSettingsVersion()
  const { list, defaultId } = readAt(version, read)
  const [menu, setMenu] = useState<Preset | null>(null)
  const [del, setDel] = useState<Preset | null>(null)
  const open = (id: string) => router.push({ pathname: '/settings/persona/[id]', params: { id } })

  return (
    <SettingsScreen
      title="Personas"
      testID="screen-personas"
      footer={
        <Button title="Nova persona" icon="add" onPress={() => open('new')} testID="persona-add" />
      }
    >
      <Note>
        Presets de chat: modelo, system prompt, parâmetros, tools e memória. Escolha uma no Novo
        chat; a estrela marca a que vem selecionada. Toque e segure para mais opções.
      </Note>
      {list.length ? (
        <Card padded={false}>
          {list.map(({ p, model }, i) => (
            <View key={p.id}>
              {i ? <Divider /> : null}
              <Row
                testID={`persona-row-${p.name}`}
                left={<ChatAvatar icon={p.icon} size={36} />}
                title={p.name || 'Persona'}
                badge={p.id === defaultId ? 'padrão' : null}
                subtitle={`${model || 'sem modelo'} · ${p.description || summary(p)}`}
                onPress={() => open(p.id)}
                onLongPress={() => setMenu(p)}
                right={
                  <Pressable
                    onPress={() => settings.setSetting('defaultPresetId', p.id)}
                    hitSlop={10}
                    accessibilityLabel={
                      p.id === defaultId ? 'Persona padrão' : `Definir ${p.name} como padrão`
                    }
                    testID={`persona-star-${p.name}`}
                  >
                    <Ionicons
                      name={p.id === defaultId ? 'star' : 'star-outline'}
                      size={20}
                      color={p.id === defaultId ? colors.accentStrong : colors.subtle}
                    />
                  </Pressable>
                }
              />
            </View>
          ))}
        </Card>
      ) : (
        <Note>Nenhuma persona. Chats novos usam os padrões de “Novos chats”.</Note>
      )}
      <Sheet
        visible={!!menu}
        onClose={() => setMenu(null)}
        title={menu?.name ?? ''}
        testID="persona-menu"
      >
        <SheetItem
          icon="create-outline"
          label="Editar"
          onPress={() => {
            if (!menu) return
            setMenu(null)
            open(menu.id)
          }}
        />
        <SheetItem
          icon="copy-outline"
          label="Duplicar"
          testID="persona-duplicate"
          onPress={() => {
            if (!menu) return
            const copy = settings.duplicatePreset(menu.id)
            setMenu(null)
            toast(`Persona “${copy.name}” criada`)
          }}
        />
        <SheetItem
          icon="star-outline"
          label="Definir como padrão do Novo chat"
          onPress={() => {
            if (!menu) return
            settings.setSetting('defaultPresetId', menu.id)
            setMenu(null)
          }}
        />
        <SheetItem
          icon="trash-outline"
          label="Apagar"
          danger
          testID="persona-delete"
          onPress={() => {
            setDel(menu)
            setMenu(null)
          }}
        />
      </Sheet>
      <ConfirmDialog
        visible={!!del}
        title={`Apagar “${del?.name ?? ''}”?`}
        message="A persona some de todos os seus dispositivos. Os chats criados com ela continuam como estão."
        confirmLabel="Apagar"
        destructive
        onClose={() => setDel(null)}
        onConfirm={() => {
          if (!del) return
          settings.deletePreset(del.id)
          setDel(null)
          toast('Persona apagada')
        }}
      />
    </SettingsScreen>
  )
}
