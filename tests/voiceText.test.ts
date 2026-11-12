// Peças puras da UI da voz: texto das mensagens da chamada (tags de voz em 0,65, o "ainda não falado"
// em 0,5 a partir do marcador, nunca no meio de uma tag; cor com alfa — o `opacity` não vale em
// `Text` aninhado) e a escolha com herança sem opção duplicada (★ = o herdado; tocar nela limpa o
// override).
import { describe, expect, it } from 'vitest'
import { liveDimFrom } from '../src/vendor/shared/heardText'
import {
  DIM_MARK,
  segmentAlpha,
  takeDimMark,
  voiceSegments,
  withAlpha,
  withDimMark,
  type VoiceTextState
} from '../src/chat/voiceText'
import { inheritPick, inheritShown, inheritValueKey } from '../src/settings/inherit'
import { lexMarkdown } from '../src/chat/markdownTokens'

const fresh = (tags = true): VoiceTextState => ({ tags, dim: false })

describe('texto das mensagens da chamada', () => {
  it('tags de voz viram segmentos à parte (0,65), com os colchetes, sem link/nota/checkbox', () => {
    const segs = voiceSegments('Claro! [risos] Isso é ótimo. Veja [1] e [ ] e [x].', fresh())
    expect(segs.map((s) => [s.text, s.tag])).toEqual([
      ['Claro! ', false],
      ['[risos]', true],
      [' Isso é ótimo. Veja [1] e [ ] e [x].', false]
    ])
    expect(segmentAlpha(segs[1])).toBe(0.65)
    expect(segmentAlpha(segs[0])).toBe(1)
    // sem `tags`, o texto fica inteiro
    expect(voiceSegments('a [risos] b', fresh(false))).toEqual([
      { text: 'a [risos] b', tag: false, dim: false }
    ])
  })

  it('o marcador corta o texto: depois dele tudo esmaece (0,5) e a tag fica com o 0,65 relativo', () => {
    const st = fresh()
    const segs = voiceSegments(`Olá, tudo${DIM_MARK} bem? [suspira] Sim.`, st)
    expect(segs).toEqual([
      { text: 'Olá, tudo', tag: false, dim: false },
      { text: ' bem? ', tag: false, dim: true },
      { text: '[suspira]', tag: true, dim: true },
      { text: ' Sim.', tag: false, dim: true }
    ])
    expect(segmentAlpha(segs[2])).toBeCloseTo(0.325)
    expect(st.dim).toBe(true)
    // o estado passa para o próximo trecho (a ordem do texto)
    expect(voiceSegments('depois', st)).toEqual([{ text: 'depois', tag: false, dim: true }])
  })

  it('o marcador nunca parte uma tag: ela vai inteira para o lado em que começa', () => {
    const segs = voiceSegments(`Oi [sus${DIM_MARK}pira] tchau`, fresh())
    expect(segs).toEqual([
      { text: 'Oi ', tag: false, dim: false },
      { text: '[suspira]', tag: true, dim: true },
      { text: ' tchau', tag: false, dim: true }
    ])
  })

  it('marcador no offset, tirado do código; o markdown continua o mesmo com ele', () => {
    expect(withDimMark('abc', 1)).toBe(`a${DIM_MARK}bc`)
    expect(withDimMark('abc', null)).toBe('abc')
    expect(withDimMark('abc', 99)).toBe(`abc${DIM_MARK}`)
    expect(takeDimMark(`x${DIM_MARK}y`)).toEqual({ text: 'xy', found: true })
    expect(takeDimMark('xy')).toEqual({ text: 'xy', found: false })
    const md = 'Primeira frase com **negrito**. Segunda frase.'
    const types = (t: string) => lexMarkdown(t).map((x) => x.type)
    expect(types(withDimMark(md, md.indexOf(' Segunda')))).toEqual(types(md))
  })

  it('leitura ao vivo: o offset da frase atual na mensagem (as já tocadas antes)', () => {
    const content = 'Primeiro isto. Depois aquilo e mais coisa.'
    const from = liveDimFrom(content, ['Primeiro isto.'], {
      text: 'Depois aquilo e mais coisa.',
      chars: 'Depois aquilo'.length
    })
    expect(content.slice(0, from!)).toBe('Primeiro isto. Depois aquilo')
    // outra mensagem (não é ela que está sendo falada)
    expect(liveDimFrom('Outra resposta.', [], { text: 'Depois aquilo.', chars: 3 })).toBeNull()
  })

  it('cor com alfa (hex curto/longo, rgb/rgba)', () => {
    expect(withAlpha('#e6e6ea', 0.5)).toBe('rgba(230, 230, 234, 0.5)')
    expect(withAlpha('#fff', 0.65)).toBe('rgba(255, 255, 255, 0.65)')
    expect(withAlpha('rgba(10, 20, 30, 0.5)', 0.5)).toBe('rgba(10, 20, 30, 0.25)')
    expect(withAlpha('rgb(1,2,3)', 0.325)).toBe('rgba(1, 2, 3, 0.325)')
    expect(withAlpha('red', 0.5)).toBe('red')
  })
})

describe('escolha com herança (★ no padrão)', () => {
  it('sem override a ★ aparece escolhida; tocar na ★ volta a herdar; outra fixa', () => {
    expect(inheritShown(null, true)).toBe(true)
    expect(inheritShown(false, true)).toBe(false)
    expect(inheritPick(true, true)).toBeNull()
    expect(inheritPick(false, true)).toBe(false)
    expect(inheritPick<'append' | 'replace' | 'none'>('append', 'append')).toBeNull()
    expect(inheritPick<'append' | 'replace' | 'none'>('none', 'append')).toBe('none')
    expect([true, false, 'replace'].map(inheritValueKey)).toEqual(['on', 'off', 'replace'])
  })
})
