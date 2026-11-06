// Rota de desenvolvimento dos chats só ao vivo (clearchat://dev/live, só __DEV__): liga um relé
// falso (./devRelay.ts) na frente do WebSocket da conta e um host falso (./devHost.ts) "PC de teste"
// com chats ao vivo — a seção "Ao vivo", o visualizador, os comandos, os anexos e as quedas do host
// aparecem no aparelho sem um desktop nem um servidor com 1.8.0. O resto (sync, push…) continua
// indo ao servidor de verdade. NUNCA em produção.
import { fromB64u, hex, sha256 } from '@/crypto'
import { account } from '@/account/native'
import { syncKeys } from '@/data/native'
import { remote, setDevWs } from '@/remote/native'
import type { DevLiveHost } from './devHost'
import { DevLiveRelay } from './devRelay'
import { live } from './native'
import { LIVE_CAP } from './types'

/** PNG 120×80 (xadrez) para a imagem do histórico (attach.get). */
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAHgAAABQCAIAAABd-SbeAAAAvUlEQVR42u3QQQkAIRRFUUtMAetMhwlgT3eGmByu7PAF-eCBt31cOKW9f3i1f-Hd1i2gQYMGDRo0aNCgQYMGDRo0aNCgQYMGDRo0aNCgQSeFhnWmCxo0aNCgQYMGDRo0aNCgQYMGDRo0aNCgQYMGDRp0Vuid8xxPeLd1QYMGDRo0aNCgQYMGDRo0aNCgQYMGDRo0aNCgQYPOCg3rTBc0aNCgQYMGDRo0aNCgQYMGDRo0aNCgQYMGDRo06KTdBQI_-ScPKYoIAAAAAElFTkSuQmCC'

export const DEV_HOST_ID = 'dev-live-host-0000-4000-8000-000000000001'

let relay: DevLiveRelay | null = null
let host: DevLiveHost | null = null

export function devLiveOn(): boolean {
  return !!relay
}

export async function installDevLive(): Promise<string> {
  if (!__DEV__) throw new Error('só em desenvolvimento')
  const keys = syncKeys()
  if (!keys) throw new Error('Entre numa conta (cofre aberto) primeiro.')
  if (relay && host) return `já ligado (${host.chats.size} chats)`
  const real = (t: string, f?: Record<string, unknown>, ms?: number) => account.wsRequest(t, f, ms)
  const r = new DevLiveRelay(keys.userId, real)
  const h = r.addHost(DEV_HOST_ID, 'PC de teste', keys.sk, { replyMs: 1500 })
  const viagem = h.createChat({
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
          '**Dia 2 — Belém**\n\n1. Mosteiro dos Jerónimos\n2. Torre de Belém\n3. Pastéis de Belém (a fila anda rápido)'
      }
    ]
  })
  // uma imagem no histórico (vem do host por attach.get, só para a memória)
  const png = fromB64u(PNG_B64)
  const file = `${hex(await sha256(png))}.png`
  h.addFile(viagem, file, png, 'image/png')
  const c = h.chats.get(viagem)!
  const id = `img-${file.slice(0, 8)}-0000-4000-8000-000000000000`
  c.items.set(`message\u0000${id}`, {
    type: 'message',
    id,
    data: {
      sv: 1,
      sessionId: `${viagem}-main`,
      seq: 50,
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'Este é o mapa que eu fiz:' },
          {
            type: 'image_url',
            image_url: { url: `clearchat-attachment://${file}` },
            _attachment: {
              name: 'mapa.png',
              mime: 'image/png',
              size: png.length,
              kind: 'image',
              file,
              sha256: file.slice(0, 64)
            }
          }
        ]
      },
      meta: {},
      createdAt: Date.now() - 60_000,
      parentId: null
    }
  })
  h.createChat({
    title: 'Refatorar o login',
    subagent: true,
    hostCwd: '/home/ana/projeto',
    messages: [
      { role: 'user', content: 'Revise o fluxo de login.' },
      { role: 'assistant', content: 'Delegando a análise a um subagente…' }
    ]
  })
  r.onViewer = (f) => {
    remote.onEvent(f)
    live.onEvent(f)
  }
  relay = r
  host = h
  setDevWs(r.request)
  live.devForceCaps = true
  await h.announce(true)
  live.onWelcome({ caps: [LIVE_CAP] })
  return `host falso ligado com ${h.chats.size} chats`
}

export type DevLiveAction = 'grace' | 'back' | 'drop' | 'quit' | 'announce' | 'saved' | 'off'

export function devLiveAction(a: DevLiveAction): void {
  if (!relay || !host) return
  if (a === 'grace') relay.hostGrace(DEV_HOST_ID)
  else if (a === 'back') relay.hostBack(DEV_HOST_ID)
  else if (a === 'drop') relay.hostDropped(DEV_HOST_ID)
  else if (a === 'quit') relay.hostQuit(DEV_HOST_ID)
  else if (a === 'announce') void host.announce(true)
  else if (a === 'saved') {
    const first = [...host.chats.keys()][0]
    if (first) relay.savedOnline(first)
  } else if (a === 'off') {
    relay.hostQuit(DEV_HOST_ID)
    setDevWs(null)
    live.devForceCaps = false
    relay = null
    host = null
  }
}
