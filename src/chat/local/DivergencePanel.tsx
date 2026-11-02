// Divergência com a versão DESTE celular (SYNC_PROTOCOL.md §9.2–9.3): o celular rodou o chat sem o
// servidor enquanto outro dispositivo gravou outra versão online. As duas versões são navegáveis
// ("Versão deste celular" · "Versão online") e a escolha "Manter esta" pede a confirmação
// obrigatória — a outra versão é apagada de verdade, em todos os dispositivos.
import { useEffect, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { describeError } from '@/account/errors'
import type { ChatState } from '@/data/types'
import { hostStack } from '@/host/native'
import type { DivergenceDetails } from '@/host/divergence'
import { divergedOf } from '@/remote/types'
import { Button } from '@/ui/Button'
import { ConfirmDialog } from '@/ui/Dialog'
import { useToast } from '@/ui/Toast'
import { colors, radius } from '@/ui/theme'

const when = (ms: number | null): string =>
  ms ? new Date(ms).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—'

const msgs = (n: number): string => `${n} ${n === 1 ? 'mensagem' : 'mensagens'}`

export function DivergencePanel({
  chatId,
  state,
  showOnline,
  onShowOnline,
  onDetails
}: {
  chatId: string
  state: ChatState | null
  showOnline: boolean
  onShowOnline: (v: boolean) => void
  onDetails: (d: DivergenceDetails | null) => void
}) {
  const toast = useToast()
  const d = divergedOf(state)
  const [det, setDet] = useState<DivergenceDetails | null>(null)
  const [keep, setKeep] = useState<'online' | 'local' | null>(null)
  const [busy, setBusy] = useState(false)
  const divergenceId = d?.divergence_id

  useEffect(() => {
    if (!divergenceId) return
    let live = true
    hostStack.divergence
      .details(chatId)
      .then((x) => {
        if (!live) return
        setDet(x)
        onDetails(x)
      })
      .catch((e: unknown) => toast(describeError(e), 'danger'))
    return () => {
      live = false
    }
  }, [chatId, divergenceId, toast, onDetails])

  if (!d) return null
  const other =
    state?.host?.name && state.host.device_id !== hostStack.host.deviceId
      ? state.host.name
      : 'outro dispositivo'
  // o que se perde ao manter cada versão
  const lose = keep === 'local' ? det?.onlyOnline : det?.onlyLocal

  return (
    <View style={st.panel} testID="divergence-self">
      <Text style={st.title}>Este chat divergiu</Text>
      <Text style={st.text}>
        Este celular continuou o chat sem conexão enquanto {other} gravou outra versão online. Nada
        deste chat sincroniza até você escolher qual versão fica.
      </Text>
      <View style={st.seg}>
        {(
          [
            [false, 'Versão deste celular', det ? det.onlyLocal.count : null],
            [true, 'Versão online', det ? det.onlyOnline.count : null]
          ] as const
        ).map(([online, label, n]) => (
          <Pressable
            key={label}
            onPress={() => onShowOnline(online)}
            style={[st.segBtn, showOnline === online && st.segOn]}
            testID={online ? 'divergence-view-online' : 'divergence-view-local'}
          >
            <Text style={[st.segText, showOnline === online && { color: colors.fg }]}>{label}</Text>
            {n != null ? <Text style={st.segSub}>{msgs(n)} só nela</Text> : null}
          </Pressable>
        ))}
      </View>
      <View style={st.row}>
        <Button
          title="Manter a deste celular"
          size="sm"
          icon="phone-portrait-outline"
          disabled={!det}
          onPress={() => setKeep('local')}
          testID="divergence-keep-local"
          style={{ flex: 1 }}
        />
        <Button
          title="Manter a online"
          size="sm"
          variant="secondary"
          icon="cloud-done-outline"
          disabled={!det}
          onPress={() => setKeep('online')}
          testID="divergence-keep-online"
          style={{ flex: 1 }}
        />
      </View>
      <ConfirmDialog
        visible={keep !== null}
        title={keep === 'local' ? 'Manter a versão deste celular?' : 'Manter a versão online?'}
        message={`A outra versão será apagada. Mensagens que só existem nela (${msgs(lose?.count ?? 0)}${lose?.since ? ` desde ${when(lose.since)}` : ''}) serão perdidas e não poderão ser recuperadas.`}
        confirmLabel="Apagar a outra versão e manter esta"
        destructive
        busy={busy}
        onClose={() => setKeep(null)}
        onConfirm={() => {
          if (!keep) return
          setBusy(true)
          hostStack.divergence
            .resolve(chatId, keep)
            .then(() => {
              onShowOnline(false)
              onDetails(null)
              toast(
                keep === 'local'
                  ? 'A versão deste celular agora é a online.'
                  : 'A versão deste celular foi apagada; o chat mostra a versão online.'
              )
            })
            .catch((e: unknown) => toast(describeError(e), 'danger'))
            .finally(() => {
              setBusy(false)
              setKeep(null)
            })
        }}
      />
    </View>
  )
}

const st = StyleSheet.create({
  panel: {
    marginHorizontal: 10,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: `${colors.danger}55`,
    backgroundColor: colors.elevated,
    padding: 14,
    gap: 10
  },
  title: { color: colors.danger, fontSize: 14.5, fontWeight: '600' },
  text: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  seg: { flexDirection: 'row', gap: 8 },
  segBtn: {
    flex: 1,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 8,
    paddingHorizontal: 10,
    gap: 2
  },
  segOn: { backgroundColor: colors.active, borderColor: colors.borderStrong },
  segText: { color: colors.subtle, fontSize: 13, fontWeight: '500' },
  segSub: { color: colors.faint, fontSize: 11.5 },
  row: { flexDirection: 'row', gap: 8 }
})
