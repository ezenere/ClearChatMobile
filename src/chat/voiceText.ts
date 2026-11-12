// Texto das mensagens da chamada de voz no Markdown do chat (PURO — sem React Native; = a ideia de
// `lib/voiceText.ts` do desktop, que é um plugin remark): o renderer do celular percorre os tokens do
// marked na ordem, então o "ainda não falado" vira um MARCADOR no texto-fonte (`DIM_MARK`, um
// caractere de uso privado) e cada trecho de texto é cortado em segmentos:
// - **tags de voz** (`@shared/audioTags` — "[sussurra]", "[risos]") ficam no texto, com os
//   colchetes, em opacidade 0,65 (mesma fonte/itálico — a cor ganha alfa: o `opacity` não vale em
//   `Text` aninhado no React Native); só fora de código;
// - **o que ainda não foi falado** (leitura ao vivo / resto não ouvido depois de um barge-in): do
//   marcador em diante, opacidade 0,5; uma tag dentro do trecho esmaecido fica com o 0,65 RELATIVO
//   a ele (0,325). O marcador nunca parte uma tag (a tag vai inteira para o lado em que começa).
import { audioTagRe } from '@shared/audioTags'

/** Marcador do ponto a partir do qual o texto ainda não foi falado (nunca escrito pela IA). */
export const DIM_MARK = '\uE000'
/** Opacidade das tags de voz e do trecho ainda não falado (= `.voice-tag`/`.voice-unheard`). */
export const TAG_ALPHA = 0.65
export const UNHEARD_ALPHA = 0.5

/** Estado da passada (mutável, na ordem do texto): já passou do marcador? */
export interface VoiceTextState {
  /** Esmaecer as tags de voz (mensagens da chamada). */
  tags: boolean
  /** Do marcador em diante (o resto do texto está esmaecido). */
  dim: boolean
}

export interface VoiceSegment {
  text: string
  tag: boolean
  dim: boolean
}

/** O texto com o marcador no offset `dimFrom` (null/fora → como veio). */
export function withDimMark(text: string, dimFrom: number | null | undefined): string {
  if (dimFrom == null || !Number.isFinite(dimFrom) || dimFrom < 0) return text
  const at = Math.min(text.length, Math.floor(dimFrom))
  return text.slice(0, at) + DIM_MARK + text.slice(at)
}

/** Tira o marcador (código, endereços): `found` = ele estava aqui (o resto fica esmaecido). */
export function takeDimMark(text: string): { text: string; found: boolean } {
  const i = text.indexOf(DIM_MARK)
  return i < 0 ? { text, found: false } : { text: text.split(DIM_MARK).join(''), found: true }
}

/**
 * Segmentos de um trecho de texto (folha do Markdown), na ordem: tags de voz separadas (com
 * `state.tags`) e o corte do marcador; atualiza `state.dim` ao passar dele.
 */
export function voiceSegments(value: string, state: VoiceTextState): VoiceSegment[] {
  const mark = value.indexOf(DIM_MARK)
  const clean = mark < 0 ? value : value.split(DIM_MARK).join('')
  let cut = mark
  const spans: [number, number][] = state.tags
    ? [...clean.matchAll(audioTagRe())].map((m) => [m.index, m.index + m[0].length])
    : []
  // nunca no meio de uma tag de voz: a tag vai inteira para o lado em que começa
  if (cut >= 0) for (const [a, b] of spans) if (cut > a && cut < b) cut = a
  const before = state.dim
  const out: VoiceSegment[] = []
  const piece = (from: number, to: number, tag: boolean) => {
    if (to <= from) return
    if (cut < 0 || to <= cut) out.push({ text: clean.slice(from, to), tag, dim: before })
    else if (from >= cut) out.push({ text: clean.slice(from, to), tag, dim: true })
    else {
      out.push({ text: clean.slice(from, cut), tag, dim: before })
      out.push({ text: clean.slice(cut, to), tag, dim: true })
    }
  }
  let last = 0
  for (const [a, b] of spans) {
    piece(last, a, false)
    piece(a, b, true)
    last = b
  }
  piece(last, clean.length, false)
  if (mark >= 0) state.dim = true
  // segmentos vizinhos iguais se juntam (menos nós de texto)
  const merged: VoiceSegment[] = []
  for (const s of out) {
    const p = merged[merged.length - 1]
    if (p && p.tag === s.tag && p.dim === s.dim && !s.tag) p.text += s.text
    else merged.push({ ...s })
  }
  return merged
}

/** Opacidade de um segmento (tag 0,65 × não falado 0,5). */
export function segmentAlpha(s: Pick<VoiceSegment, 'tag' | 'dim'>): number {
  return (s.tag ? TAG_ALPHA : 1) * (s.dim ? UNHEARD_ALPHA : 1)
}

/** Cor `#rgb`/`#rrggbb`/`rgb(a)(…)` com o alfa multiplicado por `alpha`. */
export function withAlpha(color: string, alpha: number): string {
  const a = Math.max(0, Math.min(1, alpha))
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())
  if (hex) {
    const h =
      hex[1].length === 3
        ? hex[1]
            .split('')
            .map((c) => c + c)
            .join('')
        : hex[1]
    const n = parseInt(h, 16)
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${+a.toFixed(3)})`
  }
  const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(
    color.trim()
  )
  if (rgb) {
    const base = rgb[4] != null ? Number(rgb[4]) : 1
    return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${+(base * a).toFixed(3)})`
  }
  return color
}
