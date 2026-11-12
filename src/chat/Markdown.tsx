// Markdown das mensagens em componentes nativos (tokens do marked — ver markdownTokens.ts), no visual
// do `.md` do desktop: blocos de código com linguagem, cópia e rolagem horizontal; tabelas roláveis;
// listas, citações, títulos, código inline. Sem HTML cru e sem imagens remotas (vazariam o IP, como
// no site): imagem externa vira link; `clearchat-attachment://` vira o anexo (baixado e decifrado).
// Mensagens da chamada de voz (`voiceTags`/`dimFrom`): tags de voz em opacidade 0,65 e o trecho
// ainda não falado em 0,5, fora de código (`voiceText.ts`).
import { memo, type ReactNode } from 'react'
import { Linking, ScrollView, StyleSheet, Text, View, type TextStyle } from 'react-native'
import type { Token, Tokens } from 'marked'
import { attachmentFile } from '@/data/attachments'
// web, e-mail e os links de mapas das tools de localização (geo: no Android, maps: no iOS)
import { SAFE_LINK, webFallback } from '@/location/links'
import { colors, font } from '@/ui/theme'
import { InlineAttachmentImage } from './Attachments'
import { lexMarkdown, tableColumnChars, tokensText } from './markdownTokens'
import { CopyButton } from './ui'
import {
  segmentAlpha,
  takeDimMark,
  UNHEARD_ALPHA,
  voiceSegments,
  withAlpha,
  withDimMark,
  type VoiceTextState
} from './voiceText'

/** Estado da passada de uma mensagem da chamada (null = mensagem comum). */
type Voice = VoiceTextState | null

/** Folha de texto: com voz, cortada em tags (0,65) e o "ainda não falado" (0,5). */
function leaf(text: string, key: string, color: string, voice: Voice): ReactNode {
  if (!voice) return text
  const segs = voiceSegments(text, voice)
  if (segs.length === 1 && segmentAlpha(segs[0]) === 1) return segs[0].text
  return segs.map((s, i) => {
    const a = segmentAlpha(s)
    return a === 1 ? (
      s.text
    ) : (
      <Text key={`${key}~${i}`} style={{ color: withAlpha(color, a) }}>
        {s.text}
      </Text>
    )
  })
}

/** Texto de código (sem tags): tira o marcador; esmaecido se já passou dele. */
function codeText(text: string, voice: Voice): { text: string; dim: boolean } {
  if (!voice) return { text, dim: false }
  const dim = voice.dim
  const t = takeDimMark(text)
  if (t.found) voice.dim = true
  return { text: t.text, dim }
}

function openLink(href: string) {
  if (!SAFE_LINK.test(href)) return
  void Linking.openURL(href).catch(() => {
    // sem app de mapas para o geo:/maps: → o mesmo ponto no OpenStreetMap
    const web = webFallback(href)
    if (web) void Linking.openURL(web).catch(() => undefined)
  })
}

function inline(
  tokens: Token[] | undefined,
  k: string,
  color: string = colors.fg,
  voice: Voice = null
): ReactNode[] {
  if (!tokens) return []
  return tokens.map((t, i) => {
    const key = `${k}.${i}`
    switch (t.type) {
      case 'text': {
        const x = t as Tokens.Text
        return x.tokens ? (
          <Text key={key}>{inline(x.tokens, key, color, voice)}</Text>
        ) : (
          leaf(x.text, key, color, voice)
        )
      }
      case 'escape':
        return leaf((t as Tokens.Escape).text, key, color, voice)
      case 'strong':
        return (
          <Text key={key} style={st.strong}>
            {inline((t as Tokens.Strong).tokens, key, colors.strong, voice)}
          </Text>
        )
      case 'em':
        return (
          <Text key={key} style={st.em}>
            {inline((t as Tokens.Em).tokens, key, color, voice)}
          </Text>
        )
      case 'del':
        return (
          <Text key={key} style={st.del}>
            {inline((t as Tokens.Del).tokens, key, color, voice)}
          </Text>
        )
      case 'codespan': {
        const c = codeText((t as Tokens.Codespan).text, voice)
        return (
          <Text
            key={key}
            style={[st.codespan, c.dim && { color: withAlpha(colors.codeInline, UNHEARD_ALPHA) }]}
          >
            {` ${c.text} `}
          </Text>
        )
      }
      case 'br':
        return '\n'
      case 'link': {
        const l = t as Tokens.Link
        // o marcador do "ainda não falado" nunca vai para o endereço
        const href = voice ? takeDimMark(l.href) : { text: l.href, found: false }
        const body = inline(l.tokens, key, colors.accentStrong, voice)
        if (href.found && voice) voice.dim = true
        return (
          <Text key={key} style={st.link} onPress={() => openLink(href.text)} suppressHighlighting>
            {body}
          </Text>
        )
      }
      case 'image': {
        const im = t as Tokens.Image
        const label = `[imagem${im.text ? `: ${im.text}` : ''}]`
        if (attachmentFile(im.href))
          return (
            <Text key={key} style={st.subtle}>
              {label}
            </Text>
          )
        return (
          <Text key={key} style={st.link} onPress={() => openLink(im.href)}>
            {label}
          </Text>
        )
      }
      case 'inlineMath': {
        const c = codeText((t as unknown as { text: string }).text, voice)
        return (
          <Text
            key={key}
            style={[st.math, c.dim && { color: withAlpha(colors.codeInline, UNHEARD_ALPHA) }]}
          >
            {c.text}
          </Text>
        )
      }
      case 'html':
        return leaf((t as Tokens.HTML).text, key, color, voice)
      default:
        return leaf((t as { raw?: string }).raw ?? '', key, color, voice)
    }
  })
}

function CodeBlock({ text, lang, sel }: { text: string; lang?: string; sel: boolean }) {
  return (
    <View style={st.code} testID="md-code">
      <View style={st.codeHead}>
        <Text style={st.codeLang}>{lang || 'texto'}</Text>
        <CopyButton text={text} testID="md-code-copy" />
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={st.codeScroll}>
        <Text style={st.codeText} selectable={sel}>
          {text}
        </Text>
      </ScrollView>
    </View>
  )
}

function Table({
  t,
  k,
  base,
  voice
}: {
  t: Tokens.Table
  k: string
  base: TextStyle
  voice: Voice
}) {
  const chars = tableColumnChars(
    t.header.map((h) => ({ text: tokensText(h.tokens) })),
    t.rows.map((r) => r.map((c) => ({ text: tokensText(c.tokens) })))
  )
  const widths = chars.map((n) => Math.max(72, Math.min(280, n * 8.6 + 28)))
  const cell = (c: Tokens.TableCell, i: number, header: boolean, key: string) => (
    <View key={key} style={[st.td, header && st.th, { width: widths[i] }]}>
      <Text
        style={[
          base,
          st.tdText,
          header && st.thText,
          c.align === 'center' && { textAlign: 'center' },
          c.align === 'right' && { textAlign: 'right' }
        ]}
      >
        {inline(c.tokens, key, header ? colors.fg : String(base.color ?? colors.fg), voice)}
      </Text>
    </View>
  )
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator style={st.tableWrap} testID="md-table">
      <View style={st.table}>
        <View style={st.tr}>{t.header.map((c, i) => cell(c, i, true, `${k}.h${i}`))}</View>
        {t.rows.map((r, ri) => (
          <View key={`${k}.r${ri}`} style={st.tr}>
            {r.map((c, i) => cell(c, i, false, `${k}.r${ri}.${i}`))}
          </View>
        ))}
      </View>
    </ScrollView>
  )
}

/** `sel` = texto selecionável (desligado quando o toque longo abre as ações da mensagem). */
function blocks(
  tokens: Token[],
  k: string,
  base: TextStyle,
  tight = false,
  sel = true,
  voice: Voice = null
): ReactNode[] {
  const out: ReactNode[] = []
  const color = String(base.color ?? colors.fg)
  /** Bloco (código/fórmula/imagem) inteiro depois do ponto "ainda não falado". */
  const dimBlock = (node: ReactNode, key: string): ReactNode =>
    voice?.dim ? (
      <View key={key} style={{ opacity: UNHEARD_ALPHA }}>
        {node}
      </View>
    ) : (
      node
    )
  tokens.forEach((t, i) => {
    const key = `${k}.${i}`
    switch (t.type) {
      case 'space':
      case 'def':
        return
      case 'paragraph': {
        const p = t as Tokens.Paragraph
        // parágrafo só com uma imagem de anexo → imagem em bloco
        const only = p.tokens.filter((x) => !(x.type === 'text' && !(x as Tokens.Text).text.trim()))
        if (only.length === 1 && only[0].type === 'image') {
          const file = attachmentFile((only[0] as Tokens.Image).href)
          if (file) {
            out.push(
              dimBlock(
                <InlineAttachmentImage
                  key={key}
                  file={file}
                  name={(only[0] as Tokens.Image).text}
                />,
                key
              )
            )
            return
          }
        }
        out.push(
          <Text key={key} style={[base, !tight && st.p]} selectable={sel}>
            {inline(p.tokens, key, color, voice)}
          </Text>
        )
        return
      }
      case 'text': {
        const x = t as Tokens.Text
        out.push(
          <Text key={key} style={base} selectable={sel}>
            {x.tokens ? inline(x.tokens, key, color, voice) : leaf(x.text, key, color, voice)}
          </Text>
        )
        return
      }
      case 'heading': {
        const h = t as Tokens.Heading
        const size = h.depth === 1 ? 1.35 : h.depth === 2 ? 1.2 : h.depth === 3 ? 1.07 : 1
        const fs = (base.fontSize ?? 15) * size
        out.push(
          <Text
            key={key}
            style={[base, st.heading, { fontSize: fs, lineHeight: Math.round(fs * 1.35) }]}
            accessibilityRole="header"
          >
            {inline(h.tokens, key, color, voice)}
          </Text>
        )
        return
      }
      case 'code': {
        const c = t as Tokens.Code
        const dimmed = !!voice?.dim
        const code = codeText(c.text, voice)
        out.push(
          dimmed ? (
            <View key={key} style={{ opacity: UNHEARD_ALPHA }}>
              <CodeBlock text={code.text.replace(/\n$/, '')} lang={c.lang} sel={sel} />
            </View>
          ) : (
            <CodeBlock key={key} text={code.text.replace(/\n$/, '')} lang={c.lang} sel={sel} />
          )
        )
        return
      }
      case 'blockMath': {
        const dimmed = !!voice?.dim
        const math = codeText((t as unknown as { text: string }).text, voice)
        out.push(
          <View key={key} style={[st.mathBlock, dimmed && { opacity: UNHEARD_ALPHA }]}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <Text style={st.mathText} selectable={sel}>
                {math.text}
              </Text>
            </ScrollView>
          </View>
        )
        return
      }
      case 'blockquote':
        out.push(
          <View key={key} style={st.quote}>
            {blocks(
              (t as Tokens.Blockquote).tokens,
              key,
              { ...base, color: colors.muted },
              false,
              sel,
              voice
            )}
          </View>
        )
        return
      case 'list': {
        const l = t as Tokens.List
        const start = typeof l.start === 'number' ? l.start : 1
        out.push(
          <View key={key} style={st.list}>
            {l.items.map((it, n) => (
              <View key={`${key}.${n}`} style={st.li}>
                <Text
                  style={[
                    base,
                    st.marker,
                    voice?.dim && { color: withAlpha(colors.subtle, UNHEARD_ALPHA) }
                  ]}
                >
                  {it.task ? (it.checked ? '☑' : '☐') : l.ordered ? `${start + n}.` : '•'}
                </Text>
                <View style={st.liBody}>
                  {blocks(
                    it.tokens.filter((x) => x.type !== 'checkbox'),
                    `${key}.${n}`,
                    base,
                    !l.loose,
                    sel,
                    voice
                  )}
                </View>
              </View>
            ))}
          </View>
        )
        return
      }
      case 'table':
        out.push(<Table key={key} t={t as Tokens.Table} k={key} base={base} voice={voice} />)
        return
      case 'hr':
        out.push(<View key={key} style={st.hr} />)
        return
      case 'html':
        out.push(
          <Text key={key} style={[base, st.p]}>
            {leaf((t as Tokens.HTML).text, key, color, voice)}
          </Text>
        )
        return
      default: {
        const raw = (t as { raw?: string }).raw
        if (raw?.trim())
          out.push(
            <Text key={key} style={[base, st.p]}>
              {leaf(raw, key, color, voice)}
            </Text>
          )
      }
    }
  })
  return out
}

/**
 * Markdown de uma mensagem. `size` ajusta a fonte base (cartões usam menor). Mensagem da chamada de
 * voz: `voiceTags` esmaece as tags de voz (0,65) e `dimFrom` (offset em `text`) esmaece o trecho
 * ainda não falado (0,5) — leitura ao vivo e o resto não ouvido depois de um barge-in.
 */
export const Markdown = memo(function Markdown({
  text,
  italic,
  size = 15,
  color = colors.fg,
  selectable = true,
  voiceTags,
  dimFrom
}: {
  text: string
  italic?: boolean
  size?: number
  color?: string
  selectable?: boolean
  voiceTags?: boolean
  dimFrom?: number | null
}) {
  const base: TextStyle = {
    color,
    fontSize: size,
    lineHeight: Math.round(size * 1.55),
    ...(italic ? { fontStyle: 'italic' } : {})
  }
  const voiced = !!voiceTags || dimFrom != null
  const src = voiced ? withDimMark(text, dimFrom) : text
  // estado da passada (na ordem do texto): novo a cada render
  const voice: Voice = voiced ? { tags: !!voiceTags, dim: false } : null
  return (
    <View style={st.root}>{blocks(lexMarkdown(src), 'md', base, false, selectable, voice)}</View>
  )
})

const st = StyleSheet.create({
  root: { gap: 0 },
  p: { marginVertical: 5 },
  strong: { fontWeight: '600', color: colors.strong },
  em: { fontStyle: 'italic' },
  del: { textDecorationLine: 'line-through' },
  subtle: { color: colors.subtle },
  link: {
    color: colors.accentStrong,
    textDecorationLine: 'underline',
    textDecorationColor: 'rgba(139, 92, 246, 0.5)'
  },
  codespan: {
    fontFamily: font.mono,
    fontSize: 13,
    color: colors.codeInline,
    backgroundColor: colors.elevated
  },
  math: { fontFamily: font.mono, fontSize: 13.5, color: colors.codeInline },
  heading: { fontWeight: '600', marginTop: 12, marginBottom: 4, color: colors.fg },
  code: {
    marginVertical: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.codeBg,
    overflow: 'hidden'
  },
  codeHead: {
    height: 34,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: 12,
    paddingRight: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: 'rgba(255,255,255,0.015)'
  },
  codeLang: { color: colors.subtle, fontFamily: font.mono, fontSize: 11.5 },
  codeScroll: { paddingHorizontal: 12, paddingVertical: 10 },
  codeText: { color: '#d4d4dc', fontFamily: font.mono, fontSize: 12.5, lineHeight: 20 },
  mathBlock: {
    marginVertical: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: 'rgba(139, 92, 246, 0.06)'
  },
  mathText: { fontFamily: font.mono, fontSize: 13.5, color: colors.codeInline },
  quote: {
    marginVertical: 6,
    paddingLeft: 12,
    borderLeftWidth: 2,
    borderLeftColor: colors.borderStrong
  },
  list: { marginVertical: 4, gap: 3 },
  li: { flexDirection: 'row', gap: 8, paddingLeft: 4 },
  marker: { color: colors.subtle, minWidth: 14 },
  liBody: { flex: 1 },
  tableWrap: { marginVertical: 8 },
  table: { borderWidth: 1, borderColor: colors.border, borderRadius: 8, overflow: 'hidden' },
  tr: { flexDirection: 'row' },
  td: {
    borderRightWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    paddingHorizontal: 10,
    paddingVertical: 6
  },
  th: { backgroundColor: colors.surface },
  tdText: { fontSize: 13.5, lineHeight: 19 },
  thText: { fontWeight: '600' },
  hr: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginVertical: 14 }
})
