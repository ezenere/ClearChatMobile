// Configurações → Aprovações (= desktop): modo GLOBAL de cada item (Sempre / Smart-Approve /
// Listas ou Perguntar), padrões do Smart-Approve (aceitar edições na raiz, descrição do ambiente,
// coleta automática de contexto com o modelo do resumidor) e as listas globais (whitelist /
// blacklist) de comandos, processos e páginas. Settings `approvalModes`, `approvalLists` e
// `smartApproveDefaults` (sincronizados). Cada chat/persona pode ajustar no computador.
import Ionicons from '@expo/vector-icons/Ionicons'
import { useState } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import {
  APPROVAL_ITEM_GROUPS,
  APPROVAL_LIST_ITEMS,
  APPROVAL_LISTS_SETTING,
  APPROVAL_MODES,
  APPROVAL_MODES_SETTING,
  broadPatternWarning,
  ITEM_LABEL,
  ITEM_TOOL,
  modeHint,
  modeLabel,
  normalizeApprovalSettings,
  validateListEntry
} from '@shared/approvalPolicy'
import { SMART_DEFAULTS_SETTING } from '@shared/smartDefaults'
import type { ApprovalItem, ApprovalListItem, ApprovalSettings } from '@shared/types'
import { useRouter } from 'expo-router'
import { MOBILE_TOOLS } from '@/agent/request'
import { locationPrefs } from '@/location/native'
import { useLocationPrefs } from '@/location/react'
import {
  APPROVAL_HINT as LOCATION_APPROVAL_HINT,
  APPROVAL_LABEL as LOCATION_APPROVAL_LABEL
} from '@/location/settings'
import { ModelField } from '@/settings/ModelPicker'
import { readAt, settings, useSettingsVersion } from '@/settings/react'
import { FieldLabel, Multiline, Note, Segmented, SettingsScreen } from '@/settings/ui'
import { Button, TextButton } from '@/ui/Button'
import { Card, ToggleRow } from '@/ui/Card'
import { colors, radius, spacing } from '@/ui/theme'

function read(): ApprovalSettings & { providers: ReturnType<typeof settings.providers> } {
  return {
    ...normalizeApprovalSettings(
      settings.setting(APPROVAL_MODES_SETTING),
      settings.setting(APPROVAL_LISTS_SETTING),
      settings.setting(SMART_DEFAULTS_SETTING)
    ),
    providers: settings.providers()
  }
}

export default function ApprovalsSettings() {
  const version = useSettingsVersion()
  const a = readAt(version, read)
  const [listItem, setListItem] = useState<ApprovalListItem>('commands')
  const loc = useLocationPrefs()
  const router = useRouter()
  const [env, setEnv] = useState(a.smart.environment)
  const [seenEnv, setSeenEnv] = useState(a.smart.environment)
  if (seenEnv !== a.smart.environment) {
    setSeenEnv(a.smart.environment)
    setEnv(a.smart.environment)
  }
  const setSmart = (p: Partial<ApprovalSettings['smart']>) =>
    settings.setSetting(SMART_DEFAULTS_SETTING, { ...a.smart, ...p })

  return (
    <SettingsScreen title="Aprovações" testID="screen-approvals">
      <Note>
        Modo padrão de cada item em todos os chats. Cada chat e persona pode ajustar (no
        computador). No celular rodam só pesquisa na web, abrir páginas e as ferramentas
        conversacionais — o resto vale para os chats do computador.
      </Note>
      {APPROVAL_ITEM_GROUPS.map((g) => (
        <View key={g.title} style={{ gap: spacing.sm }}>
          <FieldLabel>{g.title}</FieldLabel>
          <Card>
            <View style={{ gap: spacing.md }}>
              {g.items.map((item: ApprovalItem) => (
                <View key={item} style={{ gap: 6 }}>
                  <View style={st.itemHead}>
                    <Text style={st.itemTitle}>{ITEM_LABEL[item]}</Text>
                    {MOBILE_TOOLS.includes(ITEM_TOOL[item]) ? (
                      <Text style={st.here}>também no celular</Text>
                    ) : null}
                  </View>
                  <Segmented
                    options={APPROVAL_MODES.map((m) => ({ value: m, label: modeLabel(item, m) }))}
                    value={a.modes[item]}
                    onChange={(m) =>
                      settings.setSetting(APPROVAL_MODES_SETTING, { ...a.modes, [item]: m })
                    }
                    testID={`global-mode-${item}`}
                  />
                  <Text style={st.hint}>{modeHint(item, a.modes[item])}</Text>
                </View>
              ))}
            </View>
          </Card>
        </View>
      ))}

      <FieldLabel>Neste celular</FieldLabel>
      <Card>
        <View style={{ gap: 6 }}>
          <View style={st.itemHead}>
            <Text style={st.itemTitle}>Localização</Text>
            <Text style={st.here}>só neste aparelho</Text>
          </View>
          <Segmented
            options={(['ask', 'always', 'never'] as const).map((v) => ({
              value: v,
              label: LOCATION_APPROVAL_LABEL[v]
            }))}
            value={loc.approval}
            onChange={(v) => locationPrefs.set('approval', v)}
            testID="location-approval-mode"
          />
          <Text style={st.hint}>
            {LOCATION_APPROVAL_HINT[loc.approval]}. Precisão e permissão do sistema em{' '}
            <Text
              style={{ color: colors.accentStrong }}
              onPress={() => router.push('/settings/location')}
            >
              Configurações → Localização
            </Text>
            .
          </Text>
        </View>
      </Card>

      <FieldLabel>Smart-Approve — padrões globais</FieldLabel>
      <Card>
        <ToggleRow
          title="Aceitar edições dentro da raiz do chat"
          subtitle="write_file/edit_file dentro da raiz rodam sem perguntar e sem o juiz (caminhos protegidos continuam perguntando)."
          value={a.smart.acceptEditsInRoot}
          onChange={(acceptEditsInRoot) => setSmart({ acceptEditsInRoot })}
          testID="smart-accept-edits"
        />
      </Card>
      <Text style={st.sub}>Descrição do ambiente (vai para o juiz de todos os chats)</Text>
      <Multiline
        testID="smart-environment"
        value={env}
        onChangeText={setEnv}
        onBlur={() => env !== a.smart.environment && setSmart({ environment: env })}
        placeholder="Ex.: Notebook pessoal (Linux). Projetos em ~/dev; o servidor de produção é acessado por ssh prod."
        minHeight={90}
      />
      <Card>
        <ToggleRow
          title="Coleta automática de contexto"
          subtitle="Um modelo resume o que você pediu e permitiu, para o juiz decidir melhor (só age com modelo escolhido e algum item em Smart-Approve)."
          value={a.smart.capture.enabled}
          onChange={(enabled) => setSmart({ capture: { ...a.smart.capture, enabled } })}
          testID="smart-capture"
        />
      </Card>
      {a.smart.capture.enabled ? (
        <ModelField
          providers={a.providers}
          value={
            a.smart.capture.providerId
              ? { providerId: a.smart.capture.providerId, model: a.smart.capture.model }
              : null
          }
          onChange={(v) =>
            setSmart({
              capture: {
                ...a.smart.capture,
                providerId: v?.providerId ?? null,
                model: v?.model ?? null
              }
            })
          }
          placeholder="Modelo do resumidor"
          noneLabel="Nenhum"
          testID="smart-capture-model"
        />
      ) : null}

      <FieldLabel>Listas</FieldLabel>
      <Segmented
        options={APPROVAL_LIST_ITEMS.map((it) => ({ value: it, label: ITEM_LABEL[it] }))}
        value={listItem}
        onChange={setListItem}
        testID="lists-item"
      />
      <ListEditor key={`${listItem}-allow`} item={listItem} list="allow" a={a} />
      <ListEditor key={`${listItem}-deny`} item={listItem} list="deny" a={a} />
      <Note>
        {listItem === 'pages'
          ? 'Páginas: domínio (github.com, *.github.com) ou prefixo de URL.'
          : 'Comandos: padrão com * (ex.: git status, npm run *). Cada comando é desmontado em sub-comandos (|, &&, ;, $(…)).'}
      </Note>
    </SettingsScreen>
  )
}

function ListEditor({
  item,
  list,
  a
}: {
  item: ApprovalListItem
  list: 'allow' | 'deny'
  a: ApprovalSettings
}) {
  const entries = a.lists[item][list]
  const [editing, setEditing] = useState<number | 'new' | null>(null)
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const allow = list === 'allow'
  const save = (next: string[]) =>
    settings.setSetting(APPROVAL_LISTS_SETTING, {
      ...a.lists,
      [item]: { ...a.lists[item], [list]: next }
    })
  const commit = () => {
    const v = text.replace(/\s+/g, ' ').trim()
    const err = validateListEntry(item, v)
    if (err) return setError(err)
    if (editing === 'new') save(entries.includes(v) ? entries : [...entries, v])
    else if (typeof editing === 'number') save(entries.map((x, k) => (k === editing ? v : x)))
    setEditing(null)
    setText('')
    setError(null)
  }
  const warn = item !== 'pages' && text.trim() ? broadPatternWarning(text.trim()) : null
  return (
    <Card padded={false} testID={`list-${item}-${list}`}>
      <View style={st.listHead}>
        <Ionicons
          name={allow ? 'checkmark-circle-outline' : 'ban-outline'}
          size={16}
          color={allow ? colors.success : colors.danger}
        />
        <Text style={st.listTitle}>{allow ? 'Whitelist' : 'Blacklist'}</Text>
        <Text style={st.count}>
          {entries.length} {entries.length === 1 ? 'entrada' : 'entradas'}
        </Text>
        <TextButton
          title="Adicionar"
          icon="add"
          onPress={() => {
            setEditing('new')
            setText('')
            setError(null)
          }}
          testID={`list-add-${list}`}
        />
      </View>
      {entries.length === 0 && editing !== 'new' ? <Text style={st.empty}>Vazia.</Text> : null}
      {entries.map((e, i) =>
        editing === i ? null : (
          <View key={`${e}-${i}`} style={st.entry}>
            <Text style={st.entryText} numberOfLines={2} testID="list-entry">
              {e}
            </Text>
            <Pressable
              onPress={() => {
                setEditing(i)
                setText(e)
                setError(null)
              }}
              hitSlop={8}
              accessibilityLabel={`Editar ${e}`}
            >
              <Ionicons name="pencil-outline" size={16} color={colors.subtle} />
            </Pressable>
            <Pressable
              onPress={() => save(entries.filter((_, k) => k !== i))}
              hitSlop={8}
              accessibilityLabel={`Remover ${e}`}
              testID={`list-remove-${e}`}
            >
              <Ionicons name="close" size={18} color={colors.subtle} />
            </Pressable>
          </View>
        )
      )}
      {editing !== null ? (
        <View style={st.editor}>
          <TextInput
            testID={`list-input-${list}`}
            value={text}
            onChangeText={(v) => {
              setText(v)
              setError(null)
            }}
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            placeholder={item === 'pages' ? 'github.com' : 'git status'}
            placeholderTextColor={colors.faint}
            onSubmitEditing={commit}
            style={st.input}
          />
          {error ? <Text style={[st.hint, { color: colors.danger }]}>{error}</Text> : null}
          {warn && !error ? <Text style={[st.hint, { color: colors.warning }]}>{warn}</Text> : null}
          <View style={{ flexDirection: 'row', gap: spacing.sm }}>
            <Button
              title="Cancelar"
              variant="secondary"
              size="sm"
              full={false}
              style={{ flex: 1 }}
              onPress={() => {
                setEditing(null)
                setError(null)
              }}
            />
            <Button
              title={editing === 'new' ? 'Adicionar' : 'Salvar'}
              size="sm"
              full={false}
              style={{ flex: 1 }}
              disabled={!text.trim()}
              onPress={commit}
              testID={`list-save-${list}`}
            />
          </View>
        </View>
      ) : null}
    </Card>
  )
}

const st = StyleSheet.create({
  itemHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  itemTitle: { color: colors.fg, fontSize: 14.5, fontWeight: '500', flex: 1 },
  here: { color: colors.accentStrong, fontSize: 11.5 },
  hint: { color: colors.subtle, fontSize: 12, lineHeight: 16 },
  sub: { color: colors.muted, fontSize: 13 },
  listHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: spacing.md,
    paddingTop: 4
  },
  listTitle: { color: colors.fg, fontSize: 14, fontWeight: '600' },
  count: { flex: 1, color: colors.subtle, fontSize: 12 },
  empty: { color: colors.faint, fontSize: 12.5, paddingHorizontal: spacing.md, paddingBottom: 12 },
  entry: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: spacing.md,
    paddingVertical: 9,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border
  },
  entryText: { flex: 1, color: colors.fg, fontSize: 13.5, fontFamily: 'monospace' },
  editor: { padding: spacing.md, gap: spacing.sm },
  input: {
    color: colors.fg,
    fontSize: 14,
    fontFamily: 'monospace',
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.accent,
    backgroundColor: colors.elevated
  }
})
