// Composer do controle remoto (SYNC_PROTOCOL.md §8.6, §14): texto, anexos (galeria/arquivo →
// CCB1 → upload ANTES do envio), skills do host (lâmpada, lista vinda do snapshot), enviar /
// adicionar à fila, ⚡ forçar, parar, fila com ⚡/✕ por item e a linha de status do agente.
import Ionicons from '@expo/vector-icons/Ionicons'
import * as DocumentPicker from 'expo-document-picker'
import { File } from 'expo-file-system'
import * as Haptics from 'expo-haptics'
import * as ImagePicker from 'expo-image-picker'
import { useCallback, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native'
import { formatSize } from '@shared/attachments'
import { splitInterChatText } from '@shared/interChat'
import { splitSiblingText } from '@shared/siblings'
import type { QueuedMessage } from '@shared/types'
import { describeError } from '@/account/errors'
import { useAttachment } from '@/data/react'
import type { HostSkill } from '@/remote/mirror'
import { uploadDeps } from '@/remote/react'
import {
  checkMessageLimits,
  prepareAttachment,
  uploadAttachments,
  type PreparedAttachment
} from '@/remote/upload'
import type { IconName } from '@/ui/Button'
import { Sheet, SheetItem } from '@/ui/Sheet'
import { useToast } from '@/ui/Toast'
import { colors, radius } from '@/ui/theme'
import { Image } from 'expo-image'

interface Pending {
  key: string
  name: string
  size: number
  kind: string
  file: string | null
  status: 'preparing' | 'uploading' | 'ready' | 'error'
  error?: string
  prepared?: PreparedAttachment
  done: Promise<PreparedAttachment | null>
}

export interface SendInput {
  text: string
  attachments: PreparedAttachment[]
  skills: string[]
  force: boolean
}

/** Origem de um item da fila que não foi digitado pelo usuário (outro chat, pai, subagente). */
function queueOrigin(item: QueuedMessage): { label: string; text: string } | null {
  const kind = item.meta?.kind
  if (kind === 'inter-chat')
    return {
      label: `De: ${item.meta?.fromChatTitle || 'outro chat'}`,
      text: splitInterChatText(item.text).body
    }
  if (kind === 'parent-message')
    return { label: 'Agente pai', text: item.text.replace(/^\[Mensagem do agente pai\]\n/, '') }
  if (kind === 'sibling-message' || kind === 'sibling-broadcast') {
    const { title, body } = splitSiblingText(item.text)
    return {
      label: `${kind === 'sibling-broadcast' ? 'Broadcast do irmão' : 'Mensagem do irmão'} ${title || 'Subagente'}`,
      text: body
    }
  }
  if (kind === 'subagent-callback')
    return { label: 'Resultado de subagente', text: item.text.split('\n')[0] }
  return null
}

function QueueChip({
  item,
  onForce,
  onRemove
}: {
  item: QueuedMessage
  onForce: () => Promise<unknown>
  onRemove: () => Promise<unknown>
}) {
  const [busy, setBusy] = useState<'force' | 'remove' | null>(null)
  const origin = queueOrigin(item)
  const skills = (item.skillParts ?? []).flatMap((p) =>
    p.type === 'text' && p._skill ? [p._skill.name] : []
  )
  const act = (k: 'force' | 'remove', fn: () => Promise<unknown>) => {
    setBusy(k)
    void fn().finally(() => setBusy(null))
  }
  return (
    <View style={c.chip} testID="queue-chip">
      <View style={{ flex: 1, gap: 2 }}>
        {origin ? (
          <Text style={c.chipOrigin} numberOfLines={1}>
            {origin.label}
          </Text>
        ) : null}
        <Text style={c.chipText} numberOfLines={2}>
          {origin ? origin.text : item.text}
        </Text>
        {skills.length ? (
          <Text style={c.chipMeta} numberOfLines={1}>
            💡 {skills.join(', ')}
          </Text>
        ) : null}
        {item.attachments?.length ? (
          <Text style={c.chipMeta} numberOfLines={1}>
            📎 {item.attachments.map((a) => a.name).join(', ')}
          </Text>
        ) : null}
      </View>
      <View style={{ gap: 4 }}>
        <Pressable
          onPress={() => act('force', onForce)}
          disabled={!!busy}
          hitSlop={6}
          style={c.chipBtn}
          accessibilityLabel="Enviar agora (interrompe o agente)"
          testID="queue-force"
        >
          {busy === 'force' ? (
            <ActivityIndicator size={12} color={colors.warning} />
          ) : (
            <Ionicons name="flash" size={15} color={colors.warning} />
          )}
        </Pressable>
        <Pressable
          onPress={() => act('remove', onRemove)}
          disabled={!!busy}
          hitSlop={6}
          style={c.chipBtn}
          accessibilityLabel="Remover da fila"
          testID="queue-remove"
        >
          {busy === 'remove' ? (
            <ActivityIndicator size={12} color={colors.subtle} />
          ) : (
            <Ionicons name="close" size={15} color={colors.subtle} />
          )}
        </Pressable>
      </View>
    </View>
  )
}

function AttachmentChip({ a, onRemove }: { a: Pending; onRemove: () => void }) {
  const img = a.kind === 'image' && a.file
  const local = useAttachment(img ? a.file : null, false)
  const icon: IconName =
    a.kind === 'image'
      ? 'image-outline'
      : a.kind === 'pdf'
        ? 'document-text-outline'
        : 'document-outline'
  return (
    <View
      style={[c.att, a.status === 'error' && { borderColor: 'rgba(248,113,113,0.45)' }]}
      testID="composer-attachment"
    >
      {img && local.uri ? (
        <Image source={{ uri: local.uri }} style={c.attThumb} contentFit="cover" />
      ) : (
        <View style={[c.attThumb, { alignItems: 'center', justifyContent: 'center' }]}>
          <Ionicons name={icon} size={18} color={colors.muted} />
        </View>
      )}
      <View style={{ maxWidth: 120 }}>
        <Text style={c.attName} numberOfLines={1}>
          {a.name}
        </Text>
        <Text
          style={[c.attMeta, a.status === 'error' && { color: colors.danger }]}
          numberOfLines={1}
        >
          {a.status === 'error'
            ? (a.error ?? 'falhou')
            : a.status === 'ready'
              ? formatSize(a.size)
              : 'enviando…'}
        </Text>
      </View>
      {a.status === 'preparing' || a.status === 'uploading' ? (
        <ActivityIndicator size={12} color={colors.accentStrong} />
      ) : null}
      <Pressable onPress={onRemove} hitSlop={8} accessibilityLabel={`Remover ${a.name}`}>
        <Ionicons name="close-circle" size={18} color={colors.subtle} />
      </Pressable>
    </View>
  )
}

export function RemoteComposer({
  busy,
  statusText,
  hostName,
  queue,
  skills,
  placeholder,
  disabled,
  onSend,
  onStop,
  onQueueForce,
  onQueueRemove
}: {
  busy: boolean
  statusText: string | null
  hostName: string
  queue: QueuedMessage[]
  skills: HostSkill[]
  placeholder: string
  disabled?: string | null
  onSend: (input: SendInput) => Promise<boolean>
  onStop: () => Promise<unknown>
  onQueueForce: (id: string) => Promise<unknown>
  onQueueRemove: (id: string) => Promise<unknown>
}) {
  const toast = useToast()
  const [text, setText] = useState('')
  const [atts, setAtts] = useState<Pending[]>([])
  const [picked, setPicked] = useState<string[]>([])
  const [attachMenu, setAttachMenu] = useState(false)
  const [skillMenu, setSkillMenu] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [sending, setSending] = useState(false)
  const seq = useRef(0)

  const patch = (key: string, p: Partial<Pending>) =>
    setAtts((all) => all.map((a) => (a.key === key ? { ...a, ...p } : a)))

  const addFile = useCallback(
    (uri: string, name: string, mime: string | undefined, size: number | undefined) => {
      const key = `a${++seq.current}`
      let resolveDone!: (v: PreparedAttachment | null) => void
      const done = new Promise<PreparedAttachment | null>((r) => (resolveDone = r))
      setAtts((all) => [
        ...all,
        {
          key,
          name,
          size: size ?? 0,
          kind: mime?.startsWith('image/') ? 'image' : 'file',
          file: null,
          status: 'preparing',
          done
        }
      ])
      void (async () => {
        try {
          const data = new Uint8Array(await new File(uri).arrayBuffer())
          const prep = await prepareAttachment(uploadDeps, data, name, mime)
          patch(key, {
            status: 'uploading',
            file: prep.info.file,
            kind: prep.info.kind,
            size: prep.info.size,
            prepared: prep
          })
          // §14: o blob sobe ANTES do comando que o referencia
          await uploadAttachments(uploadDeps, [prep])
          patch(key, { status: 'ready', prepared: { ...prep, data: new Uint8Array(0) } })
          resolveDone({ ...prep, data: new Uint8Array(0) })
        } catch (e) {
          patch(key, { status: 'error', error: describeError(e) })
          resolveDone(null)
        }
      })()
    },
    []
  )

  /** Fecha a folha antes de abrir o seletor (o Modal fechando atrapalha a Activity do seletor). */
  const closeMenu = async () => {
    setAttachMenu(false)
    await new Promise((r) => setTimeout(r, 250))
  }

  const pickImages = async () => {
    await closeMenu()
    const r = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: true,
      selectionLimit: 10,
      quality: 1
    })
    if (r.canceled) return
    for (const a of r.assets)
      addFile(
        a.uri,
        a.fileName || `imagem-${Date.now()}.jpg`,
        a.mimeType ?? 'image/jpeg',
        a.fileSize
      )
  }
  const pickFiles = async () => {
    await closeMenu()
    const r = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true })
    if (r.canceled) return
    for (const a of r.assets) addFile(a.uri, a.name, a.mimeType, a.size)
  }

  const uploading = atts.some((a) => a.status === 'preparing' || a.status === 'uploading')
  const canSend =
    !disabled &&
    !sending &&
    (!!text.trim() || atts.some((a) => a.status !== 'error') || picked.length > 0)

  const submit = async (force: boolean) => {
    if (!canSend) return
    const limits = checkMessageLimits(atts.filter((a) => a.status !== 'error'))
    if (limits) {
      toast(limits, 'danger')
      return
    }
    setSending(true)
    try {
      const ready = (await Promise.all(atts.map((a) => a.done))).filter(
        (x): x is PreparedAttachment => !!x
      )
      if (ready.length < atts.length) {
        toast('Um anexo não pôde ser enviado — remova-o ou tente de novo.', 'danger')
        return
      }
      const snapshot = { text, atts, picked }
      setText('')
      setAtts([])
      setPicked([])
      if (force) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined)
      const ok = await onSend({
        text: snapshot.text.trim(),
        attachments: ready,
        skills: snapshot.picked,
        force
      })
      if (!ok) {
        // §8.6: falhou → o texto volta ao composer
        setText((cur) => cur || snapshot.text)
        setAtts((cur) => (cur.length ? cur : snapshot.atts))
        setPicked((cur) => (cur.length ? cur : snapshot.picked))
      }
    } finally {
      setSending(false)
    }
  }

  return (
    <View testID="remote-composer">
      {queue.length ? (
        <View style={{ marginBottom: 6 }}>
          <Text style={c.queueLabel}>Na fila · enviadas no próximo passo do agente</Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={c.queue}
          >
            {queue.map((q) => (
              <QueueChip
                key={q.id}
                item={q}
                onForce={() => onQueueForce(q.id)}
                onRemove={() => onQueueRemove(q.id)}
              />
            ))}
          </ScrollView>
        </View>
      ) : null}
      <View style={c.box}>
        {atts.length || picked.length ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={c.atts}
          >
            {picked.map((n) => (
              <Pressable
                key={`s:${n}`}
                style={c.skillChip}
                onPress={() => setPicked((x) => x.filter((y) => y !== n))}
                testID="composer-skill"
              >
                <Ionicons name="bulb" size={13} color={colors.warning} />
                <Text style={c.skillChipText}>{n}</Text>
                <Ionicons name="close" size={13} color={colors.subtle} />
              </Pressable>
            ))}
            {atts.map((a) => (
              <AttachmentChip
                key={a.key}
                a={a}
                onRemove={() => setAtts((x) => x.filter((y) => y.key !== a.key))}
              />
            ))}
          </ScrollView>
        ) : null}
        <TextInput
          testID="composer-input"
          value={text}
          onChangeText={setText}
          editable={!disabled}
          placeholder={disabled ?? placeholder}
          placeholderTextColor={colors.faint}
          multiline
          style={c.input}
          textAlignVertical="top"
        />
        <View style={c.bar}>
          <Pressable
            onPress={() => setAttachMenu(true)}
            disabled={!!disabled}
            hitSlop={6}
            style={c.iconBtn}
            accessibilityLabel="Anexar"
            testID="composer-attach"
          >
            <Ionicons name="attach" size={21} color={colors.muted} />
          </Pressable>
          {skills.length ? (
            <Pressable
              onPress={() => setSkillMenu(true)}
              disabled={!!disabled}
              hitSlop={6}
              style={c.iconBtn}
              accessibilityLabel="Skills do host"
              testID="composer-skills"
            >
              <Ionicons
                name={picked.length ? 'bulb' : 'bulb-outline'}
                size={19}
                color={picked.length ? colors.warning : colors.muted}
              />
            </Pressable>
          ) : null}
          <View style={c.status}>
            {busy ? (
              <ActivityIndicator size={10} color={colors.accentStrong} />
            ) : (
              <View style={c.dot} />
            )}
            <Text style={c.statusText} numberOfLines={1} testID="composer-status">
              {statusText ?? `Executa em ${hostName}`}
            </Text>
          </View>
          {busy ? (
            <Pressable
              onPress={() => {
                setStopping(true)
                void onStop().finally(() => setStopping(false))
              }}
              disabled={stopping}
              style={c.stop}
              accessibilityLabel="Parar"
              testID="composer-stop"
            >
              {stopping ? (
                <ActivityIndicator size={12} color={colors.fg} />
              ) : (
                <Ionicons name="square" size={12} color={colors.fg} />
              )}
            </Pressable>
          ) : null}
          {busy ? (
            <Pressable
              onPress={() => void submit(true)}
              disabled={!canSend}
              style={[c.force, !canSend && { opacity: 0.35 }]}
              accessibilityLabel="Enviar agora (interrompe o agente)"
              testID="composer-force"
            >
              <Ionicons name="flash" size={17} color={colors.warning} />
            </Pressable>
          ) : null}
          <Pressable
            onPress={() => void submit(false)}
            onLongPress={() => void submit(true)}
            disabled={!canSend}
            style={[c.send, !canSend && c.sendOff]}
            accessibilityLabel={busy ? 'Adicionar à fila' : 'Enviar'}
            accessibilityHint="Toque longo envia agora, interrompendo o agente"
            testID="composer-send"
          >
            {sending || (uploading && sending) ? (
              <ActivityIndicator size={14} color="#fff" />
            ) : (
              <Ionicons
                name={busy ? 'add' : 'arrow-up'}
                size={19}
                color={canSend ? '#fff' : colors.faint}
              />
            )}
          </Pressable>
        </View>
      </View>
      <Sheet visible={attachMenu} onClose={() => setAttachMenu(false)} title="Anexar">
        <SheetItem
          icon="images-outline"
          label="Imagens da galeria"
          onPress={() => void pickImages().catch((e: unknown) => toast(describeError(e), 'danger'))}
          testID="attach-images"
        />
        <SheetItem
          icon="document-outline"
          label="Arquivo"
          detail="PDF, texto, código, áudio (wav/mp3)…"
          onPress={() => void pickFiles().catch((e: unknown) => toast(describeError(e), 'danger'))}
          testID="attach-file"
        />
      </Sheet>
      <Sheet
        visible={skillMenu}
        onClose={() => setSkillMenu(false)}
        title="Skills do host"
        subtitle={`O ${hostName} lê o SKILL.md e injeta na mensagem.`}
      >
        {skills.map((s) => {
          const on = picked.includes(s.name)
          return (
            <SheetItem
              key={s.name}
              icon={on ? 'bulb' : 'bulb-outline'}
              label={s.name}
              detail={s.description}
              onPress={() =>
                setPicked((x) => (on ? x.filter((y) => y !== s.name) : [...x, s.name]))
              }
              right={
                on ? <Ionicons name="checkmark" size={18} color={colors.accentStrong} /> : null
              }
              testID={`skill-${s.name}`}
            />
          )
        })}
      </Sheet>
    </View>
  )
}

const c = StyleSheet.create({
  queueLabel: { color: colors.subtle, fontSize: 11.5, marginLeft: 14, marginBottom: 4 },
  queue: { gap: 8, paddingHorizontal: 10 },
  chip: {
    flexDirection: 'row',
    gap: 8,
    width: 250,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.elevated,
    paddingLeft: 11,
    paddingRight: 6,
    paddingVertical: 8
  },
  chipOrigin: { color: colors.accentStrong, fontSize: 10.5, fontWeight: '500' },
  chipText: { color: colors.fg, fontSize: 13, lineHeight: 18 },
  chipMeta: { color: colors.subtle, fontSize: 11 },
  chipBtn: {
    width: 30,
    height: 30,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)'
  },
  box: {
    marginHorizontal: 10,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.elevated,
    paddingTop: 6,
    paddingBottom: 6
  },
  atts: { gap: 8, paddingHorizontal: 10, paddingTop: 4, paddingBottom: 6 },
  att: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    padding: 5,
    paddingRight: 8
  },
  attThumb: { width: 36, height: 36, borderRadius: 7, backgroundColor: colors.active },
  attName: { color: colors.fg, fontSize: 12.5 },
  attMeta: { color: colors.subtle, fontSize: 11 },
  skillChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(245,181,68,0.35)',
    backgroundColor: colors.warningSoft,
    paddingHorizontal: 10,
    height: 32
  },
  skillChipText: { color: colors.fg, fontSize: 12.5 },
  input: {
    color: colors.fg,
    fontSize: 15.5,
    lineHeight: 21,
    minHeight: 40,
    maxHeight: 150,
    paddingHorizontal: 14,
    paddingTop: 6,
    paddingBottom: 4
  },
  bar: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 6 },
  iconBtn: {
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 19
  },
  status: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 4 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.success },
  statusText: { flex: 1, color: colors.subtle, fontSize: 12 },
  stop: {
    width: 36,
    height: 36,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.active,
    alignItems: 'center',
    justifyContent: 'center'
  },
  force: {
    width: 36,
    height: 36,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(245,181,68,0.35)',
    backgroundColor: colors.warningSoft,
    alignItems: 'center',
    justifyContent: 'center'
  },
  send: {
    width: 38,
    height: 38,
    borderRadius: 13,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center'
  },
  sendOff: { backgroundColor: colors.active }
})
