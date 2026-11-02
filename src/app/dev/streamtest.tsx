// Prova do streaming no aparelho (só em builds de desenvolvimento): o `streamChat` vendorado (o
// `fetch` global = expo/fetch) contra o provedor LLM FALSO local mede quando chega o 1º delta e
// quantas atualizações saem — buffering apareceria como 1 atualização no fim. Também extrai uma
// página com o pageExtract vendorado (parse5 no Hermes). Abrir com
//   adb shell am start -a android.intent.action.VIEW -d 'clearchat://dev/streamtest?base=http://127.0.0.1:8790'
// e ler a linha "CLEARCHAT_STREAMTEST ..." no logcat.
import { useLocalSearchParams } from 'expo-router'
import { useEffect, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { newAccumulator, streamChat } from '@vendor/desktop/agent/llm'
import { extractPage } from '@vendor/desktop/tools/pageExtract'
import { colors } from '@/ui/theme'

export default function StreamTest() {
  const { base = 'http://127.0.0.1:8790' } = useLocalSearchParams<{ base?: string }>()
  const [line, setLine] = useState('rodando…')
  useEffect(() => {
    if (!__DEV__) return
    void (async () => {
      const t0 = Date.now()
      let first = 0
      const stamps: number[] = []
      const acc = newAccumulator()
      try {
        await streamChat(
          {
            url: `${base}/v1/chat/completions`,
            headers: { 'Content-Type': 'application/json' },
            body: { model: 'fake/agent', messages: [{ role: 'user', content: '/slow' }] }
          },
          AbortSignal.timeout(60_000),
          acc,
          () => {
            const t = Date.now() - t0
            if (!first && acc.content) first = t
            stamps.push(t)
          }
        )
        const total = Date.now() - t0
        const html = await (await fetch(`${base}/page/hermes`)).text()
        const page = extractPage(html, `${base}/page/hermes`, { mode: 'main' })
        const ok = stamps.length > 50 && first < total / 4
        const msg =
          `CLEARCHAT_STREAMTEST ${ok ? 'PASS' : 'FAIL'} first_delta_ms=${first} total_ms=${total} ` +
          `updates=${stamps.length} chars=${acc.content.length} ` +
          `parse5_title=${JSON.stringify(page.title)} parse5_md_chars=${page.markdown.length}`
        console.log(msg)
        setLine(msg)
      } catch (e) {
        const msg = `CLEARCHAT_STREAMTEST FAIL erro=${(e as Error).message}`
        console.log(msg)
        setLine(msg)
      }
    })()
  }, [base])
  return (
    <View style={st.root} testID="screen-streamtest">
      <Text style={st.text}>{line}</Text>
    </View>
  )
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, padding: 24, justifyContent: 'center' },
  text: { color: colors.fg, fontSize: 14, fontFamily: 'monospace' }
})
