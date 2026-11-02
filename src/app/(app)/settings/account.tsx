// Configurações → Conta: conta e instância, este aparelho (renomear), lembrar/biometria, dados no
// aparelho, segurança (trocar senha de criptografia, nova chave de recuperação), bloquear e sair.
import { useRouter } from 'expo-router'
import { useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { account } from '@/account/native'
import { hostOf, useAction, useSession } from '@/account/react'
import { syncLabel } from '@/chat/ChatBits'
import { engine, store, useSyncStatus } from '@/data/react'
import { SettingsScreen } from '@/settings/ui'
import { RenameDialog } from '@/settings/RenameDialog'
import { Button } from '@/ui/Button'
import { Banner, Card, Divider, ListItem, SectionLabel, ToggleRow } from '@/ui/Card'
import { ConfirmDialog } from '@/ui/Dialog'
import { useToast } from '@/ui/Toast'
import { spacing } from '@/ui/theme'

export default function AccountSettings() {
  const s = useSession()
  const router = useRouter()
  const toast = useToast()
  const [renaming, setRenaming] = useState(false)
  const lock = useAction()
  const out = useAction()
  const remember = useAction()
  const sync = useSyncStatus()
  const stats = store.stats()
  const [confirmOut, setConfirmOut] = useState(false)
  const bio = account.canUseBiometrics

  return (
    <SettingsScreen title="Conta" testID="screen-home">
      {s.notice ? (
        <Banner
          tone={s.notice.tone}
          title={s.notice.title}
          onClose={() => account.dismissNotice()}
          action={
            s.notice.action === 'new-recovery-key' ? (
              <View style={st.noticeAction}>
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
      </Card>

      <SectionLabel>Neste aparelho</SectionLabel>
      <Card padded={false}>
        <View style={st.pad}>
          <ToggleRow
            title="Lembrar neste aparelho"
            subtitle={
              s.remember
                ? 'Abre direto; use Bloquear para pedir a senha.'
                : 'A senha será pedida quando o app abrir de novo.'
            }
            value={s.remember}
            disabled={remember.busy}
            onChange={(v) =>
              void remember.run(async () => {
                await account.setRemember({ remember: v, biometric: v && s.biometric })
                toast(v ? 'Lembrado neste aparelho' : 'A senha será pedida na próxima abertura')
              })
            }
            testID="account-remember"
          />
        </View>
        {bio ? (
          <>
            <Divider />
            <View style={st.pad}>
              <ToggleRow
                title="Exigir biometria"
                subtitle="A chave guardada só abre com a sua digital/rosto."
                value={s.remember && s.biometric}
                disabled={!s.remember || remember.busy}
                onChange={(v) =>
                  void remember.run(() => account.setRemember({ remember: true, biometric: v }))
                }
                testID="account-biometric"
              />
            </View>
          </>
        ) : null}
        <Divider />
        <ListItem
          testID="home-sync"
          icon="sync-outline"
          title={syncLabel(sync).text}
          subtitle={
            sync.lastSyncAt
              ? `Última sincronização: ${new Date(sync.lastSyncAt).toLocaleString('pt-BR')} · ${stats.chats} chats, ${stats.messages} mensagens`
              : 'Ainda não sincronizou.'
          }
          onPress={() => void engine.sync()}
        />
      </Card>
      {remember.error ? <Banner tone="danger">{remember.error}</Banner> : null}

      <SectionLabel>Segurança</SectionLabel>
      <Card padded={false}>
        <ListItem
          testID="account-password"
          icon="lock-closed-outline"
          title="Trocar senha de criptografia"
          subtitle="Os outros dispositivos continuam funcionando."
          onPress={() => router.push('/settings/password')}
          chevron
        />
        <Divider />
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
      <View style={st.actions}>
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
          onPress={() => setConfirmOut(true)}
        />
      </View>
      {renaming ? (
        <RenameDialog
          title="Nome deste aparelho"
          initial={s.device?.name ?? ''}
          onSave={(name) => account.renameDevice(name)}
          onClose={() => setRenaming(false)}
        />
      ) : null}
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
    </SettingsScreen>
  )
}

const st = StyleSheet.create({
  pad: { paddingHorizontal: spacing.lg, paddingVertical: spacing.xs },
  noticeAction: { marginTop: spacing.sm, flexDirection: 'row' },
  actions: { gap: spacing.sm, marginTop: spacing.xs }
})
