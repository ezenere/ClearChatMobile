// Configurações → Localização (preferências DESTE aparelho, nunca sincronizam): estado da permissão
// do sistema (com atalho para as configurações quando negada), precisão (Aproximada/Exata) e a
// aprovação das tools get_location/nearby_places nos chats executados aqui.
import { useCallback, useEffect, useState } from 'react'
import { AppState, Platform, StyleSheet, Text, View } from 'react-native'
import { useLocationPrefs } from '@/location/react'
import {
  locationPrefs,
  openSystemSettings,
  permissionView,
  requestPermission,
  type PermissionView
} from '@/location/native'
import {
  APPROVAL_HINT,
  APPROVAL_LABEL,
  PRECISION_LABEL,
  type LocationApproval
} from '@/location/settings'
import type { Precision } from '@/location/geo'
import { FieldLabel, Note, Segmented, SettingsScreen } from '@/settings/ui'
import { Button } from '@/ui/Button'
import { Banner, Card, StatusPill } from '@/ui/Card'
import { useToast } from '@/ui/Toast'
import { colors, spacing } from '@/ui/theme'

const ios = Platform.OS === 'ios'

function pillOf(v: PermissionView | null): {
  tone: 'success' | 'warning' | 'danger' | 'muted'
  label: string
} {
  if (!v) return { tone: 'muted', label: 'Conferindo…' }
  switch (v.kind) {
    case 'granted':
      return {
        tone: 'success',
        label: v.accuracy === 'full' ? 'Permitida · precisa' : 'Permitida · aproximada'
      }
    case 'services-off':
      return { tone: 'warning', label: 'Localização do aparelho desligada' }
    case 'denied':
      return { tone: 'danger', label: 'Negada' }
    default:
      return { tone: 'muted', label: 'Ainda não pedida' }
  }
}

export default function LocationSettings() {
  const toast = useToast()
  const prefs = useLocationPrefs()
  const [perm, setPerm] = useState<PermissionView | null>(null)
  const [asking, setAsking] = useState(false)

  const refresh = useCallback(async () => {
    setPerm(await permissionView().catch((): PermissionView => ({ kind: 'undetermined' })))
  }, [])

  useEffect(() => {
    const t = setTimeout(() => void refresh(), 0)
    // voltou das configurações do sistema: a permissão pode ter mudado
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'active') void refresh()
    })
    return () => {
      clearTimeout(t)
      sub.remove()
    }
  }, [refresh])

  const ask = () => {
    setAsking(true)
    void (async () => {
      try {
        const p = await requestPermission(prefs.precision)
        if (p.status !== 'granted')
          toast('A permissão de localização não foi concedida.', 'warning')
        await refresh()
      } finally {
        setAsking(false)
      }
    })()
  }

  const setPrecision = (v: Precision) => locationPrefs.set('precision', v)
  const setApproval = (v: LocationApproval) => locationPrefs.set('approval', v)
  const pill = pillOf(perm)
  const reducedButExact =
    prefs.precision === 'exact' &&
    (perm?.kind === 'granted' || perm?.kind === 'services-off') &&
    perm.accuracy === 'reduced'

  return (
    <SettingsScreen title="Localização" testID="screen-location">
      {perm?.kind === 'denied' ? (
        <Banner
          tone="danger"
          title="Localização negada no sistema"
          testID="location-perm-denied"
          action={
            <View style={st.bannerAction}>
              <Button
                title="Abrir configurações do sistema"
                size="sm"
                full={false}
                icon="open-outline"
                onPress={openSystemSettings}
                testID="location-open-settings"
              />
            </View>
          }
        >
          {`O agente não consegue ver onde você está. Para usar “perto de mim”, permita a localização do ClearChat ${ios ? '(“Durante o uso do app”)' : '(“Permitir durante o uso do app”)'} nas configurações do sistema. A busca de lugares por endereço continua funcionando.`}
        </Banner>
      ) : perm?.kind === 'services-off' ? (
        <Banner
          tone="warning"
          title="Localização do aparelho desligada"
          testID="location-services-off"
        >
          Ligue a localização (GPS) nas configurações rápidas do sistema para o agente achar sua
          posição.
        </Banner>
      ) : null}

      <Card>
        <View style={st.statusRow}>
          <Text style={st.statusTitle}>Permissão do sistema</Text>
          <StatusPill testID="location-status" tone={pill.tone} label={pill.label} />
        </View>
        <Text style={st.hint}>
          Só “durante o uso do app”: o ClearChat nunca lê a localização em segundo plano.
        </Text>
        {perm?.kind === 'undetermined' || (perm?.kind === 'denied' && perm.canAskAgain) ? (
          <View style={{ marginTop: spacing.sm, alignItems: 'flex-start' }}>
            <Button
              title="Permitir agora"
              size="sm"
              full={false}
              icon="location-outline"
              loading={asking}
              onPress={ask}
              testID="location-ask"
            />
          </View>
        ) : null}
        {perm?.kind === 'granted' || perm?.kind === 'services-off' ? (
          <View style={{ marginTop: spacing.sm, alignItems: 'flex-start' }}>
            <Button
              title="Abrir configurações do sistema"
              size="sm"
              full={false}
              variant="secondary"
              icon="open-outline"
              onPress={openSystemSettings}
              testID="location-open-settings-granted"
            />
          </View>
        ) : null}
      </Card>

      <FieldLabel>Precisão</FieldLabel>
      <Segmented
        options={(['approximate', 'exact'] as const).map((v) => ({
          value: v,
          label: PRECISION_LABEL[v]
        }))}
        value={prefs.precision}
        onChange={setPrecision}
        testID="location-precision"
      />
      <Text style={st.hint}>
        {prefs.precision === 'approximate'
          ? `A posição vai arredondada a ~1 km para o modelo, o OpenStreetMap e o geocodificador. ${ios ? 'No iPhone basta a “Localização Precisa” desligada.' : 'O Android só pede a localização aproximada.'}`
          : `A posição exata (GPS) vai para o modelo e para o OpenStreetMap. ${ios ? 'Com a “Localização Precisa” desligada, o iPhone pergunta a cada sessão se libera a precisão total; recusado, o resultado fica aproximado.' : 'O Android pede a localização precisa na primeira vez.'}`}
      </Text>
      {reducedButExact ? (
        <Banner
          tone="info"
          testID="location-reduced"
          action={
            <View style={st.bannerAction}>
              <Button
                title="Pedir a localização precisa"
                size="sm"
                full={false}
                variant="secondary"
                icon="locate-outline"
                loading={asking}
                onPress={ask}
                testID="location-ask-precise"
              />
            </View>
          }
        >
          {`Hoje o sistema só libera a localização aproximada para o ClearChat. No próximo uso o app pede a precisa ${ios ? '(precisão total temporária)' : ''}; recusada, o resultado continua aproximado até você ativar ${ios ? '“Localização Precisa”' : '“Usar localização precisa”'} nas configurações do sistema.`}
        </Banner>
      ) : null}

      <FieldLabel>Aprovação</FieldLabel>
      <Segmented
        options={(['ask', 'always', 'never'] as const).map((v) => ({
          value: v,
          label: APPROVAL_LABEL[v]
        }))}
        value={prefs.approval}
        onChange={setApproval}
        testID="location-approval"
      />
      <Text style={st.hint}>{APPROVAL_HINT[prefs.approval]}</Text>

      <Note>
        As ferramentas “Localização” e “Lugares próximos” funcionam nos chats executados neste
        celular (ligue-as em Novo chat ou na persona). A localização vai só para o provedor do
        modelo do chat e para o OpenStreetMap (Overpass e Nominatim); o nome do lugar pode vir do
        geocodificador do sistema ({ios ? 'Apple' : 'Google'}). O servidor do ClearChat não recebe a
        localização: o resultado da ferramenta fica no histórico do chat, que sincroniza cifrado de
        ponta a ponta como qualquer mensagem (sem conta, fica só aqui). Estas opções ficam só neste
        aparelho.
      </Note>
    </SettingsScreen>
  )
}

const st = StyleSheet.create({
  bannerAction: { marginTop: spacing.sm, alignItems: 'flex-start' },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  statusTitle: { flex: 1, color: colors.fg, fontSize: 14.5, fontWeight: '500' },
  hint: { color: colors.subtle, fontSize: 12, lineHeight: 16, marginTop: 4 }
})
