// Início (dentro da conta): conta, instância, aparelho e conexão; Bloquear e Sair. A lista de chats
// chega na fase 2.
import Ionicons from '@expo/vector-icons/Ionicons'
import { useRouter } from 'expo-router'
import { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { account } from '@/account/native'
import { hostOf, useAction, useSession } from '@/account/react'
import type { Connection } from '@/account/session'
import { Button } from '@/ui/Button'
import { Banner, Card, Divider, ListItem, SectionLabel, StatusPill } from '@/ui/Card'
import { ConfirmDialog, Dialog } from '@/ui/Dialog'
import { Screen } from '@/ui/Screen'
import { TextField } from '@/ui/TextField'
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

function RenameDevice({ onClose }: { onClose: () => void }) {
  const s = useSession()
  const [name, setName] = useState(s.device?.name ?? '')
  const { busy, error, run } = useAction()
  return (
    <Dialog
      visible
      withInput
      title="Nome deste aparelho"
      onClose={onClose}
      actions={
        <>
          <Button
            title="Cancelar"
            variant="secondary"
            full={false}
            style={{ flex: 1 }}
            onPress={onClose}
          />
          <Button
            testID="rename-save"
            title="Salvar"
            full={false}
            style={{ flex: 1 }}
            loading={busy}
            disabled={!name.trim()}
            onPress={() =>
              void run(async () => {
                await account.renameDevice(name)
                onClose()
              })
            }
          />
        </>
      }
    >
      <TextField
        testID="rename-input"
        value={name}
        onChangeText={(v) => setName(v.slice(0, 64))}
        icon="phone-portrait-outline"
        autoFocus
        error={error}
        hint="Aparece na lista de dispositivos da conta."
      />
    </Dialog>
  )
}

export default function Home() {
  const s = useSession()
  const router = useRouter()
  const [renaming, setRenaming] = useState(false)
  const lock = useAction()
  const out = useAction()
  const conn = CONNECTION[s.connection]

  const [confirmOut, setConfirmOut] = useState(false)
  const logout = () => setConfirmOut(true)

  return (
    <Screen testID="screen-home">
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.hello}>ClearChat</Text>
          <Text style={styles.email} numberOfLines={1} testID="home-email">
            {s.account?.email}
          </Text>
        </View>
        <StatusPill testID="home-connection" tone={conn.tone} label={conn.label} />
      </View>

      {s.notice ? (
        <Banner
          tone={s.notice.tone}
          title={s.notice.title}
          onClose={() => account.dismissNotice()}
          action={
            s.notice.action === 'new-recovery-key' ? (
              <View style={styles.noticeAction}>
                <Button
                  title="Gerar nova chave"
                  size="sm"
                  full={false}
                  icon="key-outline"
                  onPress={() => router.push('/recovery-key')}
                />
              </View>
            ) : undefined
          }
        >
          {s.notice.text}
        </Banner>
      ) : null}

      <Card style={styles.chats} testID="home-chats">
        <View style={styles.chatsIcon}>
          <Ionicons name="chatbubbles-outline" size={26} color={colors.accentStrong} />
        </View>
        <Text style={styles.chatsTitle}>Suas conversas aparecem aqui</Text>
        <Text style={styles.chatsText}>
          A conta está pronta e os dados estão desbloqueados neste aparelho. A lista de chats e a
          sincronização chegam na próxima versão.
        </Text>
      </Card>

      <SectionLabel>Conta</SectionLabel>
      <Card padded={false}>
        <ListItem
          icon="person-circle-outline"
          title={s.account?.name || 'Conta'}
          subtitle={s.account?.email}
        />
        <Divider />
        <ListItem
          testID="home-server"
          icon={s.server.kind === 'official' ? 'cloud-outline' : 'server-outline'}
          title={s.server.name ?? (s.server.kind === 'official' ? 'ClearChat' : 'Self-host')}
          subtitle={hostOf(s.server.url)}
        />
        <Divider />
        <ListItem
          testID="home-device"
          icon="phone-portrait-outline"
          title={s.device?.name ?? 'Este aparelho'}
          subtitle="Este aparelho · toque para renomear"
          onPress={() => setRenaming(true)}
          chevron
        />
        <Divider />
        <ListItem
          icon={
            s.remember
              ? s.biometric
                ? 'finger-print'
                : 'shield-checkmark-outline'
              : 'shield-outline'
          }
          title={s.remember ? 'Lembrado neste aparelho' : 'Não lembrado'}
          subtitle={
            s.remember
              ? s.biometric
                ? 'Abre com biometria.'
                : 'Abre direto; use Bloquear para pedir a senha.'
              : 'A senha será pedida quando o app abrir de novo.'
          }
        />
      </Card>

      <SectionLabel>Segurança</SectionLabel>
      <Card padded={false}>
        <ListItem
          testID="home-recovery-key"
          icon="key-outline"
          title="Nova chave de recuperação"
          subtitle="Gera outra chave e invalida a anterior."
          onPress={() => router.push('/recovery-key')}
          chevron
        />
      </Card>

      {lock.error || out.error ? <Banner tone="danger">{lock.error ?? out.error}</Banner> : null}
      <View style={styles.actions}>
        <Button
          testID="home-lock"
          title="Bloquear"
          variant="secondary"
          icon="lock-closed-outline"
          loading={lock.busy}
          onPress={() => void lock.run(() => account.lock())}
        />
        <Button
          testID="home-logout"
          title="Sair da conta"
          variant="dangerGhost"
          icon="log-out-outline"
          loading={out.busy}
          onPress={logout}
        />
      </View>
      {renaming ? <RenameDevice onClose={() => setRenaming(false)} /> : null}
      <ConfirmDialog
        visible={confirmOut}
        title="Sair da conta?"
        message="Este aparelho será desconectado da conta e a chave guardada aqui será apagada. Para voltar, entre de novo com o código por e-mail."
        confirmLabel="Sair"
        destructive
        busy={out.busy}
        onClose={() => setConfirmOut(false)}
        onConfirm={() => void out.run(() => account.logout())}
      />
    </Screen>
  )
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginTop: spacing.sm },
  hello: { color: colors.fg, fontSize: 26, fontWeight: '700' },
  email: { color: colors.muted, fontSize: 14, marginTop: 2 },
  noticeAction: { marginTop: spacing.sm, flexDirection: 'row' },
  chats: { alignItems: 'center', paddingVertical: spacing.xl, gap: spacing.sm },
  chatsIcon: {
    width: 52,
    height: 52,
    borderRadius: 16,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xs
  },
  chatsTitle: { color: colors.fg, fontSize: 16.5, fontWeight: '600', textAlign: 'center' },
  chatsText: { color: colors.muted, fontSize: 14, lineHeight: 20, textAlign: 'center' },
  actions: { gap: spacing.sm, marginTop: spacing.xs }
})
