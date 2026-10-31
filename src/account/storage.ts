// Onde a conta guarda as coisas (interfaces; as implementações do aparelho ficam em ./native.ts).
// - SecretStore: tokens e DEK — só Keystore/Keychain (expo-secure-store). Nunca em SQLite/logs.
// - KeyValueStore: o que não é segredo (servidor escolhido, e-mail, ids, wraps em cache, preferências)
//   — expo-sqlite/kv-store no aparelho.

export interface SecretStore {
  /** Tokens (JSON) — síncrono: a rotação do refresh precisa estar gravada antes de seguir (§5.4). */
  getTokens(): string | null
  setTokens(value: string | null): void
  /** DEK (base64url). Com biometria, ler mostra o prompt do sistema; falha/cancelamento → null. */
  getDek(): Promise<string | null>
  setDek(value: string | null, opts?: { biometric?: boolean }): Promise<void>
  /** O aparelho tem biometria cadastrada (para oferecer "Exigir biometria")? */
  canUseBiometrics(): boolean
}

export interface KeyValueStore {
  get(key: string): string | null
  set(key: string, value: string | null): void
}

/** Chaves do KeyValueStore (prefixo "account."). */
export const KV = {
  serverKind: 'account.server_kind',
  serverUrl: 'account.server_url',
  serverName: 'account.server_name',
  userId: 'account.user_id',
  email: 'account.email',
  accountName: 'account.name',
  deviceId: 'account.device_id',
  deviceName: 'account.device_name',
  keys: 'account.keys',
  keysRev: 'account.keys_rev',
  remember: 'account.remember',
  biometric: 'account.biometric'
} as const

/** Sai no logout/revogação (o servidor escolhido fica). */
export const SESSION_KEYS = [
  KV.userId,
  KV.email,
  KV.accountName,
  KV.deviceId,
  KV.keys,
  KV.keysRev
] as const

export class MemoryKeyValueStore implements KeyValueStore {
  readonly map = new Map<string, string>()
  get(key: string): string | null {
    return this.map.get(key) ?? null
  }
  set(key: string, value: string | null): void {
    if (value === null) this.map.delete(key)
    else this.map.set(key, value)
  }
}

/** Para testes e para aparelhos sem Keystore utilizável (nada persiste). */
export class MemorySecretStore implements SecretStore {
  tokens: string | null = null
  dek: string | null = null
  dekBiometric = false
  biometrics = false
  /** Simula o usuário cancelando o prompt da biometria. */
  denyBiometric = false
  getTokens(): string | null {
    return this.tokens
  }
  setTokens(value: string | null): void {
    this.tokens = value
  }
  async getDek(): Promise<string | null> {
    if (this.dekBiometric && this.denyBiometric) return null
    return this.dek
  }
  async setDek(value: string | null, opts?: { biometric?: boolean }): Promise<void> {
    this.dek = value
    this.dekBiometric = !!value && !!opts?.biometric
  }
  canUseBiometrics(): boolean {
    return this.biometrics
  }
}
