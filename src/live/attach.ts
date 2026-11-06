// Anexos de chats só ao vivo (SYNC_PROTOCOL.md §23.7): nada vira blob — os bytes viajam em pedaços
// de `ATTACH_CHUNK_BYTES` dentro dos comandos remotos cifrados, só retransmitidos pelo servidor.
// - `attach.put`: o celular manda um arquivo ao host (pedaços contíguos, um por vez; o primeiro já é
//   validado pelo host; pedaço repetido é idempotente; `offset` recusado → continua do `received`;
//   `expired` → recomeça do 0; cancelar descarta no host). O último devolve o `AttachmentInfo` salvo
//   no store do host, que o `send` usa como referência.
// - `attach.get`: baixa do host um anexo do histórico (como `fs.read`), confere o SHA-256 do nome e
//   guarda SÓ EM MEMÓRIA (cache limitado por bytes, solto quando sai da tela / do chat).
// Puro: os comandos entram por `command`.
import { classifyAttachment } from '@shared/attachments'
import type { AttachmentInfo, AttachmentKind } from '@shared/types'
import { b64u, hex, sha256 } from '@/crypto'
import { UserError } from '@/account/errors'
import { isUtf8, storeExt } from '@/remote/upload'
import { fromStdB64 } from './history'
import { isSafeInt, LIVE } from './types'

export type AttachCommand = (
  kind: 'attach.put' | 'attach.get',
  payload: Record<string, unknown>
) => Promise<Record<string, unknown>>

/** Bytes → base64 padrão (com `=`). */
export function toStdB64(b: Uint8Array): string {
  const s = b64u(b).replace(/-/g, '+').replace(/_/g, '/')
  return s + '='.repeat((4 - (s.length % 4)) % 4)
}

const FILE_RE = /^[0-9a-f]{64}\.[a-z0-9]{1,10}$/

const errText = (r: Record<string, unknown>, fallback: string): string =>
  typeof r.error === 'string' && r.error ? r.error : fallback

/** Recusa do host num `attach.*` (com o `code` do §23.7). */
export class AttachError extends UserError {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

// ---------------- envio (attach.put) ----------------

export interface LiveUploadInput {
  chatId: string
  data: Uint8Array
  name: string
  mime?: string
}

export interface ClassifiedUpload {
  name: string
  mime: string
  kind: AttachmentKind
  size: number
  sha256: string
  /** `<sha256>.<ext>` (o host grava com o mesmo nome, §14). */
  file: string
}

/** Mesmas regras do composer (tipo, texto UTF-8, tamanho) antes de mandar ao host. */
export async function classifyUpload(
  data: Uint8Array,
  name: string,
  mime: string | undefined
): Promise<ClassifiedUpload> {
  const cleanName = (name || 'arquivo').split(/[\\/]/).pop()!.slice(0, 180) || 'arquivo'
  if (data.length > LIVE.attachMaxFileBytes)
    throw new UserError(
      `“${cleanName}” passa de ${Math.round(LIVE.attachMaxFileBytes / 1048576)} MB.`
    )
  const c = classifyAttachment(cleanName, mime)
  let kind: AttachmentKind
  if (c.kind === 'maybe-text') {
    if (!isUtf8(data)) throw new UserError(`“${cleanName}”: tipo de arquivo não suportado.`)
    kind = 'text'
  } else if (!c.kind) throw new UserError(`“${cleanName}”: tipo de arquivo não suportado.`)
  else kind = c.kind
  const finalMime = c.kind === 'maybe-text' ? 'text/plain' : c.mime
  const sha = hex(await sha256(data))
  return {
    name: cleanName,
    mime: finalMime,
    kind,
    size: data.length,
    sha256: sha,
    file: `${sha}.${storeExt(cleanName, finalMime, kind)}`
  }
}

export interface UploadHandle {
  /** O anexo salvo no host (a referência que o `send` leva). */
  done: Promise<AttachmentInfo>
  /** Cancela (descarta no host). */
  cancel: () => void
}

export interface UploadOptions {
  onProgress?: (sent: number, total: number) => void
  uuid?: () => string
  /** Tentativas do MESMO pedaço depois de timeout / host caiu / sem conexão (idempotente pelo offset). */
  retries?: number
  /** Espera entre tentativas (testes encurtam). */
  sleep?: (ms: number) => Promise<void>
}

/** Falhas passageiras: repetir o mesmo pedaço é seguro. `disconnected` = o socket está voltando
 * (ex.: o seletor de arquivos pôs o app em segundo plano e o WebSocket foi fechado). */
const TRANSIENT = new Set(['command_timeout', 'host_offline', 'disconnected', 'timeout'])

function parseAttachment(v: unknown, sha: string): AttachmentInfo | null {
  if (!v || typeof v !== 'object') return null
  const a = v as Record<string, unknown>
  if (typeof a.file !== 'string' || !FILE_RE.test(a.file) || a.sha256 !== sha) return null
  if (!a.file.startsWith(sha)) return null
  const kind = a.kind
  if (kind !== 'image' && kind !== 'pdf' && kind !== 'audio' && kind !== 'text') return null
  return {
    name: typeof a.name === 'string' && a.name ? a.name : 'arquivo',
    mime: typeof a.mime === 'string' ? a.mime : 'application/octet-stream',
    size: isSafeInt(a.size) ? a.size : 0,
    kind,
    file: a.file,
    sha256: sha,
    ...(a.truncated === true ? { truncated: true } : {})
  } as AttachmentInfo
}

/** Manda um arquivo ao host de um chat ao vivo, pedaço por pedaço (§23.7). */
export function uploadToHost(
  command: AttachCommand,
  input: LiveUploadInput,
  c: ClassifiedUpload,
  opts: UploadOptions = {}
): UploadHandle {
  const uuid = opts.uuid ?? (() => crypto.randomUUID())
  const retries = opts.retries ?? 6
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  let uploadId = uuid()
  let cancelled = false
  let started = false
  const chunk = LIVE.attachChunkBytes
  const total = input.data.length

  const sendChunk = async (offset: number): Promise<Record<string, unknown>> => {
    const data = input.data.subarray(offset, Math.min(total, offset + chunk))
    let last: unknown = null
    for (let i = 0; i <= retries; i++) {
      if (cancelled) throw new AttachError('cancelled', 'Envio cancelado.')
      try {
        return await command('attach.put', {
          chatId: input.chatId,
          uploadId,
          name: c.name,
          mime: c.mime,
          size: total,
          sha256: c.sha256,
          offset,
          data: toStdB64(data)
        })
      } catch (e) {
        last = e
        // sem conexão / host caiu: repetir o mesmo pedaço é seguro (idempotente pelo offset)
        const code = (e as { code?: string })?.code
        if (!code || !TRANSIENT.has(code) || i === retries) throw e
        await sleep(Math.min(4000, 500 * 2 ** i))
      }
    }
    throw last instanceof Error ? last : new Error(String(last))
  }

  const done = (async (): Promise<AttachmentInfo> => {
    let offset = 0
    let restarts = 0
    started = true
    for (let steps = 0; steps < 100_000; steps++) {
      const r = await sendChunk(offset)
      if (r.status === 'rejected') {
        const code = typeof r.code === 'string' ? r.code : 'invalid'
        if (code === 'offset' && isSafeInt(r.received) && r.received <= total) {
          offset = r.received
          continue
        }
        if (code === 'expired' && restarts < 2) {
          restarts++
          uploadId = uuid()
          offset = 0
          continue
        }
        throw new AttachError(code, errText(r, 'O host recusou o anexo.'))
      }
      if (r.status !== 'accepted') throw new AttachError('invalid', 'Resposta inválida do host.')
      if (r.done === true) {
        const info = parseAttachment(r.attachment, c.sha256)
        if (!info) throw new AttachError('invalid', 'Resposta inválida do host.')
        opts.onProgress?.(total, total)
        return info
      }
      const received = isSafeInt(r.received) ? r.received : offset
      if (received <= offset && offset < total)
        throw new AttachError('invalid', 'O host não avançou o envio.')
      if (received >= total) throw new AttachError('invalid', 'Resposta inválida do host.')
      offset = received
      opts.onProgress?.(offset, total)
    }
    throw new AttachError('invalid', 'Envio interrompido.')
  })()
  done.catch(() => undefined)

  return {
    done,
    cancel: () => {
      if (cancelled) return
      cancelled = true
      if (started)
        void command('attach.put', { chatId: input.chatId, uploadId, cancel: true }).catch(
          () => undefined
        )
    }
  }
}

// ---------------- download (attach.get) ----------------

export interface Downloaded {
  file: string
  mime: string | null
  bytes: Uint8Array
}

/** Teto de um anexo baixado para a memória (o host serve até FS_READ_MAX_FILE_BYTES). */
export const ATTACH_GET_MAX_BYTES = 64 * 1024 * 1024

/** Baixa um anexo do store do host em pedaços e confere o SHA-256 do nome (§23.7). */
export async function downloadFromHost(
  command: AttachCommand,
  chatId: string,
  file: string,
  maxBytes = ATTACH_GET_MAX_BYTES
): Promise<Downloaded> {
  if (!FILE_RE.test(file)) throw new AttachError('invalid', 'Anexo inválido.')
  const parts: Uint8Array[] = []
  let offset = 0
  let size = -1
  let mime: string | null = null
  for (let i = 0; i < 100_000; i++) {
    const r = await command('attach.get', {
      chatId,
      file,
      offset,
      length: LIVE.attachChunkBytes
    })
    if (r.status === 'rejected') {
      const code = typeof r.code === 'string' ? r.code : 'invalid'
      throw new AttachError(
        code,
        code === 'missing'
          ? 'O anexo não está mais no host.'
          : errText(r, 'O host recusou o anexo.')
      )
    }
    if (r.status !== 'accepted' || !isSafeInt(r.size) || r.offset !== offset)
      throw new AttachError('invalid', 'Resposta inválida do host.')
    if (typeof r.data !== 'string') throw new AttachError('invalid', 'Resposta inválida do host.')
    if (size < 0) {
      size = r.size
      if (size > maxBytes)
        throw new AttachError('too_large', 'O anexo é grande demais para abrir aqui.')
      if (typeof r.mime === 'string' && r.mime) mime = r.mime
    } else if (r.size !== size)
      throw new AttachError('changed', 'O anexo mudou no host durante o download.')
    const bytes = fromStdB64(r.data)
    if (bytes.length > LIVE.attachChunkBytes)
      throw new AttachError('invalid', 'Resposta inválida do host.')
    if (!bytes.length && offset < size)
      throw new AttachError('invalid', 'Resposta inválida do host.')
    parts.push(bytes)
    offset += bytes.length
    if (offset >= size) break
  }
  const all = new Uint8Array(offset)
  let at = 0
  for (const b of parts) {
    all.set(b, at)
    at += b.length
  }
  if (hex(await sha256(all)) !== file.slice(0, 64))
    throw new AttachError('hash', 'O anexo baixado não confere (sha256).')
  return { file, mime, bytes: all }
}

/** Cache em memória dos anexos baixados (LRU por bytes). Nunca toca o disco. */
export class MemoryAttachments {
  private map = new Map<string, Downloaded>()
  private bytes = 0
  private readonly cap: number

  constructor(capBytes = 96 * 1024 * 1024) {
    this.cap = capBytes
  }

  get(file: string): Downloaded | null {
    const d = this.map.get(file)
    if (!d) return null
    // LRU: o usado vai para o fim
    this.map.delete(file)
    this.map.set(file, d)
    return d
  }

  put(d: Downloaded): void {
    const old = this.map.get(d.file)
    if (old) {
      this.bytes -= old.bytes.length
      this.map.delete(d.file)
    }
    this.map.set(d.file, d)
    this.bytes += d.bytes.length
    for (const [k, v] of this.map) {
      if (this.bytes <= this.cap || k === d.file) break
      this.map.delete(k)
      this.bytes -= v.bytes.length
    }
  }

  delete(file: string): void {
    const d = this.map.get(file)
    if (!d) return
    this.bytes -= d.bytes.length
    this.map.delete(file)
  }

  /** Solta tudo cuja chave começa com `prefix` (ex.: os anexos de um chat). */
  deletePrefix(prefix: string): void {
    for (const k of [...this.map.keys()]) if (k.startsWith(prefix)) this.delete(k)
  }

  clear(): void {
    for (const d of this.map.values()) d.bytes.fill(0)
    this.map.clear()
    this.bytes = 0
  }

  get size(): number {
    return this.map.size
  }

  get totalBytes(): number {
    return this.bytes
  }
}
