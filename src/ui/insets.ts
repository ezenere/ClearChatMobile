// Recuo inferior que acompanha o teclado (puro, worklet): `inset` com o teclado fechado, 0 com ele
// aberto e proporcional no meio da animação — a barra do pé da tela encosta no teclado sem faixa
// vazia e sem pulo.
export function keyboardAwareInset(inset: number, keyboardProgress: number): number {
  'worklet'
  const p = Math.min(1, Math.max(0, keyboardProgress))
  return inset * (1 - p)
}
