import { describe, expect, it } from 'vitest'
import { keyboardAwareInset } from '@/ui/insets'

describe('keyboardAwareInset (recuo inferior das barras do pé da tela)', () => {
  it('teclado fechado: recuo inteiro (barra de gestos / home indicator)', () => {
    expect(keyboardAwareInset(48, 0)).toBe(48)
  })
  it('teclado aberto: sem recuo — a barra encosta no teclado', () => {
    expect(keyboardAwareInset(48, 1)).toBe(0)
  })
  it('durante a animação encolhe junto (sem pulo)', () => {
    expect(keyboardAwareInset(48, 0.25)).toBe(36)
    expect(keyboardAwareInset(48, 0.5)).toBe(24)
  })
  it('progresso fora de 0..1 (overshoot da animação) não gera recuo negativo nem maior', () => {
    expect(keyboardAwareInset(48, 1.2)).toBe(0)
    expect(keyboardAwareInset(48, -0.3)).toBe(48)
  })
  it('sem recuo (aparelho sem barra) continua 0', () => {
    expect(keyboardAwareInset(0, 0)).toBe(0)
  })
})
