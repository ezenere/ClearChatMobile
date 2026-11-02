// Microfone de teste (só em build de desenvolvimento): liga/desliga e injeta WAVs no "microfone"
// sem abrir o microfone real — para o E2E ditar e conversar no emulador.
//   adb shell am start -a android.intent.action.VIEW -d 'clearchat://dev/fakemic?on=1'
//   adb shell am start -a android.intent.action.VIEW -d 'clearchat://dev/fakemic?play=http://127.0.0.1:8790/mic/q1.wav'
//   adb shell am start -a android.intent.action.VIEW -d 'clearchat://dev/fakemic?poll=http://127.0.0.1:8790'
//     → o microfone de teste busca WAVs em <poll>/mic/next (o E2E enfileira com
//       `curl -X POST <poll>/mic/queue?name=q1.wav` sem tirar o app do primeiro plano)
// A tela volta sozinha; a linha "CLEARCHAT_FAKEMIC ..." sai no log do Metro/logcat.
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useEffect, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { colors } from '@/ui/theme'
import { fakeMicEnabled, injectFakeMic, setFakeMicEnabled, setFakeMicPoll } from '@/voice/native'

export default function FakeMic() {
  const { on, play, poll } = useLocalSearchParams<{ on?: string; play?: string; poll?: string }>()
  const router = useRouter()
  const [line, setLine] = useState('…')
  useEffect(() => {
    if (!__DEV__) return
    void (async () => {
      let msg = ''
      try {
        if (on === '1' || on === '0') setFakeMicEnabled(on === '1')
        if (poll !== undefined) setFakeMicPoll(poll || null)
        msg = `enabled=${fakeMicEnabled()}${poll ? ` poll=${poll}` : ''}`
        if (play) msg += ` injected=${await injectFakeMic(play)}ms`
      } catch (e) {
        msg += ` error=${e instanceof Error ? e.message : String(e)}`
      }
      console.log(`CLEARCHAT_FAKEMIC ${msg}`)
      setLine(msg)
      if (router.canGoBack()) router.back()
    })()
  }, [on, play, poll, router])
  return (
    <View style={st.root}>
      <Text style={st.text}>
        {__DEV__ ? `microfone de teste: ${line}` : 'só em desenvolvimento'}
      </Text>
    </View>
  )
}

const st = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
  text: { color: colors.muted, fontSize: 13 }
})
