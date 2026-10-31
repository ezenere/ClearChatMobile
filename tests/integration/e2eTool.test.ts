// Ferramenta do E2E no emulador (não é teste): prepara/manipula a conta no servidor local.
//   E2E_TOOL=create E2E_STATE=/tmp/x.json npm run test:integration -- e2eTool   → conta com chaves
//   E2E_TOOL=revoke E2E_STATE=/tmp/x.json npm run test:integration -- e2eTool   → revoga os celulares
//   E2E_TOOL=seed   E2E_STATE=…  → conta com chaves + "desktop" + conversas realistas (fase 2)
//   E2E_TOOL=rename E2E_STATE=… E2E_CHAT=<id> E2E_TITLE=<título>   → o desktop renomeia (ao vivo)
//   E2E_TOOL=delete E2E_STATE=… E2E_CHAT=<id>                       → o desktop apaga (ao vivo)
// O arquivo de estado guarda e-mail, senha, chave de recuperação e o token da sessão "site" — é dado
// de teste descartável do servidor local, fora do repositório.
import { readFileSync, writeFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { fromHex, hex } from '../../src/crypto'
import {
  deleteRecord,
  loginDesktop,
  renameChat,
  seedAccount,
  setupKeysWithDek,
  type Desktop
} from './seed'
import {
  devices,
  enabled,
  randomEmail,
  rest,
  setupKeysLikeSite,
  signupWeb,
  type WebSession
} from './realServer'

const action = process.env.E2E_TOOL ?? ''
const state = process.env.E2E_STATE ?? ''

interface E2EState {
  web: WebSession
  password: string
  recoveryKey: string
  /** Fase 2: DEK (hex) e sessão do "desktop" — dados de teste descartáveis do servidor local. */
  dek?: string
  desktop?: { token: string; deviceId: string }
  mains?: Record<string, string>
}

async function desktopOf(s: E2EState): Promise<Desktop> {
  const { deriveSubkeys } = await import('../../src/crypto')
  return { ...s.desktop!, userId: s.web.userId, sk: await deriveSubkeys(fromHex(s.dek!)) }
}

it.runIf(enabled && action === 'seed' && !!state)(
  'e2e: conta com conversas realistas',
  async () => {
    const web = await signupWeb(randomEmail('e2e2'))
    const password = 'senha do teste no emulador'
    const { dek, recoveryKey } = await setupKeysWithDek(web, password)
    const d = await loginDesktop(web.email, web.userId, dek)
    const seeded = await seedAccount(d)
    const mains = Object.fromEntries(
      Object.values(seeded.chats).map((c) => [c.id, c.mainSessionId])
    )
    const s: E2EState = {
      web,
      password,
      recoveryKey,
      dek: hex(dek),
      desktop: { token: d.token, deviceId: d.deviceId },
      mains
    }
    writeFileSync(state, JSON.stringify(s, null, 2), { mode: 0o600 })
    expect(Object.keys(mains)).toHaveLength(5)
  }
)

it.runIf(enabled && action === 'rename' && !!state)('e2e: desktop renomeia um chat', async () => {
  const s = JSON.parse(readFileSync(state, 'utf8')) as E2EState
  const chat = process.env.E2E_CHAT ?? ''
  await renameChat(
    await desktopOf(s),
    chat,
    s.mains![chat],
    process.env.E2E_TITLE ?? 'Renomeado',
    Date.now()
  )
})

it.runIf(enabled && action === 'delete' && !!state)('e2e: desktop apaga um chat', async () => {
  const s = JSON.parse(readFileSync(state, 'utf8')) as E2EState
  const chat = process.env.E2E_CHAT ?? ''
  await deleteRecord(await desktopOf(s), 'chat', chat, chat)
})

it.runIf(enabled && action === 'create' && !!state)('e2e: cria conta com chaves', async () => {
  const web = await signupWeb(randomEmail('e2e'))
  const password = 'senha do teste no emulador'
  const recoveryKey = await setupKeysLikeSite(web, password)
  const s: E2EState = { web, password, recoveryKey }
  writeFileSync(state, JSON.stringify(s, null, 2), { mode: 0o600 })
  expect(recoveryKey).toBeTruthy()
})

it.runIf(enabled && action === 'revoke' && !!state)(
  'e2e: revoga os celulares da conta',
  async () => {
    const s = JSON.parse(readFileSync(state, 'utf8')) as E2EState
    const list = (await devices(s.web)).filter((d) => d.client === 'mobile')
    for (const d of list) await rest('DELETE', `/api/v1/devices/${d.id}`, undefined, s.web.token)
    expect(list.length).toBeGreaterThan(0)
  }
)
