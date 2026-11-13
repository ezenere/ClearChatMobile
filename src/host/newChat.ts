// Config de um chat novo criado no celular (porta de ClearChatDesktop/src/renderer/src/lib/
// presets.ts: padrões de "Novos chats" + persona por cima, provedor e modelo andando juntos). A
// lista de tools é a MESMA de qualquer aparelho (protocolo 1.10.0, §4.3.6 — "Tools de um tipo de
// aparelho"): o celular não desliga as do computador nem liga as dele — só roda as que executa
// (`availableTools`); as outras ficam esmaecidas na tela. Com persona o chat HERDA dela ao vivo: o
// repo grava como próprias só as unidades em que esta config difere do valor efetivo da persona
// (`newInheritingChatConfig`) — as escolhas do usuário — e a voz não é copiada. Puro.
import { DEFAULT_CHAT_CONFIG, supportsCacheControl } from '@shared/defaults'
import { defaultModelRef, resolvePresetModel } from '@shared/models'
import { applyPreset, DEFAULT_PRESET_NAME } from '@shared/presets'
import { isChatProvider, providerKind } from '@shared/providerKinds'
import type { ChatConfig, ChatParams, Preset, Provider, ToolName } from '@shared/types'
import type { Plain } from '@/data/types'

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
  // a voz da persona NÃO vira cópia (1.9.0/1.10.0): cada campo da `voice` do chat herda dela ao
  // vivo — trocar a voz da persona muda a dos chats dela (as tools da chamada inclusive)
  const cfg = applyPreset(base, preset?.config)
  delete cfg.voice
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
  // o celular não tem raiz; as tools/skills ficam como a persona (ou o padrão do app) define
  cfg.cwd = ''
  return cfg
}

/** Config final com as escolhas da tela (`tools` = a lista inteira, com as do computador). */
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
    params: pick.params,
    enabledTools: [...pick.tools]
  }
  if (pick.providerId !== base.providerId) {
    const p = providers.find((x) => x.id === pick.providerId)
    if (p) cfg.cacheEnabled = supportsCacheControl(providerKind(p))
  }
  const out: Partial<ChatConfig> = { ...cfg }
  delete out.cwd
  if (pick.presetId) out.presetId = pick.presetId
  else delete out.presetId
  return out
}
