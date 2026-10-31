// Utilitários para falar com o servidor de sync REAL local (scripts/test-server.sh): REST cru, código
// lido do log da API (MAIL_BACKEND=console) e cadastro "como o site faz" (chaves geradas no cliente).
import { readFileSync } from 'node:fs'
import { createKeyMaterial } from '../../src/crypto'

export const URL_ = process.env.CLEARCHAT_SYNC_TEST_URL ?? ''
export const MAIL_LOG = process.env.CLEARCHAT_SYNC_TEST_MAIL_LOG ?? ''
export const enabled = !!URL_ && !!MAIL_LOG

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export async function waitFor<T>(fn: () => T | Promise<T>, what: string, ms = 15_000): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`)
    await sleep(100)
  }
}

export const randomEmail = (tag: string): string =>
  `mobile-${tag}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}@example.test`

const logLines = (): string[] => readFileSync(MAIL_LOG, 'utf8').split('\n')
export const logMark = (): number => logLines().length

/** Último código enviado ao e-mail depois da linha `after` do log. */
export function codeFor(email: string, after = 0): Promise<string> {
  const re = new RegExp(`para ${email.replace(/[.+]/g, '\\$&')} — Seu código [^:\\n]*: (\\d{6})`)
  return waitFor(() => {
    let code = ''
    for (const raw of logLines().slice(Math.max(0, after - 1))) {
      let line = raw
      try {
        line = String((JSON.parse(raw) as { msg?: unknown }).msg ?? raw)
      } catch {
        /* linha não JSON */
      }
      const m = re.exec(line)
      if (m) code = m[1]
    }
    return code
  }, `código para ${email}`)
}

export class RestError extends Error {
  constructor(
    readonly status: number,
    readonly body: string
  ) {
    super(`HTTP ${status} ${body}`)
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function rest(
  method: string,
  path: string,
  body?: unknown,
  token?: string
): Promise<any> {
  const r = await fetch(URL_ + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  })
  const text = await r.text()
  if (!r.ok) throw new RestError(r.status, text)
  return text ? JSON.parse(text) : null
}

export interface WebSession {
  email: string
  userId: string
  token: string
  deviceId: string
}

/** Cadastro pelo "site": código por e-mail → sessão web (sem chaves ainda). */
export async function signupWeb(email: string): Promise<WebSession> {
  const n0 = logMark()
  await rest('POST', '/api/v1/auth/signup/start', { email, name: 'Teste Mobile' })
  const code = await codeFor(email, n0)
  const auth = await rest('POST', '/api/v1/auth/signup/verify', {
    email,
    code,
    device: {
      name: 'Site (teste)',
      platform: 'web',
      client: 'web',
      app_version: 'teste',
      can_host: false
    }
  })
  return { email, userId: auth.user.id, token: auth.access_token, deviceId: auth.device_id }
}

/** Setup das chaves como o site faz (DEK, wraps e verifier no cliente). Devolve a chave de recuperação. */
export async function setupKeysLikeSite(web: WebSession, password: string): Promise<string> {
  const m = await createKeyMaterial(web.userId, password)
  await rest('POST', '/api/v1/keys/setup', m.body, web.token)
  return m.recoveryKey
}

/** Código de reautenticação (reset_keys / delete_account) pedido pela sessão web. */
export async function reauthCode(
  web: WebSession,
  purpose: 'reset_keys' | 'delete_account'
): Promise<string> {
  const n0 = logMark()
  await rest('POST', '/api/v1/auth/reauth/request', { purpose }, web.token)
  return codeFor(web.email, n0)
}

export async function devices(web: WebSession): Promise<
  {
    id: string
    client: string
    name: string
    platform: string
    app_version: string
    can_host: boolean
  }[]
> {
  return rest('GET', '/api/v1/devices', undefined, web.token)
}
