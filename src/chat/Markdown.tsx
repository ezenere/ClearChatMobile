// Markdown das mensagens em componentes nativos (tokens do marked — ver markdownTokens.ts), no visual
// do `.md` do desktop: blocos de código com linguagem, cópia e rolagem horizontal; tabelas roláveis;
// listas, citações, títulos, código inline. Sem HTML cru e sem imagens remotas (vazariam o IP, como
// no site): imagem externa vira link; `clearchat-attachment://` vira o anexo (baixado e decifrado).
import { memo, type ReactNode } from 'react'
import { Linking, ScrollView, StyleSheet, Text, View, type TextStyle } from 'react-native'
import type { Token, Tokens } from 'marked'
import { attachmentFile } from '@/data/attachments'
import { colors, font } from '@/ui/theme'
import { InlineAttachmentImage } from './Attachments'
import { lexMarkdown, tableColumnChars, tokensText } from './markdownTokens'
import { CopyButton } from './ui'

const SAFE_LINK = /^(https?:|mailto:)/i

function openLink(href: string) {
  if (SAFE_LINK.test(href)) void Linking.openURL(href).catch(() => undefined)
}

function inline(tokens: Token[] | undefined, k: string): ReactNode[] {
  if (!tokens) return []
  return tokens.map((t, i) => {
    const key = `${k}.${i}`
    switch (t.type) {
      case 'text': {
        const x = t as Tokens.Text
        return x.tokens ? <Text key={key}>{inline(x.tokens, key)}</Text> : x.text
      }
      case 'escape':
        return (t as Tokens.Escape).text
      case 'strong':
        return (
          <Text key={key} style={st.strong}>
            {inline((t as Tokens.Strong).tokens, key)}
          </Text>
        )
      case 'em':
        return (
          <Text key={key} style={st.em}>
            {inline((t as Tokens.Em).tokens, key)}
          </Text>
        )
      case 'del':
        return (
          <Text key={key} style={st.del}>
            {inline((t as Tokens.Del).tokens, key)}
          </Text>
        )
      case 'codespan':
        return (
          <Text key={key} style={st.codespan}>
            {` ${(t as Tokens.Codespan).text} `}
          </Text>
        )
      case 'br':
        return '\n'
      case 'link': {
        const l = t as Tokens.Link
        return (
          <Text key={key} style={st.link} onPress={() => openLink(l.href)} suppressHighlighting>
            {inline(l.tokens, key)}
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
      case 'inlineMath':
        return (
          <Text key={key} style={st.math}>
            {(t as unknown as { text: string }).text}
          </Text>
        )
      case 'html':
        return (t as Tokens.HTML).text
      default:
        return (t as { raw?: string }).raw ?? ''
    }
  })
}

function CodeBlock({ text, lang }: { text: string; lang?: string }) {
  return (
    <View style={st.code} testID="md-code">
      <View style={st.codeHead}>
        <Text style={st.codeLang}>{lang || 'texto'}</Text>
        <CopyButton text={text} testID="md-code-copy" />
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={st.codeScroll}>
        <Text style={st.codeText} selectable>
          {text}
        </Text>
      </ScrollView>
    </View>
  )
}

function Table({ t, k, base }: { t: Tokens.Table; k: string; base: TextStyle }) {
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
        {inline(c.tokens, key)}
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

function blocks(tokens: Token[], k: string, base: TextStyle, tight = false): ReactNode[] {
  const out: ReactNode[] = []
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
              <InlineAttachmentImage key={key} file={file} name={(only[0] as Tokens.Image).text} />
            )
            return
          }
        }
        out.push(
          <Text key={key} style={[base, !tight && st.p]} selectable>
            {inline(p.tokens, key)}
          </Text>
        )
        return
      }
      case 'text': {
        const x = t as Tokens.Text
        out.push(
          <Text key={key} style={base} selectable>
            {x.tokens ? inline(x.tokens, key) : x.text}
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
            {inline(h.tokens, key)}
          </Text>
        )
        return
      }
      case 'code': {
        const c = t as Tokens.Code
        out.push(<CodeBlock key={key} text={c.text.replace(/\n$/, '')} lang={c.lang} />)
        return
      }
      case 'blockMath':
        out.push(
          <View key={key} style={st.mathBlock}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <Text style={st.mathText} selectable>
                {(t as unknown as { text: string }).text}
              </Text>
            </ScrollView>
          </View>
        )
        return
      case 'blockquote':
        out.push(
          <View key={key} style={st.quote}>
            {blocks((t as Tokens.Blockquote).tokens, key, { ...base, color: colors.muted })}
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
                <Text style={[base, st.marker]}>
                  {it.task ? (it.checked ? '☑' : '☐') : l.ordered ? `${start + n}.` : '•'}
                </Text>
                <View style={st.liBody}>
                  {blocks(
                    it.tokens.filter((x) => x.type !== 'checkbox'),
                    `${key}.${n}`,
                    base,
                    !l.loose
                  )}
                </View>
              </View>
            ))}
          </View>
        )
        return
      }
      case 'table':
        out.push(<Table key={key} t={t as Tokens.Table} k={key} base={base} />)
        return
      case 'hr':
        out.push(<View key={key} style={st.hr} />)
        return
      case 'html':
        out.push(
          <Text key={key} style={[base, st.p]}>
            {(t as Tokens.HTML).text}
          </Text>
        )
        return
      default: {
        const raw = (t as { raw?: string }).raw
        if (raw?.trim())
          out.push(
            <Text key={key} style={[base, st.p]}>
              {raw}
            </Text>
          )
      }
    }
  })
  return out
}

/** Markdown de uma mensagem. `size` ajusta a fonte base (cartões usam menor). */
export const Markdown = memo(function Markdown({
  text,
  italic,
  size = 15,
  color = colors.fg
}: {
  text: string
  italic?: boolean
  size?: number
  color?: string
}) {
  const base: TextStyle = {
    color,
    fontSize: size,
    lineHeight: Math.round(size * 1.55),
    ...(italic ? { fontStyle: 'italic' } : {})
  }
  return <View style={st.root}>{blocks(lexMarkdown(text), 'md', base)}</View>
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
