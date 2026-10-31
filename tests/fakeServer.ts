// Servidor de sync de mentira (fetch falso) para os testes da conta: só o que a fase 1 usa —
// /api/info, código por e-mail, refresh rotativo (reuso revoga), logout, chaves, dispositivos.
import type { KeysResponse } from '../src/crypto'
import { bytesEqual, fromB64u, sha256 } from '../src/crypto'

interface Device {
  id: string
  name: string
  client: string
  platform: string
  revoked: boolean
}

export interface Call {
  method: string
  path: string
  body: Record<string, unknown> | null
  headers: Record<string, string>
}

type Reply = { status: number; json?: unknown; headers?: Record<string, string> }

const err = (status: number, code: string, details: Record<string, unknown> = {}): Reply => ({
  status,
  json: { error: { code, message: `erro ${code}`, details } }
})

export class FakeServer {
  base = 'https://sync.fake.test'
  name = 'Instância de Teste'
  captcha = false
  protocol = { min: 1, max: 1, version: '1.5.0' }
  email = 'ana@example.test'
  userId = 'user-1'
  code = '123456'
  keys: KeysResponse | null = null
  verifier: string | null = null
  devices = new Map<string, Device>()
  access = new Map<string, string>()
  refresh = new Map<string, { device: string; used: boolean }>()
  calls: Call[] = []
  /** Próxima resposta forçada para um caminho (ex.: 429). */
  override = new Map<string, Reply>()
  private seq = 0

  private tok(prefix: string): string {
    return `${prefix}${++this.seq}_${Math.random().toString(36).slice(2)}`
  }

  private issue(device: string): Record<string, unknown> {
    const access_token = this.tok('cca_')
    const refresh_token = this.tok('ccr_')
    this.access.set(access_token, device)
    this.refresh.set(refresh_token, { device, used: false })
    return { access_token, access_expires_in: 3600, refresh_token, refresh_expires_in: 5184000 }
  }

  revoke(deviceId: string): void {
    const d = this.devices.get(deviceId)
    if (d) d.revoked = true
    for (const [t, dev] of this.access) if (dev === deviceId) this.access.delete(t)
    for (const [t, r] of this.refresh) if (r.device === deviceId) this.refresh.delete(t)
  }

  /** Deixa todos os access tokens inválidos (simula expiração). */
  expireAccess(): void {
    this.access.clear()
  }

  private authed(h: Record<string, string>): Device | null {
    const m = /^Bearer (.+)$/.exec(h.authorization ?? '')
    const dev = m ? this.access.get(m[1]) : undefined
    return dev ? (this.devices.get(dev) ?? null) : null
  }

  private async handle(c: Call): Promise<Reply> {
    const forced = this.override.get(`${c.method} ${c.path}`)
    if (forced) {
      this.override.delete(`${c.method} ${c.path}`)
      return forced
    }
    const b = c.body ?? {}
    if (c.method === 'GET' && c.path === '/api/info')
      return {
        status: 200,
        json: {
          name: this.name,
          server_version: '0.1.0',
          protocol: this.protocol,
          features: {
            signupOpen: true,
            captcha: this.captcha ? { provider: 'turnstile', siteKey: 'x' } : null
          },
          links: { signup: `${this.base}/signup` }
        }
      }
    if (c.method === 'POST' && c.path === '/api/v1/auth/code/request') {
      if (this.captcha && !b.turnstile_token) return err(400, 'captcha_failed')
      return { status: 202, json: { ok: true } }
    }
    if (c.method === 'POST' && c.path === '/api/v1/auth/code/verify') {
      if (b.email !== this.email || b.code !== this.code) return err(400, 'code_invalid')
      const d = b.device as Record<string, unknown>
      const id = `dev-${this.devices.size + 1}`
      this.devices.set(id, {
        id,
        name: String(d.name),
        client: String(d.client),
        platform: String(d.platform),
        revoked: false
      })
      return {
        status: 200,
        json: {
          ...this.issue(id),
          user: { id: this.userId, email: this.email, name: 'Ana' },
          device_id: id,
          keys_ready: !!this.keys,
          keys: this.keys
        }
      }
    }
    if (c.method === 'POST' && c.path === '/api/v1/auth/refresh') {
      const r = this.refresh.get(String(b.refresh_token))
      if (!r) return err(401, 'unauthorized')
      if (r.used) {
        this.revoke(r.device)
        return err(401, 'refresh_reused')
      }
      r.used = true
      return { status: 200, json: this.issue(r.device) }
    }
    const dev = this.authed(c.headers)
    if (!dev) return err(401, 'unauthorized', { reason: 'expired' })
    if (c.method === 'POST' && c.path === '/api/v1/auth/logout') {
      this.revoke(dev.id)
      return { status: 204 }
    }
    if (c.method === 'GET' && c.path === '/api/v1/keys')
      return this.keys ? { status: 200, json: this.keys } : err(409, 'keys_not_ready')
    if (c.method === 'POST' && c.path === '/api/v1/keys/setup') {
      if (this.keys) return err(409, 'keys_already_set')
      this.keys = {
        key_version: 1,
        keys_rev: 1,
        password: b.password as KeysResponse['password'],
        recovery: b.recovery as KeysResponse['recovery']
      }
      this.verifier = String(b.verifier)
      return { status: 200, json: this.keys }
    }
    if (
      c.method === 'PUT' &&
      (c.path === '/api/v1/keys/password' || c.path === '/api/v1/keys/recovery')
    ) {
      if (!this.keys || !this.verifier) return err(409, 'keys_not_ready')
      const proof = await sha256(fromB64u(String(b.key_proof)))
      if (!bytesEqual(proof, fromB64u(this.verifier))) return err(403, 'key_proof_invalid')
      if (b.password) this.keys = { ...this.keys, password: b.password as KeysResponse['password'] }
      if (b.recovery) this.keys = { ...this.keys, recovery: b.recovery as KeysResponse['recovery'] }
      this.keys = { ...this.keys, keys_rev: this.keys.keys_rev + 1 }
      return { status: 200, json: this.keys }
    }
    const m = /^\/api\/v1\/devices\/([^/]+)$/.exec(c.path)
    if (m && c.method === 'PATCH') {
      const d = this.devices.get(decodeURIComponent(m[1]))
      if (!d) return err(404, 'not_found')
      d.name = String(b.name)
      return { status: 200, json: { id: d.id, name: d.name } }
    }
    return err(404, 'not_found')
  }

  /** fetch falso: só responde para `base`. */
  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    )
    if (url.origin !== new URL(this.base).origin) throw new TypeError('fetch failed')
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>))
      headers[k.toLowerCase()] = v
    const body =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null
    const call: Call = { method: init?.method ?? 'GET', path: url.pathname, body, headers }
    this.calls.push(call)
    const r = await this.handle(call)
    if (r.status === 204) return new Response(null, { status: 204 })
    return new Response(JSON.stringify(r.json ?? null), {
      status: r.status,
      headers: { 'Content-Type': 'application/json', ...(r.headers ?? {}) }
    })
  }

  callsTo(path: string): Call[] {
    return this.calls.filter((c) => c.path === path)
  }
}
