// Configurações → Provedores: os endpoints sincronizados (OpenAI-compatible, OpenRouter, Anthropic
// nativa e ElevenLabs só de voz), com a chave mascarada; o do modelo padrão leva o selo "padrão".
import Ionicons from '@expo/vector-icons/Ionicons'
import { useRouter } from 'expo-router'
import { View } from 'react-native'
import { providerKind } from '@shared/providerKinds'
import { KIND_SHORT, maskApiKey } from '@/settings/records'
import { readAt, settings, useSettingsVersion } from '@/settings/react'
import { useSession } from '@/account/react'
import { Note, Row, SettingsScreen } from '@/settings/ui'
import { Button } from '@/ui/Button'
import { Card, Divider } from '@/ui/Card'
import { colors } from '@/ui/theme'

export default function Providers() {
  const router = useRouter()
  const version = useSettingsVersion()
  const local = useSession().phase === 'local'
  const { list, def } = readAt(version, () => ({
    list: settings.providers(),
    def: settings.setting<{ providerId?: string | null }>('defaultModel')?.providerId ?? null
  }))
  return (
    <SettingsScreen
      title="Provedores"
      testID="screen-providers"
      footer={
        <Button
          title="Adicionar provedor"
          icon="add"
          onPress={() =>
            router.push({ pathname: '/settings/provider/[id]', params: { id: 'new' } })
          }
          testID="provider-add"
        />
      }
    >
      <Note>
        Endpoints compatíveis com a API da OpenAI (chat/completions), OpenRouter ou a API nativa da
        Anthropic — e provedores só de voz (ElevenLabs).{' '}
        {local
          ? 'Sem conta, a chave fica só neste celular e vai apenas ao próprio provedor.'
          : 'A chave fica cifrada no sync e só é decifrada nos seus aparelhos.'}
      </Note>
      {list.length ? (
        <Card padded={false}>
          {list.map((p, i) => {
            const kind = providerKind(p)
            const key = maskApiKey(p.apiKey)
            return (
              <View key={p.id}>
                {i ? <Divider /> : null}
                <Row
                  testID={`provider-row-${p.name}`}
                  left={
                    <Ionicons
                      name={kind === 'elevenlabs' ? 'mic-outline' : 'server-outline'}
                      size={20}
                      color={colors.muted}
                    />
                  }
                  title={p.name || 'Provedor'}
                  badge={p.id === def ? 'padrão' : null}
                  subtitle={`${KIND_SHORT[kind]} · ${p.baseUrl.replace(/^https?:\/\//, '')}${key ? ` · ${key}` : ' · sem chave'}`}
                  onPress={() =>
                    router.push({ pathname: '/settings/provider/[id]', params: { id: p.id } })
                  }
                  right={<Ionicons name="chevron-forward" size={18} color={colors.subtle} />}
                />
              </View>
            )
          })}
        </Card>
      ) : (
        <Note>Nenhum provedor ainda. Adicione um para conversar com os modelos.</Note>
      )}
    </SettingsScreen>
  )
}
