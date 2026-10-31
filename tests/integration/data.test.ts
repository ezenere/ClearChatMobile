// Dados (fase 2) contra o servidor de sync REAL local: um "desktop" (dispositivo can_host com a DEK)
// grava provedores, persona, chats com versões, tools, voz e anexos; o "celular" (AccountService +
// SyncEngine reais, SQLite do Node) puxa, decifra e monta as telas; depois o desktop renomeia e
// apaga e o celular recebe pelo WebSocket (`sync.changes`), sem pull manual; o celular renomeia
// (push LWW) e o desktop vê; sair apaga o cache.
import { afterAll, describe, expect, it } from 'vitest'
import { AccountService } from '../../src/account/service'
import { MemoryKeyValueStore, MemorySecretStore } from '../../src/account/storage'
import { AttachmentStore, type AttachmentFs } from '../../src/data/attachments'
import { bindAccount } from '../../src/data/binding'
import { SyncEngine } from '../../src/data/engine'
import { LocalStore } from '../../src/data/store'
import { buildSessionView, mainSession } from '../../src/chat/viewModel'
import { openRecord, hex, sha256 } from '../../src/crypto'
import { approvalOutcome } from '../../src/vendor/renderer/approvalOutcome'
import { openNodeSql } from '../nodeSql'
import {
  codeFor,
  enabled,
  logMark,
  randomEmail,
  rest,
  signupWeb,
  URL_,
  waitFor
} from './realServer'
import {
  deleteRecord,
  loginDesktop,
  renameChat,
  seedAccount,
  setupKeysWithDek,
  whiteboardPng
} from './seed'

const PASSWORD = 'senha de integração dos dados'
const services: AccountService[] = []
afterAll(() => {
  for (const s of services) s.setForeground(false)
})

class MemoryFs implements AttachmentFs {
  files = new Map<string, Uint8Array>()
  exists = (f: string) => this.files.has(f)
  uri = (f: string) => `mem://${f}`
  write = (f: string, d: Uint8Array) => void this.files.set(f, d)
  clear = () => this.files.clear()
}

describe.skipIf(!enabled)('dados contra o servidor real', () => {
  it('seed como desktop → pull no celular → ao vivo pelo WebSocket → escrita LWW → sair apaga', async () => {
    const email = randomEmail('data')
    const web = await signupWeb(email)
    const { dek } = await setupKeysWithDek(web, PASSWORD)
    const desk = await loginDesktop(email, web.userId, dek)
    const seeded = await seedAccount(desk)

    // ---- celular ----
    const account = new AccountService({
      secrets: new MemorySecretStore(),
      kv: new MemoryKeyValueStore(),
      device: { defaultName: 'Pixel (dados)', platform: 'android', appVersion: '0.1.0' },
      envUrl: URL_,
      wsTiming: { backoffBaseMs: 100, backoffMaxMs: 1000 }
    })
    services.push(account)
    await account.init()
    const n0 = logMark()
    await account.requestCode(email)
    await account.verifyCode(await codeFor(email, n0), 'Pixel (dados)')
    const store = new LocalStore(openNodeSql())
    const keys = () => {
      const sk = account.subkeys
      const userId = account.accountUserId
      return sk && userId ? { userId, sk } : null
    }
    const engine = new SyncEngine({ store, http: account.http, keys })
    const fs = new MemoryFs()
    const attachments = new AttachmentStore({ fs, keys, fetchBlob: (id) => engine.fetchBlob(id) })
    const unbind = bindAccount(account, engine, attachments)
    await account.unlock(PASSWORD, { remember: true })
    await waitFor(
      () => engine.getStatus().phase === 'idle' && !engine.getStatus().initial,
      'primeiro pull',
      60_000
    )
    await waitFor(() => engine.getStatus().live, 'WebSocket ao vivo')

    // ---- lista ----
    const list = store.listChats()
    expect(list.map((c) => c.title)).toEqual([
      'Refatorar o parser de SSE',
      'Roteiro de 3 dias em Lisboa',
      'Foto do quadro da reunião',
      'Chamada: planejar a semana',
      'Resumo do artigo sobre CRDTs'
    ])
    expect(store.cursor).toBeGreaterThanOrEqual(seeded.head)
    const lisboaItem = list.find((c) => c.id === 'chat-lisboa')!
    expect(lisboaItem.preview).toMatch(/^Feito: Dia 3 em Sintra/) // caminho ativo pelo branchSel
    expect(list.find((c) => c.id === 'chat-sse')!.presetId).toBe('preset-dev')
    expect(store.presets().get('preset-dev')?.icon).toBe('code')
    expect(store.listChats('cascais').map((c) => c.id)).toEqual(['chat-lisboa'])

    // ---- conversa longa com tools, subagente e aprovações ----
    const sse = store.loadChat('chat-sse')!
    expect(sse.sessions.map((s) => s.depth)).toEqual([0, 1])
    const main = mainSession(sse)!
    const v = buildSessionView(sse, main, null, true)
    expect(v.path).toHaveLength(66)
    const call = v.path[1]
    expect(call.message.role === 'assistant' && call.message.tool_calls?.length).toBe(3)
    expect(v.childByToolCall.get('call_sub1')?.title).toBe('Mapear usos do parser')
    expect(approvalOutcome(v.results.get('call_sh1')!.meta)?.kind).toBe('approved')
    expect(approvalOutcome(v.results.get('call_rm')!.meta)?.kind).toBe('denied')
    expect(
      v.rows.filter((r) => r.kind === 'message' && r.msg.message.role === 'tool')
    ).toHaveLength(0)

    // ---- versões: caminho ativo e troca só na tela ----
    const lis = store.loadChat('chat-lisboa')!
    const lv = buildSessionView(lis, mainSession(lis)!, null, true)
    expect(lv.path.map((m) => m.id)).toEqual([
      'chat-lisboa-m1',
      'chat-lisboa-m2',
      'chat-lisboa-m5',
      'chat-lisboa-m6'
    ])
    expect(lv.siblings.get('chat-lisboa-m5')).toMatchObject({ index: 1, count: 2 })
    expect(lv.siblings.get('chat-lisboa-m6')).toMatchObject({ index: 0, count: 2 })

    // ---- voz, compactação, erro, entre chats ----
    const voz = store.loadChat('chat-voz')!
    const vm = voz.messages.get(voz.chat.mainSessionId)!
    expect(vm[0].meta.kind).toBe('voice-call')
    expect(vm[1].meta.voice?.source).toBe('call')
    const crdt = buildSessionView(
      store.loadChat('chat-crdt')!,
      mainSession(store.loadChat('chat-crdt')!)!,
      null,
      true
    )
    expect(crdt.rows.some((r) => r.kind === 'divider')).toBe(true)
    const foto = store.loadChat('chat-foto')!
    const fm = foto.messages.get(foto.chat.mainSessionId)!
    expect(fm.map((m) => m.meta.kind ?? null)).toContain('inter-chat')
    expect(fm.map((m) => m.meta.kind ?? null)).toContain('error')

    // ---- anexo: blob → CCB1 → sha256 conferido ----
    expect(fm[0].message.role).toBe('user')
    const uri = await attachments.ensure(seeded.image.file)
    expect(uri).toBe(`mem://${seeded.image.file}`)
    expect(hex(await sha256(fs.files.get(seeded.image.file)!))).toBe(seeded.image.sha)
    expect(fs.files.get(seeded.image.file)!.length).toBe(whiteboardPng().length)
    await attachments.ensure(seeded.pdf.file)
    expect(fs.files.has(seeded.pdf.file)).toBe(true)

    // ---- ao vivo: o desktop renomeia e apaga; o celular recebe pelo WebSocket ----
    const pulls = () => engine.getStatus().lastSyncAt
    const before = pulls()
    await renameChat(
      desk,
      'chat-voz',
      seeded.chats.voz.mainSessionId,
      'Semana planejada',
      Date.now()
    )
    await waitFor(
      () => store.listChats().find((c) => c.id === 'chat-voz')?.title === 'Semana planejada',
      'rename ao vivo'
    )
    expect(store.listChats()[0].id).toBe('chat-voz') // updatedAt novo → topo
    await deleteRecord(desk, 'chat', 'chat-crdt', 'chat-crdt')
    await waitFor(() => !store.listChats().some((c) => c.id === 'chat-crdt'), 'exclusão ao vivo')
    expect(store.loadChat('chat-crdt')).toBeNull()
    expect(store.listChats('convergem')).toEqual([])
    expect(pulls()).toBe(before) // aplicado direto do sync.changes, sem outro pull completo

    // ---- escrita do celular (LWW por campo) ----
    await engine.renameChat('chat-lisboa', 'Lisboa sem pressa')
    const rec = (
      await rest(
        'POST',
        '/api/v1/records/fetch',
        { items: [{ type: 'chat', id: 'chat-lisboa' }] },
        desk.token
      )
    ).records[0]
    const plain = await openRecord(desk.sk.record, desk.userId, rec, rec.env)
    expect(plain.title).toBe('Lisboa sem pressa')
    expect((plain.config as Record<string, unknown>).enabledTools).toEqual([
      'shell',
      'read_file',
      'delegate_task',
      'ask_user'
    ])
    expect(rec.device_id).toBe(account.getState().device!.id)

    // ---- sair apaga o cache e os anexos ----
    await account.logout()
    await waitFor(() => store.stats().records === 0, 'cache apagado')
    expect(store.listChats()).toEqual([])
    expect(fs.files.size).toBe(0)
    unbind()
  })
})
