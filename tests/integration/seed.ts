// Dados realistas para o servidor de sync LOCAL, gravados "como o app desktop": um dispositivo
// desktop (can_host) faz login por código, cifra os registros com a DEK da conta e envia — provedores,
// persona, chats com sessões e mensagens (versões/ramos, raciocínio, tool calls com aprovação e
// negação, subagente, questionário, compactação, erro, mensagem entre chats, chamada de voz) e um
// anexo de imagem (blob CCB1) + um PDF. Ideias do mock do site (ClearChatWebsite/frontend/src/mock/seed.ts).
import { deflateSync } from 'node:zlib'
import {
  blobIdFromSha256,
  createKeyMaterial,
  deriveSubkeys,
  encryptBlob,
  hex,
  randomBytes,
  sealRecord,
  sha256,
  type Bytes,
  type Subkeys
} from '../../src/crypto'
import type { PushItem } from '../../src/data/types'
import { interChatHeader, interChatText } from '../../src/vendor/shared/interChat'
import { codeFor, logMark, rest, type WebSession } from './realServer'

export interface Desktop {
  token: string
  deviceId: string
  userId: string
  sk: Subkeys
}

/** Cadastro como o site + chaves geradas no cliente; devolve a DEK (para agir como desktop). */
export async function setupKeysWithDek(
  web: WebSession,
  password: string
): Promise<{ dek: Bytes; recoveryKey: string }> {
  const m = await createKeyMaterial(web.userId, password)
  await rest('POST', '/api/v1/keys/setup', m.body, web.token)
  return { dek: m.dek, recoveryKey: m.recoveryKey }
}

/** Login de um dispositivo desktop (can_host) pelo código do e-mail. */
export async function loginDesktop(email: string, userId: string, dek: Bytes): Promise<Desktop> {
  const n0 = logMark()
  await rest('POST', '/api/v1/auth/code/request', { email })
  const code = await codeFor(email, n0)
  const r = await rest('POST', '/api/v1/auth/code/verify', {
    email,
    code,
    device: {
      name: 'PC de casa',
      platform: 'linux',
      client: 'desktop',
      app_version: '0.10.3',
      can_host: true
    }
  })
  return { token: r.access_token, deviceId: r.device_id, userId, sk: await deriveSubkeys(dek) }
}

const revs = new Map<string, number>()

export async function item(
  d: Desktop,
  type: string,
  id: string,
  scope: string | null,
  plain: Record<string, unknown>,
  blobs: string[] = []
): Promise<PushItem> {
  const k = `${type}|${id}`
  const base = revs.get(k) ?? 0
  const env = await sealRecord(d.sk.record, d.userId, { type, id, scope, rev: base + 1 }, plain)
  revs.set(k, base + 1)
  return { type, id, scope, base_rev: base, rev: base + 1, deleted: false, env, blobs }
}

export async function push(
  d: Desktop,
  items: PushItem[],
  chatBases?: Record<string, number>
): Promise<{ head: number }> {
  return rest(
    'POST',
    '/api/v1/sync/push',
    { push_id: crypto.randomUUID(), items, ...(chatBases ? { chat_bases: chatBases } : {}) },
    d.token
  )
}

/** Revisão atual no servidor (outro processo pode ter gravado: E2E). */
async function syncRev(d: Desktop, type: string, id: string): Promise<void> {
  const r = await rest('POST', '/api/v1/records/fetch', { items: [{ type, id }] }, d.token)
  const rec = r.records?.[0]
  if (rec) revs.set(`${type}|${id}`, rec.rev)
}

export async function deleteRecord(
  d: Desktop,
  type: string,
  id: string,
  scope: string | null
): Promise<void> {
  await syncRev(d, type, id)
  const k = `${type}|${id}`
  const base = revs.get(k) ?? 0
  await push(d, [{ type, id, scope, base_rev: base, rev: base + 1, deleted: true, blobs: [] }])
  revs.set(k, base + 1)
}

/** Sobe um blob (CCB1) e devolve o nome no store (`<sha>.<ext>`) e o blob_id. */
export async function uploadBlob(
  d: Desktop,
  data: Uint8Array,
  ext: string
): Promise<{ file: string; sha: string; blobId: string }> {
  const digest = await sha256(data)
  const sha = hex(digest)
  const blobId = await blobIdFromSha256(d.sk, digest)
  const ct = await encryptBlob(d.sk, d.userId, blobId, data, randomBytes(16))
  const res = await fetch(`${process.env.CLEARCHAT_SYNC_TEST_URL}/api/v1/blobs/${blobId}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${d.token}`,
      'Content-Type': 'application/octet-stream',
      'X-Content-SHA256': hex(await sha256(ct))
    },
    body: ct
  })
  if (!res.ok) throw new Error(`PUT blob ${res.status} ${await res.text()}`)
  return { file: `${sha}.${ext}`, sha, blobId }
}

// ---------------- PNG mínimo (sem dependências) ----------------

const CRC = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(b: Uint8Array): number {
  let c = 0xffffffff
  for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(data)])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

/** PNG RGB com um "quadro branco": gradiente + faixas + grade (dá para ver o zoom). */
export function whiteboardPng(w = 720, h = 480): Uint8Array {
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3
      const grid = x % 48 === 0 || y % 48 === 0
      const band = y > 140 && y < 180 && x > 80 && x < w - 80
      const box = x > 120 && x < 330 && y > 230 && y < 400
      const r = grid ? 180 : band ? 139 : box ? 74 : 236 - Math.round((y / h) * 30)
      const g = grid ? 180 : band ? 92 : box ? 222 : 236 - Math.round((x / w) * 20)
      const b = grid ? 190 : band ? 246 : box ? 128 : 244
      raw[o] = r
      raw[o + 1] = g
      raw[o + 2] = b
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array())
  ])
}

/** PDF de uma página (válido o bastante para visualizadores). */
export function tinyPdf(text = 'ClearChat - teste'): Uint8Array {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]
  const stream = `BT /F1 18 Tf 24 70 Td (${text}) Tj ET`
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  let out = '%PDF-1.4\n'
  const offs: number[] = []
  objs.forEach((o, i) => {
    offs.push(out.length)
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  for (const o of offs) out += `${String(o).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(out)
}

// ---------------- conversas ----------------

const MIN = 60_000
const H = 60 * MIN

interface Msg {
  key?: string
  /** Rótulo da mãe; `null` = raiz; ausente = a anterior. */
  parent?: string | null
  role: 'user' | 'assistant' | 'tool'
  content: unknown
  reasoning?: string
  tool_calls?: { id: string; name: string; args: Record<string, unknown> }[]
  tool_call_id?: string
  meta?: Record<string, unknown>
  /** Minutos depois da mensagem anterior (padrão 1). */
  gap?: number
}

interface ChatSpec {
  id: string
  title: string
  at: number
  presetId?: string
  messages: Msg[]
  branchSel?: Record<string, string | null>
  subs?: { id: string; title: string; task: string; parentToolCallId: string; messages: Msg[] }[]
  blobs?: string[]
}

export interface SeededChat {
  id: string
  title: string
  mainSessionId: string
  /** id da mensagem por rótulo. */
  ids: Record<string, string>
}

async function chatItems(
  d: Desktop,
  c: ChatSpec
): Promise<{ items: PushItem[]; seeded: SeededChat }> {
  const mainId = `${c.id}-main`
  const ids: Record<string, string> = {}
  c.messages.forEach((m, i) => {
    ids[m.key ?? `m${i + 1}`] = `${c.id}-m${i + 1}`
  })
  const total = c.messages.reduce((n, m) => n + (m.gap ?? 1), 0)
  const items: PushItem[] = []
  items.push(
    await item(d, 'chat', c.id, c.id, {
      sv: 1,
      title: c.title,
      config: {
        providerId: 'prov-openrouter',
        model: 'anthropic/claude-sonnet-4.5',
        enabledTools: ['shell', 'read_file', 'delegate_task', 'ask_user'],
        ...(c.presetId ? { presetId: c.presetId } : {})
      },
      mainSessionId: mainId,
      createdAt: c.at - total * MIN - H,
      updatedAt: c.at
    })
  )
  const session = (id: string, title: string, depth: number, extra: Record<string, unknown>) =>
    item(d, 'session', id, c.id, {
      sv: 1,
      chatId: c.id,
      parentSessionId: null,
      parentToolCallId: null,
      depth,
      model: 'anthropic/claude-sonnet-4.5',
      providerId: 'prov-openrouter',
      title,
      task: null,
      status: 'idle',
      createdAt: c.at - total * MIN - H,
      memory: null,
      branchSel: {},
      ...extra
    })
  const sel = Object.fromEntries(
    Object.entries(c.branchSel ?? {}).map(([k, v]) => [k === 'root' ? k : ids[k], v && ids[v]])
  )
  items.push(await session(mainId, 'Principal', 0, { branchSel: sel }))
  const msgs = async (
    sessionId: string,
    list: Msg[],
    idOf: (i: number, m: Msg) => string,
    labels: Record<string, string>
  ) => {
    let t = c.at - list.reduce((n, m) => n + (m.gap ?? 1), 0) * MIN
    for (const [i, m] of list.entries()) {
      t += (m.gap ?? 1) * MIN
      const message =
        m.role === 'tool'
          ? { role: 'tool', tool_call_id: m.tool_call_id, content: m.content }
          : m.role === 'assistant'
            ? {
                role: 'assistant',
                content: m.content,
                ...(m.reasoning ? { reasoning: m.reasoning } : {}),
                ...(m.tool_calls
                  ? {
                      tool_calls: m.tool_calls.map((tc) => ({
                        id: tc.id,
                        type: 'function',
                        function: { name: tc.name, arguments: JSON.stringify(tc.args) }
                      }))
                    }
                  : {})
              }
            : { role: 'user', content: m.content }
      const meta =
        m.role === 'assistant' && !m.meta?.synthetic
          ? {
              model: 'anthropic/claude-sonnet-4.5',
              usage: {
                promptTokens: 1800 + i * 420,
                completionTokens: 180 + (i % 7) * 60,
                cachedTokens: i > 1 ? 1600 + i * 380 : 0,
                cost: 0.0042 + i * 0.0007
              },
              durationMs: 2100 + (i % 5) * 900,
              ...m.meta
            }
          : (m.meta ?? {})
      const parent =
        m.parent === undefined
          ? i
            ? idOf(i - 1, list[i - 1])
            : null
          : m.parent && labels[m.parent]
      items.push(
        await item(
          d,
          'message',
          idOf(i, m),
          c.id,
          {
            sv: 1,
            sessionId,
            seq: i + 1,
            message,
            meta,
            createdAt: t,
            parentId: parent
          },
          i === 0 ? (c.blobs ?? []) : []
        )
      )
    }
  }
  await msgs(mainId, c.messages, (i) => `${c.id}-m${i + 1}`, ids)
  for (const s of c.subs ?? []) {
    items.push(
      await session(s.id, s.title, 1, {
        parentSessionId: mainId,
        parentToolCallId: s.parentToolCallId,
        task: s.task,
        model: 'anthropic/claude-haiku-4.5'
      })
    )
    await msgs(s.id, s.messages, (i) => `${s.id}-m${i + 1}`, {})
  }
  return { items, seeded: { id: c.id, title: c.title, mainSessionId: mainId, ids } }
}

const CODE = `export function* parseSSE(chunks: Iterable<string>) {
  let buf = ''
  for (const chunk of chunks) {
    buf += chunk
    let i: number
    while ((i = buf.indexOf('\\n\\n')) >= 0) {
      yield parseEvent(buf.slice(0, i))
      buf = buf.slice(i + 2)
    }
  }
  if (buf.trim()) yield parseEvent(buf) // evento final sem \\n — uma linha bem longa para testar a rolagem horizontal do bloco de código
}`

export interface Seeded {
  chats: Record<'sse' | 'lisboa' | 'voz' | 'foto' | 'crdt', SeededChat>
  image: { file: string; sha: string; blobId: string }
  pdf: { file: string; sha: string; blobId: string }
  head: number
}

/** Provedores, persona e as conversas (um chat por lote, modo replay com base 0). */
export async function seedAccount(d: Desktop): Promise<Seeded> {
  const now = Date.now()
  await push(d, [
    await item(d, 'provider', 'prov-openrouter', null, {
      sv: 1,
      name: 'OpenRouter',
      kind: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-v1-chave-de-teste-nao-real',
      headers: {},
      createdAt: now - 40 * 24 * H
    }),
    await item(d, 'preset', 'preset-dev', null, {
      sv: 1,
      name: 'Programador',
      description: 'Revisa e escreve código',
      icon: 'code',
      config: { model: 'anthropic/claude-sonnet-4.5' },
      createdAt: now - 30 * 24 * H,
      updatedAt: now - 30 * 24 * H
    }),
    await item(d, 'setting', 'defaultModel', null, {
      sv: 1,
      value: { providerId: 'prov-openrouter', model: 'anthropic/claude-sonnet-4.5' }
    })
  ])

  const image = await uploadBlob(d, whiteboardPng(), 'png')
  const pdf = await uploadBlob(d, tinyPdf('Ata da reuniao'), 'pdf')

  // conversa longa com ferramentas, subagente, aprovações e um trecho repetido para rolar
  const filler: Msg[] = []
  for (let i = 1; i <= 30; i++) {
    filler.push({
      role: 'user',
      content: `Pergunta de acompanhamento ${i}: e o caso ${i} do parser?`
    })
    filler.push({
      role: 'assistant',
      content: `Caso ${i}: o parser trata **${i} evento(s)** no buffer.\n\n- linha ${i}.a\n- linha ${i}.b\n\n\`\`\`ts\nexpect(parse(caso${i})).toHaveLength(${i})\n\`\`\``
    })
  }
  const sse = await chatItems(d, {
    id: 'chat-sse',
    title: 'Refatorar o parser de SSE',
    at: now - 25 * MIN,
    presetId: 'preset-dev',
    messages: [
      {
        role: 'user',
        content:
          'O parser de SSE em `src/main/sse.ts` quebra quando o servidor manda um evento sem `\\n` no final. Pode refatorar e rodar os testes?'
      },
      {
        role: 'assistant',
        reasoning:
          'Preciso ver o parser atual e onde ele é usado antes de mudar. Vou delegar o mapeamento dos usos e rodar os testes.',
        content:
          'Antes de aplicar, vou delegar o mapeamento dos outros usos do parser e rodar os testes.',
        tool_calls: [
          {
            id: 'call_sub1',
            name: 'delegate_task',
            args: {
              title: 'Mapear usos do parser',
              task: 'Encontre todos os lugares em src/ que chamam parseSSE e liste.'
            }
          },
          { id: 'call_sh1', name: 'shell', args: { command: 'npm test -- --run src/main/agent' } },
          { id: 'call_rm', name: 'shell', args: { command: 'rm -rf node_modules/.cache' } }
        ],
        meta: {
          reasoningMs: 8200,
          usage: {
            promptTokens: 2400,
            completionTokens: 310,
            cachedTokens: 1900,
            reasoningTokens: 1200,
            cost: 0.0061
          }
        }
      },
      {
        role: 'tool',
        tool_call_id: 'call_sub1',
        content:
          '3 usos: src/main/agent/runner.ts, src/main/providers/openai.ts, src/main/providers/anthropic.ts',
        meta: { toolStatus: 'ok', subSessionId: 'chat-sse-sub1' }
      },
      {
        role: 'tool',
        tool_call_id: 'call_sh1',
        content:
          ' ✓ src/main/agent/runner.test.ts (24 testes)\n ✗ src/main/sse.test.ts > evento sem \\n final\n\nTest Files  1 failed | 1 passed (2)',
        meta: {
          toolStatus: 'ok',
          approval: {
            item: 'shell',
            mode: 'lists',
            allowed: [{ text: 'npm test -- --run src/main/agent', entry: 'npm test' }]
          }
        }
      },
      {
        role: 'tool',
        tool_call_id: 'call_rm',
        content: 'Negado pelo usuário.',
        meta: {
          toolStatus: 'denied',
          approval: { item: 'shell', mode: 'lists', denied: 'rm -rf node_modules/.cache' }
        }
      },
      {
        role: 'assistant',
        content: `Encontrei o problema: o buffer só é processado quando chega \`\\n\\n\`. A correção é **descarregar o resto do buffer no fim do stream**:\n\n\`\`\`ts\n${CODE}\n\`\`\`\n\n| Arquivo | Mudança | Testes |\n|---|---|---|\n| \`runner.ts\` | nenhuma (usa o gerador) | 24 ✓ |\n| \`openai.ts\` | teste novo sem \`\\n\` | 9 ✓ |\n| \`anthropic.ts\` | teste novo sem \`\\n\` | 11 ✓ |\n\nResultado: **26 testes passando**. A complexidade continua $O(n)$ no tamanho do stream.`
      },
      ...filler
    ],
    subs: [
      {
        id: 'chat-sse-sub1',
        title: 'Mapear usos do parser',
        task: 'Encontre todos os lugares em src/ que chamam parseSSE e liste.',
        parentToolCallId: 'call_sub1',
        messages: [
          {
            role: 'user',
            content: 'Encontre todos os lugares em src/ que chamam parseSSE e liste.'
          },
          {
            role: 'assistant',
            content:
              'Usos de `parseSSE`:\n\n1. `src/main/agent/runner.ts`\n2. `src/main/providers/openai.ts`\n3. `src/main/providers/anthropic.ts`',
            meta: { model: 'anthropic/claude-haiku-4.5' }
          }
        ]
      }
    ]
  })
  await push(d, sse.items, { 'chat-sse': 0 })

  const lisboa = await chatItems(d, {
    id: 'chat-lisboa',
    title: 'Roteiro de 3 dias em Lisboa',
    at: now - 50 * MIN,
    branchSel: { u2b: 'a2b' },
    messages: [
      {
        key: 'u1',
        parent: null,
        role: 'user',
        content: 'Monta um roteiro de 3 dias em Lisboa, sem pressa.'
      },
      {
        key: 'a1',
        role: 'assistant',
        content:
          '**Dia 1** — Baixa, Chiado e pôr do sol no Miradouro de Santa Catarina.\n\n**Dia 2** — Belém: mosteiro, torre e pastéis.\n\n**Dia 3** — Alfama de manhã e LX Factory à tarde.'
      },
      { key: 'u2', role: 'user', content: 'Troca o dia 2 por um bate-volta para Sintra.' },
      {
        key: 'a2',
        role: 'assistant',
        content:
          'Feito: **Dia 2 em Sintra** — Palácio da Pena cedo, Quinta da Regaleira depois do almoço.'
      },
      {
        key: 'u2b',
        parent: 'a1',
        role: 'user',
        content: 'Troca o dia 3 por um bate-volta para Sintra.'
      },
      {
        key: 'a2b',
        role: 'assistant',
        content:
          'Feito: **Dia 3 em Sintra** — trem do Rossio às 8h, Palácio da Pena e Quinta da Regaleira.'
      },
      {
        key: 'a2c',
        parent: 'u2b',
        role: 'assistant',
        content:
          'Combinado: **Dia 3 em Sintra e Cascais** — Pena de manhã e fim de tarde na praia em Cascais.'
      }
    ]
  })
  await push(d, lisboa.items, { 'chat-lisboa': 0 })

  const callId = 'call-semana'
  const voz = await chatItems(d, {
    id: 'chat-voz',
    title: 'Chamada: planejar a semana',
    at: now - 4 * H,
    messages: [
      {
        role: 'assistant',
        content: 'Chamada de voz iniciada',
        meta: {
          synthetic: true,
          kind: 'memory-extraction',
          voiceCall: { callId, phase: 'start', startedAt: now - 4 * H - 7 * MIN }
        }
      },
      {
        role: 'user',
        content: 'Me ajuda a organizar a semana? Tenho três entregas e a academia.',
        meta: {
          voice: { source: 'call', callId, durationMs: 4200, sttModel: 'whisper-large-v3-turbo' }
        }
      },
      {
        role: 'assistant',
        content: 'Claro! Entregas de manhã e academia no fim da tarde de segunda, quarta e sexta.',
        meta: { voice: { source: 'call', callId, spoken: true, ttsModel: 'eleven_flash_v2_5' } }
      },
      {
        role: 'assistant',
        content: 'Chamada encerrada · 4 min · por você',
        meta: {
          synthetic: true,
          kind: 'memory-extraction',
          voiceCall: {
            callId,
            phase: 'end',
            startedAt: now - 4 * H - 7 * MIN,
            endedAt: now - 4 * H - 3 * MIN,
            durationMs: 4 * MIN,
            endedBy: 'user',
            usage: {
              turns: 2,
              userSpeechMs: 7300,
              stt: {
                mode: 'api',
                model: 'whisper',
                apiRequests: 6,
                apiAudioMs: 11800,
                localRequests: 0,
                cost: 0.0009,
                costedRequests: 6
              },
              tts: {
                backend: 'elevenlabs',
                model: 'eleven_flash_v2_5',
                chars: 236,
                audioMs: 15400,
                cost: 0.0142,
                estimated: true
              },
              llm: { calls: 2, cost: 0.0114, costed: 2 }
            }
          }
        }
      },
      {
        role: 'user',
        content: 'Resume o plano em uma lista curta.',
        meta: { voice: { source: 'dictation', durationMs: 2600 } }
      },
      {
        role: 'assistant',
        content:
          '- **Seg, qua e sex** — entregas de manhã, academia à tarde\n- **Qui** — reunião; sem entregas'
      }
    ]
  })
  await push(d, voz.items, { 'chat-voz': 0 })

  const foto = await chatItems(d, {
    id: 'chat-foto',
    title: 'Foto do quadro da reunião',
    at: now - 2 * H,
    blobs: [image.blobId, pdf.blobId],
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: `clearchat-attachment://${image.file}` },
            _attachment: {
              name: 'quadro.png',
              mime: 'image/png',
              size: whiteboardPng().length,
              kind: 'image',
              file: image.file
            }
          },
          {
            type: 'file',
            file: { filename: 'ata.pdf', file_data: `clearchat-attachment://${pdf.file}` },
            _attachment: {
              name: 'ata.pdf',
              mime: 'application/pdf',
              size: tinyPdf('Ata da reuniao').length,
              kind: 'pdf',
              file: pdf.file
            }
          },
          { type: 'text', text: 'Transcreve o que está no quadro e confere com a ata?' }
        ]
      },
      {
        role: 'assistant',
        content:
          'No quadro há **uma faixa roxa** com o título e **um bloco verde** à esquerda com as tarefas. A ata confirma os três pontos:\n\n1. Revisar o contrato\n2. Migrar o banco\n3. Publicar a versão 0.11'
      },
      {
        role: 'assistant',
        content: 'Quer que eu pergunte as prioridades?',
        tool_calls: [
          {
            id: 'call_ask',
            name: 'ask_user',
            args: {
              questions: [
                {
                  title: 'Qual tarefa vem primeiro?',
                  options: [{ title: 'Contrato' }, { title: 'Banco' }, { title: 'Versão 0.11' }]
                }
              ]
            }
          }
        ]
      },
      {
        role: 'tool',
        tool_call_id: 'call_ask',
        content: '1. Qual tarefa vem primeiro? → Banco',
        meta: {
          toolStatus: 'ok',
          askUser: {
            outcome: 'answered',
            questions: [
              {
                title: 'Qual tarefa vem primeiro?',
                multiple: false,
                options: [{ title: 'Contrato' }, { title: 'Banco' }, { title: 'Versão 0.11' }]
              }
            ],
            answers: [{ selected: [1] }]
          }
        }
      },
      { role: 'assistant', content: 'Combinado: **banco primeiro**.' },
      {
        role: 'user',
        content: interChatText(
          interChatHeader('Refatorar o parser de SSE', 'chat-sse'),
          'O parser já está corrigido, pode publicar.'
        ),
        meta: {
          kind: 'inter-chat',
          synthetic: true,
          fromChatId: 'chat-sse',
          fromChatTitle: 'Refatorar o parser de SSE',
          interChatHops: 1
        }
      },
      {
        role: 'assistant',
        content: '',
        meta: {
          kind: 'error',
          synthetic: true,
          error: 'HTTP 429: limite de requisições do provedor (tente de novo em 30 s)'
        }
      }
    ]
  })
  await push(d, foto.items, { 'chat-foto': 0 })

  const crdt = await chatItems(d, {
    id: 'chat-crdt',
    title: 'Resumo do artigo sobre CRDTs',
    at: now - 2 * 24 * H,
    messages: [
      { role: 'user', content: 'Resume o artigo sobre CRDTs que eu colei.' },
      { role: 'assistant', content: 'CRDTs permitem escritas sem coordenação que **convergem**.' },
      {
        role: 'user',
        content:
          '<conversation_summary>\nO usuário pediu um resumo de CRDTs; a resposta explicou convergência sem coordenação e LWW por campo.\n</conversation_summary>',
        meta: {
          kind: 'compaction',
          synthetic: true,
          usageBefore: 182000,
          contextEstimate: 2400,
          model: 'anthropic/claude-haiku-4.5',
          compactUsage: { promptTokens: 180000, completionTokens: 400, cost: 0.019 },
          durationMs: 6400
        }
      },
      { role: 'user', content: 'E como isso se aplica a um app de chat?' },
      {
        role: 'assistant',
        content:
          '## Para um app de chat\n\n| Tipo | Ideia | Exemplo |\n|---|---|---|\n| Estado (CvRDT) | junta estados com *merge* | G-Counter |\n| Operação (CmRDT) | operações comutativas | RGA |\n\n> Configurações em **LWW por campo** e mensagens num log ordenado pelo servidor.'
      }
    ]
  })
  await push(d, crdt.items, { 'chat-crdt': 0 })

  const state = await rest('GET', '/api/v1/sync/changes?since=0&limit=1', undefined, d.token)
  return {
    chats: {
      sse: sse.seeded,
      lisboa: lisboa.seeded,
      voz: voz.seeded,
      foto: foto.seeded,
      crdt: crdt.seeded
    },
    image,
    pdf,
    head: state.head
  }
}

/** Renomeia um chat como o desktop faria (LWW por campo, registro inteiro regravado). */
export async function renameChat(
  d: Desktop,
  chatId: string,
  mainSessionId: string,
  title: string,
  at: number
): Promise<void> {
  await syncRev(d, 'chat', chatId)
  await push(d, [
    await item(d, 'chat', chatId, chatId, {
      sv: 1,
      title,
      config: { providerId: 'prov-openrouter', model: 'anthropic/claude-sonnet-4.5' },
      mainSessionId,
      createdAt: at - H,
      updatedAt: at
    })
  ])
}
