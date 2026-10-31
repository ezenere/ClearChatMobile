// Ligações React da conta: estado observável e um helper de ação com "carregando" + erro em pt-BR.
import { useCallback, useState, useSyncExternalStore } from 'react'
import { CaptchaCancelled } from './captcha'
import { describeError } from './errors'
import { account } from './native'
import type { SessionState } from './session'

export function useSession(): SessionState {
  return useSyncExternalStore(account.subscribe, account.getState)
}

export function useAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = useCallback(async (fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      return true
    } catch (e) {
      if (!(e instanceof CaptchaCancelled)) setError(describeError(e))
      return false
    } finally {
      setBusy(false)
    }
  }, [])
  return { busy, error, setError, run }
}

/** Host legível de uma <base> (ex.: "clear.ezenere.com", "192.168.0.10:8080/clearchat"). */
export function hostOf(base: string): string {
  return base.replace(/^https?:\/\//, '')
}
