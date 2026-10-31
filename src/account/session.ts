// Máquina de estados pura da conta neste aparelho (SYNC_PROTOCOL.md §5, §10.2, §3.13). Sem RN, sem
// rede: o AccountService traduz respostas e eventos em `SessionEvent` e a UI só lê o `SessionState`.
import type { SyncServerKind } from '@shared/sync'

/**
 * - boot: restaurando a sessão salva (splash)
 * - signed-out: sem conta (escolha do servidor, login por código)
 * - needs-setup: logado, conta sem chaves (definir a senha de criptografia)
 * - locked: logado, DEK fora da memória (senha ou chave de recuperação)
 * - unlocked: DEK e subchaves em memória
 */
export type Phase = 'boot' | 'signed-out' | 'needs-setup' | 'locked' | 'unlocked'

export type Connection = 'offline' | 'connecting' | 'online' | 'error'

/** Por que a sessão terminou (a tela de login explica). */
export type SignOutReason =
  'logout' | 'revoked' | 'session-ended' | 'account-deleted' | 'account-disabled'

export interface Notice {
  tone: 'info' | 'warning' | 'danger'
  title: string
  text: string
  /** Ação sugerida (botão no aviso). */
  action?: 'new-recovery-key'
}

export const NEW_RECOVERY_KEY_NOTICE: Notice = {
  tone: 'info',
  title: 'Gere uma nova chave de recuperação',
  text: 'Você usou a chave de recuperação. Por segurança, gere uma nova e guarde-a — a antiga continua valendo até lá.',
  action: 'new-recovery-key'
}

export interface ServerChoice {
  kind: SyncServerKind
  /** <base> normalizada (§20.1). */
  url: string
  /** `name` do /api/info (null até a primeira validação). */
  name: string | null
  /** Sobreposto por variável de ambiente (desenvolvimento/testes). */
  envOverride?: boolean
}

export interface AccountInfo {
  userId: string
  email: string
  name: string
}

export interface DeviceInfo {
  id: string
  name: string
}

/** Login em andamento (entre pedir e confirmar o código). */
export interface PendingLogin {
  email: string
  /** ms do último envio (cooldown do "reenviar"). */
  sentAt: number
  /** ms até quando o servidor pediu para esperar (429 Retry-After). */
  retryAt?: number
}

export interface SessionState {
  phase: Phase
  server: ServerChoice
  account: AccountInfo | null
  device: DeviceInfo | null
  connection: Connection
  /** "Lembrar neste dispositivo": DEK no Keystore/Keychain. */
  remember: boolean
  /** DEK lembrada exige biometria para abrir. */
  biometric: boolean
  login: PendingLogin | null
  notice: Notice | null
}

export type SessionEvent =
  | {
      type: 'restored'
      server: ServerChoice
      account: AccountInfo | null
      device: DeviceInfo | null
      hasKeys: boolean
      unlocked: boolean
      remember: boolean
      biometric: boolean
    }
  | { type: 'server'; server: ServerChoice }
  | { type: 'code-sent'; email: string; at: number }
  | { type: 'rate-limited'; until: number }
  | { type: 'login-cancelled' }
  | { type: 'signed-in'; account: AccountInfo; device: DeviceInfo; hasKeys: boolean }
  | { type: 'device-renamed'; name: string }
  | { type: 'keys-ready' }
  | { type: 'unlocked'; remember: boolean; biometric: boolean }
  | { type: 'locked'; notice?: Notice }
  | { type: 'keys-reset' }
  | { type: 'signed-out'; reason: SignOutReason }
  | { type: 'connection'; connection: Connection }
  | { type: 'notice'; notice: Notice | null }

export const initialSession = (server: ServerChoice): SessionState => ({
  phase: 'boot',
  server,
  account: null,
  device: null,
  connection: 'offline',
  remember: true,
  biometric: false,
  login: null,
  notice: null
})

/** Explicação mostrada no login depois que a sessão termina (null = saída voluntária). */
export function signOutNotice(reason: SignOutReason): Notice | null {
  switch (reason) {
    case 'logout':
      return null
    case 'revoked':
      return {
        tone: 'warning',
        title: 'Dispositivo desconectado',
        text: 'Este aparelho foi removido da sua conta em outro dispositivo. Os dados guardados aqui foram apagados — entre de novo para continuar.'
      }
    case 'session-ended':
      return {
        tone: 'warning',
        title: 'Sessão encerrada',
        text: 'A sessão deste aparelho não vale mais (ele foi desconectado da conta ou ficou muito tempo sem uso). Entre de novo para continuar.'
      }
    case 'account-deleted':
      return {
        tone: 'danger',
        title: 'Conta apagada',
        text: 'A conta foi apagada e todos os dados dela saíram do servidor e deste aparelho.'
      }
    case 'account-disabled':
      return {
        tone: 'danger',
        title: 'Conta desativada',
        text: 'Esta conta foi desativada pelo administrador da instância.'
      }
  }
}

export const KEYS_RESET_NOTICE: Notice = {
  tone: 'warning',
  title: 'Chaves redefinidas',
  text: 'As chaves da conta foram redefinidas em outro dispositivo e os dados da nuvem foram apagados. Defina a nova senha de criptografia para continuar.'
}

/** Código do servidor (refresh recusado, 403, fechamento 4403) → motivo do fim da sessão. */
export function reasonForCode(code: string): SignOutReason {
  switch (code) {
    case 'device_revoked':
    case 'refresh_reused':
      return 'revoked'
    case 'account_disabled':
      return 'account-disabled'
    case 'account_deleted':
      return 'account-deleted'
    default:
      return 'session-ended'
  }
}

export function reduceSession(s: SessionState, e: SessionEvent): SessionState {
  switch (e.type) {
    case 'restored': {
      const signedIn = !!e.account && !!e.device
      return {
        ...s,
        server: e.server,
        account: signedIn ? e.account : null,
        device: signedIn ? e.device : null,
        remember: e.remember,
        biometric: e.biometric,
        phase: !signedIn
          ? 'signed-out'
          : !e.hasKeys
            ? 'needs-setup'
            : e.unlocked
              ? 'unlocked'
              : 'locked',
        connection: 'offline'
      }
    }
    case 'server':
      return s.phase === 'signed-out' || s.phase === 'boot' ? { ...s, server: e.server } : s
    case 'code-sent':
      return { ...s, login: { email: e.email, sentAt: e.at }, notice: null }
    case 'rate-limited':
      return s.login ? { ...s, login: { ...s.login, retryAt: e.until } } : s
    case 'login-cancelled':
      return { ...s, login: null }
    case 'signed-in':
      return {
        ...s,
        account: e.account,
        device: e.device,
        login: null,
        notice: null,
        phase: e.hasKeys ? 'locked' : 'needs-setup'
      }
    case 'device-renamed':
      return s.device ? { ...s, device: { ...s.device, name: e.name } } : s
    case 'keys-ready':
      return s.phase === 'needs-setup' ? { ...s, phase: 'locked' } : s
    case 'unlocked':
      if (s.phase !== 'locked' && s.phase !== 'needs-setup') return s
      return { ...s, phase: 'unlocked', remember: e.remember, biometric: e.biometric, notice: null }
    case 'locked':
      if (s.phase !== 'unlocked' && s.phase !== 'locked') return s
      return { ...s, phase: 'locked', notice: e.notice ?? null }
    case 'keys-reset':
      if (!s.account) return s
      return { ...s, phase: 'needs-setup', notice: KEYS_RESET_NOTICE }
    case 'signed-out':
      return {
        ...s,
        phase: 'signed-out',
        account: null,
        device: null,
        login: null,
        connection: 'offline',
        notice: signOutNotice(e.reason)
      }
    case 'connection':
      return s.connection === e.connection ? s : { ...s, connection: e.connection }
    case 'notice':
      return { ...s, notice: e.notice }
  }
}
