// Leitura ao vivo da resposta falada (= `lib/voice/voiceFollow.ts` do renderer do desktop): as frases
// da resposta atual que JÁ tocaram e a que está tocando, com quantos caracteres dela já foram ouvidos
// (`heardChars` estimado pela posição do player — palavra por palavra). O chat esmaece o resto da
// mensagem (`liveDimFrom` em `@shared/heardText` + o `dimFrom` do Markdown). Alimentado pelo
// `VoiceCallController`; zera a cada resposta nova e no fim da chamada. Sem React Native.

export interface VoiceFollowState {
  /** Sessão da chamada (só as mensagens dela esmaecem). */
  sessionId: string | null
  /** Frases da resposta atual que já terminaram de tocar (texto original, na ordem). */
  heard: string[]
  /** A frase tocando agora e quantos caracteres dela já foram ouvidos. */
  current: { id: string; text: string; chars: number } | null
}

const EMPTY: VoiceFollowState = { sessionId: null, heard: [], current: null }

export class VoiceFollow {
  private state: VoiceFollowState = EMPTY
  private listeners = new Set<() => void>()

  get = (): VoiceFollowState => this.state
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  set(p: Partial<VoiceFollowState> | ((s: VoiceFollowState) => Partial<VoiceFollowState>)): void {
    const patch = typeof p === 'function' ? p(this.state) : p
    this.state = { ...this.state, ...patch }
    for (const fn of [...this.listeners]) fn()
  }

  /** Resposta nova (ou fim da chamada): nada ouvido ainda. */
  reset(sessionId: string | null = this.state.sessionId): void {
    if (this.state.sessionId === sessionId && !this.state.heard.length && !this.state.current)
      return
    this.set({ sessionId, heard: [], current: null })
  }
}
