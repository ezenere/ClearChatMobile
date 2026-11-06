// Ligações React das notificações: preferências e estado do registro do token.
import { useSyncExternalStore } from 'react'
import type { PushPrefs } from './model'
import { pushPrefs, registrar } from './native'
import type { PushStatus } from './registration'

export function usePushPrefs(): PushPrefs {
  return useSyncExternalStore(pushPrefs.subscribe, pushPrefs.get)
}

export function usePushStatus(): PushStatus {
  return useSyncExternalStore(registrar.subscribe, registrar.getStatus)
}
