// Aviso push de teste (só em build de desenvolvimento): monta uma mensagem de dados igual à do FCM
// (§22.3, cifrada com o K_push do cofre aberto) e a entrega ao MESMO tratamento da tarefa em segundo
// plano — sem FCM, sem servidor. Para o E2E no emulador:
//   adb shell am start -a android.intent.action.VIEW -d 'clearchat://dev/push?kind=approval&chat=<id>'
//   …&kind=reply|question|retry|error|host_offline|dismiss  &tag=<32 hex>  &title=…  &text=…
//   …&delay=3      entrega 3 s depois de voltar (ex.: para testar com o chat aberto)
//   …&mode=badkey  cifrado com outra chave (descarta)   mode=old (ts de 2 dias atrás, descarta)
//   …&mode=mismatch kind interno diferente (descarta)    nokey=1 (finge DEK indisponível → genérico)
//   raw=<JSON do `message.data` do FCM, URL-encoded>  entrega uma mensagem real capturada (ex.: do
//       servidor apontando para um FCM falso local) sem montar nada
// A tela volta sozinha; a linha "CLEARCHAT_PUSH ..." sai no log do Metro/logcat (sem conteúdo).
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useEffect, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { account } from '@/account/native'
import { randomBytes } from '@/crypto'
import { sealPush } from '@/push/crypto'
import { describeDecision, randomTag } from '@/push/model'
import { handlePushData, setDevNoKey } from '@/push/task'
import { colors } from '@/ui/theme'

type Params = {
  kind?: string
  chat?: string
  tag?: string
  title?: string
  text?: string
  host?: string
  delay?: string
  mode?: string
  nokey?: string
  raw?: string
}

async function craft(p: Params): Promise<Record<string, string>> {
  if (p.raw) return JSON.parse(p.raw) as Record<string, string>
  const kind = p.kind ?? 'approval'
  const tag = p.tag ?? randomTag(randomBytes(16))
  const sentAt = new Date(p.mode === 'old' ? Date.now() - 2 * 86_400_000 : Date.now()).toISOString()
  const base = { v: '1', kind, tag, sent_at: sentAt }
  if (kind === 'dismiss') return { ...base, env: '' }
  if (kind === 'host_offline')
    return { ...base, env: '', chat_id: p.chat ?? '', device_name: p.host ?? 'Desktop de casa' }
  const userId = account.accountUserId
  const key = p.mode === 'badkey' ? randomBytes(32) : account.pushKey
  if (!userId || !key) throw new Error('cofre fechado')
  const payload = {
    sv: 1,
    kind: p.mode === 'mismatch' ? (kind === 'reply' ? 'approval' : 'reply') : kind,
    chatId: p.chat ?? '',
    sessionId: undefined,
    chatTitle: p.title ?? 'Chat de teste',
    text: p.text ?? 'Executar: npm test',
    requestId: kind === 'reply' || kind === 'error' ? undefined : 'req-dev',
    hostName: p.host ?? 'Desktop de casa',
    ts: p.mode === 'old' ? Date.now() - 2 * 86_400_000 : Date.now()
  }
  const env = await sealPush(key, userId, kind, tag, payload)
  return { ...base, env: JSON.stringify(env) }
}

export default function DevPush() {
  const p = useLocalSearchParams<Params>()
  const router = useRouter()
  const [line, setLine] = useState('…')
  useEffect(() => {
    if (!__DEV__) return
    void (async () => {
      let msg: string
      try {
        const data = await craft(p)
        if (router.canGoBack()) router.back()
        const delay = Number(p.delay ?? 0)
        if (delay > 0) await new Promise((r) => setTimeout(r, delay * 1000))
        setDevNoKey(p.nokey === '1')
        // mesma forma do RemoteMessage serializado que a tarefa recebe no Android
        const d = await handlePushData({ data: { data, collapseKey: data.tag } })
        setDevNoKey(false)
        msg = `${data.kind} ${data.tag} → ${d ? describeDecision(d) : 'ignorado'}`
      } catch (e) {
        msg = `erro: ${e instanceof Error ? e.message : String(e)}`
        if (router.canGoBack()) router.back()
      }
      console.log(`CLEARCHAT_PUSH ${msg}`)
      setLine(msg)
    })()
    // uma vez por abertura do link
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <View style={st.root}>
      <Text style={st.text}>{__DEV__ ? `aviso de teste: ${line}` : 'só em desenvolvimento'}</Text>
    </View>
  )
}

const st = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
  text: { color: colors.muted, fontSize: 13 }
})
