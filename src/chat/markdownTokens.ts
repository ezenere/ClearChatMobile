// Markdown → tokens (marked, GFM) com as mesmas normalizações do desktop (cercas aninhadas e
// fórmulas: `\[…\]`/`\(…\)` → `$$`/`$`, cifrões de preço escapados) e tokens próprios para fórmulas
// (`$…$` inline, `$$…$$` em bloco — exibidas como texto monoespaçado, sem KaTeX). Puro e com cache
// (as linhas da lista são recicladas: a mesma mensagem não é reinterpretada a cada render).
import { Marked, type Token, type TokenizerExtension } from 'marked'
import { normalizeFences } from '@vendor/renderer/fences'
import { normalizeMath } from '@vendor/renderer/math'

export interface MathToken {
  type: 'inlineMath' | 'blockMath'
  raw: string
  text: string
}

const blockMath: TokenizerExtension = {
  name: 'blockMath',
  level: 'block',
  start: (src) => src.match(/^ {0,3}\$\$/m)?.index,
  tokenizer(src) {
    const m = /^ {0,3}\$\$([\s\S]+?)\$\$[ \t]*(?:\n|$)/.exec(src)
    if (m) return { type: 'blockMath', raw: m[0], text: m[1].trim() }
    return undefined
  }
}

const inlineMath: TokenizerExtension = {
  name: 'inlineMath',
  level: 'inline',
  start: (src) => {
    const i = src.indexOf('$')
    return i < 0 ? undefined : i
  },
  tokenizer(src) {
    const dbl = /^\$\$([^$]+?)\$\$/.exec(src)
    if (dbl) return { type: 'inlineMath', raw: dbl[0], text: dbl[1].trim() }
    const m = /^\$(?![\s$])((?:\\.|[^\\$\n])*?[^\s\\$])\$(?!\d)/.exec(src)
    if (m) return { type: 'inlineMath', raw: m[0], text: m[1] }
    return undefined
  }
}

const md = new Marked({ gfm: true, breaks: false })
md.use({ extensions: [blockMath, inlineMath] })

const cache = new Map<string, Token[]>()
const MAX = 400

/** Tokens de bloco do texto (com cache). */
export function lexMarkdown(text: string): Token[] {
  const hit = cache.get(text)
  if (hit) {
    cache.delete(text)
    cache.set(text, hit)
    return hit
  }
  let tokens: Token[]
  try {
    tokens = md.lexer(normalizeMath(normalizeFences(text)))
  } catch {
    tokens = [{ type: 'paragraph', raw: text, text, tokens: [{ type: 'text', raw: text, text }] }]
  }
  cache.set(text, tokens)
  while (cache.size > MAX) cache.delete(cache.keys().next().value as string)
  return tokens
}

/** Largura (em caracteres) de cada coluna de uma tabela, para o layout em grade. */
export function tableColumnChars(header: { text: string }[], rows: { text: string }[][]): number[] {
  return header.map((h, i) => {
    let max = h.text.length
    for (const r of rows) max = Math.max(max, r[i]?.text.length ?? 0)
    return max
  })
}

/** Texto puro de tokens inline (copiar, rótulos). */
export function tokensText(tokens: Token[] | undefined): string {
  if (!tokens) return ''
  return tokens
    .map((t) => {
      const x = t as { tokens?: Token[]; text?: string; type: string }
      if (x.type === 'br') return '\n'
      if (x.tokens) return tokensText(x.tokens)
      return x.text ?? ''
    })
    .join('')
}
