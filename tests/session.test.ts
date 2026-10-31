// Máquina de estados pura da conta, captcha (§15), digitação da chave de recuperação e mensagens.
import { describe, expect, it } from 'vitest'
import {
  CaptchaBroker,
  CaptchaCancelled,
  captchaPageUrl,
  classifyCaptchaNavigation
} from '../src/account/captcha'
import { defaultDeviceName } from '../src/account/deviceName'
import { describeError, formatWait } from '../src/account/errors'
import { formatRecoveryTyping, recoveryInputComplete } from '../src/account/recoveryInput'
import {
  initialSession,
  reasonForCode,
  reduceSession,
  type SessionEvent,
  type SessionState
} from '../src/account/session'
import { SyncApiError, SyncNetworkError } from '../src/vendor/desktop/sync/http'
import { AuthError } from '../src/crypto'

const server = { kind: 'official' as const, url: 'https://clear.ezenere.com', name: null }
const account = { userId: 'u', email: 'a@b.c', name: 'A' }
const device = { id: 'd', name: 'Pixel' }

const run = (events: SessionEvent[], s: SessionState = initialSession(server)) =>
  events.reduce(reduceSession, s)

const restored = (o: Partial<Extract<SessionEvent, { type: 'restored' }>> = {}): SessionEvent => ({
  type: 'restored',
  server,
  account,
  device,
  hasKeys: true,
  unlocked: false,
  remember: true,
  biometric: false,
  ...o
})

describe('reduceSession', () => {
  it('restaura cada fase a partir do que está guardado', () => {
    expect(run([restored({ account: null, device: null })]).phase).toBe('signed-out')
    expect(run([restored({ hasKeys: false })]).phase).toBe('needs-setup')
    expect(run([restored()]).phase).toBe('locked')
    expect(run([restored({ unlocked: true })]).phase).toBe('unlocked')
  })

  it('login → (setup) → desbloqueio → bloqueio → saída', () => {
    let s = run([restored({ account: null, device: null })])
    s = reduceSession(s, { type: 'code-sent', email: 'a@b.c', at: 1 })
    expect(s.login).toEqual({ email: 'a@b.c', sentAt: 1 })
    s = reduceSession(s, { type: 'signed-in', account, device, hasKeys: false })
    expect(s.phase).toBe('needs-setup')
    expect(s.login).toBeNull()
    s = reduceSession(s, { type: 'keys-ready' })
    expect(s.phase).toBe('locked')
    s = reduceSession(s, { type: 'unlocked', remember: false, biometric: false })
    expect(s).toMatchObject({ phase: 'unlocked', remember: false })
    s = reduceSession(s, { type: 'locked' })
    expect(s.phase).toBe('locked')
    s = reduceSession(s, { type: 'signed-out', reason: 'logout' })
    expect(s).toMatchObject({ phase: 'signed-out', account: null, device: null, notice: null })
  })

  it('fim de sessão forçado traz explicação; troca de servidor só fora da conta', () => {
    const s = run([restored({ unlocked: true }), { type: 'signed-out', reason: 'revoked' }])
    expect(s.notice?.title).toBe('Dispositivo desconectado')
    const other = { kind: 'self' as const, url: 'http://10.0.2.2:8100', name: 'X' }
    expect(reduceSession(s, { type: 'server', server: other }).server).toEqual(other)
    const inside = run([restored({ unlocked: true })])
    expect(reduceSession(inside, { type: 'server', server: other }).server).toEqual(server)
  })

  it('keys.reset volta a definir senha; eventos fora de fase são ignorados', () => {
    const s = run([restored({ unlocked: true }), { type: 'keys-reset' }])
    expect(s.phase).toBe('needs-setup')
    expect(s.notice?.title).toBe('Chaves redefinidas')
    const out = run([restored({ account: null, device: null })])
    expect(reduceSession(out, { type: 'unlocked', remember: true, biometric: false })).toBe(out)
    expect(reduceSession(out, { type: 'keys-reset' })).toBe(out)
    expect(reduceSession(out, { type: 'locked' })).toBe(out)
  })

  it('motivos por código do servidor (§17.4, fechamento 4403)', () => {
    expect(reasonForCode('device_revoked')).toBe('revoked')
    expect(reasonForCode('refresh_reused')).toBe('revoked')
    expect(reasonForCode('account_disabled')).toBe('account-disabled')
    expect(reasonForCode('account_deleted')).toBe('account-deleted')
    expect(reasonForCode('unauthorized')).toBe('session-ended')
  })
})

describe('captcha (§15)', () => {
  const base = 'https://chat.exemplo.com/clearchat'
  it('monta a URL da página da instância', () => {
    expect(captchaPageUrl(base, 'abc_-1', 'login')).toBe(
      'https://chat.exemplo.com/clearchat/captcha?client=app&nonce=abc_-1&action=login'
    )
  })
  it('intercepta /captcha/done com o nonce certo e bloqueia o resto', () => {
    const done = `${base}/captcha/done#token=T0K&nonce=N1`
    expect(classifyCaptchaNavigation(base, 'N1', done)).toEqual({ kind: 'done', token: 'T0K' })
    expect(classifyCaptchaNavigation(base, 'N2', done).kind).toBe('error')
    expect(classifyCaptchaNavigation(base, 'N1', `${base}/captcha/done#nonce=N1`).kind).toBe(
      'error'
    )
    expect(classifyCaptchaNavigation(base, 'N1', `${base}/captcha?client=app`).kind).toBe('allow')
    expect(
      classifyCaptchaNavigation(base, 'N1', 'https://evil.test/captcha/done#token=x&nonce=N1').kind
    ).toBe('block')
    expect(
      classifyCaptchaNavigation(base, 'N1', 'https://challenges.cloudflare.com/x', false).kind
    ).toBe('allow')
    expect(
      classifyCaptchaNavigation(base, 'N1', 'https://challenges.cloudflare.com/x', true).kind
    ).toBe('block')
    // o mesmo caminho noutra origem não conta
    expect(
      classifyCaptchaNavigation(
        base,
        'N1',
        'http://chat.exemplo.com/clearchat/captcha/done#token=x&nonce=N1'
      ).kind
    ).toBe('block')
  })
  it('broker: um pedido por vez, cancelar rejeita', async () => {
    const b = new CaptchaBroker()
    await expect(b.request(base, 'login')).rejects.toThrow(/exige captcha/)
    let opened = 0
    b.setOpener(() => opened++)
    const p1 = b.request(base, 'login')
    const n1 = b.pending()!.nonce
    expect(n1.length).toBeGreaterThanOrEqual(16)
    const p2 = b.request(base, 'login')
    await expect(p1).rejects.toBeInstanceOf(CaptchaCancelled)
    expect(b.pending()!.nonce).not.toBe(n1)
    b.pending()!.resolve('tok')
    await expect(p2).resolves.toBe('tok')
    expect(b.pending()).toBeNull()
    expect(opened).toBe(2)
  })
})

describe('chave de recuperação (digitação)', () => {
  it('formata em grupos de 4 e tolera minúsculas, espaços, O/I/L', () => {
    expect(formatRecoveryTyping('008j 4ct4-ank7')).toBe('008J-4CT4-ANK7')
    expect(formatRecoveryTyping('oil')).toBe('011')
    const v = '008J-4CT4-ANK7-F24S-NAXW-SQFE-ZW0J-6HB7-5CDY'
    expect(formatRecoveryTyping(v.toLowerCase().replace(/-/g, '  '))).toBe(v)
    expect(formatRecoveryTyping(v + 'EXTRA')).toBe(v)
    expect(recoveryInputComplete(v)).toBe(true)
    expect(recoveryInputComplete(v.slice(0, -1))).toBe(false)
  })
})

describe('mensagens de erro', () => {
  it('rede, códigos da API e cripto em pt-BR', () => {
    expect(describeError(new SyncNetworkError('x'))).toMatch(/Sem conexão/)
    expect(describeError(new SyncApiError('x', 400, 'code_invalid'))).toMatch(/Código incorreto/)
    expect(describeError(new SyncApiError('x', 400, 'captcha_failed'))).toMatch(/anti-robô/)
    expect(
      describeError(new SyncApiError('x', 413, 'quota_exceeded', { kind: 'devices' }))
    ).toMatch(/limite de dispositivos/)
    expect(describeError(new SyncApiError('x', 429, 'rate_limited', { retry_after: 30 }))).toBe(
      'Muitas tentativas. Tente de novo em 30 s.'
    )
    expect(describeError(new SyncApiError('boom', 502, 'bad_gateway'))).toMatch(/Erro inesperado/)
    expect(describeError(new AuthError('x'))).toBe('Senha de criptografia incorreta.')
    expect(formatWait(3600)).toBe('1 h')
    expect(formatWait(5400)).toBe('1 h 30 min')
  })
})

describe('nome padrão do aparelho', () => {
  it('usa o nome/modelo e troca o do emulador por um legível', () => {
    expect(defaultDeviceName(null, 'Pixel 9 Pro', 'android')).toBe('Pixel 9 Pro')
    expect(defaultDeviceName('Celular da Ana', 'Pixel 9 Pro', 'android')).toBe('Celular da Ana')
    expect(defaultDeviceName(null, 'sdk_gphone64_x86_64', 'android')).toBe('Emulador Android')
    expect(defaultDeviceName('', null, 'android')).toBe('Celular Android')
    expect(defaultDeviceName('x'.repeat(80), null, 'ios')).toHaveLength(64)
  })
})
