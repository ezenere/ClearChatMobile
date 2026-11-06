// Chats só ao vivo de teste (só em build de desenvolvimento): liga o relé + host falsos de
// src/live/dev.ts e volta. Para o E2E no emulador (com uma conta aberta):
//   adb shell am start -a android.intent.action.VIEW -d 'clearchat://dev/live'            liga
//   …'clearchat://dev/live?do=grace|back|drop|quit|announce|saved|off'                   simula
// A linha "CLEARCHAT_LIVE ..." sai no log do Metro/logcat (sem conteúdo).
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useEffect, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { devLiveAction, installDevLive, type DevLiveAction } from '@/live/dev'
import { colors } from '@/ui/theme'

const ACTIONS = new Set(['grace', 'back', 'drop', 'quit', 'announce', 'saved', 'off'])

export default function DevLive() {
  const p = useLocalSearchParams<{ do?: string }>()
  const router = useRouter()
  const [line, setLine] = useState('…')
  useEffect(() => {
    if (!__DEV__) return
    void (async () => {
      let msg: string
      try {
        if (p.do && ACTIONS.has(p.do)) {
          devLiveAction(p.do as DevLiveAction)
          msg = `ação ${p.do}`
        } else msg = await installDevLive()
      } catch (e) {
        msg = `erro: ${e instanceof Error ? e.message : String(e)}`
      }
      console.log(`CLEARCHAT_LIVE ${msg}`)
      setLine(msg)
      if (router.canGoBack()) router.back()
    })()
    // uma vez por abertura do link
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <View style={st.root}>
      <Text style={st.text}>
        {__DEV__ ? `chats ao vivo de teste: ${line}` : 'só em desenvolvimento'}
      </Text>
    </View>
  )
}

const st = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
  text: { color: colors.muted, fontSize: 13 }
})
