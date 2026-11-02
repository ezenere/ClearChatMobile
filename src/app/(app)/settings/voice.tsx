// Configurações → Voz (= aba Áudio do desktop, sem o que é do computador): ditado (`audioInput`),
// transcrição (`sttSettings`), fala (`ttsSettings`) e os padrões da chamada de voz
// (`voiceCallDefaults`) — todos sincronizados (§4.3.2), gravados SEM as partes do dispositivo
// (`audioSettingOut`). Motores locais/GPU aparecem como "só no computador" (a escolha sincroniza,
// mas o celular não transcreve/fala com eles). "Neste aparelho": opções locais (§4.4).
import { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import {
  DEFAULT_VOICE_BASE_PROMPT,
  type AudioInputSettings,
  type SttSettings,
  type TtsSettings,
  type VoiceCallDefaults
} from '@shared/voice'
import { apiParamSpecs, setVoiceApiParam } from '@shared/voiceParams'
import { describeError } from '@/account/errors'
import { store } from '@/data/native'
import { ModelField } from '@/settings/ModelPicker'
import { readAt, settings, useSettingsVersion } from '@/settings/react'
import { FieldLabel, Multiline, Note, NumberField, Segmented, SettingsScreen } from '@/settings/ui'
import { InterjectionFields } from '@/settings/VoiceConfigEditor'
import {
  CatalogField,
  VoiceParamsEditor,
  VoiceProviderField,
  useVoiceCatalog
} from '@/settings/voiceUi'
import { Button } from '@/ui/Button'
import { Banner, Card, Divider, ToggleRow } from '@/ui/Card'
import { useToast } from '@/ui/Toast'
import { colors, spacing } from '@/ui/theme'
import { audioSettingOut, readVoiceSettings, resolveTts, voiceFamily } from '@/voice/endpoints'
import { expoPlayback } from '@/voice/nativeAudio'
import { playableAudio } from '@/voice/player'
import {
  bargeInEnabled,
  fakeMicEnabled,
  setBargeInEnabled,
  setFakeMicEnabled,
  voice
} from '@/voice/native'
import { useCallView } from '@/voice/react'
import { synthesizeBlock } from '@vendor/desktop/voice/tts'

const LANGUAGES = [
  { id: 'pt-BR', name: 'Português (Brasil)' },
  { id: 'pt-PT', name: 'Português (Portugal)' },
  { id: 'en-US', name: 'Inglês' },
  { id: 'es-ES', name: 'Espanhol' },
  { id: 'fr-FR', name: 'Francês' },
  { id: 'de-DE', name: 'Alemão' },
  { id: 'it-IT', name: 'Italiano' }
]

function read() {
  return {
    ...readVoiceSettings((id) => store.setting(id)),
    providers: settings.providers()
  }
}

export default function VoiceSettings() {
  const version = useSettingsVersion()
  const v = readAt(version, read)
  const toast = useToast()
  const callView = useCallView()
  const [barge, setBarge] = useState(bargeInEnabled)
  const [fake, setFake] = useState(fakeMicEnabled)
  const [testing, setTesting] = useState(false)

  const save = (id: string, value: unknown) =>
    settings.setSetting(id, audioSettingOut(id, value, store.setting(id)))
  const setInput = (p: Partial<AudioInputSettings>) => save('audioInput', { ...v.audioInput, ...p })
  const setStt = (p: Partial<SttSettings>) => save('sttSettings', { ...v.stt, ...p })
  const setTts = (p: Partial<TtsSettings>) => save('ttsSettings', { ...v.tts, ...p })
  const setCall = (p: Partial<VoiceCallDefaults>) =>
    settings.setSetting('voiceCallDefaults', { ...v.voiceCallDefaults, ...p })

  const sttProvider = v.stt.api.providerId
    ? (v.providers.find((p) => p.id === v.stt.api.providerId) ?? null)
    : null
  const ttsProvider = v.tts.api.providerId
    ? (v.providers.find((p) => p.id === v.tts.api.providerId) ?? null)
    : null
  const sttCat = useVoiceCatalog('stt', sttProvider, v.stt.mode !== 'local')
  const ttsCat = useVoiceCatalog('tts', ttsProvider, v.tts.backend === 'api')
  const sttFamily = sttProvider ? voiceFamily(sttProvider) : null
  const ttsFamily = ttsProvider ? voiceFamily(ttsProvider) : null
  const sttSpecs = apiParamSpecs('stt', sttFamily, v.stt.api.model)
  const ttsSpecs = apiParamSpecs('tts', ttsFamily, v.tts.api.model)
  const d = v.voiceCallDefaults
  const turn = d.turn
  const delay = d.delayPhrases ?? {
    enabled: true,
    keepAliveAfterMs: 3000,
    apologyAfterMs: 5000,
    keepAlivePool: null,
    apologyPool: null
  }

  const testVoice = async () => {
    const r = resolveTts(v.tts, (id) => v.providers.find((p) => p.id === id) ?? null)
    if ('block' in r) return toast(r.block.reason, 'danger')
    setTesting(true)
    try {
      const clip = await synthesizeBlock(
        { text: 'Olá, isto é um teste.', settings: r.settings },
        {}
      )
      const a = playableAudio(clip)
      const h = await expoPlayback.play(a.audio, a.mime, 1)
      await h.done
    } catch (e) {
      toast(`Não foi possível testar a voz: ${describeError(e)}`, 'danger')
    } finally {
      setTesting(false)
    }
  }

  return (
    <SettingsScreen title="Voz" testID="screen-voice">
      <Note>
        Ditado no composer e chamada de voz nos chats executados neste celular. Sincroniza com o
        computador, menos o que é deste aparelho (microfone, motores locais e GPU).
      </Note>

      {/* ---------------- ditado ---------------- */}
      <FieldLabel>Ditado</FieldLabel>
      <Card padded={false}>
        <CatalogField
          title="Idioma"
          icon="language-outline"
          value={v.audioInput.language}
          items={LANGUAGES}
          onChange={(language) => setInput({ language })}
          emptyLabel="Detectar automaticamente"
          allowEmpty
          testID="voice-language"
        />
        <Divider />
        <View style={st.pad}>
          <ToggleRow
            title="Parar sozinho quando eu parar de falar"
            value={v.audioInput.silenceStopEnabled}
            onChange={(silenceStopEnabled) => setInput({ silenceStopEnabled })}
            testID="voice-silence-stop"
          />
          {v.audioInput.silenceStopEnabled ? (
            <NumberField
              label="Silêncio"
              value={v.audioInput.silenceStopMs}
              onChange={(n) => setInput({ silenceStopMs: n ?? 5000 })}
              min={0}
              max={60000}
              suffix="ms"
              testID="voice-silence-ms"
            />
          ) : null}
          <ToggleRow
            title="Segurar para falar"
            subtitle="Segure o microfone enquanto fala; soltar conclui. Tocar uma vez também grava (toque de novo para concluir)."
            value={v.audioInput.pttEnabled}
            onChange={(pttEnabled) => setInput({ pttEnabled })}
            testID="voice-ptt"
          />
        </View>
      </Card>

      {/* ---------------- transcrição ---------------- */}
      <FieldLabel>Transcrição (voz → texto)</FieldLabel>
      <Segmented
        options={[
          { value: 'api', label: 'API' },
          { value: 'local', label: 'Local' },
          { value: 'hybrid', label: 'Híbrido' }
        ]}
        value={v.stt.mode === 'gpu' ? 'api' : v.stt.mode}
        onChange={(mode) => setStt({ mode })}
        testID="voice-stt-mode"
      />
      {v.stt.mode === 'local' ? (
        <Banner tone="warning" testID="voice-stt-local">
          Local (whisper.cpp/Vosk) só no computador — o áudio não sai da máquina. Neste celular o
          ditado e a chamada ficam indisponíveis até você escolher API ou Híbrido.
        </Banner>
      ) : v.stt.mode === 'hybrid' ? (
        <Note>Híbrido: no computador, motor local com a API de reserva; neste celular, a API.</Note>
      ) : null}
      <Card padded={false}>
        <VoiceProviderField
          capability="stt"
          providers={v.providers}
          value={v.stt.api.providerId}
          onChange={(providerId) => setStt({ api: { ...v.stt.api, providerId } })}
          testID="voice-stt-provider"
        />
        <Divider />
        <CatalogField
          title="Modelo de transcrição"
          icon="mic-outline"
          value={v.stt.api.model}
          items={(sttCat.view?.models ?? []).map((m) => ({
            id: m.id,
            name: m.label,
            detail: m.priceHint ?? undefined
          }))}
          loading={sttCat.loading}
          error={sttCat.view?.error}
          hint={sttCat.view?.hint}
          onRefresh={sttCat.refresh}
          onChange={(model) => model && setStt({ api: { ...v.stt.api, model } })}
          emptyLabel="whisper-large-v3-turbo"
          testID="voice-stt-model"
        />
        <Divider />
        <View style={st.pad}>
          <ToggleRow
            title="Texto ao vivo enquanto fala"
            subtitle="Parciais pela API a cada ~1 s (custa requests a mais)."
            value={v.stt.livePartials}
            onChange={(livePartials) => setStt({ livePartials })}
            testID="voice-stt-partials"
          />
          <ToggleRow
            title="Aproveitar a última parcial como texto final"
            value={v.stt.reusePartialFinal !== false}
            onChange={(reusePartialFinal) => setStt({ reusePartialFinal })}
          />
        </View>
      </Card>
      {sttFamily && sttSpecs.length ? (
        <Card>
          <VoiceParamsEditor
            specs={sttSpecs}
            values={v.stt.api.params?.[sttFamily] ?? {}}
            onChange={(key, val) =>
              setStt({
                api: {
                  ...v.stt.api,
                  params: setVoiceApiParam('stt', sttFamily, v.stt.api.params, key, val)
                }
              })
            }
            testID="voice-stt-param"
          />
        </Card>
      ) : null}

      {/* ---------------- fala ---------------- */}
      <FieldLabel>Fala (texto → voz)</FieldLabel>
      <Segmented
        options={[
          { value: 'api', label: 'API' },
          { value: 'local', label: 'Local (Kokoro)' }
        ]}
        value={v.tts.backend === 'gpu' ? 'local' : v.tts.backend}
        onChange={(backend) => setTts({ backend })}
        testID="voice-tts-backend"
      />
      {v.tts.backend !== 'api' ? (
        <Banner tone="warning" testID="voice-tts-local">
          {v.tts.backend === 'gpu' ? 'GPU local' : 'Kokoro (local)'} só no computador — neste
          celular a chamada de voz precisa da fala pela API.
        </Banner>
      ) : null}
      <Card padded={false}>
        <VoiceProviderField
          capability="tts"
          providers={v.providers}
          value={v.tts.api.providerId}
          onChange={(providerId) => setTts({ api: { ...v.tts.api, providerId } })}
          testID="voice-tts-provider"
        />
        <Divider />
        <CatalogField
          title="Modelo de fala"
          icon="volume-high-outline"
          value={v.tts.api.model}
          items={(ttsCat.view?.models ?? []).map((m) => ({
            id: m.id,
            name: m.label,
            detail: [m.priceHint, m.latencyMs ? `~${m.latencyMs} ms` : null]
              .filter(Boolean)
              .join(' · ')
          }))}
          loading={ttsCat.loading}
          error={ttsCat.view?.error}
          hint={ttsCat.view?.hint}
          onRefresh={ttsCat.refresh}
          onChange={(model) => setTts({ api: { ...v.tts.api, model } })}
          emptyLabel={ttsFamily === 'elevenlabs' ? 'eleven_flash_v2_5 (padrão)' : 'Não configurado'}
          testID="voice-tts-model"
        />
        <Divider />
        <CatalogField
          title="Voz"
          icon="person-outline"
          value={v.tts.api.voice ?? ''}
          items={(ttsCat.view?.voices ?? []).map((x) => ({
            id: x.id,
            name: x.label,
            detail: [x.language, x.recommended ? 'recomendada' : null].filter(Boolean).join(' · ')
          }))}
          loading={ttsCat.loading}
          onChange={(id) => setTts({ api: { ...v.tts.api, voice: id || null } })}
          emptyLabel="Voz padrão da API"
          allowEmpty
          testID="voice-tts-voice"
        />
      </Card>
      {ttsFamily && ttsSpecs.length ? (
        <Card>
          <VoiceParamsEditor
            specs={ttsSpecs}
            values={v.tts.api.params?.[ttsFamily] ?? {}}
            onChange={(key, val) =>
              setTts({
                api: {
                  ...v.tts.api,
                  params: setVoiceApiParam('tts', ttsFamily, v.tts.api.params, key, val)
                }
              })
            }
            testID="voice-tts-param"
          />
        </Card>
      ) : null}
      <Note>
        Na chamada, cada frase é sintetizada inteira (HTTP) e tocada assim que chega; o WebSocket da
        ElevenLabs (texto em streaming) é só do computador.
      </Note>
      <Button
        title={testing ? 'Tocando…' : 'Testar voz'}
        icon="play-outline"
        variant="secondary"
        onPress={() => void testVoice()}
        disabled={testing}
        testID="voice-tts-test"
      />

      {/* ---------------- chamada ---------------- */}
      <FieldLabel>Chamada de voz — padrões</FieldLabel>
      <Card>
        <ToggleRow
          title="Chamada de voz disponível"
          subtitle="Cada persona/chat pode mudar (aba Voz da persona)."
          value={d.enabled}
          onChange={(enabled) => setCall({ enabled })}
          testID="voice-call-enabled"
        />
        <ToggleRow
          title="O agente pode encerrar a chamada"
          subtitle="Tool end_call nos turnos da chamada (sem aprovação)."
          value={d.endCall}
          onChange={(endCall) => setCall({ endCall })}
          testID="voice-call-endcall"
        />
        <ToggleRow
          title="Prompt-base do modo voz"
          value={d.basePromptEnabled}
          onChange={(basePromptEnabled) => setCall({ basePromptEnabled })}
          testID="voice-call-baseprompt"
        />
      </Card>
      {d.basePromptEnabled ? (
        <Multiline
          value={d.basePrompt ?? DEFAULT_VOICE_BASE_PROMPT}
          onChangeText={(t) =>
            setCall({ basePrompt: t.trim() && t !== DEFAULT_VOICE_BASE_PROMPT ? t : null })
          }
          minHeight={120}
          testID="voice-call-baseprompt-text"
        />
      ) : null}
      <Text style={st.sub}>Modelo da chamada</Text>
      <ModelField
        providers={v.providers}
        value={d.model ? { providerId: d.model.providerId, model: d.model.model } : null}
        onChange={(m) =>
          setCall({
            model: m
              ? { providerId: m.providerId, model: m.model, params: d.model?.params ?? {} }
              : null
          })
        }
        placeholder="Igual ao chat"
        noneLabel="Igual ao chat"
        testID="voice-call-model"
      />
      <Card>
        <ToggleRow
          title="Preâmbulos"
          subtitle="Uma frase curta (“Hum, deixa eu ver.”) logo depois da sua fala, enquanto a resposta vem."
          value={d.fillers.enabled}
          onChange={(enabled) => setCall({ fillers: { ...d.fillers, enabled } })}
          testID="voice-call-fillers"
        />
        {d.fillers.enabled ? (
          <NumberField
            label="Espera do preâmbulo"
            value={d.fillers.delayMs}
            onChange={(n) => setCall({ fillers: { ...d.fillers, delayMs: n ?? 250 } })}
            min={0}
            max={5000}
            suffix="ms"
          />
        ) : null}
        <ToggleRow
          title="Frases de demora"
          subtitle="“Só mais um instante…” quando a resposta demora; desculpa antes de uma resposta que atrasou."
          value={delay.enabled}
          onChange={(enabled) => setCall({ delayPhrases: { ...delay, enabled } })}
          testID="voice-call-delay"
        />
        {delay.enabled ? (
          <>
            <NumberField
              label="“Manter viva” depois de"
              value={delay.keepAliveAfterMs}
              onChange={(n) => setCall({ delayPhrases: { ...delay, keepAliveAfterMs: n ?? 3000 } })}
              min={1000}
              max={60000}
              suffix="ms"
            />
            <NumberField
              label="Desculpa depois de"
              value={delay.apologyAfterMs}
              onChange={(n) => setCall({ delayPhrases: { ...delay, apologyAfterMs: n ?? 5000 } })}
              min={1000}
              max={60000}
              suffix="ms"
            />
          </>
        ) : null}
      </Card>
      <Text style={st.sub}>Interjeições</Text>
      <InterjectionFields
        value={d.interjections}
        onChange={(interjections) => setCall({ interjections })}
        testID="voice-call-interjections"
      />
      <Text style={st.sub}>Fim do turno</Text>
      <Card>
        <ToggleRow
          title="Fim de turno adaptativo"
          subtitle="Na pausa, uma transcrição rápida decide se você terminou (pergunta fecha antes; frase inacabada espera mais)."
          value={turn.adaptive}
          onChange={(adaptive) => setCall({ turn: { ...turn, adaptive } })}
          testID="voice-call-adaptive"
        />
        <ToggleRow
          title="Transcrição especulativa pela API"
          subtitle="Também vale com o texto ao vivo ligado (custa 1 request por pausa)."
          value={turn.speculativeApi}
          onChange={(speculativeApi) => setCall({ turn: { ...turn, speculativeApi } })}
        />
        <NumberField
          label="Silêncio sem veredito"
          value={turn.silenceStopMs}
          onChange={(n) => setCall({ turn: { ...turn, silenceStopMs: n ?? null } })}
          min={300}
          max={10000}
          suffix="ms"
          placeholder="1000"
        />
        <NumberField
          label="Fala completa"
          value={turn.completeSilenceMs}
          onChange={(n) => setCall({ turn: { ...turn, completeSilenceMs: n ?? 600 } })}
          min={200}
          max={10000}
          suffix="ms"
        />
        <NumberField
          label="Afirmação"
          value={turn.statementSilenceMs}
          onChange={(n) => setCall({ turn: { ...turn, statementSilenceMs: n ?? 1200 } })}
          min={200}
          max={10000}
          suffix="ms"
        />
        <NumberField
          label="Frase inacabada"
          value={turn.unfinishedSilenceMs}
          onChange={(n) => setCall({ turn: { ...turn, unfinishedSilenceMs: n ?? 1500 } })}
          min={200}
          max={10000}
          suffix="ms"
        />
      </Card>

      {/* ---------------- neste aparelho ---------------- */}
      <FieldLabel>Neste aparelho</FieldLabel>
      <Card>
        <ToggleRow
          title="Interromper falando (use fone de ouvido)"
          subtitle="Sem fone, o microfone fica mudo enquanto o assistente fala (o celular não cancela o eco) — use o botão Interromper."
          value={barge}
          onChange={(on) => {
            setBargeInEnabled(on)
            setBarge(on)
          }}
          testID="voice-barge-in"
        />
        {__DEV__ ? (
          <ToggleRow
            title="Microfone de teste (desenvolvimento)"
            subtitle="Não abre o microfone: toca os WAVs injetados por clearchat://dev/fakemic?play=…"
            value={fake}
            onChange={(on) => {
              setFakeMicEnabled(on)
              setFake(on)
            }}
            testID="voice-fake-mic"
          />
        ) : null}
      </Card>
      <Button
        title={
          callView.clips.state === 'generating'
            ? `Gerando clipes… ${callView.clips.done ?? 0}/${callView.clips.total ?? 0}`
            : 'Gerar clipes de interjeição e preâmbulo'
        }
        icon="musical-notes-outline"
        variant="secondary"
        disabled={callView.clips.state === 'generating'}
        onPress={() =>
          void voice.call
            .generateClips()
            .then(() => toast('Clipes prontos'))
            .catch((e: unknown) => toast(describeError(e), 'danger'))
        }
        testID="voice-gen-clips"
      />
      <Note>
        Os clipes são gerados com a voz atual e ficam só neste aparelho (sem eles a chamada não toca
        interjeições nem preâmbulos).
      </Note>
    </SettingsScreen>
  )
}

const st = StyleSheet.create({
  pad: { paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
  sub: { color: colors.muted, fontSize: 13, marginBottom: -4 }
})
