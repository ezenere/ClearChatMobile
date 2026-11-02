// ask_user no celular: resolve ícones/imagens/ajuda das opções para arquivos do store de anexos
// (porta de ClearChatDesktop/src/main/askUserImages.ts). URL → baixada (timeout, limite, só
// image/*); SVG inline / data URL → salvos; caminho local → indisponível (o celular não lê arquivos
// do chat). Falha numa imagem não derruba a tool: some e vai uma nota ao modelo.
import { attachmentUrl } from '@shared/attachments'
import {
  ASK_USER_LIMITS,
  classifyHelp,
  classifyIcon,
  classifyImageRef,
  type RawAskUserQuestion
} from '@shared/askUser'
import type { AskUserOption, AskUserQuestion } from '@shared/types'

export interface ImageResolveCtx {
  /** Grava no store (sha256 + ext) e devolve o nome do arquivo. */
  save: (data: Uint8Array, ext: string) => Promise<string>
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg'
}

const latin1 = (b: Uint8Array, a: number, z: number): string =>
  String.fromCharCode(...b.subarray(a, Math.min(z, b.length)))

/** Formato real pelos bytes (png/jpg/gif/webp/svg) ou null. */
export function sniffImage(b: Uint8Array): string | null {
  const hex8 = Array.from(b.subarray(0, 8), (x) => x.toString(16).padStart(2, '0')).join('')
  if (b.length >= 8 && hex8 === '89504e470d0a1a0a') return 'png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg'
  if (b.length >= 6 && /^GIF8[79]a$/.test(latin1(b, 0, 6))) return 'gif'
  if (b.length >= 12 && latin1(b, 0, 4) === 'RIFF' && latin1(b, 8, 12) === 'WEBP') return 'webp'
  let head = ''
  try {
    head = new TextDecoder().decode(b.subarray(0, 4096)).replace(/^\uFEFF/, '')
  } catch {
    return null
  }
  if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(head))
    return 'svg'
  return null
}

class ImageError extends Error {}

const sizeErr = (n: number): ImageError =>
  new ImageError(
    `${(n / 1024 / 1024).toFixed(1)} MB — máximo ${ASK_USER_LIMITS.imageBytes / 1024 / 1024} MB`
  )

async function store(data: Uint8Array, ctx: ImageResolveCtx): Promise<string> {
  const fmt = sniffImage(data)
  if (!fmt) throw new ImageError('não é uma imagem png/jpeg/webp/gif/svg')
  return attachmentUrl(await ctx.save(data, fmt))
}

async function download(url: string, ctx: ImageResolveCtx): Promise<string> {
  const timeout = AbortSignal.timeout(ASK_USER_LIMITS.downloadTimeoutMs)
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout
  let res: Response
  try {
    res = await (ctx.fetchImpl ?? fetch)(url, {
      signal,
      headers: { Accept: 'image/png,image/jpeg,image/webp,image/gif,image/svg+xml;q=0.9' }
    })
  } catch (e) {
    if (ctx.signal?.aborted) throw e
    if (timeout.aborted)
      throw new ImageError(`tempo esgotado (${ASK_USER_LIMITS.downloadTimeoutMs / 1000} s)`)
    throw new ImageError(`falha de rede: ${(e as Error).message}`)
  }
  if (!res.ok) throw new ImageError(`HTTP ${res.status}`)
  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  if (!MIME_EXT[type]) throw new ImageError(`tipo não suportado (${type || 'sem content-type'})`)
  const len = Number(res.headers.get('content-length'))
  if (Number.isFinite(len) && len > ASK_USER_LIMITS.imageBytes) throw sizeErr(len)
  const data = new Uint8Array(await res.arrayBuffer())
  if (data.length > ASK_USER_LIMITS.imageBytes) throw sizeErr(data.length)
  if (!data.length) throw new ImageError('resposta vazia')
  if (!sniffImage(data)) throw new ImageError(`o conteúdo não é uma imagem válida (${type})`)
  return store(data, ctx)
}

function base64ToBytes(s: string): Uint8Array {
  const bin = atob(s.replace(/\s+/g, ''))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function fromData(ref: string, ctx: ImageResolveCtx): Promise<string> {
  const m = /^data:([^;,]*)(;base64)?,(.*)$/is.exec(ref)
  if (!m) throw new ImageError('data URL inválida')
  const data = m[2] ? base64ToBytes(m[3]) : new TextEncoder().encode(decodeURIComponent(m[3]))
  if (data.length > ASK_USER_LIMITS.imageBytes) throw sizeErr(data.length)
  return store(data, ctx)
}

export async function resolveImageRef(ref: string, ctx: ImageResolveCtx): Promise<string> {
  const t = ref.trim()
  switch (classifyImageRef(t)) {
    case 'svg': {
      const data = new TextEncoder().encode(t)
      if (data.length > ASK_USER_LIMITS.svgBytes)
        throw new ImageError(`SVG com mais de ${ASK_USER_LIMITS.svgBytes / 1024} KB`)
      if (sniffImage(data) !== 'svg') throw new ImageError('SVG inválido')
      return attachmentUrl(await ctx.save(data, 'svg'))
    }
    case 'url':
      return download(t, ctx)
    case 'data':
      return fromData(t, ctx)
    default:
      throw new ImageError('caminho local indisponível (o chat roda no celular, sem arquivos)')
  }
}

const reason = (e: unknown): string =>
  e instanceof ImageError ? e.message : (e as Error)?.message || String(e)

export async function resolveAskUserQuestions(
  raw: RawAskUserQuestion[],
  ctx: ImageResolveCtx
): Promise<{ questions: AskUserQuestion[]; notes: string[] }> {
  const notes: string[] = []
  const tryImg = async (ref: string, what: string): Promise<string | undefined> => {
    try {
      return await resolveImageRef(ref, ctx)
    } catch (e) {
      if (ctx.signal?.aborted) throw e
      notes.push(`[${what} indisponível: ${reason(e)}]`)
      return undefined
    }
  }
  const questions: AskUserQuestion[] = []
  for (let qi = 0; qi < raw.length; qi++) {
    const q = raw[qi]
    const options: AskUserOption[] = []
    for (let oi = 0; oi < q.options.length; oi++) {
      const o = q.options[oi]
      const where = `da opção ${oi + 1} da pergunta ${qi + 1}`
      const opt: AskUserOption = { title: o.title }
      if (o.description) opt.description = o.description
      if (o.icon) {
        const k = classifyIcon(o.icon)
        if (k === 'lucide') opt.icon = { kind: 'lucide', name: o.icon.trim() }
        else if (k === 'text') opt.icon = { kind: 'text', text: o.icon.trim() }
        else {
          const url = await tryImg(o.icon, `ícone ${where}`)
          if (url) opt.icon = { kind: 'image', url }
        }
      }
      if (o.image) {
        const url = await tryImg(o.image, `imagem ${where}`)
        if (url) opt.image = url
      }
      if (o.help) {
        if (classifyHelp(o.help) === 'text') opt.help = { kind: 'text', text: o.help }
        else {
          const url = await tryImg(o.help, `imagem de ajuda ${where}`)
          if (url) opt.help = { kind: 'image', url }
        }
      }
      options.push(opt)
    }
    questions.push({
      title: q.title,
      ...(q.description ? { description: q.description } : {}),
      multiple: q.multiple,
      options
    })
  }
  return { questions, notes }
}
