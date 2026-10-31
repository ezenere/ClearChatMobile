// Captcha (§15): a página /captcha da PRÓPRIA instância numa WebView isolada (sem cookies
// persistentes, sem janelas novas, navegação de topo só na origem da instância). O sucesso navega
// para <base>/captcha/done#token=…&nonce=…, interceptado aqui (o fragmento não vai à rede).
import { useRouter } from 'expo-router'
import { useEffect, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { WebView, type WebViewNavigation } from 'react-native-webview'
import { CaptchaCancelled, captchaPageUrl, classifyCaptchaNavigation } from '@/account/captcha'
import { captchaBroker } from '@/account/native'
import { TextButton } from '@/ui/Button'
import { Banner, Spinner } from '@/ui/Card'
import { Screen, ScreenHeader } from '@/ui/Screen'
import { colors, spacing } from '@/ui/theme'

export default function Captcha() {
  const router = useRouter()
  const [req] = useState(() => captchaBroker.pending())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const settled = useRef(false)

  // fechar a tela sem concluir = cancelado
  useEffect(() => {
    return () => {
      if (!settled.current) req?.reject(new CaptchaCancelled())
    }
  }, [req])

  useEffect(() => {
    if (!req) router.back()
  }, [req, router])
  if (!req) return null

  const handle = (url: string, topFrame = true): boolean => {
    const r = classifyCaptchaNavigation(req.base, req.nonce, url, topFrame)
    if (r.kind === 'allow') return true
    if (r.kind === 'done' && !settled.current) {
      settled.current = true
      req.resolve(r.token)
      router.back()
    } else if (r.kind === 'error') setError(r.message)
    return false
  }

  return (
    <Screen
      scroll={false}
      testID="screen-captcha"
      header={
        <ScreenHeader
          title="Verificação"
          onBack={() => router.back()}
          backLabel="Cancelar verificação"
        />
      }
      contentStyle={styles.content}
    >
      <Banner tone="info">
        Confirme que você não é um robô para receber o código. A verificação roda na página do seu
        servidor.
      </Banner>
      {error ? (
        <Banner tone="danger" action={<TextButton title="Fechar" onPress={() => router.back()} />}>
          {error}
        </Banner>
      ) : null}
      <View style={styles.web}>
        <WebView
          source={{ uri: captchaPageUrl(req.base, req.nonce, req.action) }}
          originWhitelist={['http://*', 'https://*', 'about:*']}
          onShouldStartLoadWithRequest={(e): boolean => handle(e.url, e.isTopFrame !== false)}
          onNavigationStateChange={(e: WebViewNavigation): void => {
            handle(e.url)
          }}
          onLoadEnd={() => setLoading(false)}
          onError={() => setError('Não foi possível abrir a verificação. Confira a conexão.')}
          incognito
          setSupportMultipleWindows={false}
          javaScriptCanOpenWindowsAutomatically={false}
          allowFileAccess={false}
          allowsLinkPreview={false}
          mixedContentMode="never"
          style={styles.webview}
          containerStyle={styles.webview}
        />
        {loading ? (
          <View style={styles.loading}>
            <Spinner label="Carregando a verificação…" />
          </View>
        ) : null}
      </View>
    </Screen>
  )
}

const styles = StyleSheet.create({
  content: { paddingTop: spacing.md, gap: spacing.md },
  web: {
    flex: 1,
    minHeight: 420,
    borderRadius: 14,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface
  },
  webview: { flex: 1, backgroundColor: colors.surface },
  loading: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface
  }
})
