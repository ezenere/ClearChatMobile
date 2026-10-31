// Conta contra o servidor de sync REAL local (../ClearChatWebsite/backend via scripts/test-server.sh),
// com o AccountService de verdade (fetch e WebSocket reais; Keystore/SQLite trocados por memória):
// cadastro como o site → login por código (dispositivo mobile) → desbloqueio → refresh rotativo →
// revogação pelo "site" (4403) → recuperação → keys.reset → setup no app → sair → conta apagada.
import { afterAll, describe, expect, it } from 'vitest'
import { AccountService } from '../../src/account/service'
import { KV, MemoryKeyValueStore, MemorySecretStore } from '../../src/account/storage'
import type { Tokens } from '../../src/vendor/desktop/sync/http'
import {
  codeFor,
  devices,
  enabled,
  logMark,
  randomEmail,
  reauthCode,
  rest,
  RestError,
  setupKeysLikeSite,
  signupWeb,
  URL_,
  waitFor
} from './realServer'

const PASSWORD = 'senha de integração do celular'
const NEW_PASSWORD = 'outra senha de integração bem longa'
const services: AccountService[] = []

afterAll(() => {
  for (const s of services) s.setForeground(false)
})

function newApp(kv = new MemoryKeyValueStore(), secrets = new MemorySecretStore()) {
  const a = new AccountService({
    secrets,
    kv,
    device: { defaultName: 'Pixel de teste', platform: 'android', appVersion: '0.1.0' },
    envUrl: URL_,
    wsTiming: { backoffBaseMs: 100, backoffMaxMs: 1000 }
  })
  services.push(a)
  return { a, kv, secrets }
}

async function login(a: AccountService, email: string, name = 'Celular (integração)') {
  const n0 = logMark()
  await a.requestCode(email)
  await a.verifyCode(await codeFor(email, n0), name)
}

describe.skipIf(!enabled)('conta contra o servidor real', () => {
  it('fluxo completo da fase 1', async () => {
    const email = randomEmail('int')
    const web = await signupWeb(email)
    let recoveryKey = await setupKeysLikeSite(web, PASSWORD)

    // ---- login por código + registro do dispositivo ----
    const { a, kv, secrets } = newApp()
    await a.init()
    expect(a.getState().phase).toBe('signed-out')
    const info = await a.probeServer()
    expect(info.name).toBeTruthy()
    await login(a, email)
    expect(a.getState().phase).toBe('locked')
    const deviceId = a.getState().device!.id
    const dev = (await devices(web)).find((d) => d.id === deviceId)!
    expect(dev).toMatchObject({
      client: 'mobile',
      platform: 'android',
      can_host: true,
      app_version: '0.1.0',
      name: 'Celular (integração)'
    })

    // ---- WebSocket online mesmo bloqueado (eventos de sessão) ----
    await waitFor(() => a.getState().connection === 'online', 'ws online')

    // ---- desbloqueio ----
    await expect(a.unlock('senha errada de propósito', { remember: true })).rejects.toThrow()
    await a.unlock(PASSWORD, { remember: true })
    expect(a.getState().phase).toBe('unlocked')
    expect(secrets.dek).toBeTruthy()

    // ---- reabrir: tokens + DEK lembrada → direto ----
    const reopened = newApp(kv, secrets)
    await reopened.a.init()
    expect(reopened.a.getState().phase).toBe('unlocked')
    reopened.a.setForeground(false)

    // ---- refresh rotativo (no corpo) ----
    const t1 = JSON.parse(secrets.tokens!) as Tokens
    expect(await a.http.refresh()).toBe(true)
    const t2 = JSON.parse(secrets.tokens!) as Tokens
    expect(t2.refresh_token).not.toBe(t1.refresh_token)
    expect(t2.access_token).not.toBe(t1.access_token)
    // o access antigo continua até expirar? não importa; o novo funciona
    await a.renameDevice('Celular renomeado')
    expect((await devices(web)).find((d) => d.id === deviceId)?.name).toBe('Celular renomeado')

    // ---- revogação pelo "site" → 4403 → login com explicação ----
    await rest('DELETE', `/api/v1/devices/${deviceId}`, undefined, web.token)
    await waitFor(() => a.getState().phase === 'signed-out', 'revogação')
    expect(a.getState().notice?.title).toBe('Dispositivo desconectado')
    expect(secrets.tokens).toBeNull()
    expect(secrets.dek).toBeNull()
    expect(kv.get(KV.userId)).toBeNull()

    // ---- login de novo (dispositivo novo) + recuperação ----
    await login(a, email)
    expect(a.getState().device!.id).not.toBe(deviceId)
    await a.beginRecovery(recoveryKey.toLowerCase())
    await a.finishRecovery(NEW_PASSWORD, { remember: false })
    expect(a.getState().phase).toBe('unlocked')
    expect(a.getState().notice?.action).toBe('new-recovery-key')
    const nk = await a.newRecoveryKey()
    await nk.commit()
    recoveryKey = nk.recoveryKey
    await a.lock()
    await expect(a.unlock(PASSWORD, { remember: false })).rejects.toThrow()
    await a.unlock(NEW_PASSWORD, { remember: true })

    // ---- reuso de refresh antigo revoga (detecção de roubo, §5.4) ----
    const old = JSON.parse(secrets.tokens!) as Tokens
    expect(await a.http.refresh()).toBe(true)
    await expect(
      rest('POST', '/api/v1/auth/refresh', { refresh_token: old.refresh_token })
    ).rejects.toMatchObject({
      status: 401
    })
    await waitFor(() => a.getState().phase === 'signed-out', 'refresh reutilizado')

    // ---- keys.reset pelo "site" → definir senha no app ----
    await login(a, email)
    await a.unlock(NEW_PASSWORD, { remember: true })
    await waitFor(() => a.getState().connection === 'online', 'ws online (2)')
    const resetCode = await reauthCode(web, 'reset_keys')
    await rest('POST', '/api/v1/keys/reset', { code: resetCode }, web.token)
    await waitFor(() => a.getState().phase === 'needs-setup', 'keys.reset')
    expect(a.getState().notice?.title).toBe('Chaves redefinidas')
    expect(secrets.dek).toBeNull()
    expect(secrets.tokens).toBeTruthy()
    const pending = await a.setupKeys(PASSWORD)
    expect(pending.recoveryKey).toMatch(/^([0-9A-Z]{4}-){8}[0-9A-Z]{4}$/)
    await pending.commit({ remember: true })
    expect(a.getState().phase).toBe('unlocked')
    await waitFor(() => a.getState().connection === 'online', 'ws reconecta após o setup')
    const keys = await rest('GET', '/api/v1/keys', undefined, web.token)
    expect(keys.keys_rev).toBeGreaterThanOrEqual(1)

    // ---- sair: revoga o dispositivo no servidor ----
    const before = JSON.parse(secrets.tokens!) as Tokens
    await a.logout()
    expect(a.getState()).toMatchObject({ phase: 'signed-out', notice: null })
    expect(secrets.tokens).toBeNull()
    await expect(
      rest('GET', '/api/v1/keys', undefined, before.access_token)
    ).rejects.toBeInstanceOf(RestError)

    // ---- conta apagada pelo "site" → account.deleted ----
    await login(a, email)
    await waitFor(() => a.getState().connection === 'online', 'ws online (3)')
    const delCode = await reauthCode(web, 'delete_account')
    await rest('DELETE', '/api/v1/account', { code: delCode }, web.token)
    await waitFor(() => a.getState().phase === 'signed-out', 'account.deleted')
    expect(a.getState().notice?.title).toBe('Conta apagada')
  })
})
