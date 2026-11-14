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
import { FieldLabel, Segmented, SettingsScreen } from '@/settings/ui'
import { Button } from '@/ui/Button'
import { Banner, Card, StatusPill } from '@/ui/Card'
import { HelpButton } from '@/ui/Help'
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
    <SettingsScreen
      title="Localização"
      testID="screen-location"
      help={`As ferramentas “Localização” e “Lugares próximos” funcionam nos chats executados neste celular (ligue-as em Novo chat ou na persona).\n\nA localização vai só para o provedor do modelo do chat e para o OpenStreetMap (Overpass e Nominatim); o nome do lugar pode vir do geocodificador do sistema (${ios ? 'Apple' : 'Google'}). O servidor do ClearChat não recebe a localização: o resultado da ferramenta fica no histórico do chat, que sincroniza cifrado de ponta a ponta como qualquer mensagem (sem conta, fica só aqui).\n\nEstas opções ficam só neste aparelho.`}
    >
      {perm?.kind === 'denied' ? (
        // aviso com ação: o botão é o aviso (o que fazer lá, no detalhe do leitor de tela)
        <View testID="location-perm-denied">
          <Button
            title="Localização negada · Abrir configurações"
            variant="warning"
            onPress={openSystemSettings}
            accessibilityHint={`Para usar “perto de mim”, permita a localização do ClearChat ${ios ? '(“Durante o uso do app”)' : '(“Permitir durante o uso do app”)'} nas configurações do sistema. A busca de lugares por endereço continua funcionando.`}
            testID="location-open-settings"
          />
        </View>
      ) : perm?.kind === 'services-off' ? (
        <Banner tone="warning" testID="location-services-off">
          Localização do aparelho desligada — ligue o GPS nas configurações rápidas.
        </Banner>
      ) : null}

      <Card>
        <View style={st.statusRow}>
          <Text style={st.statusTitle}>Permissão do sistema</Text>
          <HelpButton title="Permissão do sistema" testID="location-perm-help">
            Só “durante o uso do app”: o ClearChat nunca lê a localização em segundo plano.
          </HelpButton>
          <View style={{ flex: 1 }} />
          <StatusPill testID="location-status" tone={pill.tone} label={pill.label} />
        </View>
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

      <FieldLabel
        testID="location-precision-label"
        help={`${PRECISION_LABEL.approximate}: a posição vai arredondada a ~1 km para o modelo, o OpenStreetMap e o geocodificador. ${ios ? 'No iPhone basta a “Localização Precisa” desligada.' : 'O Android só pede a localização aproximada.'}\n\n${PRECISION_LABEL.exact}: a posição exata (GPS) vai para o modelo e para o OpenStreetMap. ${ios ? 'Com a “Localização Precisa” desligada, o iPhone pergunta a cada sessão se libera a precisão total; recusado, o resultado fica aproximado.' : 'O Android pede a localização precisa na primeira vez.'}`}
      >
        Precisão
      </FieldLabel>
      <Segmented
        options={(['approximate', 'exact'] as const).map((v) => ({
          value: v,
          label: PRECISION_LABEL[v]
        }))}
        value={prefs.precision}
        onChange={setPrecision}
        testID="location-precision"
      />
      {reducedButExact ? (
        <View testID="location-reduced">
          <Button
            title="Só a aproximada liberada · Pedir a precisa"
            variant="warning"
            size="sm"
            loading={asking}
            onPress={ask}
            accessibilityHint={`Hoje o sistema só libera a localização aproximada para o ClearChat. No próximo uso o app pede a precisa ${ios ? '(precisão total temporária)' : ''}; recusada, o resultado continua aproximado até você ativar ${ios ? '“Localização Precisa”' : '“Usar localização precisa”'} nas configurações do sistema.`}
            testID="location-ask-precise"
          />
        </View>
      ) : null}

      <FieldLabel
        testID="location-approval-label"
        help={(['ask', 'always', 'never'] as const)
          .map((v) => `${APPROVAL_LABEL[v]}: ${APPROVAL_HINT[v]}.`)
          .join('\n\n')}
      >
        Aprovação
      </FieldLabel>
      <Segmented
        options={(['ask', 'always', 'never'] as const).map((v) => ({
          value: v,
          label: APPROVAL_LABEL[v]
        }))}
        value={prefs.approval}
        onChange={setApproval}
        testID="location-approval"
      />
    </SettingsScreen>
  )
}

const st = StyleSheet.create({
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  statusTitle: { color: colors.fg, fontSize: 14.5, fontWeight: '500' }
})
