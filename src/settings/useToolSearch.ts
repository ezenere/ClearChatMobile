// Busca nativa de tools (1.12.0) nas telas: uma versão que sobe quando este aparelho lembra uma
// falha da busca nativa (`toolSearchCaps`, §4.4) — as telas de tools recalculam o modo efetivo
// (`toolSearchViewOf`) na hora, como o desktop faz quando o chat muda.
import { useEffect, useState } from 'react'
import { hostStack } from '@/host/native'

export function useToolSearchCapsVersion(): number {
  const [v, setV] = useState(0)
  useEffect(() => hostStack.toolSearchCaps.subscribe(() => setV((x) => x + 1)), [])
  return v
}
