// Configurações → Dispositivos (§6.6): os dispositivos da conta (este marcado), online/visto há…,
// renomear (qualquer um, como no desktop) e desconectar os outros com confirmação — revogar apaga
// os tokens do aparelho, fecha o WebSocket dele e o tira de host dos chats (§5.4). Desconectar
// este = sair da conta.
import Ionicons from '@expo/vector-icons/Ionicons'
import { useCallback, useEffect, useState } from 'react'
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { describeError } from '@/account/errors'
import { account } from '@/account/native'
import { useAction, useSession } from '@/account/react'
import type { DeviceRow } from '@/account/service'
import { relativeTime } from '@/chat/format'
import { RenameDialog } from '@/settings/RenameDialog'
import { Note, Row } from '@/settings/ui'
import { TextButton } from '@/ui/Button'
import { Banner, Card, Divider, Spinner } from '@/ui/Card'
import { ConfirmDialog } from '@/ui/Dialog'
import { ScreenHeader } from '@/ui/Screen'
import { useToast } from '@/ui/Toast'
import { colors, spacing } from '@/ui/theme'

const CLIENT: Record<string, string> = { desktop: 'computador', mobile: 'celular', web: 'site' }

function deviceIcon(d: DeviceRow) {
  return d.client === 'mobile'
    ? 'phone-portrait-outline'
    : d.client === 'web'
      ? 'globe-outline'
      : 'desktop-outline'
}

function seen(d: DeviceRow): string {
  if (d.online) return 'online agora'
  const t = d.last_seen_at ? Date.parse(d.last_seen_at) : NaN
  if (!Number.isFinite(t)) return 'nunca conectado'
  const rel = relativeTime(t, Date.now())
  return rel === 'agora'
    ? 'visto agora'
    : /^\d+ (min|h|d)$/.test(rel)
      ? `visto há ${rel}`
      : `visto em ${rel}`
}

export default function Devices() {
  const s = useSession()
  const router = useRouter()
  const toast = useToast()
  const insets = useSafeAreaInsets()
  const [list, setList] = useState<DeviceRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [renaming, setRenaming] = useState<DeviceRow | null>(null)
  const [revoking, setRevoking] = useState<DeviceRow | null>(null)
  const revoke = useAction()

  const load = useCallback(async () => {
    try {
      setList(await account.devices())
      setError(null)
    } catch (e) {
      setError(describeError(e))
    }
  }, [])
  useEffect(() => {
    const t = setTimeout(() => void load(), 0)
    return () => clearTimeout(t)
  }, [load, s.connection])

  const sorted = (list ?? [])
    .slice()
    .sort(
      (a, b) =>
        Number(b.current) - Number(a.current) ||
        Number(b.online) - Number(a.online) ||
        (b.last_seen_at ?? '').localeCompare(a.last_seen_at ?? '')
    )

  return (
    <View style={[st.root, { paddingTop: insets.top }]} testID="screen-devices">
      <ScreenHeader title="Dispositivos" onBack={() => router.back()} />
      <ScrollView
        contentContainerStyle={[st.body, { paddingBottom: insets.bottom + spacing.xl }]}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true)
              void load().finally(() => setRefreshing(false))
            }}
            tintColor={colors.accentStrong}
            colors={[colors.accent]}
            progressBackgroundColor={colors.elevated}
          />
        }
      >
        <Note>
          Cada login é um dispositivo. Desconectar apaga a sessão dele na hora: para voltar, ele
          precisa entrar de novo com o código por e-mail (e a senha de criptografia).
        </Note>
        {error ? <Banner tone="danger">{error}</Banner> : null}
        {revoke.error ? <Banner tone="danger">{revoke.error}</Banner> : null}
        {!list && !error ? <Spinner label="Carregando…" /> : null}
        {list ? (
          <Card padded={false}>
            {sorted.map((d, i) => (
              <View key={d.id}>
                {i ? <Divider /> : null}
                <Row
                  testID={`device-${d.current ? 'current' : d.id}`}
                  left={
                    <View>
                      <Ionicons name={deviceIcon(d)} size={22} color={colors.muted} />
                      <View
                        style={[
                          st.dot,
                          { backgroundColor: d.online ? colors.success : colors.faint }
                        ]}
                      />
                    </View>
                  }
                  title={d.name}
                  badge={d.current ? 'este aparelho' : null}
                  subtitle={`${d.platform} · ${CLIENT[d.client] ?? d.client}${d.app_version ? ` ${d.app_version}` : ''} · ${seen(d)}`}
                  onPress={() => setRenaming(d)}
                  right={
                    d.current ? null : (
                      <TextButton
                        title="Desconectar"
                        tone="danger"
                        onPress={() => setRevoking(d)}
                        testID={`device-revoke-${d.id}`}
                      />
                    )
                  }
                />
              </View>
            ))}
          </Card>
        ) : null}
        <Text style={st.hint}>Toque num dispositivo para renomear.</Text>
      </ScrollView>
      {renaming ? (
        <RenameDialog
          title={renaming.current ? 'Nome deste aparelho' : `Renomear “${renaming.name}”`}
          initial={renaming.name}
          onSave={async (name) => {
            await account.renameDevice(name, renaming.current ? undefined : renaming.id)
            await load()
          }}
          onClose={() => setRenaming(null)}
        />
      ) : null}
      <ConfirmDialog
        visible={!!revoking}
        title={`Desconectar “${revoking?.name ?? ''}”?`}
        message="O dispositivo sai da conta agora: a sessão dele é apagada e os chats que ele executava ficam sem host. Os dados dele não são apagados do servidor."
        confirmLabel="Desconectar"
        destructive
        busy={revoke.busy}
        onClose={() => setRevoking(null)}
        onConfirm={() =>
          void revoke.run(async () => {
            const d = revoking
            if (!d) return
            await account.revokeDevice(d.id)
            setRevoking(null)
            toast(`“${d.name}” desconectado`)
            await load()
          })
        }
      />
    </View>
  )
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  body: { padding: spacing.xl, gap: spacing.md },
  dot: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 9,
    height: 9,
    borderRadius: 5,
    borderWidth: 1.5,
    borderColor: colors.surface
  },
  hint: { color: colors.faint, fontSize: 12 }
})
