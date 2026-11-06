// Ferramenta do E2E no emulador (não é teste): prepara/manipula a conta no servidor local.
//   E2E_TOOL=create E2E_STATE=/tmp/x.json npm run test:integration -- e2eTool   → conta com chaves
//   E2E_TOOL=revoke E2E_STATE=/tmp/x.json npm run test:integration -- e2eTool   → revoga os celulares
//   E2E_TOOL=seed   E2E_STATE=…  → conta com chaves + "desktop" + conversas realistas (fase 2)
//   E2E_TOOL=rename E2E_STATE=… E2E_CHAT=<id> E2E_TITLE=<título>   → o desktop renomeia (ao vivo)
//   E2E_TOOL=delete E2E_STATE=… E2E_CHAT=<id>                       → o desktop apaga (ao vivo)
//   E2E_TOOL=livehost E2E_STATE=… [E2E_CTL=<arquivo>] [E2E_HOLD_S=900]
//       → 1.8.0: o "desktop" vira um host de chats SÓ AO VIVO (DevLiveHost no WebSocket real, com
//         caps live_chats) e fica rodando; escrever no arquivo de controle uma linha `grace`
//         (derruba o socket), `back` (reconecta), `quit` (live.withdraw quit), `announce`, `stop`
// O arquivo de estado guarda e-mail, senha, chave de recuperação e o token da sessão "site" — é dado
// de teste descartável do servidor local, fora do repositório.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
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

// "Usar sem conta" (E2E): o que o "desktop" (segundo cliente, com a DEK) vê na conta depois do merge
// do celular — títulos dos chats, provedores e personas (nunca as chaves).
it.runIf(enabled && action === 'list' && !!state)('e2e: o desktop lista a conta', async () => {
  const s = JSON.parse(readFileSync(state, 'utf8')) as E2EState
  const d = await desktopOf(s)
  const { openRecord } = await import('../../src/crypto')
  const out: Record<string, string[]> = {}
  let after = 0
  for (;;) {
    const r = await rest(
      'GET',
      `/api/v1/records?after=${after}&limit=500&payload=1`,
      undefined,
      d.token
    )
    for (const c of r.records ?? []) {
      if (c.deleted || !c.env || !['chat', 'provider', 'preset', 'message'].includes(c.type))
        continue
      const p = await openRecord(d.sk.record, d.userId, c, c.env)
      if (c.type === 'message') {
        // por chat: só a contagem e o texto das mensagens de texto curtas
        const t = (p.message as { content?: unknown })?.content
        ;(out[`messages:${c.scope?.slice(0, 8)}`] ??= []).push(
          typeof t === 'string' ? t.slice(0, 40) : '[partes]'
        )
        continue
      }
      const label = String(p.title ?? p.name ?? '')
      ;(out[c.type] ??= []).push(`${c.id.slice(0, 8)} ${label}`)
    }
    if (!r.has_more || !r.records?.length) break
    after = r.next ?? r.records[r.records.length - 1].seq
  }
  console.log(`E2E_LIST ${JSON.stringify(out)}`)
  expect(out.chat?.length ?? 0).toBeGreaterThan(0)
})

// 1.8.0 (§23): host de chats só ao vivo para o E2E no emulador (o celular de verdade vê a seção
// "Ao vivo em PC de casa", abre o chat, manda mensagens/anexos, aprova…). Controlado por arquivo.
it.runIf(enabled && action === 'livehost' && !!state)(
  'e2e: host de chats só ao vivo',
  async () => {
    const { RealtimeClient } = await import('../../src/vendor/desktop/sync/ws')
    const { DevLiveHost } = await import('../../src/live/devHost')
    const { URL_ } = await import('./realServer')
    const s = JSON.parse(readFileSync(state, 'utf8')) as E2EState
    const d = await desktopOf(s)
    const ctl = process.env.E2E_CTL ?? `${state}.ctl`
    const hold = Number(process.env.E2E_HOLD_S ?? 900) * 1000
    let ws!: InstanceType<typeof RealtimeClient>
    const dev = new DevLiveHost({
      userId: d.userId,
      deviceId: d.deviceId,
      sk: d.sk,
      replyMs: 2500,
      emit: (f) => {
        const { t, ...fields } = f as { t: string } & Record<string, unknown>
        if (t === 'stream.event') ws.send(t, fields)
        else void ws.request(t, fields).catch(() => undefined)
      }
    })
    dev.createChat({
      title: 'Plano da viagem a Lisboa',
      hostCwd: '/home/ana/viagem',
      messages: [
        { role: 'user', content: 'Monte um roteiro de 3 dias em Lisboa.' },
        {
          role: 'assistant',
          content:
            '**Dia 1 — Alfama e Castelo**\n\n- Castelo de São Jorge de manhã\n- Almoço em Alfama\n- Miradouro da Senhora do Monte no fim da tarde'
        },
        { role: 'user', content: 'E o dia 2?' },
        {
          role: 'assistant',
          content:
            '**Dia 2 — Belém**\n\n1. Mosteiro dos Jerónimos\n2. Torre de Belém\n3. Pastéis de Belém'
        }
      ]
    })
    dev.createChat({
      title: 'Refatorar o login',
      subagent: true,
      hostCwd: '/home/ana/projeto',
      messages: [
        { role: 'user', content: 'Revise o fluxo de login.' },
        { role: 'assistant', content: 'Delegando a análise a um subagente…' }
      ]
    })
    ws = new RealtimeClient({
      url: () => URL_.replace(/^http/, 'ws') + '/ws',
      hello: async () => ({
        access_token: d.token,
        cursor: 0,
        state_cursor: 0,
        active_windows: [],
        subscriptions: [],
        caps: ['live_chats']
      }),
      onWelcome: () => void dev.announce(true),
      onEvent: (f) => {
        if (f.t === 'remote.command') {
          console.log(`E2E_LIVE comando ${String(f.kind)}`)
          void dev.onCommand(f)
        } else if (f.t === 'stream.resync_request') void dev.snapshot(String(f.chat_id))
        else if (f.t === 'live.refresh_request') void dev.announce(true)
      },
      onState: (st) => console.log(`E2E_LIVE ws ${st}`),
      onUnauthorized: async () => false,
      onFatal: (c) => console.log(`E2E_LIVE fatal ${c}`),
      timing: { backoffBaseMs: 200, backoffMaxMs: 1000 }
    })
    ws.start()
    writeFileSync(ctl, '')
    const t0 = Date.now()
    while (Date.now() - t0 < hold) {
      await new Promise((r) => setTimeout(r, 500))
      const cmd = existsSync(ctl) ? readFileSync(ctl, 'utf8').trim() : ''
      if (!cmd) continue
      writeFileSync(ctl, '')
      console.log(`E2E_LIVE ctl ${cmd}`)
      if (cmd === 'stop') break
      if (cmd === 'grace') ws.stop()
      else if (cmd === 'back') ws.start()
      else if (cmd === 'quit') await ws.request('live.withdraw', { chat_ids: null, reason: 'quit' })
      else if (cmd === 'announce') await dev.announce(true)
    }
    ws.stop()
  },
  3_600_000
)
