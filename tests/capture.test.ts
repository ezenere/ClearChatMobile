// Fase 6 — Smart-Approve: coleta automática de contexto (resumidor) nos chats executados no
// celular. O `ContextCaptureService` do desktop é vendorado; o runner do celular o liga como o
// desktop: mensagem digitada → resumo em segundo plano (debounce) → descrição gravada na config do
// chat (sincroniza) → o juiz espera o resumo e recebe a descrição; Parar cancela o resumo.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_CHAT_CONFIG } from '../src/vendor/shared/defaults'
import { makeHarness, until, type Harness } from './hostHarness'

let h: Harness
beforeEach(async () => {
  h = await makeHarness()
})
afterEach(async () => h.close())

const smartChat = (capture: boolean) => {
  const { chat, session } = h.stack.repo.createChat({
    config: {
      ...DEFAULT_CHAT_CONFIG(''),
      providerId: h.providerId,
      model: 'fake/agent',
      enabledTools: ['web_search'],
      approvalModes: { search: 'smart' },
      smartApprove: {
        ...(DEFAULT_CHAT_CONFIG('').smartApprove ?? {}),
        providerId: h.providerId,
        model: 'fake/agent',
        ...(capture
          ? {
              capture: {
                enabled: true,
                providerId: h.providerId,
                model: 'fake/agent',
                maxTokens: null,
                lookback: 4
              }
            }
          : {})
      } as never
    }
  })
  return { chatId: chat.id, sid: session.id }
}

describe('coleta automática de contexto no celular', () => {
  it('mensagem digitada → descrição capturada na config do chat; o juiz a recebe', async () => {
    const { chatId, sid } = smartChat(true)
    await h.stack.host.local(chatId, 'send', {
      sessionId: sid,
      text: 'pode pesquisar sobre gatos persas'
    })
    await until(() => !h.stack.runner.isRunning(sid), 10_000, 'turno')
    await until(
      () => !!h.stack.repo.chat(chatId)?.config.capturedContext,
      8000,
      'descrição capturada'
    )
    const cap = JSON.stringify(h.stack.repo.chat(chatId)!.config.capturedContext)
    expect(cap).toContain('pode pesquisar sobre gatos persas')
    // a config sobe para o servidor (sincroniza como o resto da config)
    await h.stack.writer.flush(chatId)
    // o juiz (Smart-Approve) recebe a descrição: a busca vai ao juiz com o contexto capturado
    await h.stack.host.local(chatId, 'send', { sessionId: sid, text: '/search gatos persas' })
    await until(
      () =>
        h.llm.requests.some((r) => {
          const b = JSON.stringify(r.body)
          return (
            b.includes('You are Smart-Approve') &&
            /Contexto capturado da conversa[^"]*\\"\\"\\"\\n- Usuário disse: \[1\] pode pesquisar sobre gatos persas/.test(
              b
            )
          )
        }),
      15_000,
      'juiz com a descrição'
    )
    await h.stack.runner.stop(sid)
  }, 40_000)

  it('sem o resumidor configurado nada é chamado; Parar cancela o resumo agendado', async () => {
    const off = smartChat(false)
    await h.stack.host.local(off.chatId, 'send', { sessionId: off.sid, text: 'oi' })
    await until(() => !h.stack.runner.isRunning(off.sid), 10_000, 'turno')
    expect(h.stack.runner.capture.busy(off.sid)).toBe(false)
    const on = smartChat(true)
    await h.stack.host.local(on.chatId, 'send', {
      sessionId: on.sid,
      text: '/slow e pode apagar o cache'
    })
    expect(h.stack.runner.capture.busy(on.sid)).toBe(true)
    await h.stack.runner.stop(on.sid)
    expect(h.stack.runner.capture.busy(on.sid)).toBe(false)
    await new Promise((r) => setTimeout(r, 1800))
    expect(
      h.llm.requests.some((r) => JSON.stringify(r.body).includes('You maintain a short'))
    ).toBe(false)
  }, 30_000)
})
