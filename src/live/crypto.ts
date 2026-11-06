// Anúncio de chat só ao vivo (SYNC_PROTOCOL.md §23.4, §3.10): envelope §3.9 com K_stream e AAD
// `clearchat|v1|live-announce|<user_id>|<host_device_id>|<chat_id>|<epoch>|<arev>` — amarra o host,
// o chat, o epoch ao vivo e a revisão do anúncio (o servidor não troca um anúncio de host nem serve
// um velho dentro do mesmo epoch). O histórico (`history.*`) e o `rec` reusam as AADs de comando,
// resultado e stream (src/remote/crypto.ts). A AAD vem da cripto vendorada do site (keys.ts).
import { aadLiveAnnounce } from '@/crypto'
import { openJson, sealJson, type Envelope } from '@/remote/crypto'

export { aadLiveAnnounce }

export function sealAnnounce(
  key: Uint8Array,
  userId: string,
  hostDeviceId: string,
  chatId: string,
  epoch: number,
  arev: number,
  info: Record<string, unknown>,
  nonce?: Uint8Array
): Promise<Envelope> {
  return sealJson(key, aadLiveAnnounce(userId, hostDeviceId, chatId, epoch, arev), info, nonce)
}

export function openAnnounce(
  key: Uint8Array,
  userId: string,
  hostDeviceId: string,
  chatId: string,
  epoch: number,
  arev: number,
  env: Envelope
): Promise<Record<string, unknown>> {
  return openJson(key, aadLiveAnnounce(userId, hostDeviceId, chatId, epoch, arev), env)
}
