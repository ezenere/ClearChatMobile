// Chamada de voz na conversa (chats executados neste celular): o "dock" no lugar do composer —
// fase do turno (Ouvindo/Transcrevendo/Pensando/Falando), relógio, nível do microfone, o texto da
// fala (parcial/especulativo/final), "falando por cima" (a voz do assistente abaixada — ducking),
// mudo, Interromper (barge-in pelo botão — sem fone o microfone fica surdo enquanto o assistente
// fala, sem cancelamento de eco), desligar, erro e o "Gerar clipes" quando faltam os dos
// preâmbulos. E a folha "Chamada de voz…" do menu (config de voz do chat, ★ = herdado).
import Ionicons from '@expo/vector-icons/Ionicons'
import { useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { formatCallClock } from '@shared/voiceCallMarks'
import { normalizeVoiceCallConfig, type VoiceCallConfig } from '@shared/voice'
import type { ToolName } from '@shared/types'
import { describeError } from '@/account/errors'
import { store } from '@/data/native'
import { hostStack } from '@/host/native'
import { settings } from '@/settings/react'
import { VoiceConfigEditor } from '@/settings/VoiceConfigEditor'
import { useVoiceCallInheritance } from '@/settings/voiceUi'
import { Sheet } from '@/ui/Sheet'
import { useToast } from '@/ui/Toast'
import { colors, radius } from '@/ui/theme'
import { useCallView, voice } from '@/voice/react'

const PHASE: Record<string, string> = {
  listening: 'Ouvindo…',
  transcribing: 'Transcrevendo…',
  thinking: 'Pensando…',
  speaking: 'Falando…'
}

export function CallDock() {
  const v = useCallView()
  const toast = useToast()
  const [now, setNow] = useState(0)
  useEffect(() => {
    if (!v.call.active) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [v.call.active])
  if (!v.call.active) return null
  const st = v.call
  const elapsed = st.startedAt && now > st.startedAt ? now - st.startedAt : 0
  const phase = st.preparing ?? (st.muted ? 'Microfone mudo' : (PHASE[st.phase] ?? ''))
  return (
    <View style={s.dock} testID="voice-call-dock">
      <View style={s.head}>
        <View style={[s.live, { backgroundColor: st.muted ? colors.faint : colors.danger }]} />
        <Text style={s.phase} testID="voice-call-phase">
          {phase}
        </Text>
        <Text style={s.clock}>{formatCallClock(elapsed)}</Text>
        {v.ducked ? (
          <Text style={s.ducked} testID="voice-call-ducked">
            falando por cima · voz baixa
          </Text>
        ) : v.deaf ? (
          <Text style={s.deaf} testID="voice-call-deaf">
            mic em pausa
          </Text>
        ) : null}
      </View>
      <View style={s.meter}>
        <View
          style={[
            s.meterFill,
            { width: `${Math.min(100, Math.round(v.level * 900))}%` },
            st.muted || v.deaf ? { backgroundColor: colors.faint } : null
          ]}
        />
      </View>
      {v.live.text ? (
        <Text
          style={[s.liveText, v.live.state !== 'final' && { opacity: 0.6 }]}
          numberOfLines={2}
          testID="voice-call-live"
        >
          {v.live.text}
        </Text>
      ) : null}
      {v.error ? (
        <Pressable onPress={() => voice.call.clearError()} testID="voice-call-error">
          <Text style={s.err}>{v.error}</Text>
        </Pressable>
      ) : null}
      {v.clips.state === 'missing' || v.clips.state === 'generating' ? (
        <Pressable
          style={s.clips}
          disabled={v.clips.state === 'generating'}
          onPress={() =>
            void voice.call.generateClips().catch((e: unknown) => toast(describeError(e), 'danger'))
          }
          testID="voice-call-gen-clips"
        >
          {v.clips.state === 'generating' ? (
            <ActivityIndicator size={11} color={colors.accentStrong} />
          ) : (
            <Ionicons name="musical-notes-outline" size={14} color={colors.accentStrong} />
          )}
          <Text style={s.clipsText}>
            {v.clips.state === 'generating'
              ? `Gerando clipes… ${v.clips.done ?? 0}/${v.clips.total ?? 0}`
              : 'Sem clipes dos preâmbulos — gerar com a voz atual'}
          </Text>
        </Pressable>
      ) : null}
      <View style={s.actions}>
        <Pressable
          onPress={() => void voice.call.toggleMute()}
          style={[s.btn, st.muted && s.btnOn]}
          accessibilityLabel={st.muted ? 'Ligar o microfone' : 'Silenciar o microfone'}
          testID="voice-call-mute"
        >
          <Ionicons name={st.muted ? 'mic-off' : 'mic-outline'} size={20} color={colors.fg} />
        </Pressable>
        <Pressable
          onPress={() => voice.call.interrupt()}
          disabled={!v.playing}
          style={[s.btn, s.wide, !v.playing && { opacity: 0.35 }]}
          accessibilityLabel="Interromper a fala do assistente"
          testID="voice-call-interrupt"
        >
          <Ionicons name="hand-left-outline" size={18} color={colors.fg} />
          <Text style={s.btnText}>Interromper</Text>
        </Pressable>
        <Pressable
          onPress={() => voice.call.stop()}
          style={[s.btn, s.hang]}
          accessibilityLabel="Desligar"
          testID="voice-call-hangup"
        >
          <Ionicons
            name="call"
            size={20}
            color="#fff"
            style={{ transform: [{ rotate: '135deg' }] }}
          />
        </Pressable>
      </View>
    </View>
  )
}

/** Folha "Chamada de voz…": a config de voz deste chat (herda da persona → Configurações → Voz). */
export function ChatVoiceSheet({
  chatId,
  visible,
  onClose
}: {
  chatId: string
  visible: boolean
  onClose: () => void
}) {
  return (
    <Sheet visible={visible} onClose={onClose} title="Chamada de voz neste chat" maxHeight="92%">
      {visible ? <ChatVoiceBody chatId={chatId} /> : null}
    </Sheet>
  )
}

function ChatVoiceBody({ chatId }: { chatId: string }) {
  const [providers] = useState(() => settings.providers())
  const inherit = useVoiceCallInheritance()
  const [cfg] = useState(
    () => store.getPlain('chat', chatId)?.config as Record<string, unknown> | undefined
  )
  const [value, setValue] = useState<VoiceCallConfig | null>(
    () => (cfg?.voice as VoiceCallConfig | undefined) ?? null
  )
  // a persona de origem (camada do meio: chat > persona > global), lida ao vivo
  const [persona] = useState(() => {
    const presetId = typeof cfg?.presetId === 'string' ? cfg.presetId : null
    const p = presetId ? settings.preset(presetId) : null
    const pv = (p?.config as Record<string, unknown> | undefined)?.voice
    return p
      ? { name: p.name, voice: pv && typeof pv === 'object' ? normalizeVoiceCallConfig(pv) : null }
      : null
  })
  return (
    <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
      <VoiceConfigEditor
        scope="chat"
        value={value}
        providers={providers}
        defaults={inherit.defaults}
        tagsSupport={inherit.tagsSupport}
        persona={persona}
        chatTools={Array.isArray(cfg?.enabledTools) ? (cfg.enabledTools as ToolName[]) : null}
        onChange={(voiceCfg) => {
          setValue(voiceCfg)
          hostStack.repo.updateChat(chatId, { config: { voice: voiceCfg } })
        }}
        testID="chat-voice"
      />
    </View>
  )
}

const s = StyleSheet.create({
  dock: {
    marginHorizontal: 10,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: 'rgba(139,108,255,0.45)',
    backgroundColor: colors.elevated,
    padding: 12,
    gap: 8
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  live: { width: 8, height: 8, borderRadius: 4 },
  phase: { color: colors.fg, fontSize: 15, fontWeight: '600', flex: 1 },
  clock: { color: colors.muted, fontSize: 13, fontVariant: ['tabular-nums'] },
  deaf: { color: colors.subtle, fontSize: 11 },
  ducked: { color: colors.warning, fontSize: 11 },
  meter: { height: 4, borderRadius: 2, backgroundColor: colors.active, overflow: 'hidden' },
  meterFill: { height: 4, borderRadius: 2, backgroundColor: colors.accentStrong },
  liveText: { color: colors.fg, fontSize: 14, fontStyle: 'italic', lineHeight: 19 },
  err: { color: colors.danger, fontSize: 12.5, lineHeight: 17 },
  clips: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  clipsText: { color: colors.accentStrong, fontSize: 12.5, flex: 1 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2 },
  btn: {
    height: 44,
    minWidth: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.active,
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 12
  },
  btnOn: { backgroundColor: 'rgba(248,113,113,0.25)' },
  wide: { flex: 1 },
  btnText: { color: colors.fg, fontSize: 14 },
  hang: { backgroundColor: colors.danger, width: 56 }
})
