// Token de push contra o servidor de sync REAL local (§22.2): o PushRegistrar do app com o
// AccountService de verdade — PUT depois do login, idempotente, token novo substitui, `push` em
// GET /devices (visto pelo "site"), desligar → DELETE, sair → o servidor apaga o token.
// Precisa da instância com push ligado (`features.push` ≠ null). Para não falar com o Google, o
// servidor de teste sobe com uma conta de serviço FALSA (chave RSA gerada na hora, `token_uri` e
// FCM_BASE_URL apontando para uma porta morta) — ver README § "Notificações push".
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AccountService } from '../../src/account/service'
import { MemoryKeyValueStore, MemorySecretStore } from '../../src/account/storage'
import { writePref } from '../../src/push/model'
import { PushRegistrar, pushFeatureOf } from '../../src/push/registration'
import {
  codeFor,
  enabled,
  logMark,
  randomEmail,
  rest,
  setupKeysLikeSite,
  signupWeb,
  URL_,
  type WebSession
} from './realServer'

let pushOn = false
const services: AccountService[] = []

beforeAll(async () => {
  if (!enabled) return
  pushOn = pushFeatureOf(await rest('GET', '/api/info'))
})
afterAll(() => {
  for (const s of services) s.setForeground(false)
})

describe.skipIf(!enabled)('token de push contra o servidor real', () => {
  it('registra, substitui, aparece em /devices, remove e some ao sair', async (t) => {
    if (!pushOn) {
      t.skip()
      return
    }
    const email = randomEmail('push')
    const web: WebSession = await signupWeb(email)
    await setupKeysLikeSite(web, 'senha de integração do push')
    const kv = new MemoryKeyValueStore()
    const a = new AccountService({
      secrets: new MemorySecretStore(),
      kv,
      device: { defaultName: 'Pixel (push)', platform: 'android', appVersion: '0.1.0' },
      envUrl: URL_
    })
    services.push(a)
    await a.init()
    const n0 = logMark()
    await a.requestCode(email)
    await a.verifyCode(await codeFor(email, n0), 'Celular (push)')
    let token = `fcm-teste-${Date.now()}`
    const reg = new PushRegistrar({
      http: a.http,
      kv,
      deviceId: () => a.getState().device?.id ?? null,
      serverSupportsPush: async () => pushFeatureOf(await rest('GET', '/api/info')),
      permission: async () => 'granted',
      token: async () => token
    })
    const phone = a.getState().device!.id
    const pushOf = async () =>
      (
        (await rest('GET', '/api/v1/devices', undefined, web.token)) as {
          id: string
          push?: boolean
        }[]
      ).find((d) => d.id === phone)?.push

    expect(await pushOf()).toBe(false)
    expect(await reg.sync('login')).toBe('registered')
    expect(await pushOf()).toBe(true)
    expect(await reg.sync('abertura')).toBe('registered')
    token = `${token}-2`
    expect(await reg.sync('token novo')).toBe('registered')
    expect(await pushOf()).toBe(true)
    // o próprio app vê o campo na lista dele
    expect((await a.devices()).find((d) => d.current)?.push).toBe(true)

    writePref(kv, 'enabled', false)
    expect(await reg.sync('desligou')).toBe('off')
    expect(await pushOf()).toBe(false)
    writePref(kv, 'enabled', true)
    expect(await reg.sync('ligou')).toBe('registered')
    expect(await pushOf()).toBe(true)

    await a.logout()
    reg.forget()
    const list = (await rest('GET', '/api/v1/devices', undefined, web.token)) as { id: string }[]
    expect(list.find((d) => d.id === phone)).toBeUndefined()
  })
})
