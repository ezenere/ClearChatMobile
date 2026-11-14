// Arquivo selecionado de cada chat neste aparelho (protocolo 1.13.0): o arquivo aberto por último
// no visualizador do host (`file/[chat]`) enquanto a conversa está aberta — o celular não tem o
// painel lateral do desktop, então "o arquivo aberto no painel" vira "o último aberto no
// visualizador". O composer mostra o chip `[arquivo ×]` e manda `meta.openFile` em cada mensagem
// enquanto ele estiver ali: × para de mencionar até abrir um arquivo de novo (= desktop); sair da
// conversa esquece a seleção (o "painel" fecha junto). Só em memória, nunca gravado.
import { useSyncExternalStore } from 'react'
import type { OpenFileSelection } from './chatPaths'

const selected = new Map<string, OpenFileSelection>()
const listeners = new Set<() => void>()
let version = 0

const changed = (): void => {
  version++
  for (const l of listeners) l()
}

export const openFileStore = {
  get(chatId: string): OpenFileSelection | null {
    return selected.get(chatId) ?? null
  },
  /** Abriu um arquivo no visualizador do host deste chat (volta a mencionar, mesmo depois do ×). */
  open(chatId: string, sel: OpenFileSelection): void {
    const cur = selected.get(chatId)
    if (cur && cur.path === sel.path && (cur.root ?? null) === (sel.root ?? null)) return
    selected.set(chatId, { path: sel.path, ...(sel.root ? { root: sel.root } : {}) })
    changed()
  },
  /** × do chip, ou saiu da conversa. */
  clear(chatId: string): void {
    if (selected.delete(chatId)) changed()
  },
  subscribe(fn: () => void): () => void {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
  getVersion: (): number => version
}

/** A seleção do chat (re-renderiza quando muda). */
export function useOpenFileSelection(chatId: string): OpenFileSelection | null {
  // o snapshot é o próprio objeto (mesma referência até mudar)
  return useSyncExternalStore(openFileStore.subscribe, () => openFileStore.get(chatId))
}
