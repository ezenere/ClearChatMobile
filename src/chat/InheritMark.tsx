// Herança ao vivo da persona nas telas do chat (protocolo 1.10.0, §4.3.6) — as peças visuais (=
// `panel/inherit.tsx` do desktop, no jeito do celular): o chip "↺ neste chat" num campo PRÓPRIO do
// chat; tocar abre, logo abaixo do campo, o valor que voltaria e de onde ele vem (persona “X” ou
// "Novos chats") com "Voltar a herdar" — nada de diálogo do sistema. Campo herdado = sem marca (a
// linha da persona no topo explica). Fora de um chat que herda (persona, chat sem persona, chat
// antigo ainda não migrado) não há contexto e nada aparece.
import Ionicons from '@expo/vector-icons/Ionicons'
import { createContext, useContext, useState, type ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { FieldLabel } from '@/settings/ui'
import { Button } from '@/ui/Button'
import { colors, radius, spacing } from '@/ui/theme'
import { unitLabel, type InheritView } from './inheritUi'

export interface ChatInheritCtx {
  view: InheritView
  /** Volta a herdar as unidades (salva na hora). */
  revert: (units: readonly string[]) => void
}

const Ctx = createContext<ChatInheritCtx | null>(null)

export function ChatInheritProvider({
  value,
  children
}: {
  value: ChatInheritCtx | null
  children: ReactNode
}) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

/** Contexto da herança do chat (null = sem herança aqui). */
export function useChatInherit(): ChatInheritCtx | null {
  const c = useContext(Ctx)
  return c?.view.active ? c : null
}

/** Unidades próprias entre `units` (vazio = nenhuma marca). */
export function useOwnUnits(units: readonly string[]): string[] {
  const c = useChatInherit()
  return c ? units.filter(c.view.isOwn) : []
}

/** O chip "↺ neste chat" (só com unidade própria). */
export function InheritChip({
  units,
  open,
  onPress,
  testID
}: {
  units: readonly string[]
  open?: boolean
  onPress: () => void
  testID?: string
}) {
  const c = useChatInherit()
  const own = useOwnUnits(units)
  if (!c || !own.length) return null
  const one = own.length === 1 ? own[0] : null
  return (
    <Pressable
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => [st.chip, (open || pressed) && st.chipOn]}
      accessibilityRole="button"
      accessibilityLabel={
        one
          ? `${unitLabel(one)}: deste chat. Toque para ver o valor da persona “${c.view.personaName}” e voltar a herdar`
          : `${own.length} campos deste chat. Toque para voltar a herdar da persona “${c.view.personaName}”`
      }
      testID={testID ?? 'inherit-mark'}
    >
      <Ionicons name="arrow-undo" size={11} color={colors.accentStrong} />
      <Text style={st.chipText}>neste chat</Text>
    </Pressable>
  )
}

/** Painel aberto pelo chip: o valor herdado, a origem e "Voltar a herdar". */
export function RevertPanel({ units, onDone }: { units: readonly string[]; onDone: () => void }) {
  const c = useChatInherit()
  const own = useOwnUnits(units)
  if (!c || !own.length) return null
  const one = own.length === 1 ? own[0] : null
  return (
    <View style={st.panel} testID="inherit-panel">
      {one ? (
        <>
          <Text style={st.panelText}>
            <Text style={st.panelStrong}>Herdando, ficaria: </Text>
            {c.view.inheritedText(one)}
          </Text>
          <Text style={st.panelSub}>De onde: {c.view.source(one)}.</Text>
        </>
      ) : (
        <>
          <Text style={st.panelText}>
            <Text style={st.panelStrong}>Deste chat: </Text>
            {own.map(unitLabel).join(', ')}
          </Text>
          <Text style={st.panelSub}>
            Voltam a seguir a persona “{c.view.personaName}” (ou “Novos chats”, onde ela não
            define).
          </Text>
        </>
      )}
      <View style={st.panelActions}>
        <Button
          title="Cancelar"
          variant="secondary"
          size="sm"
          full={false}
          onPress={onDone}
          testID="inherit-cancel"
        />
        <Button
          title={one ? 'Voltar a herdar' : `Voltar a herdar (${own.length})`}
          icon="arrow-undo"
          size="sm"
          full={false}
          onPress={() => {
            onDone()
            c.revert(own)
          }}
          testID="inherit-revert"
        />
      </View>
    </View>
  )
}

/** Rótulo de campo com a marca de próprio (o painel abre logo abaixo). */
export function InheritLabel({
  title,
  units,
  right,
  testID
}: {
  title: string
  units: readonly string[]
  right?: ReactNode
  testID?: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <FieldLabel
        right={
          <View style={st.labelRight}>
            {right}
            <InheritChip
              units={units}
              open={open}
              onPress={() => setOpen((v) => !v)}
              testID={testID}
            />
          </View>
        }
      >
        {title}
      </FieldLabel>
      {open ? <RevertPanel units={units} onDone={() => setOpen(false)} /> : null}
    </>
  )
}

/** Marca dentro de uma linha (tool, parâmetro): o chip e, aberto, o painel embaixo da linha. */
export function InheritInline({
  units,
  children,
  testID
}: {
  units: readonly string[]
  children: ReactNode
  testID?: string
}) {
  const [open, setOpen] = useState(false)
  const own = useOwnUnits(units)
  return (
    <View>
      {children}
      {own.length ? (
        <View style={st.inline}>
          <InheritChip
            units={units}
            open={open}
            onPress={() => setOpen((v) => !v)}
            testID={testID}
          />
        </View>
      ) : null}
      {open ? <RevertPanel units={units} onDone={() => setOpen(false)} /> : null}
    </View>
  )
}

const st = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.accentBorder,
    backgroundColor: colors.accentSoft
  },
  chipOn: { borderColor: colors.accent },
  chipText: { color: colors.accentStrong, fontSize: 11, fontWeight: '500' },
  labelRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  inline: { flexDirection: 'row', paddingBottom: 6, marginTop: -2 },
  panel: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.accentBorder,
    backgroundColor: colors.elevated,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 4
  },
  panelText: { color: colors.fg, fontSize: 13, lineHeight: 18 },
  panelStrong: { color: colors.muted, fontWeight: '600' },
  panelSub: { color: colors.subtle, fontSize: 12, lineHeight: 16 },
  panelActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
    marginTop: 6
  }
})
