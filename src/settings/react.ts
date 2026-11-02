// Ligações React das Configurações: uma versão que sobe quando provedores, personas, settings ou
// memórias mudam (pull, `sync.changes` ao vivo, gravação local) — as telas releem o cache.
import { useEffect, useState } from 'react'
import { engine } from '@/data/native'

export function useSettingsVersion(): number {
  const [v, setV] = useState(0)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = engine.subscribe((e) => {
      if (e.kind !== 'data') return
      // mensagens de um chat (turno rodando) não mexem nas Configurações
      if (!e.settings && !e.all && e.chats.length) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => setV((x) => x + 1), 60)
    })
    return () => {
      off()
      if (timer) clearTimeout(timer)
    }
  }, [])
  return v
}

export { settings } from './native'

/**
 * Leitura do cache amarrada à versão: o React Compiler memoiza chamadas a objetos externos pelas
 * dependências visíveis — passar a versão como argumento faz a leitura refazer quando ela sobe.
 */
export function readAt<T>(version: number, read: () => T): T {
  void version
  return read()
}
