// Configurações → Voz (= aba Áudio do desktop, sem o que é do computador): ditado (`audioInput`),
// transcrição (`sttSettings`), fala (`ttsSettings`) e os padrões da chamada de voz
// (`voiceCallDefaults` — turnos, "Falar por cima da resposta", preâmbulos, frases de espera e de
// ferramenta, tags de voz) — padrões DESTE aparelho desde o protocolo 1.9.0 (`device_settings`,
// nunca sincronizam; cada persona/chat pode ter a própria voz). O "Nível de ativação" do microfone é deste aparelho (kv local, nunca vai no
// registro). Motores locais/GPU aparecem como "só no computador" (a escolha sincroniza, mas o
// celular não transcreve/fala com eles). "Neste aparelho": opções locais (§4.4).
import { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import {
  BARGE_IN_RANGES,
  DEFAULT_BARGE_IN,
  DEFAULT_DELAY_PHRASES,
  DEFAULT_FILLER_DELAY_MS,
  FILLER_DELAY_MS_RANGE,
  resolveBargeIn,
  type AudioInputSettings,
  type SttSettings,
  type TtsSettings,
  type VoiceCallDefaults
} from '@shared/voice'
import { DEFAULT_AUDIO_TAGS_PROMPT } from '@shared/audioTags'
import { fishVoiceIdFrom, isFishAudioModel, supportsAudioTags } from '@shared/voiceCatalog'
import { apiParamSpecs, setVoiceApiParam } from '@shared/voiceParams'
import { describeError } from '@/account/errors'
import { store } from '@/data/native'
import { ModelField } from '@/settings/ModelPicker'
import { readAt, settings, useSettingsVersion } from '@/settings/react'
import { FieldLabel, Note, NumberField, Segmented, SettingsScreen } from '@/settings/ui'
import { AudioTagsField } from '@/settings/AudioTagsField'
import { DelayPhrasesSettings } from '@/settings/DelayPhrasesSettings'
import { MicActivationLevel } from '@/settings/MicActivationLevel'
import { ToolPhrasesSettings } from '@/settings/ToolPhrasesSettings'
import {
  CatalogField,
  DICTATION_LANGUAGES,
  VoiceParamsEditor,
  VoiceProviderField,
  useVoiceCatalog
} from '@/settings/voiceUi'
import { Button } from '@/ui/Button'
import { Banner, Card, Divider, ToggleRow } from '@/ui/Card'
import { useToast } from '@/ui/Toast'
import { colors, spacing } from '@/ui/theme'
import {
  audioSettingOut,
  callTtsTagsSupport,
  readVoiceSettings,
  resolveTts,
  voiceFamily
} from '@/voice/endpoints'
import { expoPlayback } from '@/voice/nativeAudio'
import { playableAudio } from '@/voice/player'
import {
  activationDb,
  bargeInEnabled,
  fakeMicEnabled,
  openMeterMic,
  setActivationDb,
  setBargeInEnabled,
  setFakeMicEnabled,
  voice
} from '@/voice/native'
import { useCallView } from '@/voice/react'
import { synthesizeBlock } from '@vendor/desktop/voice/tts'

function read() {
  return {
    ...readVoiceSettings((id) => store.deviceSetting(id), { activationDb: activationDb() }),
    providers: settings.providers()
  }
}

export default function VoiceSettings() {
  const version = useSettingsVersion()
  const v = readAt(version, read)
  const toast = useToast()
  const callView = useCallView()
  const [barge, setBarge] = useState(bargeInEnabled)
  const [activation, setActivation] = useState(activationDb)
  const [fake, setFake] = useState(fakeMicEnabled)
  const [testing, setTesting] = useState(false)

  const save = (id: string, value: unknown) =>
    settings.setSetting(id, audioSettingOut(id, value, store.deviceSetting(id)))
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
  const bargeIn = resolveBargeIn(turn)
  const delay = d.delayPhrases ?? { ...DEFAULT_DELAY_PHRASES }
  // vozes do modelo escolhido (OpenRouter: `supported_voices`); lista vazia = o modelo não lista
  // vozes (Fish Audio pelo OpenRouter) — cola-se o id ou o link da biblioteca
  const ttsModelInfo = ttsCat.view?.models.find((m) => m.id === v.tts.api.model) ?? null
  const modelVoices = ttsModelInfo?.voiceIds ?? null
  const noVoiceList = !!modelVoices && modelVoices.length === 0
  const fishModel = isFishAudioModel(v.tts.api.model)
  const voiceItems = (ttsCat.view?.voices ?? []).filter(
    (x) => !modelVoices?.length || modelVoices.includes(x.id)
  )
  const tagsSupport = callTtsTagsSupport(
    v.tts,
    (id) => v.providers.find((p) => p.id === id) ?? null
  )

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
      <Banner tone="info" testID="voice-device-note">
        Padrões deste aparelho (não sincronizam) — cada persona pode ter a própria voz e transcrição
        (Configurações → Personas → aba Voz). Uma voz de persona que não existe aqui (provedor
        ausente, motor local ou GPU do computador) usa a padrão deste aparelho.
      </Banner>
      <Note>Ditado no composer e chamada de voz nos chats executados neste celular.</Note>

      {/* ---------------- ditado ---------------- */}
      <FieldLabel>Ditado</FieldLabel>
      <Card padded={false}>
        <CatalogField
          title="Idioma"
          icon="language-outline"
          value={v.audioInput.language}
          items={DICTATION_LANGUAGES}
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
      <Card>
        <MicActivationLevel
          value={activation}
          onChange={(db) => {
            setActivationDb(db)
            setActivation(activationDb())
          }}
          openMic={openMeterMic}
          disabledReason={callView.call.active ? 'Microfone em uso pela chamada de voz.' : null}
        />
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
          items={voiceItems.map((x) => ({
            id: x.id,
            name: x.label,
            detail: [x.language, x.recommended ? 'recomendada' : null].filter(Boolean).join(' · ')
          }))}
          loading={ttsCat.loading}
          hint={
            noVoiceList
              ? fishModel
                ? 'Este modelo não lista vozes: cole o id (ou o link fish.audio/m/…) de uma voz do Fish Audio, ou use a voz padrão.'
                : 'Este modelo não lista vozes: digite o id de uma voz que o provedor aceite, ou use a voz padrão.'
              : null
          }
          // Fish Audio: o link colado da biblioteca (fish.audio/m/<id>) vira o id da voz
          onChange={(id) =>
            setTts({
              api: {
                ...v.tts.api,
                voice: id && fishModel ? (fishVoiceIdFrom(id) ?? id) : id || null
              }
            })
          }
          emptyLabel="Voz padrão da API"
          allowEmpty
          testID="voice-tts-voice"
        />
      </Card>
      {v.tts.backend === 'api' && ttsProvider && v.tts.api.model ? (
        <Note>
          {supportsAudioTags(ttsFamily, v.tts.api.model)
            ? 'Este modelo interpreta tags de voz ([risos], [sussurra]…) — ative em Chamada de voz → Tags de voz.'
            : 'Tags de voz como [risos] funcionam com ElevenLabs v3/v4 e Fish Audio Drama 3/S2 — com este modelo elas são tiradas da fala.'}
        </Note>
      ) : null}
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
      </Card>
      <Note>
        O app não acrescenta prompt próprio na chamada: o único texto a mais é o “Prompt do modo
        voz” de cada persona/chat (aba Voz — vazio por padrão, com “Usar sugestão”) e, com as tags
        de voz ligadas, a instrução delas.
      </Note>
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
          subtitle="“Hum, deixa eu ver.” — só quando a resposta DEMORA (a espera abaixo); com uma ferramenta, a frase de ferramenta fica no lugar dele."
          value={d.fillers.enabled}
          onChange={(enabled) => setCall({ fillers: { ...d.fillers, enabled } })}
          testID="voice-call-fillers"
        />
        {d.fillers.enabled ? (
          <>
            <NumberField
              label="Espera do preâmbulo"
              value={d.fillers.delayMs}
              onChange={(n) =>
                setCall({ fillers: { ...d.fillers, delayMs: n ?? DEFAULT_FILLER_DELAY_MS } })
              }
              min={FILLER_DELAY_MS_RANGE.min}
              max={FILLER_DELAY_MS_RANGE.max}
              suffix="ms"
              placeholder={String(DEFAULT_FILLER_DELAY_MS)}
              testID="voice-call-filler-delay"
            />
            <Text style={st.hint} testID="voice-call-filler-delay-help">
              {`Falar “deixa eu ver…” só se a resposta demorar mais que isto depois da sua fala: se a 1ª frase da resposta (ou a frase de ferramenta) sair antes, o preâmbulo nem toca. 0 = sempre, logo depois da sua fala. Padrão ${String(DEFAULT_FILLER_DELAY_MS / 1000).replace('.', ',')} s.`}
            </Text>
          </>
        ) : null}
      </Card>
      <Text style={st.sub}>Frases de espera</Text>
      <DelayPhrasesSettings value={delay} onChange={(delayPhrases) => setCall({ delayPhrases })} />
      <Text style={st.sub}>Frases de ferramenta</Text>
      <ToolPhrasesSettings
        value={d.toolPhrases}
        onChange={(toolPhrases) => setCall({ toolPhrases })}
      />
      <Text style={st.sub}>Falar por cima da resposta</Text>
      <Card>
        <NumberField
          label="Abaixar a voz depois de"
          value={bargeIn.onsetMs}
          onChange={(n) =>
            setCall({ turn: { ...turn, duckOnsetMs: n ?? DEFAULT_BARGE_IN.onsetMs } })
          }
          min={BARGE_IN_RANGES.onsetMs.min}
          max={BARGE_IN_RANGES.onsetMs.max}
          suffix="ms"
          testID="voice-call-duck-onset"
        />
        <NumberField
          label="Volume ao falar por cima"
          value={Math.round(bargeIn.duckGain * 100)}
          onChange={(n) =>
            setCall({
              turn: {
                ...turn,
                duckGain: (n ?? Math.round(DEFAULT_BARGE_IN.duckGain * 100)) / 100
              }
            })
          }
          min={0}
          max={100}
          suffix="%"
          testID="voice-call-duck-gain"
        />
        <NumberField
          label="Interromper depois de falar"
          value={bargeIn.voicedMs}
          onChange={(n) =>
            setCall({ turn: { ...turn, bargeInVoicedMs: n ?? DEFAULT_BARGE_IN.voicedMs } })
          }
          min={BARGE_IN_RANGES.voicedMs.min}
          max={BARGE_IN_RANGES.voicedMs.max}
          suffix="ms"
          testID="voice-call-barge-in-voiced"
        />
        <NumberField
          label="Interromper com palavras"
          value={bargeIn.words}
          onChange={(n) =>
            setCall({ turn: { ...turn, bargeInWords: n ?? DEFAULT_BARGE_IN.words } })
          }
          min={BARGE_IN_RANGES.words.min}
          max={BARGE_IN_RANGES.words.max}
          testID="voice-call-barge-in-words"
        />
        <NumberField
          label="Volume volta depois de"
          value={bargeIn.restoreMs}
          onChange={(n) =>
            setCall({ turn: { ...turn, duckRestoreMs: n ?? DEFAULT_BARGE_IN.restoreMs } })
          }
          min={BARGE_IN_RANGES.restoreMs.min}
          max={BARGE_IN_RANGES.restoreMs.max}
          suffix="ms"
          testID="voice-call-duck-restore"
        />
      </Card>
      <Note>
        {`Falar enquanto o assistente responde não para a resposta na hora: depois de “Abaixar a voz depois de” de voz SEGUIDA por cima (um clique, uma tosse curta ou um barulho isolado nunca abaixam nada), a voz dele ABAIXA para o volume acima e continua; o volume volta depois do silêncio acima e o som curto é descartado. Se você insistir (o tempo com voz acima desde o começo da fala por cima, ${DEFAULT_BARGE_IN.words}+ palavras reais na transcrição ao vivo ou um pedido curto como “para”, “espera”, “chega” — sempre depois de a voz ter abaixado), ele para e a sua fala vira o próximo turno — no histórico fica só o que você ouviu. Neste celular vale com “Falar por cima da resposta” ligado em Neste aparelho (use fone); sem ele, use o botão Interromper.`}
      </Note>
      <AudioTagsField
        global
        value={d.audioTags}
        inherited={d.audioTags}
        inheritedFrom="Padrão do app"
        prompt={d.audioTagsPrompt}
        inheritedPrompt={DEFAULT_AUDIO_TAGS_PROMPT}
        onChange={(t) => setCall({ audioTags: t ?? false })}
        onPromptChange={(audioTagsPrompt) => setCall({ audioTagsPrompt })}
        support={tagsSupport}
        testID="voice-call-audio-tags"
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
          title="Falar por cima da resposta (use fone de ouvido)"
          subtitle="Ligado: falar enquanto o assistente responde abaixa a voz dele e, se você insistir, interrompe. Sem fone, deixe desligado — o microfone fica mudo enquanto o assistente fala (o celular não cancela o eco) — e use o botão Interromper."
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
            : 'Gerar clipes (preâmbulos, frases de ferramenta e agradecimentos)'
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
        Os clipes (os preâmbulos — “Hum, deixa eu ver aqui.” —, as frases de ferramenta e o
        “Obrigado por aguardar.”) são gerados com a voz padrão deste aparelho e ficam só aqui; a voz
        de uma persona tem os clipes dela (“Gerar clipes desta voz” na aba Voz da persona). Ao
        trocar a voz ou as frases, gere de novo — sem clipes, os preâmbulos não tocam e as frases de
        ferramenta e de agradecimento são sintetizadas na hora.
      </Note>
    </SettingsScreen>
  )
}

const st = StyleSheet.create({
  pad: { paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
  sub: { color: colors.muted, fontSize: 13, marginBottom: -4 },
  hint: { color: colors.faint, fontSize: 11.5, lineHeight: 15, marginTop: -2, marginBottom: 4 }
})
