// Herança AO VIVO da persona no celular (protocolo 1.10.0, SYNC_PROTOCOL.md §4.3.6) sobre o cache:
// o registro `chat` guarda os valores próprios + a cópia informativa das herdadas + `overrides`;
// tudo que roda ou exibe um chat (o host/agente daqui, a chamada de voz, as telas, os chats de outro
// host — online ou só ao vivo) usa a config EFETIVA, calculada na leitura com as personas, os
// padrões de "Novos chats" (`defaultModel`, `defaultSystemPrompt`) e os provedores de chat DESTE
// aparelho. A lógica é a do desktop (@shared/chatInherit, vendorado); aqui só a leitura do cache —
// = ClearChatDesktop/src/main/chatInherit.ts sem o SQLite do app. Sem React Native.
import { APPROVAL_MODES_SETTING, migrateLegacyApprovals } from '@shared/approvalPolicy'
import { normalizeAppSignatureId } from '@shared/appSignatures'
import {
  applyChatConfigPatch,
  effectiveChatConfig,
  freezeChat,
  hasOverrides,
  migrateChatOverrides,
  type ChatPatchContext,
  type InheritConfig,
  type InheritEnv
} from '@shared/chatInherit'
import { DEFAULT_CHAT_CONFIG } from '@shared/defaults'
import { chatRanOn, type ChatRanOn } from '@shared/deviceTools'
import { sanitizePresetConfig, type PresetConfig } from '@shared/presets'
import { isChatProvider } from '@shared/providerKinds'
import { migrateConfigTools } from '@shared/toolRename'
import type { ApprovalItem, ApprovalMode, ChatConfig } from '@shared/types'
import { layerVoiceCallConfig, normalizeVoiceCallConfig } from '@shared/voice'
import type { LocalStore } from './store'
import type { Plain } from './types'

const isObj = (v: unknown): v is Plain => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

/** Padrões de "Novos chats" + provedores de chat deste aparelho (o que a herança lê ao vivo). */
export function inheritEnvOf(store: Pick<LocalStore, 'setting' | 'plainsOf'>): InheritEnv {
  const dm = store.setting<unknown>('defaultModel')
  return {
    defaults: {
      defaultProviderId: isObj(dm) ? str(dm.providerId) : null,
      defaultModel: isObj(dm) ? str(dm.model) : null,
      defaultSystemPrompt: str(store.setting<unknown>('defaultSystemPrompt'))
    },
    providers: store
      .plainsOf('provider')
      .map((r) => ({
        id: r.id,
        baseUrl: str(r.plain.baseUrl) ?? '',
        kind: (str(r.plain.kind) ?? undefined) as never
      }))
      .filter(isChatProvider)
  }
}

/** Config (sanitizada) da persona com esse id aqui; null = não existe neste aparelho. */
export function presetConfigOf(
  store: Pick<LocalStore, 'getPlain'>,
  id: string | null | undefined
): PresetConfig | null {
  if (!id) return null
  const p = store.getPlain('preset', id)
  return p ? sanitizePresetConfig(isObj(p.config) ? p.config : {}) : null
}

/**
 * Registro do chat como o app o lê (= `chatRecordFrom` do desktop): aliases de leitura (tools
 * renomeadas, aprovações ≤ 0.4.0, id antigo da assinatura, voz normalizada) e completo sobre os
 * padrões do app. Sem `cwd` (o celular não tem raiz).
 */
export function chatRecordFrom(store: Pick<LocalStore, 'setting'>, raw: unknown): InheritConfig {
  const cfg = migrateLegacyApprovals(
    migrateConfigTools((isObj(raw) ? { ...raw } : {}) as Partial<ChatConfig>),
    {
      globalModes: () =>
        store.setting<Partial<Record<ApprovalItem, ApprovalMode>>>(APPROVAL_MODES_SETTING) ?? null
    }
  )
  return {
    ...DEFAULT_CHAT_CONFIG(''),
    ...cfg,
    appSignature: normalizeAppSignatureId(cfg.appSignature),
    params: { ...(cfg.params ?? {}) },
    // campos legados de registros antigos (`interjections` — §4.3.6) somem aqui
    ...(cfg.voice && typeof cfg.voice === 'object'
      ? { voice: normalizeVoiceCallConfig(cfg.voice) }
      : {}),
    cwd: ''
  }
}

/** Config efetiva de um registro (persona e padrões lidos agora). */
export function effectiveOf(
  store: Pick<LocalStore, 'setting' | 'plainsOf' | 'getPlain'>,
  record: InheritConfig,
  env?: InheritEnv
): InheritConfig {
  if (!record.presetId || !hasOverrides(record)) return record
  return effectiveChatConfig(
    record,
    presetConfigOf(store, record.presetId),
    env ?? inheritEnvOf(store)
  )
}

/** Config efetiva de uma `config` crua (registro do cache, `rec` de um chat só ao vivo). */
export function effectiveConfigOf(
  store: Pick<LocalStore, 'setting' | 'plainsOf' | 'getPlain'>,
  raw: unknown,
  env?: InheritEnv
): InheritConfig {
  return effectiveOf(store, chatRecordFrom(store, raw), env)
}

/** Registro (normalizado) do chat no cache; null = não existe. */
export function chatRecordOf(store: LocalStore, chatId: string): InheritConfig | null {
  const p = store.getPlain('chat', chatId)
  return p ? chatRecordFrom(store, p.config) : null
}

/**
 * Config com que o chat RODA para `usesLocalTools` (§8.9): a efetiva com a voz da persona em
 * camadas (= `runConfig` do host do desktop) — uma tool local herdada conta.
 */
export function runConfigOf(
  store: Pick<LocalStore, 'setting' | 'plainsOf' | 'getPlain'>,
  raw: unknown
): Record<string, unknown> {
  const eff = effectiveConfigOf(store, raw)
  return {
    ...eff,
    voice: layerVoiceCallConfig(eff.voice, presetConfigOf(store, eff.presetId)?.voice)
  } as unknown as Record<string, unknown>
}

/**
 * Em que tipos de aparelho o chat já rodou (§4.3.6, migração das tools de um tipo de aparelho):
 * num computador se o registro tem `hostCwd` (o host computador o grava); num celular, se não tem.
 */
export function chatRanOnOf(plain: Plain | null | undefined): ChatRanOn {
  return chatRanOn(plain?.hostCwd)
}

/** Contexto da interpretação de patches de config do chat (persona e padrões lidos agora). */
export function patchContextOf(
  store: Pick<LocalStore, 'setting' | 'plainsOf' | 'getPlain'>,
  chatId: string | null
): ChatPatchContext {
  const env = inheritEnvOf(store)
  return {
    env,
    persona: (id) => presetConfigOf(store, id),
    ranOn: chatRanOnOf(chatId ? store.getPlain('chat', chatId) : null)
  }
}

/**
 * Patch de config de um chat com a semântica da herança (`applyChatConfigPatch`): sem `overrides`
 * = edição (as unidades tocadas viram próprias); com `overrides` = como enviado (voltar a herdar);
 * `presetId` = trocar de persona (null/'' = congelar). Devolve o registro novo.
 */
export function patchedRecord(
  store: LocalStore,
  chatId: string,
  record: InheritConfig,
  patch: Partial<InheritConfig> & { presetId?: string | null }
): InheritConfig {
  return applyChatConfigPatch(record, patch, patchContextOf(store, chatId))
}

/** Chats com `presetId` e sem `overrides` (anteriores à 1.10.0): ainda não migrados. */
function legacyChats(store: LocalStore): { id: string; config: unknown; ranOn: ChatRanOn }[] {
  return store.sql
    .all<{ id: string; plain: string }>(
      `SELECT id, plain FROM records WHERE type = 'chat' AND deleted = 0 AND state = 0
         AND plain IS NOT NULL AND json_valid(plain)
         AND json_type(plain, '$.config.presetId') = 'text'
         AND coalesce(json_type(plain, '$.config.overrides'), '') <> 'object'`
    )
    .flatMap((r) => {
      try {
        const plain = JSON.parse(r.plain) as Plain
        return [{ id: r.id, config: plain.config, ranOn: chatRanOnOf(plain) }]
      } catch {
        return []
      }
    })
}

/**
 * Migração única dos chats antigos (com `presetId` e sem `overrides`) contra a persona e os padrões
 * DAQUI (§4.3.6) — depois de um pull completo (com conta) ou na inicialização (sem conta; chats
 * "Só neste aparelho" também). Uma diferença numa tool de um tipo de aparelho só vira própria se o
 * chat rodou naquele tipo (`hostCwd` no registro = computador; sem = celular). Devolve os registros
 * novos (quem chama grava e envia).
 */
export function inheritanceMigrations(
  store: LocalStore
): { chatId: string; config: InheritConfig }[] {
  const rows = legacyChats(store)
  if (!rows.length) return []
  const env = inheritEnvOf(store)
  const out: { chatId: string; config: InheritConfig }[] = []
  for (const r of rows) {
    const rec = chatRecordFrom(store, r.config)
    const next = migrateChatOverrides(rec, presetConfigOf(store, rec.presetId), env, r.ranOn)
    if (next) out.push({ chatId: r.id, config: next })
  }
  return out
}

/** Ids dos chats (vivos) com aquele `presetId` (inclusive os ainda não migrados). */
export function chatsOfPreset(store: LocalStore, presetId: string): string[] {
  return store.sql
    .all<{ id: string }>(
      `SELECT id FROM records WHERE type = 'chat' AND deleted = 0 AND state = 0
         AND plain IS NOT NULL AND json_valid(plain)
         AND json_extract(plain, '$.config.presetId') = ?`,
      [presetId]
    )
    .map((r) => r.id)
}

/** Quantos chats seguem cada persona ao vivo (os que já estão na forma da herança). */
export function followersByPreset(store: LocalStore): Map<string, number> {
  const out = new Map<string, number>()
  for (const r of store.sql.all<{ pid: string; n: number }>(
    `SELECT json_extract(plain, '$.config.presetId') AS pid, COUNT(*) AS n FROM records
       WHERE type = 'chat' AND deleted = 0 AND state = 0 AND plain IS NOT NULL AND json_valid(plain)
         AND json_type(plain, '$.config.presetId') = 'text'
         AND json_type(plain, '$.config.overrides') = 'object'
       GROUP BY pid`
  ))
    out.set(r.pid, r.n)
  return out
}

/**
 * Persona apagada (local ou tombstone remoto, §7.7): o registro congelado de cada chat local com
 * aquele `presetId` — valores efetivos gravados, voz preenchida, `presetId` removido, `overrides`
 * mantido. Chamar ANTES de a persona sair do cache (a config dela entra no congelamento).
 */
export function freezesOfPreset(
  store: LocalStore,
  presetId: string
): { chatId: string; config: InheritConfig }[] {
  const ids = chatsOfPreset(store, presetId)
  if (!ids.length) return []
  const env = inheritEnvOf(store)
  const persona = presetConfigOf(store, presetId)
  return ids.flatMap((chatId) => {
    const rec = chatRecordOf(store, chatId)
    return rec ? [{ chatId, config: freezeChat(rec, persona, env) }] : []
  })
}
