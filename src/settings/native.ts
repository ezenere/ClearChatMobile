// Instância das Configurações no aparelho (cache, outbox LWW e índice da memória do host) e a
// retomada da outbox LWW: ao abrir o cofre e quando o WebSocket volta, o que ficou pendente
// (memórias, provedores, personas, settings gravados offline ou antes de fechar o app) sobe.
import { account } from '@/account/native'
import { engine, onAfterMerge, store } from '@/data/native'
import { hostStack } from '@/host/native'
import { invalidateModels } from '@/agent/providers'
import { SettingsService } from './service'

export const settings = new SettingsService({
  store,
  writer: hostStack.memory.writer,
  memory: hostStack.memory.index,
  notify: (list) => engine.notifySettings(list),
  invalidateModels
})

let started = false

/** Depois do `startHost`. */
export function startSettings(): void {
  if (started) return
  started = true
  const writer = hostStack.memory.writer
  let unlocked = false
  const sync = () => {
    const now = account.getState().phase === 'unlocked'
    if (now && !unlocked) writer.resume()
    unlocked = now
  }
  account.subscribe(sync)
  onAfterMerge(() => writer.resume())
  account.addRealtimeListener({ onState: (online) => online && unlocked && writer.resume() })
  sync()
}
