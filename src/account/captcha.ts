// Captcha no app (SYNC_PROTOCOL.md §15): página da PRÓPRIA instância numa WebView; o sucesso navega
// para `<base>/captcha/done#token=…&nonce=…`, que o app intercepta (o fragmento nunca vai à rede).
// Funções puras — a tela (src/app/(auth)/captcha.tsx) só liga isto à WebView.
import { b64u, randomBytes } from '@/crypto'

export type CaptchaAction = 'login' | 'signup'

/** 18 bytes aleatórios em base64url (24 caracteres; o contrato pede ≥ 16). */
export const newCaptchaNonce = (): string => b64u(randomBytes(18))

export const captchaPageUrl = (base: string, nonce: string, action: CaptchaAction): string =>
  `${base}/captcha?client=app&nonce=${encodeURIComponent(nonce)}&action=${action}`

export type CaptchaNavigation =
  /** Navegação permitida (a própria página da instância, o iframe do Turnstile). */
  | { kind: 'allow' }
  /** Fora da origem da instância no nível de cima: bloquear. */
  | { kind: 'block' }
  /** Chegou ao `/captcha/done`: token conferido (ou erro de nonce/token ausente). */
  | { kind: 'done'; token: string }
  | { kind: 'error'; message: string }

function parse(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

/**
 * Decide o que fazer com uma navegação da WebView. `topFrame` = navegação da página (não de um
 * iframe); no Android a WebView só consulta o app para o nível de cima.
 */
export function classifyCaptchaNavigation(
  base: string,
  nonce: string,
  url: string,
  topFrame = true
): CaptchaNavigation {
  if (url === 'about:blank' || url.startsWith('about:srcdoc')) return { kind: 'allow' }
  const u = parse(url)
  const b = parse(base)
  if (!u || !b) return { kind: 'block' }
  const donePath = `${b.pathname.replace(/\/+$/, '')}/captcha/done`
  if (u.origin === b.origin && u.pathname === donePath) {
    const params = new URLSearchParams(u.hash.replace(/^#/, ''))
    if (params.get('nonce') !== nonce)
      return { kind: 'error', message: 'Verificação inválida (nonce não confere). Tente de novo.' }
    const token = params.get('token')
    if (!token) return { kind: 'error', message: 'A verificação não devolveu um token.' }
    return { kind: 'done', token }
  }
  if (!topFrame) return { kind: 'allow' }
  return u.origin === b.origin ? { kind: 'allow' } : { kind: 'block' }
}

/**
 * Ponte entre quem precisa do token (AccountService.requestCode) e a tela da WebView: o serviço pede,
 * a UI abre a tela, a tela resolve. Um pedido por vez (o anterior é cancelado).
 */
export interface CaptchaRequest {
  base: string
  action: CaptchaAction
  nonce: string
  resolve: (token: string) => void
  reject: (e: Error) => void
}

export class CaptchaCancelled extends Error {
  constructor() {
    super('Verificação cancelada.')
  }
}

export class CaptchaBroker {
  private current: CaptchaRequest | null = null
  private opener: (() => void) | null = null

  /** A UI registra como abrir a tela do captcha (ex.: router.push('/captcha')). */
  setOpener(open: (() => void) | null): void {
    this.opener = open
  }

  pending(): CaptchaRequest | null {
    return this.current
  }

  request(base: string, action: CaptchaAction): Promise<string> {
    if (!this.opener) return Promise.reject(new Error('Este servidor exige captcha.'))
    this.current?.reject(new CaptchaCancelled())
    return new Promise<string>((resolve, reject) => {
      const req: CaptchaRequest = {
        base,
        action,
        nonce: newCaptchaNonce(),
        resolve: (t) => {
          if (this.current === req) this.current = null
          resolve(t)
        },
        reject: (e) => {
          if (this.current === req) this.current = null
          reject(e)
        }
      }
      this.current = req
      this.opener!()
    })
  }
}
