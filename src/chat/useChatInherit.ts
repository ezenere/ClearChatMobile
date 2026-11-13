// Contexto da herança ao vivo da persona (1.10.0, §4.3.6) de um chat do cache para as folhas do
// chat (Memória…, Compactar…): campos próprios marcados e "voltar a herdar" gravado no registro.
// A tela "Configurações do chat" monta o dela (também para chats só ao vivo de outro host).
import { useCallback, useEffect, useMemo, useState } from 'react'
import { inheritEnvOf, presetConfigOf } from '@/data/inherit'
import { engine, store } from '@/data/native'
import { hostStack } from '@/host/native'
import { readAt, settings, useSettingsVersion } from '@/settings/react'
import { useToast } from '@/ui/Toast'
import type { ChatInheritCtx } from './InheritMark'
import { inheritView, revertPatch, unitLabel } from './inheritUi'

export function useCacheChatInherit(chatId: string): ChatInheritCtx | null {
  const toast = useToast()
  const sv = useSettingsVersion()
  const [cv, setCv] = useState(0)
  useEffect(
    () =>
      engine.subscribe((e) => {
        if (e.kind === 'data' && (e.all || e.chats.includes(chatId))) setCv((x) => x + 1)
      }),
    [chatId]
  )
  const record = readAt(sv + cv, () => hostStack.repo.record(chatId))
  const revert = useCallback(
    (units: readonly string[]) => {
      const rec = hostStack.repo.record(chatId)
      if (!rec || !units.length) return
      try {
        hostStack.repo.updateChat(chatId, { config: revertPatch(rec, units) })
        toast(
          units.length === 1
            ? `${unitLabel(units[0])}: segue a persona de novo`
            : `${units.length} campos seguem a persona de novo`
        )
      } catch (e) {
        toast((e as Error).message, 'danger')
      }
    },
    [chatId, toast]
  )
  return useMemo(() => {
    void sv
    if (!record?.presetId) return null
    const p = settings.preset(record.presetId)
    const cfg = p ? presetConfigOf(store, p.id) : null
    const providers = settings.providers()
    const view = inheritView(
      record,
      p && cfg ? { name: p.name, config: cfg } : null,
      inheritEnvOf(store),
      (id) => providers.find((x) => x.id === id)?.name ?? null
    )
    return view.active ? { view, revert } : null
  }, [record, revert, sv])
}
