// AbortSignal.timeout / AbortSignal.any — usados pelo cliente HTTP do sync. O RN 0.88 já traz os dois;
// isto só cobre runtimes mais antigos.
type AbortSignalStatics = typeof AbortSignal & {
  timeout?: (ms: number) => AbortSignal
  any?: (signals: AbortSignal[]) => AbortSignal
}

function timeoutError(): Error {
  const e = new Error('signal timed out')
  e.name = 'TimeoutError'
  return e
}

export function installAbortSignal(): string[] {
  const done: string[] = []
  const S = AbortSignal as AbortSignalStatics
  if (typeof S.timeout !== 'function') {
    S.timeout = (ms: number) => {
      const c = new AbortController()
      setTimeout(() => c.abort(timeoutError()), ms)
      return c.signal
    }
    done.push('AbortSignal.timeout')
  }
  if (typeof S.any !== 'function') {
    S.any = (signals: AbortSignal[]) => {
      const c = new AbortController()
      for (const s of signals) {
        if (s.aborted) {
          c.abort(s.reason)
          return c.signal
        }
      }
      const onAbort = (s: AbortSignal) => () => {
        if (!c.signal.aborted) c.abort(s.reason)
      }
      for (const s of signals) s.addEventListener('abort', onAbort(s), { once: true })
      return c.signal
    }
    done.push('AbortSignal.any')
  }
  return done
}
