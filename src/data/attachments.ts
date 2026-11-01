// Anexos (SYNC_PROTOCOL.md §14, §3.11): `clearchat-attachment://<sha256>.<ext>` → blob_id
// (HMAC do sha256) → GET /blobs/{id} → decifra o CCB1 → confere o SHA-256 → grava no store local
// (escrita atômica). Sem React Native: o sistema de arquivos entra por `AttachmentFs`.
import { ATTACHMENT_FILE_RE, parseAttachmentUrl } from '@shared/attachments'
import { SyncApiError, SyncNetworkError } from '@vendor/desktop/sync/http'
import { blobIdFromSha256, decryptBlob, fromHex, hex, sha256 } from '@/crypto'
import { UserError } from '@/account/errors'
import type { EngineKeys } from './engine'

export interface AttachmentFs {
  exists(file: string): boolean
  /** URI local do arquivo (file://…). */
  uri(file: string): string
  /** Escrita atômica (temporário + rename). */
  write(file: string, data: Uint8Array): void
  /** Apaga o store inteiro (logout/troca de conta). */
  clear(): void
}

export interface AttachmentDeps {
  fs: AttachmentFs
  keys: () => EngineKeys | null
  /** Ciphertext do blob (GET /blobs/{id}). */
  fetchBlob: (blobId: string) => Promise<Uint8Array>
  log?: (msg: string) => void
}

/** Nome do arquivo no store a partir de uma referência (`clearchat-attachment://…` ou o nome). */
export function attachmentFile(ref: string): string | null {
  const f = parseAttachmentUrl(ref) ?? ref
  return ATTACHMENT_FILE_RE.test(f) ? f : null
}

export class AttachmentStore {
  private readonly d: AttachmentDeps
  private inflight = new Map<string, Promise<string>>()
  private listeners = new Set<(file: string) => void>()

  constructor(deps: AttachmentDeps) {
    this.d = deps
  }

  /** URI local se o arquivo já está no aparelho. */
  local(file: string): string | null {
    try {
      return this.d.fs.exists(file) ? this.d.fs.uri(file) : null
    } catch {
      return null
    }
  }

  isLoading(file: string): boolean {
    return this.inflight.has(file)
  }

  onReady(fn: (file: string) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** Garante o arquivo no aparelho (baixa sob demanda) e devolve a URI local. */
  ensure(file: string): Promise<string> {
    if (!ATTACHMENT_FILE_RE.test(file)) return Promise.reject(new UserError('Anexo inválido.'))
    const have = this.local(file)
    if (have) return Promise.resolve(have)
    const cur = this.inflight.get(file)
    if (cur) return cur
    const p = this.download(file).finally(() => this.inflight.delete(file))
    this.inflight.set(file, p)
    return p
  }

  private async download(file: string): Promise<string> {
    const keys = this.d.keys()
    if (!keys) throw new UserError('Desbloqueie a conta para baixar o anexo.')
    const sha = file.slice(0, 64)
    const blobId = await blobIdFromSha256(keys.sk, fromHex(sha))
    let ct: Uint8Array
    try {
      ct = await this.d.fetchBlob(blobId)
    } catch (e) {
      if (e instanceof SyncNetworkError)
        throw new UserError('Sem conexão — o anexo ainda não foi baixado neste aparelho.', {
          cause: e
        })
      if (e instanceof SyncApiError && e.code === 'not_found')
        throw new UserError('Arquivo ausente no servidor.', { cause: e })
      throw e
    }
    const plain = await decryptBlob(keys.sk, keys.userId, blobId, ct)
    if (hex(await sha256(plain)) !== sha) {
      this.d.log?.(`anexo com sha256 divergente: ${blobId}`)
      throw new UserError('O anexo baixado não confere (sha256).')
    }
    this.d.fs.write(file, plain)
    for (const fn of this.listeners) fn(file)
    return this.d.fs.uri(file)
  }

  /** Grava um arquivo já conferido (anexo escolhido neste aparelho) e avisa quem espera por ele. */
  put(file: string, data: Uint8Array): string {
    if (!ATTACHMENT_FILE_RE.test(file)) throw new UserError('Anexo inválido.')
    if (!this.local(file)) this.d.fs.write(file, data)
    for (const fn of this.listeners) fn(file)
    return this.d.fs.uri(file)
  }

  clear(): void {
    this.inflight.clear()
    try {
      this.d.fs.clear()
    } catch {
      /* nada para apagar */
    }
  }
}
