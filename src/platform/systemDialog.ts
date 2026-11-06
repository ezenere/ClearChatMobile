// Diálogos do sistema (permissões) pausam a Activity no Android: o AppState vira "background" sem o
// usuário ter saído do app. Quem pede uma permissão no meio de um turno (localização) marca o
// diálogo aqui, e os ouvintes de segundo plano (conta/host, avisos, voz) ignoram essa pausa.
// Puro (sem React Native).

let pending = 0

export const systemDialogOpen = (): boolean => pending > 0

/** Roda `fn` (que abre um diálogo do sistema) com a pausa da Activity ignorada. */
export async function withSystemDialog<T>(fn: () => Promise<T>): Promise<T> {
  pending++
  try {
    return await fn()
  } finally {
    // o "active" da volta chega logo depois da resposta do diálogo
    setTimeout(() => {
      pending = Math.max(0, pending - 1)
    }, 1500)
  }
}
