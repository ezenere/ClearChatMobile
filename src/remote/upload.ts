// Anexos enviados pelo celular (SYNC_PROTOCOL.md §14, §3.11): classifica como o desktop
// (imagem/PDF/áudio/texto), grava `<sha256>.<ext>` no store local, calcula o blob_id (HMAC do
// sha256), confere no servidor (`POST /blobs/check`) e sobe o CCB1 que faltar (`PUT /blobs/{id}`
// com `X-Content-SHA256` do ciphertext) — sempre ANTES do comando `send` que o referencia.
import { ATTACHMENT_LIMITS } from '@shared/limits'
import { classifyAttachment, fileExt, IMAGE_MIMES } from '@shared/attachments'
import type { AttachmentInfo, AttachmentKind } from '@shared/types'
import { blobIdFromSha256, encryptBlob, hex, randomBytes, sha256, type Subkeys } from '@/crypto'
import { UserError } from '@/account/errors'

export interface UploadDeps {
  keys: () => { userId: string; sk: Subkeys } | null
  /** Grava no store local de anexos (a miniatura aparece na hora). */
  put: (file: string, data: Uint8Array) => void
  post: <T = unknown>(path: string, json: unknown) => Promise<T>
  putBlob: (blobId: string, ciphertext: Uint8Array, sha256Hex: string) => Promise<void>
}

/** Anexo pronto para enviar: os bytes ficam até o upload terminar. */
export interface PreparedAttachment {
  info: AttachmentInfo
  blobId: string
  data: Uint8Array
}

const MIME_EXT: Record<string, string> = {
  ...Object.fromEntries(Object.entries(IMAGE_MIMES).map(([ext, m]) => [m, ext])),
  'image/jpeg': 'jpg',
  'application/pdf': 'pdf',
  'audio/wav': 'wav',
  'audio/mpeg': 'mp3',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'application/json': 'json'
}

/** UTF-8 estrito? (arquivos de tipo desconhecido só entram como texto se forem UTF-8). */
export function isUtf8(data: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(data)
    return true
  } catch {
    return false
  }
}

/** Extensão do arquivo no store (o host grava com ela, §14). */
export function storeExt(name: string, mime: string, kind: AttachmentKind): string {
  const e = fileExt(name)
  if (/^[a-z0-9]{1,10}$/.test(e)) return e
  return MIME_EXT[mime] ?? (kind === 'text' ? 'txt' : 'bin')
}

/** Classifica, confere os limites e grava localmente. Lança `UserError` em pt-BR. */
export async function prepareAttachment(
  deps: UploadDeps,
  data: Uint8Array,
  name: string,
  mime: string | undefined
): Promise<PreparedAttachment> {
  const keys = deps.keys()
  if (!keys) throw new UserError('Desbloqueie a conta primeiro.')
  const cleanName = (name || 'arquivo').split(/[\\/]/).pop()!.slice(0, 180) || 'arquivo'
  if (data.length > ATTACHMENT_LIMITS.maxFileBytes)
    throw new UserError(
      `“${cleanName}” passa de ${Math.round(ATTACHMENT_LIMITS.maxFileBytes / 1048576)} MB.`
    )
  const c = classifyAttachment(cleanName, mime)
  let kind: AttachmentKind
  if (c.kind === 'maybe-text') {
    if (!isUtf8(data)) throw new UserError(`“${cleanName}”: tipo de arquivo não suportado.`)
    kind = 'text'
  } else if (!c.kind) throw new UserError(`“${cleanName}”: tipo de arquivo não suportado.`)
  else kind = c.kind
  const finalMime = c.kind === 'maybe-text' ? 'text/plain' : c.mime
  const digest = await sha256(data)
  const sha = hex(digest)
  const file = `${sha}.${storeExt(cleanName, finalMime, kind)}`
  deps.put(file, data)
  const blobId = await blobIdFromSha256(keys.sk, digest)
  return {
    info: { name: cleanName, mime: finalMime, size: data.length, kind, file, sha256: sha },
    blobId,
    data
  }
}

/** Garante os blobs no servidor (só sobe os ausentes). */
export async function uploadAttachments(
  deps: UploadDeps,
  items: PreparedAttachment[]
): Promise<void> {
  if (!items.length) return
  const keys = deps.keys()
  if (!keys) throw new UserError('Desbloqueie a conta primeiro.')
  const ids = [...new Set(items.map((i) => i.blobId))]
  const r = await deps.post<{ missing?: string[] }>('/api/v1/blobs/check', { ids })
  const missing = new Set(r?.missing ?? ids)
  for (const it of items) {
    if (!missing.has(it.blobId)) continue
    missing.delete(it.blobId)
    const ct = await encryptBlob(keys.sk, keys.userId, it.blobId, it.data, randomBytes(16))
    await deps.putBlob(it.blobId, ct, hex(await sha256(ct)))
  }
}

/** Soma/quantidade dentro dos limites de uma mensagem (§ anexos do desktop). */
export function checkMessageLimits(list: { size: number }[]): string | null {
  if (list.length > ATTACHMENT_LIMITS.maxFiles)
    return `No máximo ${ATTACHMENT_LIMITS.maxFiles} anexos por mensagem.`
  const total = list.reduce((n, a) => n + a.size, 0)
  if (total > ATTACHMENT_LIMITS.maxTotalBytes)
    return `Os anexos somam mais de ${Math.round(ATTACHMENT_LIMITS.maxTotalBytes / 1048576)} MB.`
  return null
}
