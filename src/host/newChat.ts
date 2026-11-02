// Config de um chat novo criado no celular (porta de ClearChatDesktop/src/renderer/src/lib/
// presets.ts: padrões de "Novos chats" + persona por cima, provedor e modelo andando juntos) com as
// regras do celular: só as tools portáveis ficam ligadas, skills desligadas e as tools locais da
// chamada de voz removidas — o chat nasce sem ferramentas locais (§8.9). Puro.
import { DEFAULT_CHAT_CONFIG, supportsCacheControl } from '@shared/defaults'
import { defaultModelRef, resolvePresetModel } from '@shared/models'
import { applyPreset, DEFAULT_PRESET_NAME } from '@shared/presets'
import { isChatProvider, providerKind } from '@shared/providerKinds'
import type { ChatConfig, ChatParams, Preset, Provider, ToolName } from '@shared/types'
import type { Plain } from '@/data/types'
import { MOBILE_TOOLS } from '@/agent/request'
import { LOCAL_TOOLS } from './policy'

export function presetFromPlain(id: string, p: Plain): Preset {
  return {
    id,
    name: typeof p.name === 'string' ? p.name : '',
    description: typeof p.description === 'string' ? p.description : '',
    icon: typeof p.icon === 'string' ? p.icon : '',
    config: (p.config && typeof p.config === 'object' ? p.config : {}) as Partial<ChatConfig>,
    createdAt: typeof p.createdAt === 'number' ? p.createdAt : 0,
    updatedAt: typeof p.updatedAt === 'number' ? p.updatedAt : 0
  }
}

export interface NewChatSettings {
  defaultModel?: { providerId?: string | null; model?: string | null } | null
  defaultSystemPrompt?: string | null
  defaultPresetId?: string | null
}

/** Persona inicial: a padrão → "Padrão" → a primeira → nenhuma. */
export function initialPresetId(
  presets: Preset[],
  defaultPresetId: string | null | undefined
): string | null {
  return (
    presets.find((p) => p.id === defaultPresetId)?.id ??
    presets.find((p) => p.name === DEFAULT_PRESET_NAME)?.id ??
    presets[0]?.id ??
    null
  )
}

/** Config base + persona (o que a tela mostra antes das escolhas do usuário). */
export function resolveNewChat(
  settings: NewChatSettings,
  providers: Provider[],
  preset: Preset | null
): ChatConfig {
  const chatProviders = providers.filter(isChatProvider)
  const ids = chatProviders.map((p) => p.id)
  const ref = defaultModelRef(
    {
      defaultProviderId: settings.defaultModel?.providerId,
      defaultModel: settings.defaultModel?.model
    },
    ids
  )
  const prov = chatProviders.find((p) => p.id === ref.providerId)
  const base = DEFAULT_CHAT_CONFIG('', {
    providerId: ref.providerId,
    model: ref.model,
    systemPrompt: settings.defaultSystemPrompt ?? undefined,
    baseUrl: prov?.baseUrl,
    kind: prov ? providerKind(prov) : undefined
  })
  const cfg = applyPreset(base, preset?.config)
  const { ref: r } = resolvePresetModel(
    { providerId: base.providerId, model: base.model },
    preset?.config,
    ids
  )
  cfg.providerId = r.providerId
  cfg.model = r.model
  // sem provedor padrão: o primeiro de chat (o usuário escolhe o modelo)
  if (!cfg.providerId && chatProviders[0]) cfg.providerId = chatProviders[0].id
  if (preset?.config.cacheEnabled === undefined) {
    const p = chatProviders.find((x) => x.id === cfg.providerId)
    if (p) cfg.cacheEnabled = supportsCacheControl(providerKind(p))
  }
  cfg.enabledTools = portableOf(cfg.enabledTools)
  return mobileSafe(cfg)
}

export const portableOf = (tools: readonly ToolName[] | undefined): ToolName[] =>
  (tools ?? []).filter((t) => MOBILE_TOOLS.includes(t))

/** Tools locais da persona que ficam de fora no celular (para avisar). */
export const droppedLocalTools = (preset: Preset | null): string[] =>
  (preset?.config.enabledTools ?? []).filter((t) =>
    LOCAL_TOOLS.includes(String(t) === 'bash' ? 'shell' : t)
  )

/** Sem ferramentas locais: tools portáveis, skills desligadas, tools locais da voz fora, sem cwd. */
export function mobileSafe(cfg: ChatConfig): ChatConfig {
  const out = { ...cfg, enabledTools: portableOf(cfg.enabledTools), cwd: '' }
  if (out.skills?.enabled) out.skills = { ...out.skills, enabled: false }
  const vt = out.voice?.tools?.enabledTools
  if (out.voice && vt)
    out.voice = {
      ...out.voice,
      tools: { ...out.voice.tools!, enabledTools: vt.filter((t) => !LOCAL_TOOLS.includes(t)) }
    }
  return out
}

/** Config final com as escolhas da tela. */
export function finalizeNewChat(
  base: ChatConfig,
  pick: {
    providerId: string
    model: string
    params: ChatParams
    tools: ToolName[]
    presetId: string | null
  },
  providers: Provider[]
): Partial<ChatConfig> {
  const cfg: ChatConfig = {
    ...base,
    providerId: pick.providerId,
    model: pick.model,
    params: pick.params
  }
  cfg.enabledTools = portableOf(pick.tools)
  if (pick.providerId !== base.providerId) {
    const p = providers.find((x) => x.id === pick.providerId)
    if (p) cfg.cacheEnabled = supportsCacheControl(providerKind(p))
  }
  const out: Partial<ChatConfig> = mobileSafe(cfg)
  delete out.cwd
  if (pick.presetId) out.presetId = pick.presetId
  else delete out.presetId
  return out
}
