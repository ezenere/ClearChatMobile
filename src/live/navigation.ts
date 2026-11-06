// Toque numa notificação (§22.7): chat comum → a conversa; chat só ao vivo → o visualizador, se o
// chat estiver na lista ao vivo (espera um pouco a lista chegar depois de abrir o app a frio);
// senão "Este chat só ao vivo não está disponível agora — <host> não está conectado". Sem React.
import type { LiveService } from './service'

export type PushOpen =
  | { kind: 'chat'; chatId: string }
  | { kind: 'live'; chatId: string }
  | { kind: 'unavailable'; text: string }

export function unavailableText(hostName: string | null): string {
  return `Este chat só ao vivo não está disponível agora — ${hostName || 'o computador'} não está conectado.`
}

export function resolvePushOpen(
  t: { chatId: string; live: boolean; hostName: string | null },
  live: Pick<LiveService, 'subscribe'> & { list: { has(id: string): boolean } },
  hasLocalChat: (id: string) => boolean,
  waitMs = 6000
): Promise<PushOpen> {
  if (!t.live && hasLocalChat(t.chatId)) return Promise.resolve({ kind: 'chat', chatId: t.chatId })
  if (live.list.has(t.chatId)) return Promise.resolve({ kind: 'live', chatId: t.chatId })
  return new Promise((resolve) => {
    let done = false
    const finish = (r: PushOpen) => {
      if (done) return
      done = true
      off()
      clearTimeout(timer)
      resolve(r)
    }
    const off = live.subscribe(() => {
      if (live.list.has(t.chatId)) finish({ kind: 'live', chatId: t.chatId })
    })
    const timer = setTimeout(
      () =>
        finish(
          t.live
            ? { kind: 'unavailable', text: unavailableText(t.hostName) }
            : { kind: 'chat', chatId: t.chatId }
        ),
      waitMs
    )
  })
}
