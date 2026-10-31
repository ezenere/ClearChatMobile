// Ferramenta do E2E no emulador (não é teste): prepara/manipula a conta no servidor local.
//   E2E_TOOL=create E2E_STATE=/tmp/x.json npm run test:integration -- e2eTool   → conta com chaves
//   E2E_TOOL=revoke E2E_STATE=/tmp/x.json npm run test:integration -- e2eTool   → revoga os celulares
// O arquivo de estado guarda e-mail, senha, chave de recuperação e o token da sessão "site" — é dado
// de teste descartável do servidor local, fora do repositório.
import { readFileSync, writeFileSync } from 'node:fs'
import { expect, it } from 'vitest'
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
}

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
