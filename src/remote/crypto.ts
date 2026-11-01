// Envelopes do stream e dos comandos remotos (SYNC_PROTOCOL.md §3.9–3.10, §8.6, §11): JSON com a
// moldura de formato (deflate acima de 1 KiB) cifrado com K_stream e a AAD do contexto.
import {
  aadCommand,
  aadCommandResult,
  aadStream,
  COMPRESS_THRESHOLD,
  frameJson,
  open,
  seal,
  unframeJson,
  utf8,
  type Envelope
} from '@/crypto'

export type { Envelope }

export async function sealJson(
  key: Uint8Array,
  aad: Uint8Array,
  obj: Record<string, unknown>,
  nonce?: Uint8Array
): Promise<Envelope> {
  const json = JSON.stringify(obj)
  const frame = await frameJson(json, utf8(json).length > COMPRESS_THRESHOLD)
  return seal(key, aad, frame, nonce)
}

export async function openJson(
  key: Uint8Array,
  aad: Uint8Array,
  env: Envelope
): Promise<Record<string, unknown>> {
  return unframeJson(await open(key, aad, env))
}

/** Plaintext de um comando (`sv: 1` + `kind` + campos do §8.6). */
export function sealCommand(
  key: Uint8Array,
  userId: string,
  chatId: string,
  cmdId: string,
  payload: Record<string, unknown>,
  nonce?: Uint8Array
): Promise<Envelope> {
  return sealJson(key, aadCommand(userId, chatId, cmdId), { sv: 1, ...payload }, nonce)
}

export function openCommand(
  key: Uint8Array,
  userId: string,
  chatId: string,
  cmdId: string,
  env: Envelope
): Promise<Record<string, unknown>> {
  return openJson(key, aadCommand(userId, chatId, cmdId), env)
}

export function sealResult(
  key: Uint8Array,
  userId: string,
  chatId: string,
  cmdId: string,
  result: Record<string, unknown>
): Promise<Envelope> {
  return sealJson(key, aadCommandResult(userId, chatId, cmdId), { sv: 1, ...result })
}

export function openResult(
  key: Uint8Array,
  userId: string,
  chatId: string,
  cmdId: string,
  env: Envelope
): Promise<Record<string, unknown>> {
  return openJson(key, aadCommandResult(userId, chatId, cmdId), env)
}

export function sealStream(
  key: Uint8Array,
  userId: string,
  chatId: string,
  epoch: number,
  n: number,
  payload: Record<string, unknown>
): Promise<Envelope> {
  return sealJson(key, aadStream(userId, chatId, epoch, n), { sv: 1, ...payload })
}

export function openStream(
  key: Uint8Array,
  userId: string,
  chatId: string,
  epoch: number,
  n: number,
  env: Envelope
): Promise<Record<string, unknown>> {
  return openJson(key, aadStream(userId, chatId, epoch, n), env)
}
