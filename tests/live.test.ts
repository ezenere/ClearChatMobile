// Chats só ao vivo (protocolo 1.8.0, §23) no celular: vetores de live.json; a lista "Ao vivo"
// (live.list substitui, eventos antes do ack descartados, anti-replay por arev, epoch novo, removed,
// host em tolerância, settling depois do reinício do servidor, anúncio ilegível/de outro chat
// ignorado); o histórico sob demanda (páginas, `large` em pedaços, `omitted`, `rec` guardados
// durante o carregamento, maior lseq vence, exclusões, buraco → history.changes, reset → recarrega,
// snapshot.live.lseq, epoch novo no resultado); garantia "só em memória" (nada no cache SQLite nem
// em disco); attach.put (pedaços, offset, expirado, timeout, cancelar, já no host) e attach.get
// (pedaços, sha256); chat.update; comandos no máximo 3 em voo; e o fluxo inteiro pelo relé falso.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import live from '../src/vendor/protocol/test-vectors/live.json'
import { deriveSubkeys, fromHex, hex, randomBytes, sha256, utf8, type Subkeys } from '../src/crypto'
import { openJson, sealJson } from '../src/remote/crypto'
import { RemoteController, RemoteError } from '../src/remote/controller'
import { aadLiveAnnounce, openAnnounce, sealAnnounce } from '../src/live/crypto'
import { LiveList, parseWire, type LiveListEvent } from '../src/live/list'
import { LiveHistory, type HistoryKind } from '../src/live/history'
import { LiveService } from '../src/live/service'
import {
  classifyUpload,
  downloadFromHost,
  MemoryAttachments,
  toStdB64,
  uploadToHost,
  type AttachCommand
} from '../src/live/attach'
import { liveAttachmentSource } from '../src/live/attachSource'
import { resolvePushOpen, unavailableText } from '../src/live/navigation'
import { parseLiveInfo, parseLiveItem, liveStatusText } from '../src/live/types'
import { LocalStore } from '../src/data/store'
import { FakeLiveRelay } from './fakeServer'
import { until } from './hostHarness'
import { openNodeSql } from './nodeSql'

const USER = live.user_id
const HOST = live.host_device_id

// ---------------- vetores (live.json) ----------------

describe('vetores live.json (§23, §3.10)', () => {
  const key = fromHex(live.stream_key_hex)
  const [announce, ...others] = live.cases

  it('anúncio: AAD live-announce, cifra byte a byte e abre', async () => {
    const aad = announce.aad_utf8.split('|')
    const [, , , user, host, chat, epoch, arev] = aad
    expect(new TextDecoder().decode(aadLiveAnnounce(user, host, chat, +epoch, +arev))).toBe(
      announce.aad_utf8
    )
    const env = await sealAnnounce(
      key,
      user,
      host,
      chat,
      +epoch,
      +arev,
      JSON.parse(announce.json),
      fromHex(announce.nonce_hex)
    )
    expect(env).toEqual(announce.envelope)
    const back = await openAnnounce(key, user, host, chat, +epoch, +arev, announce.envelope)
    expect(back).toEqual(JSON.parse(announce.json))
    const info = parseLiveInfo(back, chat)!
    expect(info.title).toBe('Plano da viagem')
    expect(info.status).toBe('waiting')
    expect(info.pending.approvals).toBe(1)
    expect(liveStatusText(info, 'online')).toBe('aguardando você')
    expect(liveStatusText(info, 'grace')).toBe('reconectando…')
    // chatId de dentro diferente do de fora → inválido
    expect(parseLiveInfo(back, 'outro-chat')).toBeNull()
  })

  for (const c of others)
    it(`${c.name}: contextos de comando/resultado/stream reusados`, async () => {
      const env = await sealJson(key, utf8(c.aad_utf8), JSON.parse(c.json), fromHex(c.nonce_hex))
      expect(env).toEqual(c.envelope)
      expect(await openJson(key, utf8(c.aad_utf8), c.envelope)).toEqual(JSON.parse(c.json))
    })

  for (const c of live.must_fail)
    it(`DEVE falhar: ${c.name}`, async () => {
      await expect(openJson(key, utf8(c.aad_utf8), c.envelope as never)).rejects.toThrow()
    })

  it('itens do histórico dos vetores: data, large e deleted', () => {
    const r = JSON.parse(others[1].json) as { items: unknown[] }
    const items = r.items.map(parseLiveItem)
    expect(items[0]?.data).toBeTruthy()
    expect(items[1]?.large).toBe(300000)
    const rec = JSON.parse(others[2].json) as { items: unknown[] }
    expect(rec.items.map(parseLiveItem)[1]?.deleted).toBe(true)
    expect(parseLiveItem({ type: 'x', id: 'a', lseq: 1, data: {} })).toBeNull()
    expect(parseLiveItem({ type: 'message', id: 'a', lseq: -1, data: {} })).toBeNull()
  })
})

// ---------------- lista ----------------

describe('LiveList (§23.4)', () => {
  let sk: Subkeys
  let list: LiveList
  let events: LiveListEvent[]
  beforeEach(async () => {
    sk = await deriveSubkeys(randomBytes(32))
    events = []
    list = new LiveList({
      open: (w) =>
        openAnnounce(sk.stream, USER, w.host.device_id, w.chat_id, w.epoch, w.arev, w.env as never),
      deviceId: () => 'phone'
    })
    list.on((e) => events.push(e))
  })
  afterEach(() => vi.useRealTimers())

  const wire = async (
    chatId: string,
    o: {
      epoch?: number
      arev?: number
      title?: string
      host?: string
      status?: string
      inner?: string
      running?: boolean
    } = {}
  ) => {
    const epoch = o.epoch ?? 100
    const arev = o.arev ?? 1
    const host = o.host ?? HOST
    const env = await sealAnnounce(sk.stream, USER, host, chatId, epoch, arev, {
      sv: 1,
      chatId: o.inner ?? chatId,
      title: o.title ?? chatId,
      persona: null,
      model: { providerId: null, providerName: null, model: 'm' },
      status: o.running ? 'running' : 'idle',
      pending: { approvals: 0, questions: 0, retries: 0 },
      usesLocalTools: false,
      hostCwd: null,
      createdAt: 1,
      updatedAt: arev
    })
    return {
      chat_id: chatId,
      epoch,
      arev,
      running: !!o.running,
      env,
      host: {
        device_id: host,
        name: host === HOST ? 'PC de casa' : 'Notebook',
        platform: 'linux',
        status: o.status ?? 'online'
      }
    }
  }

  it('live.list substitui; eventos antes do ack descartados; os de depois por cima', async () => {
    list.beginListing()
    list.onEvent({ t: 'live.update', chats: [await wire('antes')] })
    await list.applyList({
      chats: [await wire('a'), await wire('b', { host: 'nb' })],
      settling_s: 0
    })
    expect(list.has('antes')).toBe(false)
    expect(
      list
        .all()
        .map((e) => e.chatId)
        .sort()
    ).toEqual(['a', 'b'])
    expect(
      list
        .groups()
        .map((g) => g.host.name)
        .sort()
    ).toEqual(['Notebook', 'PC de casa'])
    list.onEvent({ t: 'live.update', chats: [await wire('c')] })
    await until(() => list.has('c'), 1000, 'c')
  })

  it('anti-replay por arev no mesmo epoch; epoch novo vira evento; running → evento', async () => {
    await list.applyList({ chats: [await wire('a', { arev: 3, title: 'T3' })], settling_s: 0 })
    list.onEvent({ t: 'live.update', chats: [await wire('a', { arev: 2, title: 'velho' })] })
    list.onEvent({ t: 'live.update', chats: [await wire('a', { arev: 3, title: 'repetido' })] })
    list.onEvent({
      t: 'live.update',
      chats: [await wire('a', { arev: 4, title: 'T4', running: true })]
    })
    await until(() => list.get('a')?.info.title === 'T4', 1000, 'T4')
    expect(events.some((e) => e.kind === 'running' && e.running)).toBe(true)
    list.onEvent({
      t: 'live.update',
      chats: [await wire('a', { epoch: 200, arev: 1, title: 'novo epoch' })]
    })
    await until(() => list.get('a')?.epoch === 200, 1000, 'epoch')
    expect(events.some((e) => e.kind === 'epoch' && e.chatId === 'a')).toBe(true)
    // epoch mais velho que o conhecido: ignorado
    list.onEvent({ t: 'live.update', chats: [await wire('a', { epoch: 150, arev: 9 })] })
    await new Promise((r) => setTimeout(r, 20))
    expect(list.get('a')?.epoch).toBe(200)
  })

  it('ilegível, outro chatId dentro, ou do próprio aparelho: não aparece', async () => {
    const bad = await wire('x')
    bad.arev = 2 // AAD não confere mais
    await list.applyList({
      chats: [
        bad,
        await wire('y', { inner: 'z' }),
        await wire('eu', { host: 'phone' }),
        { lixo: 1 }
      ],
      settling_s: 0
    })
    expect(list.size).toBe(0)
    expect(
      parseWire({ chat_id: 'a', epoch: 0, arev: 1, env: {}, host: { device_id: 'h' } })
    ).toBeNull()
  })

  it('live.removed (só do host certo) e live.host grace/online', async () => {
    await list.applyList({ chats: [await wire('a'), await wire('b')], settling_s: 0 })
    list.onEvent({ t: 'live.host', host_device_id: HOST, status: 'grace' })
    await until(() => list.get('a')?.host.status === 'grace', 1000, 'grace')
    list.onEvent({ t: 'live.removed', host_device_id: 'outro', chat_ids: ['a'], reason: 'deleted' })
    list.onEvent({
      t: 'live.removed',
      host_device_id: HOST,
      chat_ids: ['a', 'b'],
      reason: 'host_dropped'
    })
    await until(() => list.size === 0, 1000, 'vazia')
    const rm = events.find((e) => e.kind === 'removed')
    expect(rm && rm.kind === 'removed' && rm.reason).toBe('host_dropped')
  })

  it('reconexão: tudo "reconectando…"; lista nova com settling_s mantém os ausentes até passar', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await list.applyList({ chats: [await wire('a'), await wire('b')], settling_s: 0 })
    list.onDisconnected()
    expect(list.all().every((e) => e.stale)).toBe(true)
    list.beginListing()
    await list.applyList({ chats: [await wire('a', { arev: 2 })], settling_s: 30 })
    expect(list.get('a')?.stale).toBe(false)
    expect(list.get('b')?.stale).toBe(true)
    expect(events.some((e) => e.kind === 'back' && e.chatId === 'a')).toBe(true)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(list.has('b')).toBe(false)
    // sem settling: some na hora
    list.onDisconnected()
    await list.applyList({ chats: [], settling_s: 0 })
    expect(list.size).toBe(0)
  })
})

// ---------------- histórico (puro, com um host roteirizado) ----------------

describe('LiveHistory (§23.5)', () => {
  type Cmd = { kind: HistoryKind; payload: Record<string, unknown> }
  const msg = (id: string, seq: number, content: string, role = 'user') => ({
    type: 'message' as const,
    id,
    lseq: 0,
    data: {
      sv: 1,
      sessionId: 's1',
      seq,
      message: { role, content },
      meta: {},
      createdAt: seq,
      parentId: null
    }
  })
  const chat = {
    type: 'chat' as const,
    id: 'c1',
    lseq: 0,
    data: { sv: 1, title: 'Viagem', config: {}, mainSessionId: 's1', createdAt: 1, updatedAt: 1 }
  }
  const sess = {
    type: 'session' as const,
    id: 's1',
    lseq: 0,
    data: { sv: 1, chatId: 'c1', depth: 0, status: 'idle', createdAt: 1, branchSel: {} }
  }

  function scripted(
    handler: (c: Cmd) => Record<string, unknown> | Promise<Record<string, unknown>>
  ) {
    const calls: Cmd[] = []
    let changed = 0
    const assistants: string[] = []
    let epochSeen: number | null = null
    const h = new LiveHistory({
      chatId: 'c1',
      epoch: 7,
      command: async (kind, payload) => {
        const c = { kind, payload }
        calls.push(c)
        return { status: 'accepted', epoch: 7, ...(await handler(c)) }
      },
      changed: () => changed++,
      onAssistant: (m) => assistants.push(m.id),
      onEpoch: (e) => (epochSeen = e)
    })
    return { h, calls, assistants, changes: () => changed, epoch: () => epochSeen }
  }

  it('páginas de mensagens, item grande em pedaços, omitido por history.item; vira LoadedChat', async () => {
    const big = {
      sv: 1,
      sessionId: 's1',
      seq: 3,
      message: { role: 'assistant', content: 'é'.repeat(5000) },
      meta: {},
      createdAt: 3,
      parentId: null
    }
    const bigJson = utf8(JSON.stringify(big))
    const { h, calls } = scripted(({ kind, payload }) => {
      if (kind === 'history.list') {
        if (payload.type === 'chat') return { lseq: 4, items: [chat], next: null }
        if (payload.type === 'session') return { lseq: 4, items: [sess], next: null }
        if (payload.after === null)
          return {
            lseq: 4,
            items: [msg('m1', 1, 'oi'), { type: 'message', id: 'm2', lseq: 2, omitted: true }],
            next: 'p2'
          }
        return {
          lseq: 4,
          items: [{ type: 'message', id: 'm3', lseq: 3, large: bigJson.length }],
          next: null
        }
      }
      if (kind === 'history.item' && payload.items)
        return { lseq: 4, items: [{ ...msg('m2', 2, 'tudo bem', 'assistant'), lseq: 2 }] }
      if (kind === 'history.item' && payload.piece) {
        const off = (payload.piece as { offset: number }).offset
        const part = bigJson.subarray(off, off + 4000)
        return {
          lseq: 4,
          piece: {
            type: 'message',
            id: 'm3',
            lseq: 3,
            total: bigJson.length,
            offset: off,
            data: toStdB64(part)
          }
        }
      }
      return {}
    })
    await h.start()
    expect(h.phase).toBe('ready')
    const l = h.loaded!
    expect(l.chat.title).toBe('Viagem')
    expect(l.messages.get('s1')!.map((m) => m.id)).toEqual(['m1', 'm2', 'm3'])
    expect((l.messages.get('s1')![2].message.content as string).length).toBe(5000)
    expect(calls.filter((c) => c.payload.piece).length).toBe(Math.ceil(bigJson.length / 4000))
    expect(h.knownLseq).toBe(4)
    expect(calls.every((c) => c.payload.chatId === 'c1')).toBe(true)
  })

  it('rec guardados durante o carregamento; maior lseq vence; exclusão; assistente troca o draft', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const { h, assistants } = scripted(async ({ kind, payload }) => {
      if (kind === 'history.list' && payload.type === 'chat') {
        await gate
        return { lseq: 1, items: [chat], next: null }
      }
      if (kind === 'history.list' && payload.type === 'session')
        return { lseq: 1, items: [sess], next: null }
      if (kind === 'history.list') return { lseq: 1, items: [msg('m1', 1, 'velho')], next: null }
      return {}
    })
    const started = h.start()
    // chegam antes de o histórico terminar
    h.onRec(2, [{ ...msg('m1', 1, 'novo'), lseq: 2 }])
    h.onRec(3, [
      { ...msg('m2', 2, 'resposta', 'assistant'), lseq: 3 },
      { type: 'message', id: 'mX', lseq: 3, deleted: true }
    ])
    release()
    await started
    const list = h.loaded!.messages.get('s1')!
    expect(list.map((m) => [m.id, m.message.content])).toEqual([
      ['m1', 'novo'],
      ['m2', 'resposta']
    ])
    expect(h.item('message', 'mX')?.deleted).toBe(true)
    expect(h.knownLseq).toBe(3)
    // rec atrasado (lseq menor) não volta a versão velha
    h.onRec(2, [{ ...msg('m1', 1, 'velho de novo'), lseq: 2 }])
    expect(h.loaded!.messages.get('s1')![0].message.content).toBe('novo')
    // assistente vindo por rec depois de carregado → onAssistant
    h.onRec(4, [{ ...msg('m4', 3, 'mais', 'assistant'), lseq: 4 }])
    expect(assistants).toContain('m4')
  })

  it('buraco no lseq → history.changes; omitido → history.item; reset → recarrega; snapshot maior → changes', async () => {
    let reset = false
    let loads = 0
    const { h, calls } = scripted(({ kind, payload }) => {
      if (kind === 'history.list' && payload.type === 'chat') {
        loads++
        return { lseq: 5, items: [chat], next: null }
      }
      if (kind === 'history.list' && payload.type === 'session')
        return { lseq: 5, items: [sess], next: null }
      if (kind === 'history.list') return { lseq: 5, items: [msg('m1', 1, 'a')], next: null }
      if (kind === 'history.changes')
        return reset
          ? { lseq: 9, reset: true }
          : {
              lseq: 8,
              changes: [
                { type: 'message', id: 'm6', lseq: 6 },
                { type: 'message', id: 'm1', lseq: 7, deleted: true }
              ]
            }
      if (kind === 'history.item')
        return { lseq: 8, items: [{ ...msg('m6', 2, 'perdida'), lseq: 6 }] }
      return {}
    })
    await h.start()
    h.onRec(8, [{ type: 'message', id: 'm8', lseq: 8, omitted: true }])
    await until(() => calls.some((c) => c.kind === 'history.changes'), 1000, 'changes')
    expect(calls.find((c) => c.kind === 'history.changes')!.payload.since).toBe(5)
    await until(() => !!h.item('message', 'm6')?.data, 1000, 'm6')
    expect(h.item('message', 'm1')?.deleted).toBe(true)
    // snapshot com lseq maior que o conhecido → mudanças perdidas
    const before = calls.filter((c) => c.kind === 'history.changes').length
    reset = true
    h.onSnapshotLseq(99)
    await until(() => loads === 2, 1000, 'recarga')
    expect(calls.filter((c) => c.kind === 'history.changes').length).toBe(before + 1)
    await until(() => h.phase === 'ready', 1000, 'pronto')
  })

  it('resultado com outro epoch → o dono recomeça; recusa vira erro legível', async () => {
    const a = scripted(() => ({ epoch: 8, items: [], next: null }))
    await a.h.start()
    expect(a.epoch()).toBe(8)
    const b = scripted(() => ({ status: 'rejected', error: 'x', code: 'not_live' }))
    await b.h.start()
    expect(b.h.phase).toBe('error')
    expect(b.h.error).toMatch(/não é mais só ao vivo/)
  })
})

// ---------------- anexos ----------------

describe('attach.put / attach.get (§23.7)', () => {
  it('classifica como o composer: tipo, UTF-8 e 20 MiB', async () => {
    const c = await classifyUpload(utf8('hello\n'), 'hello.txt', 'text/plain')
    expect(c.file).toBe('5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03.txt')
    expect(c.kind).toBe('text')
    await expect(
      classifyUpload(new Uint8Array([0xff, 0xfe, 0xfd]), 'x.bin', undefined)
    ).rejects.toThrow(/não suportado/)
    await expect(
      classifyUpload(new Uint8Array(20 * 1024 * 1024 + 1), 'f.png', 'image/png')
    ).rejects.toThrow(/20 MB/)
  })

  function hostSim(
    opts: { failOnce?: number; offsetAt?: number; expireOnce?: boolean; already?: boolean } = {}
  ) {
    const calls: Record<string, unknown>[] = []
    let received = 0
    let expired = false
    let failed = 0
    const cmd: AttachCommand = async (kind, p) => {
      calls.push({ kind, ...p })
      if (p.cancel) return { status: 'accepted', cancelled: true }
      if (opts.failOnce !== undefined && p.offset === opts.failOnce && failed === 0) {
        failed++
        throw new RemoteError('command_timeout', 'sem resposta')
      }
      if (opts.already)
        return {
          status: 'accepted',
          received: p.size,
          done: true,
          attachment: {
            name: p.name,
            mime: p.mime,
            size: p.size,
            kind: 'image',
            file: `${p.sha256}.png`,
            sha256: p.sha256
          }
        }
      if (opts.expireOnce && !expired && p.offset !== 0) {
        expired = true
        received = 0
        return { status: 'rejected', error: 'expirou', code: 'expired' }
      }
      const data = Buffer.from(String(p.data), 'base64')
      if (
        opts.offsetAt !== undefined &&
        p.offset === opts.offsetAt &&
        received !== opts.offsetAt - 1
      ) {
        // o host já tinha recebido menos: continua de lá
      }
      if (p.offset !== received)
        return { status: 'rejected', error: 'offset', code: 'offset', received }
      received += data.length
      if (received < Number(p.size)) return { status: 'accepted', received, done: false }
      return {
        status: 'accepted',
        received,
        done: true,
        attachment: {
          name: p.name,
          mime: p.mime,
          size: p.size,
          kind: 'image',
          file: `${p.sha256}.png`,
          sha256: p.sha256
        }
      }
    }
    return { cmd, calls, received: () => received }
  }

  const bytes = (n: number) => {
    const b = new Uint8Array(n)
    for (let i = 0; i < n; i++) b[i] = i % 251
    return b
  }

  it('pedaços contíguos de 512 KiB, um por vez; progresso; AttachmentInfo no fim', async () => {
    const data = bytes(1300 * 1024)
    const c = await classifyUpload(data, 'foto.png', 'image/png')
    const sim = hostSim()
    const progress: number[] = []
    const up = uploadToHost(sim.cmd, { chatId: 'c1', data, name: c.name, mime: c.mime }, c, {
      onProgress: (s) => progress.push(s)
    })
    const info = await up.done
    expect(info.file).toBe(c.file)
    expect(sim.calls.map((x) => x.offset)).toEqual([0, 512 * 1024, 1024 * 1024])
    expect(new Set(sim.calls.map((x) => x.uploadId)).size).toBe(1)
    expect(
      sim.calls.every(
        (x) => x.sha256 === c.sha256 && x.size === data.length && x.name === 'foto.png'
      )
    ).toBe(true)
    expect(progress.at(-1)).toBe(data.length)
  })

  it('timeout repete o MESMO pedaço; offset recusado continua do received; expirado recomeça com outro uploadId', async () => {
    const data = bytes(1100 * 1024)
    const c = await classifyUpload(data, 'foto.png', 'image/png')
    const a = hostSim({ failOnce: 512 * 1024 })
    await uploadToHost(a.cmd, { chatId: 'c1', data, name: c.name, mime: c.mime }, c, {
      sleep: async () => undefined
    }).done
    expect(a.calls.map((x) => x.offset)).toEqual([0, 512 * 1024, 512 * 1024, 1024 * 1024])
    const b = hostSim({ expireOnce: true })
    await uploadToHost(b.cmd, { chatId: 'c1', data, name: c.name, mime: c.mime }, c).done
    const ids = b.calls.map((x) => x.uploadId)
    expect(new Set(ids).size).toBe(2)
    expect(b.calls.map((x) => x.offset)).toEqual([0, 512 * 1024, 0, 512 * 1024, 1024 * 1024])
  })

  it('já no store do host: done no primeiro pedaço; cancelar manda cancel', async () => {
    const data = bytes(900 * 1024)
    const c = await classifyUpload(data, 'foto.png', 'image/png')
    const a = hostSim({ already: true })
    await uploadToHost(a.cmd, { chatId: 'c1', data, name: c.name, mime: c.mime }, c).done
    expect(a.calls.length).toBe(1)
    let release!: () => void
    const slow: AttachCommand = async (kind, p) => {
      if (p.cancel) return { status: 'accepted', cancelled: true }
      await new Promise<void>((r) => (release = r))
      return { status: 'accepted', received: 512 * 1024, done: false }
    }
    const calls: Record<string, unknown>[] = []
    const cmd: AttachCommand = (k, p) => {
      calls.push(p)
      return slow(k, p)
    }
    const up = uploadToHost(cmd, { chatId: 'c1', data, name: c.name, mime: c.mime }, c)
    await until(() => calls.length === 1, 500, 'primeiro pedaço')
    up.cancel()
    release()
    await expect(up.done).rejects.toThrow(/cancelado/)
    expect(calls.some((p) => p.cancel === true)).toBe(true)
  })

  it('attach.get: pedaços, sha256 conferido; diferente → erro; memória com teto', async () => {
    const data = bytes(1200 * 1024)
    const file = `${hex(await sha256(data))}.png`
    const cmd: AttachCommand = async (_k, p) => {
      const off = Number(p.offset)
      return {
        status: 'accepted',
        file,
        size: data.length,
        ...(off === 0 ? { mime: 'image/png' } : {}),
        offset: off,
        data: toStdB64(data.subarray(off, off + Number(p.length)))
      }
    }
    const d = await downloadFromHost(cmd, 'c1', file)
    expect(d.bytes.length).toBe(data.length)
    expect(d.mime).toBe('image/png')
    const wrong = `${'0'.repeat(64)}.png`
    await expect(downloadFromHost(cmd, 'c1', wrong)).rejects.toThrow(/não confere/)
    await expect(downloadFromHost(cmd, 'c1', '../etc/passwd')).rejects.toThrow(/inválido/)
    const mem = new MemoryAttachments(2 * 1024 * 1024)
    mem.put({ file: 'a', mime: null, bytes: new Uint8Array(1024 * 1024) })
    mem.put({ file: 'b', mime: null, bytes: new Uint8Array(1024 * 1024) })
    mem.get('a')
    mem.put({ file: 'c', mime: null, bytes: new Uint8Array(1024 * 1024) })
    expect(mem.get('b')).toBeNull()
    expect(mem.get('a')).not.toBeNull()
    mem.deletePrefix('a')
    expect(mem.size).toBe(1)
  })

  it('fonte de anexos: imagem vira data: (memória); PDF vai para o temporário', async () => {
    const temp: string[] = []
    const png = bytes(100)
    const pdf = bytes(50)
    const src = liveAttachmentSource({
      chatId: 'c1',
      temp: (n) => {
        temp.push(n)
        return `file:///cache/live-view/${n}`
      },
      live: {
        cachedFile: () => null,
        file: async (_c, f) => ({
          file: f,
          mime: f.endsWith('.png') ? 'image/png' : 'application/pdf',
          bytes: f.endsWith('.png') ? png : pdf
        })
      }
    })
    expect(src.memoryOnly).toBe(true)
    const img = await src.ensure(`${'a'.repeat(64)}.png`)
    expect(img.startsWith('data:image/png;base64,')).toBe(true)
    expect(temp).toEqual([])
    const doc = await src.ensure(`${'b'.repeat(64)}.pdf`)
    expect(doc).toContain('live-view')
    expect(temp.length).toBe(1)
  })
})

// ---------------- fluxo inteiro pelo relé falso ----------------

describe('visualizador ao vivo pelo relé (fluxo completo)', () => {
  let sk: Subkeys
  let relay: FakeLiveRelay
  let rc: RemoteController
  let svc: LiveService
  let wiped = 0
  let store: LocalStore

  beforeEach(async () => {
    sk = await deriveSubkeys(randomBytes(32))
    relay = new FakeLiveRelay(USER)
    store = new LocalStore(openNodeSql())
    wiped = 0
    const ws = { request: relay.request }
    rc = new RemoteController({
      ws,
      keys: () => ({ userId: USER, sk }),
      deviceId: () => 'phone',
      chatState: (id) => store.chatState(id),
      post: async () => ({}),
      assistantIds: (id) => store.assistantIds(id),
      loadMessage: (id) => store.message(id),
      timing: { commandMs: 2000, fsMs: 2000, resyncGapMs: 0 },
      live: () => svc.hook
    })
    svc = new LiveService({
      ws,
      remote: rc,
      keys: () => ({ userId: USER, sk }),
      deviceId: () => 'phone',
      fetchFeature: async () => true,
      wipeTemp: () => void wiped++
    })
    relay.onViewer = (f) => {
      rc.onEvent(f)
      svc.onEvent(f)
    }
  })

  const connect = async () => {
    rc.onConnection(true)
    svc.onConnection(true)
    rc.onWelcome({})
    svc.onWelcome({ caps: ['live_chats'] })
    await until(() => relay.of('live.list').length > 0, 1000, 'live.list')
  }

  const dbCounts = () =>
    ['records', 'chats', 'messages', 'outbox', 'meta', 'chat_storage', 'history_fts'].map(
      (t) => store.sql.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`)!.n
    )

  it('anúncio → lista "Ao vivo em <host>"; abrir → histórico em memória; enviar → rec com a resposta; NADA no cache', async () => {
    const host = relay.addHost(HOST, 'PC de casa', sk, { replyMs: 5, pageMax: 3 })
    const chatId = host.createChat({
      title: 'Plano da viagem',
      messages: [
        { role: 'user', content: 'oi' },
        { role: 'assistant', content: 'olá' },
        { role: 'user', content: 'roteiro?' },
        { role: 'assistant', content: 'dia 1…' },
        { role: 'user', content: 'e o dia 2?' }
      ],
      hostCwd: '/home/ana/viagem'
    })
    await host.announce(true)
    const before = dbCounts()
    await connect()
    await until(() => svc.list.has(chatId), 1000, 'na lista')
    expect(svc.supported).toBe(true)
    const g = svc.list.groups()
    expect(g[0].host.name).toBe('PC de casa')
    expect(rc.mode(chatId)).toBe('remote')
    expect(rc.hostName(chatId)).toBe('PC de casa')

    svc.open(chatId)
    await until(() => svc.history(chatId)?.phase === 'ready', 3000, 'histórico')
    const h = svc.history(chatId)!
    expect(h.loaded!.messages.get(`${chatId}-main`)!.length).toBe(5)
    // 5 mensagens em páginas de 3
    expect(
      host.received.filter((r) => r.kind === 'history.list' && r.payload.type === 'message').length
    ).toBe(2)
    // inscrição antes do histórico (§23.5.1)
    const iSub = relay.sent.findIndex((s) => s.t === 'stream.subscribe')
    const iHist = relay.sent.findIndex(
      (s) => s.t === 'remote.send' && s.fields.kind === 'history.list'
    )
    expect(iSub).toBeGreaterThanOrEqual(0)
    expect(iSub).toBeLessThan(iHist)
    // o snapshot (com live.lseq) montou o espelho do stream
    await until(() => !!rc.view(chatId)?.complete, 1000, 'snapshot')
    expect(rc.view(chatId)!.skills.map((s) => s.name)).toEqual(['deploy'])

    await rc.send(chatId, `${chatId}-main`, 'e o dia 3?', [], [])
    await until(
      () =>
        (h.loaded?.messages.get(`${chatId}-main`) ?? []).some(
          (m) => m.message.content === 'ok: e o dia 3?'
        ),
      3000,
      'resposta pelo rec'
    )
    // o draft encerrado foi trocado pela mensagem persistida (rec)
    await until(() => !rc.view(chatId)?.drafts[`${chatId}-main`], 3000, 'draft trocado')
    await until(() => svc.list.get(chatId)?.running === false, 2000, 'anúncio ocioso')

    // chat.update: renomeia no host → rec do chat + anúncio novo
    await rc.chatUpdate(chatId, { title: 'Lisboa' })
    await until(() => svc.list.get(chatId)?.info.title === 'Lisboa', 2000, 'título no anúncio')
    await until(() => h.loaded?.chat.title === 'Lisboa', 2000, 'título no histórico')
    const upd = host.received.find((r) => r.kind === 'chat.update')!
    expect(upd.payload).toMatchObject({ chatId, title: 'Lisboa' })

    // SÓ EM MEMÓRIA: o cache SQLite não mudou nada
    expect(dbCounts()).toEqual(before)
    expect(store.listChats()).toEqual([])

    // sair do chat mantém o espelho em memória (voltar sem recarregar) e apaga temporários
    svc.close(chatId)
    expect(wiped).toBeGreaterThan(0)
    expect(svc.history(chatId)).not.toBeNull()
    // bloquear/sair: descarta tudo
    svc.wipe()
    expect(svc.stats()).toEqual({ chats: 0, histories: 0, files: 0, fileBytes: 0 })
  })

  it('aprovação e pergunta por comando; anexo pelo attach.put referenciado no send; attach.get do histórico', async () => {
    const host = relay.addHost(HOST, 'PC de casa', sk, { replyMs: 5 })
    const chatId = host.createChat({
      title: 'Projeto',
      messages: [{ role: 'user', content: 'oi' }]
    })
    await host.announce(true)
    await connect()
    await until(() => svc.list.has(chatId), 1000, 'lista')
    svc.open(chatId)
    await until(() => svc.history(chatId)?.phase === 'ready', 3000, 'histórico')
    const sid = `${chatId}-main`

    await rc.send(chatId, sid, '/tool rodar testes', [], [])
    await until(() => (rc.view(chatId)?.approvals.length ?? 0) === 1, 2000, 'aprovação')
    await until(() => svc.list.get(chatId)?.info.status === 'waiting', 2000, 'aguardando você')
    await rc.approve(chatId, rc.view(chatId)!.approvals[0].id, 'allow')
    await until(
      () =>
        (svc.history(chatId)?.loaded?.messages.get(sid) ?? []).some(
          (m) => m.message.content === 'executei: npm test'
        ),
      2000,
      'resultado da aprovação'
    )

    // anexo: pedaços ao host, depois o send com o AttachmentInfo do host
    const png = new Uint8Array(700 * 1024).map((_, i) => i % 200)
    const up = await svc.upload(chatId, png, 'foto.png', 'image/png')
    const info = await up.handle.done
    expect(host.received.filter((r) => r.kind === 'attach.put').length).toBe(2)
    expect(svc.cachedFile(chatId, info.file)).not.toBeNull() // miniatura em memória
    await rc.send(chatId, sid, 'veja', [info], [])
    await until(
      () =>
        (svc.history(chatId)?.loaded?.messages.get(sid) ?? []).some(
          (m) => m.message.content === 'ok: veja (1 anexo)'
        ),
      2000,
      'resposta com anexo'
    )
    // baixar do host (outro arquivo do histórico)
    const other = new Uint8Array([1, 2, 3, 4, 5])
    const file = `${hex(await sha256(other))}.pdf`
    host.addFile(chatId, file, other, 'application/pdf')
    const got = await svc.file(chatId, file)
    expect([...got.bytes]).toEqual([1, 2, 3, 4, 5])
    expect(svc.stats().files).toBeGreaterThan(0)
  })

  it('host em tolerância → host-offline; volta; tolerância expira → some da lista e o espelho é descartado', async () => {
    const host = relay.addHost(HOST, 'PC de casa', sk)
    const chatId = host.createChat({ title: 'A', messages: [{ role: 'user', content: 'x' }] })
    await host.announce(true)
    await connect()
    await until(() => svc.list.has(chatId), 1000, 'lista')
    svc.open(chatId)
    await until(() => svc.history(chatId)?.phase === 'ready', 3000, 'histórico')
    const notices: string[] = []
    svc.onNotice((n) => n.kind === 'removed' && notices.push(n.reason))
    relay.hostGrace(HOST)
    await until(() => rc.mode(chatId) === 'host-offline', 1000, 'host-offline')
    await expect(rc.send(chatId, `${chatId}-main`, 'x', [], [])).rejects.toThrow(/offline/)
    relay.hostBack(HOST)
    await until(() => rc.mode(chatId) === 'remote', 1000, 'online')
    relay.hostDropped(HOST)
    await until(() => !svc.list.has(chatId), 1000, 'saiu')
    expect(notices).toEqual(['host_dropped'])
    expect(svc.history(chatId)).toBeNull()
    expect(rc.mode(chatId)).toBe('none')
    // o host reabre o app (epoch novo) com a tela ainda aberta: volta e carrega sozinho
    host.chats.get(chatId)!.epoch += 1000
    await host.announce(true)
    await until(() => svc.history(chatId)?.phase === 'ready', 3000, 'recarregou ao voltar')
    expect(svc.history(chatId)!.epoch).toBe(host.chats.get(chatId)!.epoch)
  })

  it('rec perdido → buraco (n e lseq) → resync + history.changes; reset depois de esquecer', async () => {
    const host = relay.addHost(HOST, 'PC de casa', sk, { replyMs: 5 })
    const chatId = host.createChat({ title: 'A', messages: [{ role: 'user', content: 'x' }] })
    await host.announce(true)
    await connect()
    await until(() => svc.list.has(chatId), 1000, 'lista')
    svc.open(chatId)
    await until(() => svc.history(chatId)?.phase === 'ready', 3000, 'histórico')
    const c = host.chats.get(chatId)!
    const msgId = [...c.items.values()].find((r) => r.type === 'message')!.id
    const data = [...c.items.values()].find((r) => r.type === 'message')!.data!
    relay.dropNext = 1
    host.change(chatId, [
      {
        type: 'message',
        id: msgId,
        data: { ...data, message: { role: 'user', content: 'editada' } }
      }
    ])
    host.change(chatId, [
      {
        type: 'chat',
        id: chatId,
        data: { ...c.items.get(`chat\u0000${chatId}`)!.data!, title: 'B' }
      }
    ])
    await until(() => host.received.some((r) => r.kind === 'history.changes'), 2000, 'changes')
    await until(
      () =>
        svc.history(chatId)?.loaded?.messages.get(`${chatId}-main`)?.[0].message.content ===
        'editada',
      2000,
      'recuperou'
    )
    // host esqueceu as mudanças antigas: o próximo buraco dá reset → recarrega tudo
    host.forgetChanges(chatId, 100)
    relay.dropNext = 1
    host.change(chatId, [
      {
        type: 'chat',
        id: chatId,
        data: { ...c.items.get(`chat\u0000${chatId}`)!.data!, title: 'C' }
      }
    ])
    host.change(chatId, [
      {
        type: 'chat',
        id: chatId,
        data: { ...c.items.get(`chat\u0000${chatId}`)!.data!, title: 'D' }
      }
    ])
    await until(() => svc.history(chatId)?.loaded?.chat.title === 'D', 3000, 'recarregou')
    expect(
      host.received.filter((r) => r.kind === 'history.list' && r.payload.type === 'chat').length
    ).toBe(2)
  })

  it('saved_online → aviso; epoch novo → recomeça; servidor antigo → nada de live.*', async () => {
    const host = relay.addHost(HOST, 'PC de casa', sk)
    const chatId = host.createChat({ title: 'A' })
    await host.announce(true)
    await connect()
    await until(() => svc.list.has(chatId), 1000, 'lista')
    svc.open(chatId)
    await until(() => svc.history(chatId)?.phase === 'ready', 3000, 'histórico')
    const notices: string[] = []
    svc.onNotice((n) => notices.push(n.kind === 'removed' ? n.reason : n.kind))
    // o host reiniciou o app: epoch novo
    host.chats.get(chatId)!.epoch += 1000
    await host.announce(true)
    await until(() => notices.includes('restarted'), 2000, 'recomeçou')
    await until(
      () =>
        svc.history(chatId)?.epoch === host.chats.get(chatId)!.epoch &&
        svc.history(chatId)?.phase === 'ready',
      3000,
      'histórico novo'
    )
    relay.savedOnline(chatId)
    await until(() => notices.includes('saved_online'), 1000, 'salvo online')
    // servidor sem live_chats nas caps: lista vazia, sem live.list
    const n = relay.of('live.list').length
    svc.onWelcome({ caps: [] })
    expect(svc.supported).toBe(false)
    expect(relay.of('live.list').length).toBe(n)
  })

  it('texto com ? % & # + acentos e emoji vai e volta sem codificação (send → host → rec)', async () => {
    const host = relay.addHost(HOST, 'PC de casa', sk, { replyMs: 5 })
    const chatId = host.createChat({ title: 'A' })
    await host.announce(true)
    await connect()
    await until(() => svc.list.has(chatId), 1000, 'lista')
    svc.open(chatId)
    await until(() => svc.history(chatId)?.phase === 'ready', 3000, 'histórico')
    const text = 'E o dia 3? 100% & #lisboa a+b=c %3F ação 🇵🇹'
    await rc.send(chatId, `${chatId}-main`, text, [], [])
    expect(host.received.find((r) => r.kind === 'send')!.payload.text).toBe(text)
    await until(
      () =>
        (svc.history(chatId)?.loaded?.messages.get(`${chatId}-main`) ?? []).some(
          (m) => m.message.content === `ok: ${text}`
        ),
      2000,
      'eco exato'
    )
    const user = svc
      .history(chatId)!
      .loaded!.messages.get(`${chatId}-main`)!
      .find((m) => m.message.role === 'user')!
    expect(user.message.content).toBe(text)
  })

  it('welcome com o cofre fechado: os anúncios não decifram; ao abrir o cofre, live.list de novo', async () => {
    const host = relay.addHost(HOST, 'PC de casa', sk)
    const chatId = host.createChat({ title: 'A' })
    await host.announce(true)
    let unlocked = false
    const locked = new LiveService({
      ws: { request: relay.request },
      remote: rc,
      keys: () => (unlocked ? { userId: USER, sk } : null),
      deviceId: () => 'phone'
    })
    locked.onConnection(true)
    locked.onWelcome({ caps: ['live_chats'] })
    await new Promise((r) => setTimeout(r, 20))
    expect(locked.list.has(chatId)).toBe(false)
    const before = relay.of('live.list').length
    unlocked = true
    locked.relist()
    await until(() => locked.list.has(chatId), 1000, 'lista depois de abrir o cofre')
    expect(relay.of('live.list').length).toBe(before + 1)
  })

  it('no máximo 3 comandos de leitura/transferência em voo (§23.5)', async () => {
    let inFlight = 0
    let peak = 0
    const slow = new RemoteController({
      ws: {
        request: async (t) => {
          if (t !== 'remote.send') return {}
          inFlight++
          peak = Math.max(peak, inFlight)
          return { status: 'delivered' }
        }
      },
      keys: () => ({ userId: USER, sk }),
      deviceId: () => 'phone',
      chatState: () => null,
      post: async () => ({}),
      assistantIds: () => [],
      loadMessage: () => null,
      timing: { commandMs: 60, fsMs: 60, resyncGapMs: 0 },
      live: () => ({ entry: () => ({ hostName: 'PC', online: true }), onStream: () => undefined })
    })
    slow.onWelcome({})
    const all = Array.from({ length: 7 }, () =>
      slow
        .liveCommand('c1', 'history.list', { chatId: 'c1', type: 'chat', after: null })
        .catch((e: unknown) => {
          inFlight--
          return e
        })
    )
    await Promise.all(all)
    expect(peak).toBe(3)
  })

  it('toque numa notificação ao vivo: abre se está na lista, senão o texto de indisponível', async () => {
    const host = relay.addHost(HOST, 'PC de casa', sk)
    const chatId = host.createChat({ title: 'A' })
    await host.announce(true)
    await connect()
    await until(() => svc.list.has(chatId), 1000, 'lista')
    expect(
      await resolvePushOpen({ chatId, live: true, hostName: 'PC de casa' }, svc, () => false)
    ).toEqual({ kind: 'live', chatId })
    expect(
      await resolvePushOpen(
        { chatId: 'outro', live: true, hostName: 'PC de casa' },
        svc,
        () => false,
        30
      )
    ).toEqual({
      kind: 'unavailable',
      text: unavailableText('PC de casa')
    })
    expect(
      await resolvePushOpen(
        { chatId: 'comum', live: false, hostName: null },
        svc,
        (id) => id === 'comum'
      )
    ).toEqual({ kind: 'chat', chatId: 'comum' })
  })
})
