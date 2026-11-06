// Fonte dos anexos exibidos num chat só ao vivo (§23.7): baixa do host por `attach.get` para a
// MEMÓRIA. Imagens viram `data:` (e o expo-image usa só o cache de memória); PDF/áudio, que só
// abrem no app do sistema, passam por um arquivo temporário apagado ao sair do chat / bloquear.
import type { AttachmentSource } from '@/data/react'
import { toStdB64 } from './attach'
import type { LiveService } from './service'

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|heic|heif|avif)$/i

export interface LiveSourceDeps {
  live: Pick<LiveService, 'file' | 'cachedFile'>
  chatId: string
  /** Grava um arquivo temporário (PDF/áudio) e devolve a URI. */
  temp: (name: string, bytes: Uint8Array) => string
}

export function liveAttachmentSource(d: LiveSourceDeps): AttachmentSource {
  const uris = new Map<string, string>()
  const listeners = new Set<(file: string) => void>()
  const toUri = (file: string, mime: string | null, bytes: Uint8Array): string => {
    if (IMAGE_EXT.test(file) || mime?.startsWith('image/'))
      return `data:${mime && mime.startsWith('image/') ? mime : 'image/png'};base64,${toStdB64(bytes)}`
    return d.temp(file, bytes)
  }
  return {
    memoryOnly: true,
    local(file) {
      const u = uris.get(file)
      if (u) return u
      // imagem já em memória (ex.: a que acabou de ser anexada no composer)
      const c = d.live.cachedFile(d.chatId, file)
      if (c && (IMAGE_EXT.test(file) || c.mime?.startsWith('image/'))) {
        const uri = toUri(file, c.mime, c.bytes)
        uris.set(file, uri)
        return uri
      }
      return null
    },
    async ensure(file) {
      const have = uris.get(file)
      if (have) return have
      const got = await d.live.file(d.chatId, file)
      const uri = toUri(file, got.mime, got.bytes)
      uris.set(file, uri)
      for (const fn of listeners) fn(file)
      return uri
    },
    onReady(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    }
  }
}
