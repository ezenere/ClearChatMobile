// Escolha "Salvar online" · "Só neste aparelho" ao criar um chat no celular (SYNC_PROTOCOL.md §23.1,
// §23.2, §23.10). Regras:
// - padrão = a última escolha feita NESTE aparelho (`newChatStorage`, setting local — §4.4);
// - sem escolha anterior: "Só neste aparelho" numa instalação nova; numa instalação que já
//   sincronizava antes de atualizar para 1.8.0, "Salvar online" (gravado na primeira execução);
// - sem conta: o seletor não aparece, mas o chat grava o padrão do aparelho (no primeiro login os
//   "só neste aparelho" continuam locais — o merge os pula, §12.7);
// - com conta, o seletor só aparece se a instância suporta chats ao vivo (`features.liveChats` +
//   `welcome.caps`, §23.2); servidor antigo → escondido e tudo online, como antes.
// Puro (o kv entra por parâmetro).
import type { KeyValueStore } from '@/account/storage'

export type NewChatStorage = 'online' | 'live'

export const KV_NEW_CHAT_STORAGE = 'newChatStorage'
/** Marca da primeira execução da versão 1.8.0 (a regra "já sincronizava" só vale uma vez). */
export const KV_STORAGE_INIT = 'newChatStorage.init'

/**
 * Primeira execução com 1.8.0: quem já sincronizava fica com "Salvar online" (nada muda sem o
 * usuário escolher). Idempotente.
 */
export function initStorageDefault(kv: KeyValueStore, alreadySynced: boolean): void {
  if (kv.get(KV_STORAGE_INIT) === '1') return
  kv.set(KV_STORAGE_INIT, '1')
  if (!kv.get(KV_NEW_CHAT_STORAGE) && alreadySynced) kv.set(KV_NEW_CHAT_STORAGE, 'online')
}

/** Padrão do aparelho (instalação nova sem escolha: só neste aparelho). */
export function deviceDefault(kv: KeyValueStore): NewChatStorage {
  return kv.get(KV_NEW_CHAT_STORAGE) === 'online' ? 'online' : 'live'
}

export function rememberChoice(kv: KeyValueStore, s: NewChatStorage): void {
  kv.set(KV_NEW_CHAT_STORAGE, s)
}

export interface StorageOffer {
  /** Mostrar o seletor na tela do Novo chat. */
  show: boolean
  /** O que vale se o usuário não mexer (ou sem seletor). */
  storage: NewChatStorage
}

/**
 * O que a tela oferece. `signedIn` = com conta (cofre aberto); `supported` = a instância suporta
 * chats ao vivo (null = não deu para saber ainda e nada conhecido → como servidor antigo).
 */
export function storageOffer(
  kv: KeyValueStore,
  signedIn: boolean,
  supported: boolean | null
): StorageOffer {
  if (!signedIn) return { show: false, storage: deviceDefault(kv) }
  if (supported !== true) return { show: false, storage: 'online' }
  return { show: true, storage: deviceDefault(kv) }
}

/** Texto curto de cada opção (pt-BR, §23.1). */
export const STORAGE_TEXT: Record<NewChatStorage, { title: string; detail: string }> = {
  online: {
    title: 'Salvar online',
    detail: 'Cifrado no servidor e sincronizado com os seus dispositivos.'
  },
  live: {
    title: 'Só neste aparelho',
    detail: 'Fica só neste celular: nada vai para o servidor. Dá para salvar online depois.'
  }
}
