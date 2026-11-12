// Configurações → Voz → Ditado: "Nível de ativação" do microfone (`audioInput.activationDb`, LOCAL
// deste aparelho — nunca sincroniza; = `MicActivationLevel.tsx` do desktop) com um medidor ao vivo e
// a linha do nível. Abaixo do nível nada é fala: o portão de ativação (`@shared/speechGate`) não
// manda o trecho ao STT (corta as alucinações do whisper em silêncio/ruído — "Tchau.", "Obrigado.")
// e a chamada não abre turno nem abaixa a voz do assistente. O medidor só abre o microfone quando o
// usuário toca em "Testar" (nunca sozinho). Arrastar/tocar no medidor (ou −/+) muda o nível.
import Ionicons from '@expo/vector-icons/Ionicons'
import { useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { ACTIVATION_DB_RANGE, DEFAULT_ACTIVATION_DB, rmsToDb } from '@shared/speechGate'
import { captureErrorText } from '@vendor/renderer/voice/dictation'
import { colors, radius, spacing } from '@/ui/theme'
import type { MicSource } from '@/voice/mic'

/** Faixa do medidor (dBFS): a da ativação com uma folga dos dois lados (= desktop). */
const METER_MIN = -80
const METER_MAX = -10

/** dBFS → posição no medidor (0..100 %). */
export function meterPct(db: number): number {
  const v = Math.min(METER_MAX, Math.max(METER_MIN, db))
  return ((v - METER_MIN) / (METER_MAX - METER_MIN)) * 100
}

/** Posição no medidor (0..1) → nível de ativação (dB inteiro, preso na faixa). */
export function dbAtFraction(f: number): number {
  const db = METER_MIN + Math.min(1, Math.max(0, f)) * (METER_MAX - METER_MIN)
  return Math.min(ACTIVATION_DB_RANGE.max, Math.max(ACTIVATION_DB_RANGE.min, Math.round(db)))
}

export function MicActivationLevel({
  value,
  onChange,
  openMic,
  disabledReason
}: {
  /** Nível salvo (dBFS). */
  value: number
  onChange: (db: number) => void
  /** Abre o microfone do teste (pede a permissão); null = negada. */
  openMic: () => Promise<MicSource | null>
  /** Teste indisponível agora (ex.: chamada em andamento). */
  disabledReason?: string | null
}) {
  const [testing, setTesting] = useState(false)
  const [level, setLevel] = useState<number | null>(null)
  const [peak, setPeak] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<number | null>(null)
  const width = useRef(1)
  const shown = draft ?? value

  useEffect(() => {
    if (!testing) return
    let disposed = false
    let mic: MicSource | null = null
    let peakDb = -120
    void (async () => {
      try {
        mic = await openMic()
        if (disposed) return
        if (!mic) {
          setError(captureErrorText({ name: 'NotAllowedError', message: '' }))
          setTesting(false)
          return
        }
        await mic.start(
          (f) => {
            if (disposed) return
            const db = rmsToDb(f.rms)
            peakDb = Math.max(db, peakDb - 0.6) // pico que cai devagar
            setLevel(db)
            setPeak(peakDb)
          },
          (e) => {
            if (disposed) return
            setError(captureErrorText(e))
            setTesting(false)
          }
        )
        if (disposed) void mic.stop()
      } catch (e) {
        if (disposed) return
        setError(captureErrorText(e as Error))
        setTesting(false)
      }
    })()
    return () => {
      disposed = true
      void mic?.stop().catch(() => undefined)
      setLevel(null)
      setPeak(null)
    }
  }, [testing, openMic])

  const commitAt = (x: number) => {
    const db = dbAtFraction(x / Math.max(1, width.current))
    setDraft(db)
    return db
  }
  const finish = (db: number | null) => {
    setDraft(null)
    if (db != null && db !== value) onChange(db)
  }
  const step = (d: number) => {
    const db = Math.min(ACTIVATION_DB_RANGE.max, Math.max(ACTIVATION_DB_RANGE.min, value + d))
    if (db !== value) onChange(db)
  }
  const above = level != null && level >= shown

  return (
    <View style={st.wrap} testID="mic-activation">
      <View style={st.head}>
        <Text style={st.title}>Nível de ativação</Text>
        <Text style={st.value} testID="mic-activation-value">
          {shown} dB
        </Text>
      </View>
      <View style={st.row}>
        <Pressable
          onPress={() => step(-1)}
          hitSlop={6}
          style={st.stepBtn}
          accessibilityLabel="Diminuir o nível de ativação"
          testID="mic-activation-minus"
        >
          <Ionicons name="remove" size={16} color={colors.muted} />
        </Pressable>
        <View
          style={st.meter}
          testID="mic-activation-meter"
          onLayout={(e) => (width.current = e.nativeEvent.layout.width)}
          onStartShouldSetResponder={() => true}
          onMoveShouldSetResponder={() => true}
          onResponderGrant={(e) => void commitAt(e.nativeEvent.locationX)}
          onResponderMove={(e) => void commitAt(e.nativeEvent.locationX)}
          onResponderRelease={(e) => finish(commitAt(e.nativeEvent.locationX))}
          onResponderTerminate={() => finish(draft)}
          accessibilityRole="adjustable"
          accessibilityLabel={`Nível de ativação do microfone: ${shown} dB`}
          accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
          onAccessibilityAction={(e) => step(e.nativeEvent.actionName === 'increment' ? 1 : -1)}
        >
          {level != null ? (
            <View
              pointerEvents="none"
              style={[
                st.fill,
                { width: `${meterPct(level)}%` },
                above ? st.fillAbove : st.fillBelow
              ]}
              testID="mic-activation-fill"
            />
          ) : null}
          {peak != null ? (
            <View pointerEvents="none" style={[st.peak, { left: `${meterPct(peak)}%` }]} />
          ) : null}
          {/* a linha do nível de ativação */}
          <View
            pointerEvents="none"
            style={[st.threshold, { left: `${meterPct(shown)}%` }]}
            testID="mic-activation-threshold"
          />
        </View>
        <Pressable
          onPress={() => step(1)}
          hitSlop={6}
          style={st.stepBtn}
          accessibilityLabel="Aumentar o nível de ativação"
          testID="mic-activation-plus"
        >
          <Ionicons name="add" size={16} color={colors.muted} />
        </Pressable>
        <Pressable
          onPress={() => {
            setError(null)
            setTesting((t) => !t)
          }}
          disabled={!testing && !!disabledReason}
          style={[st.test, testing && st.testOn, !testing && !!disabledReason && { opacity: 0.4 }]}
          accessibilityRole="button"
          accessibilityLabel={testing ? 'Parar o teste do microfone' : 'Testar o microfone'}
          testID="mic-activation-test"
        >
          <Ionicons
            name={testing ? 'stop' : 'mic-outline'}
            size={14}
            color={testing ? colors.onAccent : colors.fg}
          />
          <Text style={[st.testText, testing && { color: colors.onAccent }]}>
            {testing ? 'Parar' : 'Testar'}
          </Text>
        </Pressable>
      </View>
      {testing && level != null ? (
        <Text style={st.status} testID="mic-activation-status">
          {above ? 'Fala detectada' : 'Abaixo do nível — não conta como fala'} · {Math.round(level)}{' '}
          dB
        </Text>
      ) : null}
      {error ? (
        <Text style={st.err} testID="mic-activation-error">
          {error}
        </Text>
      ) : null}
      {!testing && disabledReason ? <Text style={st.status}>{disabledReason}</Text> : null}
      <Text style={st.help}>
        Abaixo deste nível o som não conta como fala: o trecho nem vai para a transcrição (ditado e
        chamada de voz) e não abaixa a voz do assistente. Evita que silêncio e ruído virem texto
        inventado — o “Tchau.” ou “Obrigado.” que aparecem do nada. Toque em Testar, fale
        normalmente e deixe a linha entre o ruído parado e a sua voz (arraste no medidor ou use
        −/+). Vale só neste aparelho (depende do microfone e do ambiente; não sincroniza). Padrão{' '}
        {DEFAULT_ACTIVATION_DB} dB.
      </Text>
    </View>
  )
}

const st = StyleSheet.create({
  wrap: { gap: 6, paddingVertical: 4 },
  head: { flexDirection: 'row', alignItems: 'center' },
  title: { flex: 1, color: colors.fg, fontSize: 14.5 },
  value: { color: colors.muted, fontSize: 13, fontFamily: 'monospace' },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  stepBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.active
  },
  meter: {
    flex: 1,
    height: 22,
    borderRadius: radius.pill,
    backgroundColor: colors.hover,
    overflow: 'hidden',
    justifyContent: 'center'
  },
  fill: { position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: radius.pill },
  fillAbove: { backgroundColor: 'rgba(74, 222, 128, 0.7)' },
  fillBelow: { backgroundColor: 'rgba(110, 110, 120, 0.45)' },
  peak: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 1,
    backgroundColor: 'rgba(230,230,234,0.45)'
  },
  threshold: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 3,
    marginLeft: -1,
    backgroundColor: colors.accentStrong
  },
  test: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    height: 32,
    borderRadius: radius.pill,
    backgroundColor: colors.active
  },
  testOn: { backgroundColor: colors.accent },
  testText: { color: colors.fg, fontSize: 13, fontWeight: '500' },
  status: { color: colors.subtle, fontSize: 12 },
  err: { color: colors.danger, fontSize: 12.5 },
  help: { color: colors.faint, fontSize: 11.5, lineHeight: 15 }
})
