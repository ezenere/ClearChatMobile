// Implementações do aparelho para a conta: Keystore/Keychain (expo-secure-store) para tokens e DEK,
// expo-sqlite/kv-store para o resto, perfil do aparelho (expo-device) e a instância única do serviço.
import Constants from 'expo-constants'
import * as Device from 'expo-device'
import * as SecureStore from 'expo-secure-store'
import { Storage } from 'expo-sqlite/kv-store'
import { AppState, Platform } from 'react-native'
import { CaptchaBroker } from './captcha'
import { defaultDeviceName } from './deviceName'
import { AccountService, type DeviceProfile } from './service'
import { KV, type KeyValueStore, type SecretStore } from './storage'

const TOKENS = 'clearchat.tokens'
const DEK = 'clearchat.dek'
const DEK_BIO = 'clearchat.dek.bio'

const bioOptions: SecureStore.SecureStoreOptions = {
  requireAuthentication: true,
  authenticationPrompt: 'Desbloquear o ClearChat'
}

/** Só o processo do app lê; nada vai para backup (plugin configureAndroidBackup). */
const baseOptions: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY
}

export class NativeSecretStore implements SecretStore {
  // a DEK com biometria fica numa entrada separada (chave do Keystore com autenticação)
  constructor(private readonly kv: KeyValueStore) {}

  getTokens(): string | null {
    try {
      return SecureStore.getItem(TOKENS, baseOptions)
    } catch {
      return null
    }
  }

  setTokens(value: string | null): void {
    if (value === null) {
      void SecureStore.deleteItemAsync(TOKENS, baseOptions).catch(() => undefined)
      return
    }
    // síncrono de propósito: o refresh rotacionado precisa estar gravado antes de qualquer outra
    // requisição (reusar o antigo revoga o aparelho — §5.4)
    SecureStore.setItem(TOKENS, value, baseOptions)
  }

  async getDek(): Promise<string | null> {
    const bio = this.kv.get(KV.biometric) === '1'
    try {
      return bio
        ? await SecureStore.getItemAsync(DEK_BIO, { ...baseOptions, ...bioOptions })
        : await SecureStore.getItemAsync(DEK, baseOptions)
    } catch {
      // prompt cancelado, biometria trocada (chave invalidada) ou indisponível → pede a senha
      return null
    }
  }

  async setDek(value: string | null, opts?: { biometric?: boolean }): Promise<void> {
    await SecureStore.deleteItemAsync(DEK, baseOptions).catch(() => undefined)
    await SecureStore.deleteItemAsync(DEK_BIO, { ...baseOptions, ...bioOptions }).catch(
      () => undefined
    )
    if (value === null) return
    if (opts?.biometric) {
      await SecureStore.setItemAsync(DEK_BIO, value, { ...baseOptions, ...bioOptions })
    } else {
      await SecureStore.setItemAsync(DEK, value, baseOptions)
    }
  }

  canUseBiometrics(): boolean {
    try {
      return SecureStore.canUseBiometricAuthentication()
    } catch {
      return false
    }
  }
}

export class NativeKeyValueStore implements KeyValueStore {
  get(key: string): string | null {
    return Storage.getItemSync(key)
  }
  set(key: string, value: string | null): void {
    if (value === null) Storage.removeItemSync(key)
    else Storage.setItemSync(key, value)
  }
}

function deviceProfile(): DeviceProfile {
  const platform = Platform.OS === 'ios' ? 'ios' : 'android'
  return {
    defaultName: defaultDeviceName(Device.deviceName, Device.modelName, platform),
    platform,
    appVersion: Constants.expoConfig?.version ?? '0.0.0'
  }
}

export const captchaBroker = new CaptchaBroker()

const kv = new NativeKeyValueStore()

export const account = new AccountService({
  secrets: new NativeSecretStore(kv),
  kv,
  device: deviceProfile(),
  envUrl: process.env.EXPO_PUBLIC_CLEARCHAT_SYNC_URL || null,
  captcha: (base, action) => captchaBroker.request(base, action)
})

let started: Promise<void> | null = null

/** Restaura a sessão (uma vez) e liga o WebSocket ao primeiro/segundo plano do app. */
export function startAccount(): Promise<void> {
  if (started) return started
  account.setForeground(AppState.currentState !== 'background')
  AppState.addEventListener('change', (s) => account.setForeground(s !== 'background'))
  started = account.init()
  return started
}
