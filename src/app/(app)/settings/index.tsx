// Configurações (aberta pela lista de chats): a conta no topo e os mesmos grupos do desktop —
// Geral (Novos chats, Personas, Voz), Agente (Aprovações, Memórias, Pesquisa na web) e Conexões
// (Provedores, Dispositivos, Conta). Tudo sincroniza com os outros dispositivos, menos o que é do
// aparelho (§4.4).
import { useRouter, type Href } from 'expo-router'
import { StyleSheet, Text, View } from 'react-native'
import { MEMORY_CATEGORIES } from '@shared/memory'
import { providerKind } from '@shared/providerKinds'
import { ENGINE_META } from '@shared/webSearchSettings'
import { readVoiceSettings } from '@/voice/endpoints'
import { KIND_SHORT } from '@/settings/records'
import { useSession } from '@/account/react'
import type { Connection } from '@/account/session'
import { readAt, settings, useSettingsVersion } from '@/settings/react'
import { SettingsScreen } from '@/settings/ui'
import { usePushPrefs } from '@/push/react'
import { Banner, Card, Divider, ListItem, SectionLabel, StatusPill } from '@/ui/Card'
import type { IconName } from '@/ui/Button'
import { colors, spacing } from '@/ui/theme'

const CONNECTION: Record<
  Connection,
  { tone: 'success' | 'warning' | 'danger' | 'muted'; label: string }
> = {
  online: { tone: 'success', label: 'Conectado' },
  connecting: { tone: 'warning', label: 'Conectando…' },
  offline: { tone: 'muted', label: 'Offline' },
  error: { tone: 'danger', label: 'Erro de conexão' }
}

function summary() {
  const providers = settings.providers()
  const presets = settings.presets()
  const cols = (() => {
    try {
      return settings.collections()
    } catch {
      return []
    }
  })()
  const engines = settings.engines().filter((e) => e.enabled && !e.desktopOnly)
  const def = settings.setting<{ providerId?: string | null; model?: string | null }>(
    'defaultModel'
  )
  const memories = cols.reduce((n, c) => n + (c.count ?? 0), 0)
  return {
    providers: providers.length
      ? `${providers.length} · ${[...new Set(providers.map((p) => KIND_SHORT[providerKind(p)]))].join(', ')}`
      : 'Nenhum provedor',
    presets: presets.length
      ? presets
          .slice(0, 3)
          .map((p) => p.name)
          .join(', ') + (presets.length > 3 ? ` e mais ${presets.length - 3}` : '')
      : 'Nenhuma persona',
    memory: cols.length
      ? `${cols.length} ${cols.length === 1 ? 'coleção' : 'coleções'} em ${new Set(cols.map((c) => c.category)).size}/${MEMORY_CATEGORIES.length} categorias · ${memories} ${memories === 1 ? 'memória' : 'memórias'}`
      : 'Nenhuma coleção',
    web: engines.length
      ? engines.map((e) => ENGINE_META[e.id].label).join(' → ')
      : 'Nenhum buscador habilitado',
    defaults: def?.model ? `Modelo padrão: ${def.model}` : 'Modelo padrão não definido',
    voice: (() => {
      const v = readVoiceSettings((id) => settings.setting(id))
      const name = (id: string | null) => providers.find((p) => p.id === id)?.name
      const stt =
        v.stt.mode === 'local'
          ? 'local (computador)'
          : (name(v.stt.api.providerId) ?? 'sem provedor')
      const tts =
        v.tts.backend !== 'api'
          ? 'local (computador)'
          : (name(v.tts.api.providerId) ?? 'sem provedor')
      return `Ditado e chamada · transcrição: ${stt} · fala: ${tts}`
    })()
  }
}

export default function SettingsHome() {
  const s = useSession()
  const router = useRouter()
  const version = useSettingsVersion()
  const sum = readAt(version, summary)
  const conn = CONNECTION[s.connection]
  const push = usePushPrefs()
  const notifSummary = push.enabled
    ? `Neste aparelho: ${[push.pending && 'pendências', push.reply && 'respostas', push.error && 'erros', push.hostOffline && 'host offline'].filter(Boolean).join(', ') || 'nenhum tipo'}`
    : 'Desligadas neste aparelho'
  const go = (href: Href) => () => router.push(href)
  const item = (
    href: Href,
    icon: IconName,
    title: string,
    subtitle: string,
    testID: string,
    last = false
  ) => (
    <>
      <ListItem
        icon={icon}
        title={title}
        subtitle={subtitle}
        onPress={go(href)}
        chevron
        testID={testID}
      />
      {last ? null : <Divider />}
    </>
  )

  return (
    <SettingsScreen title="Configurações" testID="screen-settings">
      <View style={st.top}>
        <View style={{ flex: 1 }}>
          <Text style={st.name} numberOfLines={1}>
            {s.account?.name || 'ClearChat'}
          </Text>
          <Text style={st.email} numberOfLines={1} testID="home-email">
            {s.account?.email}
          </Text>
        </View>
        <StatusPill testID="home-connection" tone={conn.tone} label={conn.label} />
      </View>
      {s.notice?.action === 'new-recovery-key' ? (
        <Banner tone={s.notice.tone} title={s.notice.title}>
          {s.notice.text}
        </Banner>
      ) : null}

      <SectionLabel>Geral</SectionLabel>
      <Card padded={false}>
        {item(
          '/settings/defaults',
          'add-circle-outline',
          'Novos chats',
          sum.defaults,
          'settings-defaults'
        )}
        {item('/settings/personas', 'people-outline', 'Personas', sum.presets, 'settings-personas')}
        {item('/settings/voice', 'mic-outline', 'Voz', sum.voice, 'settings-voice')}
        {item(
          '/settings/notifications',
          'notifications-outline',
          'Notificações',
          notifSummary,
          'settings-notifications',
          true
        )}
      </Card>

      <SectionLabel>Agente</SectionLabel>
      <Card padded={false}>
        {item(
          '/settings/approvals',
          'shield-checkmark-outline',
          'Aprovações',
          'Modo de cada ferramenta, listas e Smart-Approve',
          'settings-approvals'
        )}
        {item('/settings/memory', 'library-outline', 'Memórias', sum.memory, 'settings-memory')}
        {item('/settings/web', 'globe-outline', 'Pesquisa na web', sum.web, 'settings-web', true)}
      </Card>

      <SectionLabel>Conexões</SectionLabel>
      <Card padded={false}>
        {item(
          '/settings/providers',
          'server-outline',
          'Provedores',
          sum.providers,
          'settings-providers'
        )}
        {item(
          '/settings/devices',
          'phone-portrait-outline',
          'Dispositivos',
          `${s.device?.name ?? 'Este aparelho'} e os outros da conta`,
          'settings-devices'
        )}
        {item(
          '/settings/account',
          'person-circle-outline',
          'Conta',
          'Senha, chave de recuperação, bloquear e sair',
          'settings-account',
          true
        )}
      </Card>
      <Text style={st.foot}>
        As configurações sincronizam com o computador e o site (cifradas). Ficam só aqui: este
        aparelho lembrado, a biometria e as notificações.
      </Text>
    </SettingsScreen>
  )
}

const st = StyleSheet.create({
  top: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginTop: spacing.sm },
  name: { color: colors.fg, fontSize: 22, fontWeight: '700' },
  email: { color: colors.muted, fontSize: 14, marginTop: 2 },
  foot: { color: colors.faint, fontSize: 12, lineHeight: 17, marginTop: spacing.sm }
})
