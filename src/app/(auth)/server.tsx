// Escolha do servidor (§20.1, estilo Jellyfin): instância oficial ou self-host validado com
// GET <base>/api/info (protocolo compatível) — mostra o nome da instância antes de salvar.
import Ionicons from '@expo/vector-icons/Ionicons'
import { useRouter } from 'expo-router'
import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { account } from '@/account/native'
import { hostOf, useAction, useSession } from '@/account/react'
import { OFFICIAL_SYNC_LABEL, type SyncServerInfo, type SyncServerKind } from '@shared/sync'
import { normalizeBaseUrl, SyncNetworkError } from '@vendor/desktop/sync/http'
import { UserError } from '@/account/errors'
import { Button } from '@/ui/Button'
import { Banner, Card } from '@/ui/Card'
import { Hero, Screen, ScreenHeader } from '@/ui/Screen'
import { TextField } from '@/ui/TextField'
import { colors, radius, spacing } from '@/ui/theme'

function Option({
  selected,
  onPress,
  icon,
  title,
  subtitle,
  testID
}: {
  selected: boolean
  onPress: () => void
  icon: 'cloud-outline' | 'server-outline'
  title: string
  subtitle: string
  testID: string
}) {
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityLabel={title}
      accessibilityState={{ selected }}
      style={({ pressed }) => [
        styles.option,
        selected && styles.optionOn,
        pressed && !selected && { backgroundColor: colors.hover }
      ]}
    >
      <View style={[styles.optionIcon, selected && { backgroundColor: colors.accent }]}>
        <Ionicons name={icon} size={20} color={selected ? '#fff' : colors.accentStrong} />
      </View>
      <View style={styles.optionText}>
        <Text style={styles.optionTitle}>{title}</Text>
        <Text style={styles.optionSub}>{subtitle}</Text>
      </View>
      <View style={[styles.radio, selected && styles.radioOn]}>
        {selected ? <View style={styles.radioDot} /> : null}
      </View>
    </Pressable>
  )
}

export default function Server() {
  const s = useSession()
  const router = useRouter()
  const [kind, setKind] = useState<SyncServerKind>(s.server.kind)
  const [url, setUrl] = useState(s.server.kind === 'self' ? s.server.url : '')
  const [checked, setChecked] = useState<SyncServerInfo | null>(null)
  const check = useAction()
  const save = useAction()

  const verify = () =>
    void check.run(async () => {
      setChecked(null)
      try {
        setChecked(await account.probeServer(url))
      } catch (e) {
        // sem esquema vira https:// (§20.1): servidor local em http:// precisa do esquema explícito
        if (e instanceof SyncNetworkError && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url.trim()))
          throw new UserError(
            'Não foi possível conectar por https://. Se o servidor usa http:// (rede local), digite o endereço com http:// no início.'
          )
        throw e
      }
    })

  const urlChanged = (v: string) => {
    setUrl(v)
    setChecked(null)
    check.setError(null)
  }

  let normalized: string | null = null
  try {
    normalized = url.trim() ? normalizeBaseUrl(url) : null
  } catch {
    normalized = null
  }
  const verified = !!checked && checked.url === normalized

  const apply = () =>
    void save.run(async () => {
      await account.setServer(kind, kind === 'self' ? url : undefined)
      router.back()
    })

  return (
    <Screen
      testID="screen-server"
      header={<ScreenHeader title="Servidor" onBack={() => router.back()} />}
      footer={
        <Button
          testID="server-save"
          title="Usar este servidor"
          icon="checkmark"
          loading={save.busy}
          disabled={kind === 'self' && !verified}
          onPress={apply}
        />
      }
    >
      <Hero
        title="Onde fica sua conta?"
        subtitle="O ClearChat sincroniza com a instância oficial ou com um servidor próprio (self-host). Seus dados vão cifrados ponta a ponta nos dois casos."
      />
      <View style={styles.options}>
        <Option
          testID="server-official"
          selected={kind === 'official'}
          onPress={() => setKind('official')}
          icon="cloud-outline"
          title="ClearChat (oficial)"
          subtitle={OFFICIAL_SYNC_LABEL}
        />
        <Option
          testID="server-self"
          selected={kind === 'self'}
          onPress={() => setKind('self')}
          icon="server-outline"
          title="Self-host"
          subtitle="Endereço do seu servidor"
        />
      </View>

      {kind === 'self' ? (
        <Card>
          <TextField
            testID="server-url"
            label="Endereço do servidor"
            value={url}
            onChangeText={urlChanged}
            placeholder="https://chat.exemplo.com"
            icon="link-outline"
            keyboardType="url"
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="go"
            onSubmitEditing={verify}
            error={check.error}
            hint="esquema://host[:porta][/caminho] — sem esquema, usa https://"
          />
          {verified && checked ? (
            <View style={styles.found} testID="server-found">
              <Ionicons name="checkmark-circle" size={20} color={colors.success} />
              <View style={{ flex: 1 }}>
                <Text style={styles.foundName}>{checked.name}</Text>
                <Text style={styles.foundSub}>
                  {hostOf(checked.url)}
                  {checked.protocol.version ? ` · protocolo ${checked.protocol.version}` : ''}
                </Text>
              </View>
            </View>
          ) : (
            <Button
              testID="server-verify"
              title={check.busy ? 'Verificando…' : 'Verificar servidor'}
              variant="secondary"
              icon="pulse-outline"
              loading={check.busy}
              disabled={!url.trim()}
              onPress={verify}
            />
          )}
        </Card>
      ) : null}

      {kind === 'self' && verified && checked?.insecure ? (
        <Banner tone="warning" title="Sem criptografia de transporte (http://)">
          Use só em rede local. Os dados continuam cifrados ponta a ponta, mas o login e os
          metadados trafegam abertos.
        </Banner>
      ) : null}
      {save.error ? <Banner tone="danger">{save.error}</Banner> : null}
    </Screen>
  )
}

const styles = StyleSheet.create({
  options: { gap: spacing.md },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface
  },
  optionOn: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  optionIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center'
  },
  optionText: { flex: 1, gap: 2 },
  optionTitle: { color: colors.fg, fontSize: 16, fontWeight: '600' },
  optionSub: { color: colors.muted, fontSize: 13.5 },
  radio: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: colors.faint,
    alignItems: 'center',
    justifyContent: 'center'
  },
  radioOn: { borderColor: colors.accent },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.accent },
  found: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.successSoft,
    borderWidth: 1,
    borderColor: 'rgba(74, 222, 128, 0.3)'
  },
  foundName: { color: colors.fg, fontSize: 15.5, fontWeight: '600' },
  foundSub: { color: colors.muted, fontSize: 13 }
})
