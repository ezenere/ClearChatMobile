// Controle remoto (fase 3) contra o servidor de sync REAL local com um host falso (fakeHost.ts, um
// "desktop" no WebSocket que executa turnos determinísticos): o "celular" (AccountService +
// SyncEngine + RemoteController reais) se inscreve no stream, recebe snapshot e deltas, manda TODOS
// os kinds do §8.6 (send/force/fila/parar/aprovação por item/questionário/retry/versões/editar/
// apagar/compactar/memória/subagentes/smart_override/fs.*), sobe anexos antes do envio (§14), fixa o
// host e vê a queda do host (host_dropped → host_offline).
import { afterAll, describe, expect, it } from 'vitest'
import { AccountService } from '../../src/account/service'
import { MemoryKeyValueStore, MemorySecretStore } from '../../src/account/storage'
import { AttachmentStore, type AttachmentFs } from '../../src/data/attachments'
import { bindAccount } from '../../src/data/binding'
import { SyncEngine } from '../../src/data/engine'
import { LocalStore } from '../../src/data/store'
import { buildSessionView, mainSession } from '../../src/chat/viewModel'
import { bindRemote } from '../../src/remote/binding'
import { RemoteController } from '../../src/remote/controller'
import { fetchRange } from '../../src/remote/files'
import { prepareAttachment, uploadAttachments, type UploadDeps } from '../../src/remote/upload'
import { contentText } from '../../src/vendor/shared/attachments'
import { fromUtf8, sha256, hex } from '../../src/crypto'
import { openNodeSql } from '../nodeSql'
import {
  codeFor,
  enabled,
  logMark,
  randomEmail,
  signupWeb,
  sleep,
  URL_,
  waitFor
} from './realServer'
import { loginDesktop, setupKeysWithDek, whiteboardPng } from './seed'
import { EDIT_NEEDS_UPDATE, FakeHost, HOST_FILES } from './fakeHost'

const PASSWORD = 'senha de integração do controle remoto'
const CHAT = 'chat-remoto'
const cleanup: (() => void)[] = []
afterAll(() => {
  for (const f of cleanup) f()
})

class MemoryFs implements AttachmentFs {
  files = new Map<string, Uint8Array>()
  exists = (f: string) => this.files.has(f)
  uri = (f: string) => `mem://${f}`
  write = (f: string, d: Uint8Array) => void this.files.set(f, d)
  clear = () => this.files.clear()
}

describe.skipIf(!enabled)('controle remoto contra o servidor real (host falso)', () => {
  it('stream ao vivo + todos os comandos do §8.6 + anexos + fixar + queda do host', async () => {
    const email = randomEmail('remote')
    const web = await signupWeb(email)
    const { dek } = await setupKeysWithDek(web, PASSWORD)
    const desk = await loginDesktop(email, web.userId, dek)
    const host = new FakeHost(desk, CHAT)
    await host.seed()
    host.start()
    cleanup.push(() => host.stop())

    // ---- celular ----
    const account = new AccountService({
      secrets: new MemorySecretStore(),
      kv: new MemoryKeyValueStore(),
      device: { defaultName: 'Pixel (remoto)', platform: 'android', appVersion: '0.1.0' },
      envUrl: URL_,
      wsTiming: { backoffBaseMs: 100, backoffMaxMs: 1000 }
    })
    cleanup.push(() => account.setForeground(false))
    await account.init()
    const n0 = logMark()
    await account.requestCode(email)
    await account.verifyCode(await codeFor(email, n0), 'Pixel (remoto)')
    const store = new LocalStore(openNodeSql())
    const keys = () => {
      const sk = account.subkeys
      const userId = account.accountUserId
      return sk && userId ? { userId, sk } : null
    }
    const engine = new SyncEngine({ store, http: account.http, keys })
    const fs = new MemoryFs()
    const attachments = new AttachmentStore({ fs, keys, fetchBlob: (id) => engine.fetchBlob(id) })
    bindAccount(account, engine, attachments)
    const remote = new RemoteController({
      ws: { request: (t, f, ms) => account.wsRequest(t, f, ms) },
      keys,
      deviceId: () => account.getState().device?.id ?? null,
      chatState: (id) => store.chatState(id),
      post: (path, json) => account.http.post(path, json),
      assistantIds: (id) => store.assistantIds(id),
      loadMessage: (id) => store.message(id)
    })
    bindRemote(account, engine, remote)
    const notices: string[] = []
    remote.onNotice((n) => notices.push(n.text))
    await account.unlock(PASSWORD, { remember: true })
    await waitFor(
      () => engine.getStatus().phase === 'idle' && !engine.getStatus().initial,
      'pull',
      60_000
    )
    await waitFor(() => remote.mode(CHAT) === 'remote', 'host online (modo remoto)', 20_000)

    const texts = () => {
      const l = store.loadChat(CHAT)!
      const main = mainSession(l)!
      return buildSessionView(l, main, null, true).path.map((m) =>
        contentText(m.message.content as never)
      )
    }
    const lastText = () => texts().at(-1)
    const drafts: string[] = []
    remote.subscribe(() => {
      const d = remote.view(CHAT)?.drafts[`${CHAT}-main`]?.content
      if (d && drafts.at(-1) !== d) drafts.push(d)
    })

    // ---- inscrição → snapshot ----
    remote.setActive(CHAT)
    await waitFor(() => remote.view(CHAT)?.complete, 'snapshot do host')
    expect(remote.view(CHAT)!.skills.map((s) => s.name)).toEqual(['deploy'])
    const main = `${CHAT}-main`

    // ---- send (turno com deltas) ----
    const r1 = await remote.send(CHAT, main, 'olá do celular', [], ['deploy'])
    expect(r1).toMatchObject({ status: 'accepted', queued: false })
    await waitFor(() => lastText() === 'ok: olá do celular', 'resposta persistida')
    expect(drafts.some((d) => d.startsWith('ok:') && d.length < 'ok: olá do celular'.length)).toBe(
      true
    )
    await waitFor(() => !remote.view(CHAT)?.drafts[main], 'draft trocado pela mensagem')
    expect(host.received.find((c) => c.kind === 'send')?.payload.skills).toEqual(['deploy'])

    // ---- fila: remover, forçar ----
    await remote.send(CHAT, main, '/slow longo', [], [])
    await waitFor(() => remote.view(CHAT)?.status[main] === 'running', 'rodando')
    const q1 = await remote.send(CHAT, main, 'vai sair da fila', [], [])
    expect(q1.queued).toBe(true)
    await waitFor(() => remote.view(CHAT)?.queues[main]?.length === 1, 'fila ao vivo')
    await remote.queueRemove(CHAT, main, remote.view(CHAT)!.queues[main][0].id)
    await waitFor(() => !remote.view(CHAT)?.queues[main], 'removido da fila')
    await remote.send(CHAT, main, 'forçada pela fila', [], [])
    await waitFor(() => remote.view(CHAT)?.queues[main]?.length === 1, 'fila de novo')
    await remote.queueForce(CHAT, main, remote.view(CHAT)!.queues[main][0].id)
    await waitFor(() => lastText() === 'ok: forçada pela fila', 'forçada rodou', 30_000)
    await host.idle()

    // ---- force (send já com ⚡) ----
    await remote.send(CHAT, main, '/slow de novo', [], [])
    await waitFor(() => remote.view(CHAT)?.status[main] === 'running', 'rodando 2')
    await remote.send(CHAT, main, 'urgente', [], [], true)
    await waitFor(() => lastText() === 'ok: urgente', 'force rodou', 30_000)
    await host.idle()

    // ---- parar ----
    await remote.send(CHAT, main, '/slow para parar', [], [])
    await waitFor(() => (remote.view(CHAT)?.drafts[main]?.content.length ?? 0) > 20, 'stream longo')
    await remote.stop(CHAT, main)
    await waitFor(
      () => store.loadChat(CHAT)!.sessions.find((s) => s.id === main)?.status === 'interrupted',
      'interrompida'
    )
    await host.idle()

    // ---- aprovação por item (permitir) ----
    await remote.send(CHAT, main, '/tool', [], [])
    await waitFor(() => remote.view(CHAT)?.approvals.length === 1, 'aprovação ao vivo')
    const ap = remote.view(CHAT)!.approvals[0]
    expect(ap.check?.items.map((i) => i.verdict)).toEqual(['allow', 'ask'])
    expect(remote.view(CHAT)!.status[main]).toBe('awaiting_approval')
    await remote.approve(CHAT, ap.id, 'allow', [{ index: 1, allow: true }])
    await waitFor(() => lastText() === 'Comando executado.', 'tool aprovada')
    expect(host.received.filter((c) => c.kind === 'approval').at(-1)!.payload.items).toEqual([
      { index: 1, allow: true }
    ])
    expect(remote.view(CHAT)!.approvals).toHaveLength(0)
    await host.idle()

    // ---- aprovação: negar ----
    await remote.send(CHAT, main, '/tool', [], [])
    await waitFor(() => remote.view(CHAT)?.approvals.length === 1, 'aprovação 2')
    await remote.approve(CHAT, remote.view(CHAT)!.approvals[0].id, 'deny', [
      { index: 1, allow: false }
    ])
    await waitFor(() => lastText() === 'Tudo bem, não rodei.', 'tool negada')
    await host.idle()

    // ---- questionário: responder e cancelar ----
    await remote.send(CHAT, main, '/ask', [], [])
    await waitFor(() => remote.view(CHAT)?.questions.length === 1, 'questionário')
    await remote.answer(CHAT, remote.view(CHAT)!.questions[0].id, [{ selected: [1] }])
    await waitFor(() => lastText() === 'Escolhido: 1', 'respondido')
    await host.idle()
    await remote.send(CHAT, main, '/ask', [], [])
    await waitFor(() => remote.view(CHAT)?.questions.length === 1, 'questionário 2')
    await remote.cancelQuestion(CHAT, remote.view(CHAT)!.questions[0].id)
    await waitFor(() => lastText() === 'Sem resposta.', 'cancelado')
    await host.idle()

    // ---- falha de conexão: tentar de novo e cancelar ----
    await remote.send(CHAT, main, '/retry', [], [])
    await waitFor(() => remote.view(CHAT)?.retries.length === 1, 'retry')
    expect(remote.view(CHAT)!.drafts[main]).toBeUndefined()
    await remote.retry(CHAT, remote.view(CHAT)!.retries[0].id, 'retry')
    await waitFor(() => lastText() === 'Deu certo na segunda tentativa.', 'retry ok')
    await host.idle()
    await remote.send(CHAT, main, '/retry', [], [])
    await waitFor(() => remote.view(CHAT)?.retries.length === 1, 'retry 2')
    await remote.retry(CHAT, remote.view(CHAT)!.retries[0].id, 'cancel')
    await waitFor(() => remote.view(CHAT)?.retries.length === 0, 'retry cancelado')
    await host.idle()

    // ---- versões: regenerar, trocar, editar como nova versão ----
    const lastAssistant = host.allMessages.filter((m) => m.message.role === 'assistant').at(-1)!
    await remote.regenerate(CHAT, main, lastAssistant.id)
    await waitFor(() => /^nova versão para:/.test(lastText() ?? ''), 'regenerado')
    await host.idle()
    await remote.selectBranch(CHAT, lastAssistant.id)
    const pathIds = () => {
      const l = store.loadChat(CHAT)!
      return buildSessionView(l, mainSession(l)!, null, true).path.map((m) => m.id)
    }
    await waitFor(() => pathIds().includes(lastAssistant.id), 'versão trocada no host')
    expect(store.loadChat(CHAT)!.sessions.find((s) => s.id === main)!.branchSel).toMatchObject({
      [lastAssistant.parentId!]: lastAssistant.id
    })
    const first = host.allMessages[0]
    await remote.editBranch(CHAT, first.id, { role: 'user', content: 'Olá v2' })
    await waitFor(
      () => texts()[0] === 'Olá v2' && lastText() === 'ok: Olá v2',
      'nova versão da mensagem'
    )
    await host.idle()
    // plain `regenerate` vira branch.regenerate no fio
    await remote.command(CHAT, 'regenerate', { sessionId: main })
    expect(host.received.at(-1)!.kind).toBe('branch.regenerate')
    await host.idle()

    // ---- editar no lugar (recusado na digitada; aceito no assistente) e apagar ----
    const userMsg = host.allMessages.find((m) => m.message.role === 'user' && !m.meta.kind)!
    await expect(
      remote.editMessage(CHAT, userMsg.id, { role: 'user', content: 'x' })
    ).rejects.toThrow(/Editar como nova versão/)
    expect(EDIT_NEEDS_UPDATE).toMatch(/^Editar uma mensagem sua/)
    const editTarget = host.allMessages.filter((m) => m.message.role === 'assistant').at(-1)!
    await remote.editMessage(CHAT, editTarget.id, {
      role: 'assistant',
      content: 'texto editado no celular'
    })
    await waitFor(
      () => store.message(editTarget.id)?.message.content === 'texto editado no celular',
      'edição no lugar'
    )
    await remote.deleteMessage(CHAT, editTarget.id)
    await waitFor(() => !store.message(editTarget.id), 'mensagem apagada')

    // ---- compactar, memória, subagentes, smart_override ----
    expect(await remote.compact(CHAT, main, { retry: false })).toMatchObject({
      status: 'accepted',
      queued: true
    })
    expect(await remote.extractMemory(CHAT, main)).toMatchObject({ status: 'accepted' })
    expect(await remote.stopSubagents(CHAT)).toMatchObject({ status: 'accepted' })
    expect(await remote.smartOverride(CHAT, editTarget.id)).toMatchObject({ status: 'accepted' })

    // ---- arquivos do host ----
    const root = await remote.fsList(CHAT, '')
    expect(root.ok && root.entries.map((e) => `${e.kind}:${e.name}`)).toEqual([
      'dir:src',
      'file:grande.txt',
      'file:README.md'
    ])
    const readme = await remote.fsRead(CHAT, '/home/host/projeto/README.md', 0, 512 * 1024)
    expect(readme.ok && fromUtf8(readme.data)).toBe(HOST_FILES['/home/host/projeto/README.md'])
    const big = await fetchRange(
      (o, l) => remote.fsRead(CHAT, '/home/host/projeto/grande.txt', o, l),
      {
        maxBytes: 10 * 1024 * 1024,
        chunkBytes: 64 * 1024
      }
    )
    expect(big.complete).toBe(true)
    expect(fromUtf8(big.bytes)).toBe(HOST_FILES['/home/host/projeto/grande.txt'])
    expect(await remote.fsRead(CHAT, '/etc/passwd', 0, 10)).toMatchObject({
      ok: false,
      reason: 'denied'
    })
    expect(await remote.fsList(CHAT, '/home/host/projeto/src')).toMatchObject({
      ok: true,
      entries: [{ name: 'main.ts' }]
    })

    // ---- anexos: sobe antes de enviar; sem blob → attachment_missing ----
    const deps: UploadDeps = {
      keys,
      put: (f, d) => void attachments.put(f, d),
      post: (p, j) => account.http.post(p, j),
      putBlob: async (id, ct, sha) => {
        await account.http.req('PUT', `/api/v1/blobs/${id}`, {
          body: ct,
          headers: { 'Content-Type': 'application/octet-stream', 'X-Content-SHA256': sha }
        })
      }
    }
    const png = whiteboardPng(64, 48)
    const prep = await prepareAttachment(deps, png, 'quadro.png', 'image/png')
    await uploadAttachments(deps, [prep])
    await remote.send(CHAT, main, 'com imagem', [prep.info], [])
    await waitFor(() => lastText() === 'ok: com imagem', 'mensagem com anexo')
    const withImg = host.allMessages.find(
      (m) => Array.isArray(m.message.content) && m.blobs.length
    )!
    expect(store.recordBlobs('message', withImg.id)).toEqual(withImg.blobs)
    expect(hex(await sha256(fs.files.get(prep.info.file)!))).toBe(prep.info.sha256)
    await host.idle()
    const fake = await prepareAttachment(
      deps,
      new Uint8Array([1, 2, 3, 4]),
      'nunca-subiu.png',
      'image/png'
    )
    await expect(remote.send(CHAT, main, 'sem blob', [fake.info], [])).rejects.toThrow(
      /não conseguiu baixar um dos anexos/
    )

    // ---- fixar host ----
    await remote.setPinned(CHAT, true)
    await waitFor(() => store.chatState(CHAT)?.pinned === true, 'fixado')
    await remote.setPinned(CHAT, false)
    await waitFor(() => store.chatState(CHAT)?.pinned === false, 'desafixado')

    // ---- queda do host: host_dropped depois da tolerância; comandos → host offline ----
    host.stop()
    await waitFor(
      () => notices.some((n) => /O dispositivo remoto \(PC de casa\) caiu/.test(n)),
      'host_dropped',
      25_000
    )
    expect(remote.mode(CHAT)).toBe('host-offline')
    await expect(remote.stop(CHAT, main)).rejects.toThrow(/está offline/)
    expect(await remote.fsList(CHAT, '')).toMatchObject({ ok: false, reason: 'host-offline' })
    host.start()
    await waitFor(() => remote.mode(CHAT) === 'remote', 'host voltou', 20_000)
    await waitFor(() => notices.some((n) => /voltou a ficar online/.test(n)), 'aviso de volta')
    await sleep(200)
    // todos os kinds do §8.6 chegaram ao host (regenerate vai como branch.regenerate)
    const kinds = new Set(host.received.map((c) => c.kind))
    for (const k of [
      'send',
      'force',
      'queue.force',
      'queue.remove',
      'stop',
      'stop_subagents',
      'approval',
      'smart_override',
      'question',
      'retry',
      'message.edit',
      'message.delete',
      'compact',
      'memory.extract',
      'branch.edit',
      'branch.regenerate',
      'branch.select',
      'fs.list',
      'fs.read'
    ])
      expect(kinds.has(k), k).toBe(true)
  })
})
