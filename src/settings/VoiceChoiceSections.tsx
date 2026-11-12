// Voz da persona/chat (protocolo 1.9.0 — `config.voice.tts`/`.stt`): as seções "Fala" e
// "Transcrição" da aba Voz (editor de personas e "Chamada de voz…" do chat) — = `VoiceChoiceSections`
// do desktop. Sem opção "herdar/padrão" duplicada: cada seção diz o que vale ("Usando a voz padrão
// deste aparelho: …" / "Usando a voz da persona “X”: …" / "Voz própria desta persona: …"), se
// funciona AQUI ("Disponível aqui" / "Não disponível neste dispositivo — usa o padrão deste
// dispositivo (…): <motivo>") e oferece "Escolher…" (os mesmos seletores de Configurações → Voz:
// provedor, modelo, voz e parâmetros; na transcrição, provedor/modelo e o idioma com ★ no deste
// aparelho), "Testar esta voz", "Gerar clipes desta voz" (só com o clique — uma API paga) e "Voltar
// a usar …". No celular só a API funciona: uma escolha local/GPU feita no computador aparece com o
// rótulo e cai na padrão daqui. A escolha sincroniza com a persona/chat.
import Ionicons from '@expo/vector-icons/Ionicons'
import { useState } from 'react'
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'
import type { Provider } from '@shared/types'
import {
  applySttChoice,
  applyTtsChoice,
  normalizeVoiceSttChoice,
  normalizeVoiceTtsChoice,
  sttChoiceFromSettings,
  ttsChoiceFromSettings,
  type VoiceCallConfig,
  type VoiceResolution,
  type VoiceSttChoice,
  type VoiceTtsChoice
} from '@shared/voice'
import { apiParamSpecs, setVoiceApiParam } from '@shared/voiceParams'
import { fishVoiceIdFrom, isFishAudioModel } from '@shared/voiceCatalog'
import { sttVoiceLabel, ttsVoiceLabel } from '@vendor/renderer/voice/voiceChoice'
import { describeError } from '@/account/errors'
import { TextButton } from '@/ui/Button'
import { Card, Divider } from '@/ui/Card'
import { useToast } from '@/ui/Toast'
import { colors, spacing } from '@/ui/theme'
import { voiceFamily, voiceProviders, type VoiceSettings } from '@/voice/endpoints'
import { mobileVoiceText, resolveChatVoice } from '@/voice/resolve'
import { voice as voiceStack } from '@/voice/native'
import { FieldLabel, Note } from './ui'
import {
  CatalogField,
  DICTATION_LANGUAGES,
  testTtsVoice,
  useVoiceCatalog,
  VoiceParamsEditor,
  VoiceProviderField
} from './voiceUi'

type Res = VoiceResolution<unknown, unknown>

/** Linha de disponibilidade NESTE aparelho da voz que está valendo neste nível. */
function Availability({ r, deviceLabel, testID }: { r: Res; deviceLabel: string; testID: string }) {
  const state = !r.available ? 'unavailable' : r.fallback ? 'fallback' : 'ok'
  const color =
    state === 'ok' ? colors.success : state === 'fallback' ? colors.warning : colors.danger
  const text =
    state === 'ok'
      ? 'Disponível aqui'
      : state === 'fallback'
        ? `Não disponível neste dispositivo — usa o padrão deste dispositivo (${deviceLabel}): ${r.fallback?.reason ?? ''}`
        : mobileVoiceText(
            `${r.unconfigured ? 'Não configurada' : 'Não funciona'} neste dispositivo: ${r.reason ?? 'indisponível'} (Configurações → Áudio)`
          )
  return (
    <View style={st.avail} testID={testID} accessibilityLabel={text}>
      <Ionicons
        name={state === 'ok' ? 'checkmark-circle' : 'warning'}
        size={15}
        color={color}
        style={{ marginTop: 1 }}
      />
      <Text style={[st.availText, { color }]}>{text}</Text>
    </View>
  )
}

export function VoiceChoiceSections({
  value,
  onChange,
  scope,
  persona,
  device,
  providers,
  testID = 'voice-choice'
}: {
  /** A `voice` deste nível (normalizada). */
  value: VoiceCallConfig
  onChange: (p: Pick<VoiceCallConfig, 'tts' | 'stt'>) => void
  scope: 'chat' | 'persona'
  /** Chat: a persona de origem (a voz dela é herdada ao vivo). */
  persona: { name: string; voice: VoiceCallConfig | null } | null
  device: VoiceSettings
  providers: Provider[]
  testID?: string
}) {
  const provider = (id: string) => providers.find((p) => p.id === id) ?? null
  const layers =
    scope === 'chat' ? { chat: value, persona: persona?.voice ?? null } : { persona: value }
  const r = resolveChatVoice(layers, device, provider)
  const where = scope === 'chat' ? 'deste chat' : 'desta persona'
  return (
    <View style={{ gap: spacing.md }} testID={testID}>
      <TtsChoice
        own={value.tts ?? null}
        inherited={scope === 'chat' ? normalizeVoiceTtsChoice(persona?.voice?.tts) : null}
        personaName={persona?.name ?? ''}
        device={device}
        providers={providers}
        r={r.tts}
        where={where}
        scope={scope}
        onChange={(tts) => onChange({ tts, stt: value.stt ?? null })}
      />
      <SttChoice
        own={value.stt ?? null}
        inherited={scope === 'chat' ? normalizeVoiceSttChoice(persona?.voice?.stt) : null}
        personaName={persona?.name ?? ''}
        device={device}
        providers={providers}
        r={r.stt}
        where={where}
        scope={scope}
        onChange={(stt) => onChange({ tts: value.tts ?? null, stt })}
      />
    </View>
  )
}

interface ChoiceProps<C> {
  own: C | null
  inherited: C | null
  personaName: string
  device: VoiceSettings
  providers: Provider[]
  r: Res
  where: string
  scope: 'chat' | 'persona'
  onChange: (c: C | null) => void
}

/** Ponto de partida da voz pela API: a que vale agora (se for pela API) ou o 1º provedor de fala. */
function startTts(inherited: VoiceTtsChoice | null, device: VoiceSettings, providers: Provider[]) {
  const from = inherited ?? ttsChoiceFromSettings(device.tts)
  if (from?.backend === 'api') return from
  const p = voiceProviders(providers, 'tts')[0]
  return {
    backend: 'api' as const,
    api: {
      providerId: p?.id ?? '',
      model: p && voiceFamily(p) === 'elevenlabs' ? 'eleven_flash_v2_5' : '',
      voice: null
    }
  }
}

function TtsChoice(p: ChoiceProps<VoiceTtsChoice>) {
  const toast = useToast()
  const { own, inherited, device, providers } = p
  // rascunho: o seletor aberto ainda sem provedor+modelo (só grava quando a escolha vale)
  const [draft, setDraft] = useState<VoiceTtsChoice | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const deviceLabel = ttsVoiceLabel(device.tts, providers)
  const label = (c: VoiceTtsChoice) => ttsVoiceLabel(applyTtsChoice(device.tts, c), providers)
  const current = own
    ? `Voz própria ${p.where}: ${label(own)}`
    : inherited
      ? `Usando a voz da persona “${p.personaName}”: ${label(inherited)}`
      : `Usando a voz padrão deste dispositivo: ${deviceLabel}`
  const back = inherited
    ? 'Voltar a usar a voz da persona'
    : 'Voltar a usar a voz padrão deste dispositivo'
  const editing: VoiceTtsChoice | null = draft ?? (own?.backend === 'api' ? own : null)
  const commit = (next: VoiceTtsChoice) => {
    const c = normalizeVoiceTtsChoice(next)
    if (c) {
      setDraft(null)
      p.onChange(c)
    } else setDraft(next)
  }
  const tid = `tts-choice-${p.scope}`
  return (
    <View style={{ gap: spacing.sm }} testID={tid}>
      <FieldLabel>Fala</FieldLabel>
      <Text style={st.current} testID="tts-choice-current">
        {current}
      </Text>
      <Availability r={p.r} deviceLabel={deviceLabel} testID="tts-choice-availability" />
      {editing && editing.backend === 'api' ? (
        <TtsApiPicker
          choice={editing}
          providers={providers}
          onChange={commit}
          pending={!!draft}
          testID={tid}
        />
      ) : own ? (
        <Note>
          Voz escolhida no computador (motor local/GPU) — neste celular vale a padrão deste
          aparelho.
        </Note>
      ) : null}
      <View style={st.actions}>
        {own || draft ? (
          <>
            {own ? (
              <TextButton
                title={busy === 'test' ? 'Tocando…' : 'Testar esta voz'}
                icon="play-outline"
                disabled={!!busy}
                onPress={() => {
                  setBusy('test')
                  void testTtsVoice(applyTtsChoice(device.tts, own), providers)
                    .catch((e: unknown) =>
                      toast(`Não foi possível testar a voz: ${describeError(e)}`, 'danger')
                    )
                    .finally(() => setBusy(null))
                }}
                testID="tts-choice-test"
              />
            ) : null}
            {own ? (
              <TextButton
                title={busy?.startsWith('clips') ? busy.slice(6) : 'Gerar clipes desta voz'}
                icon="musical-notes-outline"
                disabled={!!busy}
                onPress={() => {
                  setBusy('clips Gerando…')
                  void voiceStack.call
                    .generateClips(own, (done, total) =>
                      setBusy(`clips Gerando clipes… ${done}/${total}`)
                    )
                    .then(() => toast('Clipes desta voz prontos'))
                    .catch((e: unknown) => toast(describeError(e), 'danger'))
                    .finally(() => setBusy(null))
                }}
                testID="tts-choice-clips"
              />
            ) : null}
            {own && own.backend !== 'api' && !draft ? (
              <TextButton
                title="Trocar por uma voz pela API"
                icon="swap-horizontal"
                onPress={() => setDraft(startTts(null, device, providers))}
                testID="tts-choice-api"
              />
            ) : null}
            <TextButton
              title={back}
              tone="muted"
              icon="refresh"
              onPress={() => {
                setDraft(null)
                p.onChange(null)
              }}
              testID="tts-choice-inherit"
            />
          </>
        ) : (
          <TextButton
            title={
              p.scope === 'chat'
                ? 'Escolher uma voz para este chat'
                : 'Escolher uma voz para esta persona'
            }
            icon="person-circle-outline"
            onPress={() => commit(startTts(inherited, device, providers))}
            testID="tts-choice-custom"
          />
        )}
        {busy?.startsWith('clips') ? (
          <ActivityIndicator size={14} color={colors.accentStrong} />
        ) : null}
      </View>
    </View>
  )
}

/** Provedor/modelo/voz/parâmetros de uma voz pela API (os seletores de Configurações → Voz). */
function TtsApiPicker({
  choice,
  providers,
  onChange,
  pending,
  testID
}: {
  choice: Extract<VoiceTtsChoice, { backend: 'api' }>
  providers: Provider[]
  onChange: (c: VoiceTtsChoice) => void
  pending: boolean
  testID: string
}) {
  const prov = providers.find((x) => x.id === choice.api.providerId) ?? null
  const cat = useVoiceCatalog('tts', prov, true)
  const family = prov ? voiceFamily(prov) : null
  const specs = apiParamSpecs('tts', family, choice.api.model)
  const modelInfo = cat.view?.models.find((m) => m.id === choice.api.model) ?? null
  const ids = modelInfo?.voiceIds ?? null
  const fish = isFishAudioModel(choice.api.model)
  const set = (api: Partial<typeof choice.api>) =>
    onChange({ backend: 'api', api: { ...choice.api, ...api } })
  return (
    <>
      <Card padded={false}>
        <VoiceProviderField
          capability="tts"
          providers={providers}
          value={choice.api.providerId || null}
          onChange={(id) => {
            const np = id ? providers.find((x) => x.id === id) : null
            set({
              providerId: id ?? '',
              model: np && voiceFamily(np) === 'elevenlabs' ? 'eleven_flash_v2_5' : '',
              voice: null,
              params: undefined
            })
          }}
          testID={`${testID}-provider`}
        />
        <Divider />
        <CatalogField
          title="Modelo de fala"
          icon="volume-high-outline"
          value={choice.api.model}
          items={(cat.view?.models ?? []).map((m) => ({ id: m.id, name: m.label }))}
          loading={cat.loading}
          error={cat.view?.error}
          hint={cat.view?.hint}
          onRefresh={cat.refresh}
          onChange={(model) => set({ model })}
          emptyLabel="Escolha o modelo"
          testID={`${testID}-model`}
        />
        <Divider />
        <CatalogField
          title="Voz"
          icon="person-outline"
          value={choice.api.voice ?? ''}
          items={(cat.view?.voices ?? [])
            .filter((x) => !ids?.length || ids.includes(x.id))
            .map((x) => ({ id: x.id, name: x.label, detail: x.language ?? undefined }))}
          loading={cat.loading}
          hint={
            ids && !ids.length
              ? fish
                ? 'Este modelo não lista vozes: cole o id (ou o link fish.audio/m/…) de uma voz do Fish Audio, ou use a voz padrão.'
                : 'Este modelo não lista vozes: digite o id de uma voz que o provedor aceite, ou use a voz padrão.'
              : null
          }
          onChange={(id) => set({ voice: id && fish ? (fishVoiceIdFrom(id) ?? id) : id || null })}
          emptyLabel="Voz padrão da API"
          allowEmpty
          testID={`${testID}-voice`}
        />
      </Card>
      {family && specs.length ? (
        <Card>
          <VoiceParamsEditor
            specs={specs}
            values={choice.api.params?.[family] ?? {}}
            onChange={(key, val) =>
              set({ params: setVoiceApiParam('tts', family, choice.api.params, key, val) })
            }
            testID={`${testID}-param`}
          />
          <Note>Os parâmetros sincronizam junto com a voz da persona/chat.</Note>
        </Card>
      ) : null}
      {pending ? (
        <Text style={st.pending} testID={`${testID}-pending`}>
          Escolha o provedor e o modelo para salvar esta voz.
        </Text>
      ) : null}
    </>
  )
}

/** Ponto de partida da transcrição pela API: a que vale agora (pela API) ou o 1º provedor. */
function startStt(inherited: VoiceSttChoice | null, device: VoiceSettings, providers: Provider[]) {
  const from = inherited ?? sttChoiceFromSettings(device.stt)
  if (from && (from.mode === 'api' || from.mode === 'hybrid') && from.api)
    return {
      mode: 'api' as const,
      api: from.api,
      ...(from.language ? { language: from.language } : {})
    }
  const p = voiceProviders(providers, 'stt')[0]
  return { mode: 'api' as const, api: { providerId: p?.id ?? '', model: '' } }
}

function SttChoice(p: ChoiceProps<VoiceSttChoice>) {
  const { own, inherited, device, providers } = p
  const [draft, setDraft] = useState<VoiceSttChoice | null>(null)
  const deviceLanguage = device.audioInput.language
  const deviceLabel = sttVoiceLabel(device.stt, providers, deviceLanguage)
  const label = (c: VoiceSttChoice) =>
    sttVoiceLabel(applySttChoice(device.stt, c), providers, c.language || deviceLanguage)
  const current = own
    ? `Transcrição própria ${p.where}: ${label(own)}`
    : inherited
      ? `Usando a transcrição da persona “${p.personaName}”: ${label(inherited)}`
      : `Usando a transcrição padrão deste dispositivo: ${deviceLabel}`
  const back = inherited
    ? 'Voltar a usar a transcrição da persona'
    : 'Voltar a usar a transcrição padrão deste dispositivo'
  const editing = draft ?? (own && (own.mode === 'api' || own.mode === 'hybrid') ? own : null)
  const commit = (next: VoiceSttChoice) => {
    const c = normalizeVoiceSttChoice(next)
    if (c) {
      setDraft(null)
      p.onChange(c)
    } else setDraft(next)
  }
  const tid = `stt-choice-${p.scope}`
  return (
    <View style={{ gap: spacing.sm }} testID={tid}>
      <FieldLabel>Transcrição</FieldLabel>
      <Text style={st.current} testID="stt-choice-current">
        {current}
      </Text>
      <Availability r={p.r} deviceLabel={deviceLabel} testID="stt-choice-availability" />
      {editing ? (
        <SttApiPicker
          choice={editing}
          deviceLanguage={deviceLanguage}
          providers={providers}
          onChange={commit}
          pending={!!draft}
          testID={tid}
        />
      ) : own ? (
        <Note>
          Transcrição escolhida no computador (motor local/GPU) — neste celular vale a padrão deste
          aparelho.
        </Note>
      ) : null}
      <View style={st.actions}>
        {own || draft ? (
          <>
            {own && !editing ? (
              <TextButton
                title="Trocar por uma transcrição pela API"
                icon="swap-horizontal"
                onPress={() => setDraft(startStt(null, device, providers))}
                testID="stt-choice-api"
              />
            ) : null}
            <TextButton
              title={back}
              tone="muted"
              icon="refresh"
              onPress={() => {
                setDraft(null)
                p.onChange(null)
              }}
              testID="stt-choice-inherit"
            />
          </>
        ) : (
          <TextButton
            title={
              p.scope === 'chat'
                ? 'Escolher a transcrição deste chat'
                : 'Escolher a transcrição desta persona'
            }
            icon="mic-circle-outline"
            onPress={() => commit(startStt(inherited, device, providers))}
            testID="stt-choice-custom"
          />
        )}
      </View>
    </View>
  )
}

/** Provedor/modelo/idioma (★ = o do ditado deste aparelho) de uma transcrição pela API. */
function SttApiPicker({
  choice,
  deviceLanguage,
  providers,
  onChange,
  pending,
  testID
}: {
  choice: VoiceSttChoice
  deviceLanguage: string
  providers: Provider[]
  onChange: (c: VoiceSttChoice) => void
  pending: boolean
  testID: string
}) {
  const api = choice.api ?? { providerId: '', model: '' }
  const prov = providers.find((x) => x.id === api.providerId) ?? null
  const cat = useVoiceCatalog('stt', prov, true)
  const family = prov ? voiceFamily(prov) : null
  const specs = apiParamSpecs('stt', family, api.model)
  // no celular a transcrição da persona é pela API (o motor local de um híbrido fica de fora)
  const set = (patch: Partial<NonNullable<VoiceSttChoice['api']>>) =>
    onChange({
      mode: 'api',
      api: { ...api, ...patch },
      ...(choice.language ? { language: choice.language } : {})
    })
  const lang = choice.language || deviceLanguage
  const langItems = [
    ...DICTATION_LANGUAGES,
    ...[deviceLanguage, choice.language ?? '']
      .filter((c) => c && !DICTATION_LANGUAGES.some((l) => l.id === c))
      .map((c) => ({ id: c, name: c }))
  ].map((l) =>
    l.id === deviceLanguage ? { ...l, name: `${l.name} ★`, detail: 'o deste aparelho' } : l
  )
  return (
    <>
      <Card padded={false}>
        <VoiceProviderField
          capability="stt"
          providers={providers}
          value={api.providerId || null}
          onChange={(id) => set({ providerId: id ?? '', model: '', params: undefined })}
          testID={`${testID}-provider`}
        />
        <Divider />
        <CatalogField
          title="Modelo de transcrição"
          icon="mic-outline"
          value={api.model}
          items={(cat.view?.models ?? []).map((m) => ({ id: m.id, name: m.label }))}
          loading={cat.loading}
          error={cat.view?.error}
          hint={cat.view?.hint}
          onRefresh={cat.refresh}
          onChange={(model) => model && set({ model })}
          emptyLabel="Escolha o modelo"
          testID={`${testID}-model`}
        />
        <Divider />
        <CatalogField
          title="Idioma"
          icon="language-outline"
          value={lang}
          items={langItems}
          onChange={(v) => {
            // ★ (o idioma deste aparelho) = segue o aparelho
            const { language: _drop, ...rest } = choice
            void _drop
            onChange(!v || v === deviceLanguage ? rest : { ...rest, language: v })
          }}
          emptyLabel="Detectar automaticamente"
          testID={`${testID}-language`}
        />
      </Card>
      {family && specs.length ? (
        <Card>
          <VoiceParamsEditor
            specs={specs}
            values={api.params?.[family] ?? {}}
            onChange={(key, val) =>
              set({ params: setVoiceApiParam('stt', family, api.params, key, val) })
            }
            testID={`${testID}-param`}
          />
        </Card>
      ) : null}
      {pending ? (
        <Text style={st.pending} testID={`${testID}-pending`}>
          Escolha o provedor e o modelo para salvar esta transcrição.
        </Text>
      ) : null}
    </>
  )
}

const st = StyleSheet.create({
  current: { color: colors.fg, fontSize: 14, lineHeight: 19 },
  avail: { flexDirection: 'row', gap: 6, alignItems: 'flex-start' },
  availText: { flex: 1, fontSize: 12.5, lineHeight: 17 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.md },
  pending: { color: colors.warning, fontSize: 12.5 }
})
