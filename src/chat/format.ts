// Formatos do rodapé das mensagens — mesmos do desktop (ClearChatDesktop/src/renderer/src/lib/format.ts,
// que não dá para vendorar inteiro porque importa `clsx`).

export function formatTokens(n: number | undefined): string {
  if (n == null) return '–'
  if (n < 1000) return String(n)
  if (n < 10_000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
  if (n < 1_000_000) return Math.round(n / 1000) + 'k'
  return (n / 1_000_000).toFixed(2).replace(/\.?0+$/, '') + 'M'
}

export function formatCost(cost: number | undefined): string | null {
  if (cost == null) return null
  if (cost === 0) return '$0'
  if (cost < 0.0001) return '<$0.0001'
  if (cost < 0.01) return '$' + cost.toFixed(4)
  return '$' + cost.toFixed(3)
}

export function formatDuration(ms: number | undefined): string | null {
  if (ms == null) return null
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  return `${Math.floor(s / 60)}m${Math.round(s % 60)}s`
}

/** "agora", "5 min", "3 h", "2 d", "12 de out." (lista de chats). */
export function relativeTime(ts: number, now = Date.now()): string {
  const min = Math.floor((now - ts) / 60000)
  if (min < 1) return 'agora'
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} h`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d} d`
  const dt = new Date(ts)
  const months = [
    'jan.',
    'fev.',
    'mar.',
    'abr.',
    'mai.',
    'jun.',
    'jul.',
    'ago.',
    'set.',
    'out.',
    'nov.',
    'dez.'
  ]
  const sameYear = dt.getFullYear() === new Date(now).getFullYear()
  return `${dt.getDate()} de ${months[dt.getMonth()]}${sameYear ? '' : ` de ${dt.getFullYear()}`}`
}
