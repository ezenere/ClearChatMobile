// Anexos na request (porta de ClearChatDesktop/src/main/attachments.ts, parte pura): parts
// persistidos por referência (`clearchat-attachment://<sha256>.<ext>` + `_attachment`) e a expansão
// para base64 só na CÓPIA enviada. Lá a leitura é síncrona do disco; aqui o runner baixa (§14) e lê
// os arquivos antes e entrega um leitor síncrono (`AttachmentReader`) — buildRequest continua pura.
import {
  ATTACHMENT_FILE_RE,
  ATTACHMENT_URL_PREFIX,
  attachmentUrl,
  audioFormat,
  formatSize,
  parseAttachmentUrl,
  textFileBlock
} from '@shared/attachments'
import { ATTACHMENT_LIMITS } from '@shared/limits'
import type { ApiMessage, AttachmentInfo, AttachmentMeta, ContentPart } from '@shared/types'

/** Conteúdo de um arquivo do store já carregado: base64 (padrão) — lança se faltar. */
export type AttachmentReader = (file: string, name?: string) => string

export class MissingAttachmentError extends Error {}

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'application/pdf': 'pdf',
  'audio/wav': 'wav',
  'audio/mpeg': 'mp3'
}
const MIME_BY_EXT: Record<string, string> = Object.fromEntries(
  Object.entries(EXT_BY_MIME).map(([m, e]) => [e, m])
)
MIME_BY_EXT.txt = 'text/plain; charset=utf-8'
MIME_BY_EXT.svg = 'image/svg+xml'

export function mimeForFile(file: string): string {
  const ext = file.includes('.') ? file.slice(file.lastIndexOf('.') + 1) : ''
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

/** Nome exibido/enviado: sem diretórios nem caracteres de controle, até 200 chars. */
export function sanitizeName(name: unknown): string {
  const base = (typeof name === 'string' ? name : '').split(/[\\/]/).pop() ?? ''
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return (clean || 'arquivo').slice(0, 200)
}

function metaOf(a: AttachmentInfo, extra: Partial<AttachmentMeta> = {}): AttachmentMeta {
  return { name: a.name, mime: a.mime, size: a.size, kind: a.kind, file: a.file, ...extra }
}

export function capText(
  text: string,
  max: number = ATTACHMENT_LIMITS.maxTextChars
): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  return {
    text: `${text.slice(0, max)}\n[… arquivo cortado: mostrando ${max.toLocaleString('pt-BR')} de ${text.length.toLocaleString('pt-BR')} caracteres]`,
    truncated: true
  }
}

/**
 * Part persistido de um anexo (igual ao desktop). Texto vai inline: `readText` devolve o conteúdo
 * UTF-8 do arquivo (já no aparelho).
 */
export function attachmentPart(a: AttachmentInfo, readText: (file: string) => string): ContentPart {
  const url = attachmentUrl(a.file)
  switch (a.kind) {
    case 'image':
      return { type: 'image_url', image_url: { url }, _attachment: metaOf(a) }
    case 'pdf':
      return { type: 'file', file: { filename: a.name, file_data: url }, _attachment: metaOf(a) }
    case 'audio':
      return {
        type: 'input_audio',
        input_audio: { data: url, format: audioFormat(a.mime) },
        _attachment: metaOf(a)
      }
    case 'text': {
      const { text, truncated } = capText(readText(a.file))
      return {
        type: 'text',
        text: textFileBlock(a.name, text),
        _attachment: metaOf(a, truncated ? { truncated: true } : {})
      }
    }
  }
}

/** Valida anexos recebidos (comando remoto / composer). Tamanho real conferido por `sizeOf`. */
export function validateAttachments(
  list: unknown,
  sizeOf: (file: string) => number | null
): AttachmentInfo[] {
  if (list == null) return []
  if (!Array.isArray(list)) throw new Error('Anexos inválidos.')
  if (list.length > ATTACHMENT_LIMITS.maxFiles)
    throw new Error(`No máximo ${ATTACHMENT_LIMITS.maxFiles} anexos por mensagem.`)
  let total = 0
  const out = list.map((x): AttachmentInfo => {
    const a = x as Partial<AttachmentInfo>
    if (!a || typeof a.file !== 'string' || !ATTACHMENT_FILE_RE.test(a.file))
      throw new Error('Anexo inválido.')
    if (!['image', 'pdf', 'audio', 'text'].includes(a.kind as string))
      throw new Error(`Tipo de anexo inválido: ${String(a.kind)}`)
    const size = sizeOf(a.file)
    if (size == null)
      throw new Error(`Anexo não encontrado no aparelho: "${sanitizeName(a.name)}". Anexe de novo.`)
    total += size
    return {
      sha256: a.file.slice(0, 64),
      name: sanitizeName(a.name),
      mime: typeof a.mime === 'string' && a.mime ? a.mime : mimeForFile(a.file),
      size,
      kind: a.kind as AttachmentInfo['kind'],
      file: a.file
    }
  })
  if (total > ATTACHMENT_LIMITS.maxTotalBytes)
    throw new Error(
      `Os anexos somam ${formatSize(total)} — o limite por mensagem é ${formatSize(ATTACHMENT_LIMITS.maxTotalBytes)}.`
    )
  return out
}

export function buildUserContent(
  text: string,
  attachments: AttachmentInfo[],
  skillParts: ContentPart[],
  readText: (file: string) => string
): string | ContentPart[] {
  if (!attachments.length && !skillParts.length) return text
  const parts = [...attachments.map((a) => attachmentPart(a, readText)), ...skillParts]
  if (text.trim()) parts.push({ type: 'text', text })
  return parts
}

function stripPrivate(p: ContentPart): ContentPart {
  if (!p._attachment && !(p.type === 'text' && p._skill)) return p
  const { _attachment: _a, ...rest } = p as ContentPart & { _skill?: unknown }
  void _a
  delete (rest as { _skill?: unknown })._skill
  return rest as ContentPart
}

function hasRef(p: ContentPart): boolean {
  if (p.type === 'image_url') return p.image_url.url.startsWith(ATTACHMENT_URL_PREFIX)
  if (p.type === 'file') return p.file.file_data.startsWith(ATTACHMENT_URL_PREFIX)
  if (p.type === 'input_audio') return p.input_audio.data.startsWith(ATTACHMENT_URL_PREFIX)
  return false
}

export function expandPart(p: ContentPart, read: AttachmentReader): ContentPart {
  const meta = p._attachment
  const out = stripPrivate(p)
  if (out.type === 'image_url') {
    const file = parseAttachmentUrl(out.image_url.url)
    if (file) {
      const mime = meta?.mime || mimeForFile(file)
      return {
        ...out,
        image_url: { ...out.image_url, url: `data:${mime};base64,${read(file, meta?.name)}` }
      }
    }
  } else if (out.type === 'file') {
    const file = parseAttachmentUrl(out.file.file_data)
    if (file) {
      const mime = meta?.mime || mimeForFile(file)
      return {
        ...out,
        file: { ...out.file, file_data: `data:${mime};base64,${read(file, meta?.name)}` }
      }
    }
  } else if (out.type === 'input_audio') {
    const file = parseAttachmentUrl(out.input_audio.data)
    if (file) return { ...out, input_audio: { ...out.input_audio, data: read(file, meta?.name) } }
  }
  return out
}

/** Cópia com as referências expandidas e os campos privados removidos (determinística). */
export function expandAttachments(messages: ApiMessage[], read: AttachmentReader): ApiMessage[] {
  return messages.map((m) => {
    if (m.role === 'assistant' || typeof m.content === 'string' || !m.content) return m
    if (!m.content.some((p) => p._attachment || hasRef(p) || (p.type === 'text' && p._skill)))
      return m
    return { ...m, content: m.content.map((p) => expandPart(p, read)) } as ApiMessage
  })
}

/** Arquivos do store citados nas mensagens (o runner garante que estão no aparelho antes). */
export function referencedFiles(messages: ApiMessage[]): string[] {
  const out = new Set<string>()
  for (const m of messages) {
    if (m.role === 'assistant' || typeof m.content === 'string' || !m.content) continue
    for (const p of m.content) {
      const ref =
        p.type === 'image_url'
          ? p.image_url.url
          : p.type === 'file'
            ? p.file.file_data
            : p.type === 'input_audio'
              ? p.input_audio.data
              : null
      const f = ref ? parseAttachmentUrl(ref) : null
      if (f) out.add(f)
    }
  }
  return [...out]
}

/**
 * OpenAI-compatible: `role: tool` só aceita texto — a mídia de resultados de tool vai numa mensagem
 * `user` sintética logo depois do bloco (igual ao desktop; roda antes de expandAttachments).
 */
export function hoistToolMedia(messages: ApiMessage[]): ApiMessage[] {
  if (!messages.some((m) => m.role === 'tool' && Array.isArray(m.content))) return messages
  const out: ApiMessage[] = []
  let pending: ContentPart[] = []
  const flush = (): void => {
    if (!pending.length) return
    const names = pending.map((p) => p._attachment?.name ?? 'arquivo')
    out.push({
      role: 'user',
      content: [
        ...pending,
        { type: 'text', text: `[arquivos retornados por read_file: ${names.join(', ')}]` }
      ]
    })
    pending = []
  }
  for (const m of messages) {
    if (m.role !== 'tool') flush()
    if (m.role !== 'tool' || typeof m.content === 'string') {
      out.push(m)
      continue
    }
    const media = m.content.filter((p) => p.type !== 'text')
    const text = m.content
      .filter((p) => p.type === 'text')
      .map((p) => (p as { text: string }).text)
      .join('\n')
    if (!media.length) {
      out.push({ ...m, content: text })
      continue
    }
    const what = media.every((p) => p.type === 'image_url') ? 'imagem anexada' : 'arquivo anexado'
    out.push({ ...m, content: `${text}${text ? '\n' : ''}[${what} na próxima mensagem]` })
    pending.push(...media)
  }
  flush()
  return out
}
