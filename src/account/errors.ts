// Mensagens pt-BR para erros da API (SYNC_PROTOCOL.md §6.1, §17.4), da rede e da cripto.
import { SyncApiError, SyncNetworkError } from '@vendor/desktop/sync/http'
import { AuthError, RecoveryKeyError } from '@/crypto'

/** Erro com texto já pronto para o usuário (validações locais). */
export class UserError extends Error {}

export function retryAfterSeconds(e: unknown): number | null {
  if (!(e instanceof SyncApiError) || e.code !== 'rate_limited') return null
  const ra = Number(e.details.retry_after ?? 0)
  return Number.isFinite(ra) && ra > 0 ? ra : null
}

export function formatWait(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.ceil(seconds))} s`
  const min = Math.ceil(seconds / 60)
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  const rest = min % 60
  return rest ? `${h} h ${rest} min` : `${h} h`
}

const BY_CODE: Record<string, string> = {
  code_invalid: 'Código incorreto ou expirado. Confira os 6 dígitos ou peça um novo.',
  captcha_failed: 'A verificação anti-robô falhou ou expirou. Tente de novo.',
  signup_closed: 'O cadastro está fechado nesta instância. Peça um convite ao administrador.',
  invite_invalid: 'Convite inválido ou expirado.',
  account_disabled: 'Esta conta foi desativada pelo administrador da instância.',
  device_revoked: 'Este aparelho foi desconectado da conta.',
  refresh_reused: 'A sessão deste aparelho foi encerrada por segurança. Entre de novo.',
  unauthorized: 'Sua sessão expirou. Entre de novo.',
  key_proof_invalid: 'O servidor recusou a prova da chave. Desbloqueie de novo e tente outra vez.',
  keys_not_ready: 'A conta ainda não tem senha de criptografia.',
  keys_already_set: 'As chaves desta conta já foram definidas. Desbloqueie com a senha.',
  protocol_unsupported: 'Este servidor usa uma versão incompatível do protocolo — atualize o app.',
  payload_too_large: 'Dados grandes demais para o servidor.',
  internal: 'Erro inesperado no servidor. Tente de novo em instantes.'
}

/** Texto para mostrar ao usuário. */
export function describeError(e: unknown): string {
  if (e instanceof UserError) return e.message
  if (e instanceof SyncNetworkError)
    return 'Sem conexão com o servidor. Confira a internet (ou o endereço do servidor) e tente de novo.'
  if (e instanceof SyncApiError) {
    if (e.code === 'rate_limited') {
      const ra = retryAfterSeconds(e)
      return ra
        ? `Muitas tentativas. Tente de novo em ${formatWait(ra)}.`
        : 'Muitas tentativas. Aguarde um pouco e tente de novo.'
    }
    if (e.code === 'quota_exceeded' && e.details.kind === 'devices')
      return 'A conta atingiu o limite de dispositivos. Remova um aparelho antigo (no site ou no app desktop) e tente de novo.'
    if (e.code === 'invalid_request' && e.details.field === 'email') return 'E-mail inválido.'
    const known = BY_CODE[e.code]
    if (known) return known
    if (e.status >= 500) return BY_CODE.internal
    return e.message || `Erro do servidor (${e.status}).`
  }
  if (e instanceof AuthError) return 'Senha de criptografia incorreta.'
  if (e instanceof RecoveryKeyError)
    return 'Chave de recuperação incorreta. Confira a digitação (36 caracteres, 9 grupos de 4).'
  if (e instanceof Error && /limites aceitos|kdf não suportado/.test(e.message))
    return 'O servidor enviou parâmetros de chave fora dos limites seguros. Por segurança, o desbloqueio foi interrompido.'
  if (e instanceof Error && e.message) return e.message
  return 'Algo deu errado. Tente de novo.'
}
