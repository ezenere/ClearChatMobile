// Cripto das notificações push (SYNC_PROTOCOL.md §3.7, §3.10, §22.4): K_push = HKDF(DEK, info
// "clearchat/v1/push"), envelope §3.9 com AAD `clearchat|v1|push|<user_id>|<kind>|<tag>`. A cripto
// do site vendorada ainda não tem K_push (só o desktop/servidor usam) — fica aqui, sobre as mesmas
// primitivas, conferida contra docs/test-vectors/push.json.
import {
  type Bytes,
  type Envelope,
  frameJson,
  hkdf,
  isWellFormedEnvelope,
  open,
  seal,
  unframeJson,
  utf8
} from '@/crypto'

export const PUSH_INFO = 'clearchat/v1/push'

/** K_push (§3.7). */
export function pushKey(dek: Uint8Array): Promise<Bytes> {
  if (dek.length !== 32) throw new Error('DEK precisa de 32 bytes')
  return hkdf(dek, new Uint8Array(0), PUSH_INFO)
}

/** AAD do aviso (§3.10). */
export const aadPush = (userId: string, kind: string, tag: string): Bytes =>
  utf8(`clearchat|v1|push|${userId}|${kind}|${tag}`)

/** Cifra um PushPayload (testes e a rota de desenvolvimento; quem envia de verdade é o host). */
export async function sealPush(
  key: Uint8Array,
  userId: string,
  kind: string,
  tag: string,
  payload: Record<string, unknown>,
  nonce?: Uint8Array
): Promise<Envelope> {
  const json = JSON.stringify(payload)
  const frame = await frameJson(json, utf8(json).length > 1024)
  return seal(key, aadPush(userId, kind, tag), frame, nonce)
}

/** Decifra o envelope (falha de autenticação/AAD → AuthError; formato inválido → Error). */
export async function openPush(
  key: Uint8Array,
  userId: string,
  kind: string,
  tag: string,
  env: unknown
): Promise<Record<string, unknown>> {
  if (!isWellFormedEnvelope(env)) throw new Error('envelope malformado')
  return unframeJson(await open(key, aadPush(userId, kind, tag), env))
}
