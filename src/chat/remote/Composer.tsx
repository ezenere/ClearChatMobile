// Composer do controle remoto (SYNC_PROTOCOL.md §8.6, §14): texto, anexos (galeria/arquivo →
// CCB1 → upload ANTES do envio), skills do host (lâmpada, lista vinda do snapshot), enviar /
// adicionar à fila, ⚡ forçar, parar, fila com ⚡/✕ por item e a linha de status do agente.
// Fase 6: ditado (microfone → STT pela API das Configurações → Voz; o texto entra no ponto do
// cursor, com as funções puras do desktop; `meta.voice = { source: 'dictation' }` no envio quando
// o chat roda aqui) e o ponto de status que mostra a conexão (verde/amarelo/vermelho).
// Protocolo 1.13.0 (chat de outro dispositivo com os arquivos do host ao alcance): o chip
// `[arquivo ×]` do arquivo aberto por último no visualizador do host (vai em `meta.openFile`; toque
// → o texto exato que o modelo recebe; × para de mencionar) e o popup de `@` que lista os arquivos
// do host pasta por pasta (`fs.list`; pasta continua listando, arquivo fecha com espaço).
import Ionicons from '@expo/vector-icons/Ionicons'
import * as DocumentPicker from 'expo-document-picker'
import { File } from 'expo-file-system'
import * as Haptics from 'expo-haptics'
import * as ImagePicker from 'expo-image-picker'
import { useCallback, useEffect, useRef, useState, type ComponentRef } from 'react'
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
import {
  activeMentionQuery,
  applyMention,
  filterMentionIndex,
  type MentionCandidate
} from '@shared/pathMentions'
import { splitInterChatText } from '@shared/interChat'
import { splitSiblingText } from '@shared/siblings'
import type { AttachmentInfo, QueuedMessage } from '@shared/types'
import type { VoiceMessageMeta } from '@shared/voiceCallMarks'
import type { OpenFileMeta } from '@shared/openFile'
import {
  dictationPreview,
  insertDictationText,
  rebaseDictationAnchor,
  type DictationAnchor
} from '@vendor/renderer/voice/dictation'
import { useChatVoice, useDictationView, voice } from '@/voice/react'
import { describeError } from '@/account/errors'
import { useAttachment, useAttachmentSource, useSyncStatus } from '@/data/react'
import type { HostSkill } from '@/remote/mirror'
import { uploadDeps } from '@/remote/react'
import { useSession } from '@/account/react'
import {
  checkMessageLimits,
  prepareAttachment,
  uploadAttachments,
  type PreparedAttachment
} from '@/remote/upload'
import type { IconName } from '@/ui/Button'
import { Sheet, SheetItem } from '@/ui/Sheet'
import { useToast } from '@/ui/Toast'
import { colors, font } from '@/ui/theme'
import { Image } from 'expo-image'
import {
  mentionDirPart,
  mentionEntries,
  openFileChipOf,
  type HostLister,
  type OpenFileSelection
} from '../chatPaths'
import { MonoBlock } from '../ui'

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
  /** Fração enviada (anexos de chats ao vivo, §23.7). */
  progress?: number
  cancel?: () => void
}

/**
 * Envio de anexos alternativo (chats só ao vivo, §23.7: o arquivo vai ao host em pedaços pelo
 * `attach.put`, nada vira blob). `done` = o `AttachmentInfo` salvo no host.
 */
export interface ComposerAttach {
  start(
    data: Uint8Array,
    name: string,
    mime: string | undefined,
    onProgress: (sent: number, total: number) => void
  ): Promise<{
    file: string
    kind: string
    size: number
    name: string
    done: Promise<AttachmentInfo>
    cancel: () => void
  }>
  checkLimits?: (list: { size: number }[]) => string | null
  /** Apaga a cópia que o seletor deixou no cache do app depois de ler (nada fica em disco). */
  ephemeral?: boolean
}

export interface SendInput {
  text: string
  attachments: PreparedAttachment[]
  skills: string[]
  force: boolean
  /** Texto ditado (o campo recebeu uma transcrição): `meta.voice` do envio. */
  voice?: VoiceMessageMeta
  /** Arquivo selecionado (1.13.0): o chip do composer no envio → `meta.openFile`. */
  openFile?: OpenFileMeta
}

const clock = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Ponto de status: conectado (verde), reconectando (amarelo), sem conexão (vermelho). */
function useConnectionTone(): { color: string; label: string } {
  const sync = useSyncStatus()
  // sem conta não há servidor: o chat roda aqui, direto com o provedor
  const local = useSession().phase === 'local'
  if (local) return { color: colors.success, label: 'Neste celular, sem conta' }
  if (sync.live) return { color: colors.success, label: 'Conectado' }
  if (sync.phase === 'offline') return { color: colors.danger, label: 'Sem conexão' }
  return { color: colors.warning, label: 'Reconectando' }
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
        {item.meta?.openFile?.path ? (
          <Text style={c.chipMeta} numberOfLines={1} ellipsizeMode="middle">
            📄 {item.meta.openFile.path}
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
  const memoryOnly = !!useAttachmentSource().memoryOnly
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
        <Image
          source={{ uri: local.uri }}
          style={c.attThumb}
          contentFit="cover"
          cachePolicy={memoryOnly ? 'memory' : undefined}
        />
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
              : a.progress !== undefined && a.size
                ? `enviando… ${Math.round(a.progress * 100)}%`
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
  onQueueRemove,
  attach,
  hostUnavailable,
  voiceConfig,
  openFile = null,
  onClearOpenFile,
  files = null
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
  attach?: ComposerAttach
  /** O host não está ao alcance (chat ao vivo: reconectando / indisponível) — ponto amarelo. */
  hostUnavailable?: boolean
  /**
   * Config do chat (a que este celular tem — salvo, controle remoto ou ao vivo): o ditado usa a
   * transcrição/idioma da persona/chat (protocolo 1.9.0) e o microfone esmaece com o motivo.
   */
  voiceConfig?: Record<string, unknown> | null
  /**
   * Arquivo selecionado (1.13.0): o aberto por último no visualizador do host deste chat — chip
   * `[arquivo ×]` e `meta.openFile` no envio. null = sem chip (chat executado aqui, host fora).
   */
  openFile?: OpenFileSelection | null
  /** × do chip: para de mencionar o arquivo (até abrir um arquivo de novo). */
  onClearOpenFile?: () => void
  /** `fs.list` do host (chat de outro dispositivo com os arquivos ao alcance): popup de `@`. */
  files?: HostLister | null
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
  const inputRef = useRef<ComponentRef<typeof TextInput>>(null)
  const [fileInfo, setFileInfo] = useState(false)
  const chip = openFileChipOf(openFile)
  const connTone = useConnectionTone()
  const tone =
    hostUnavailable && connTone.color === colors.success
      ? { color: colors.warning, label: `${hostName} reconectando` }
      : connTone
  // ---- ditado ----
  const dict = useDictationView()
  const chatVoice = useChatVoice(voiceConfig)
  const recording = dict.phase !== 'idle'
  const [sel, setSel] = useState({ start: 0, end: 0 })
  // ---- popup de @ (arquivos do host, pasta por pasta) ----
  const query =
    files && !disabled && sel.start === sel.end && sel.start <= text.length
      ? activeMentionQuery(text, sel.start)
      : null
  const [mentionOff, setMentionOff] = useState<number | null>(null)
  const mentionOpen = !!query && mentionOff !== query.start
  const dirPart = query ? mentionDirPart(query.query) : ''
  // fechado com × vale até o token mudar de lugar/sumir; cada abertura relista a pasta (o host
  // pode ter mudado) — ajuste de estado no render, sem efeito em cascata
  const queryStart = query?.start ?? null
  const [lastStart, setLastStart] = useState<number | null>(null)
  const [listEpoch, setListEpoch] = useState(0)
  const [wasOpen, setWasOpen] = useState(false)
  if (queryStart !== lastStart) {
    setLastStart(queryStart)
    if (mentionOff !== null && mentionOff !== queryStart) setMentionOff(null)
  }
  if (mentionOpen !== wasOpen) {
    setWasOpen(mentionOpen)
    if (mentionOpen) setListEpoch((n) => n + 1)
  }
  const listKey = `${listEpoch}\n${dirPart}`
  const [listing, setListing] = useState<{
    key: string
    entries: string[]
    error: string | null
  } | null>(null)
  useEffect(() => {
    if (!mentionOpen || !files) return
    let alive = true
    void files(dirPart.replace(/\/$/, '')).then((r) => {
      if (alive)
        setListing({
          key: listKey,
          entries: mentionEntries(dirPart, r),
          error: r.ok ? null : r.message
        })
    })
    return () => {
      alive = false
    }
  }, [mentionOpen, files, dirPart, listKey])
  const listed = listing?.key === listKey ? listing : null
  const mentionItems =
    mentionOpen && query && listed ? filterMentionIndex(listed.entries, query.query, 30) : []
  const pickMention = (it: MentionCandidate) => {
    if (!query) return
    const r = applyMention(text, query, { path: it.path, dir: it.dir })
    setText(r.text)
    setSel({ start: r.caret, end: r.caret })
    requestAnimationFrame(() => inputRef.current?.setSelection(r.caret, r.caret))
  }
  const [anchor, setAnchor] = useState<DictationAnchor | null>(null)
  const [dictError, setDictError] = useState<{ text: string; partial: string } | null>(null)
  const [now, setNow] = useState(0)
  const textRef = useRef(text)
  useEffect(() => {
    textRef.current = text
  }, [text])
  const anchorRef = useRef<DictationAnchor | null>(null)
  /** O campo tem texto ditado: o envio leva `meta.voice` (zera quando o campo esvazia). */
  const dictatedRef = useRef(false)
  const pttRef = useRef(false)
  useEffect(() => {
    if (!text.trim()) dictatedRef.current = false
  }, [text])
  useEffect(() => {
    if (dict.phase !== 'recording') return
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [dict.phase])
  // sair do chat no meio do ditado: descarta
  useEffect(() => () => voice.dictation.cancel(), [])

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
          const picked = new File(uri)
          const data = new Uint8Array(await picked.arrayBuffer())
          if (attach) {
            if (attach.ephemeral && /\/cache\//.test(uri)) {
              try {
                picked.delete()
              } catch {
                /* o seletor já apagou */
              }
            }
            // chat ao vivo: pedaços pelo attach.put direto ao host (§23.7)
            const up = await attach.start(data, name, mime, (sent, total) =>
              patch(key, { progress: total ? sent / total : 1 })
            )
            patch(key, {
              status: 'uploading',
              file: up.file,
              kind: up.kind,
              size: up.size,
              name: up.name,
              progress: 0,
              cancel: up.cancel
            })
            const info = await up.done
            const prep: PreparedAttachment = { info, blobId: '', data: new Uint8Array(0) }
            patch(key, { status: 'ready', prepared: prep, progress: 1 })
            resolveDone(prep)
            return
          }
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
    [attach]
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

  const submit = async (force: boolean, override?: string) => {
    if (override === undefined && !canSend) return
    const value = override ?? text
    if (!value.trim() && !atts.some((a) => a.status !== 'error') && !picked.length) return
    const limits = (attach?.checkLimits ?? checkMessageLimits)(
      atts.filter((a) => a.status !== 'error')
    )
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
      const snapshot = { text: value, atts, picked }
      const dictated = dictatedRef.current
      dictatedRef.current = false
      setText('')
      setAtts([])
      setPicked([])
      if (force) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined)
      const ok = await onSend({
        text: snapshot.text.trim(),
        attachments: ready,
        skills: snapshot.picked,
        force,
        ...(dictated ? { voice: { source: 'dictation' as const } } : {}),
        // arquivo selecionado (1.13.0): o caminho do host como veio; o host normaliza pela raiz dele
        ...(chip && openFile ? { openFile: { path: openFile.path } } : {})
      })
      if (!ok) {
        dictatedRef.current = dictated
        // §8.6: falhou → o texto volta ao composer
        setText((cur) => cur || snapshot.text)
        setAtts((cur) => (cur.length ? cur : snapshot.atts))
        setPicked((cur) => (cur.length ? cur : snapshot.picked))
      }
    } finally {
      setSending(false)
    }
  }

  // ---------------- ditado ----------------

  const insertSpoken = (spoken: string): string => {
    const cur = textRef.current
    const at = rebaseDictationAnchor(anchorRef.current, cur)
    const r = insertDictationText(cur, at.start, at.end, spoken)
    if (r.insert) {
      setText(r.value)
      dictatedRef.current = true
      setSel({ start: r.caret, end: r.caret })
    }
    return r.value
  }

  const finishDictation = async (andSend: boolean) => {
    pttRef.current = false
    voice.dictation.onAutoStop = null
    const partial = voice.dictation.getView().partial
    try {
      const r = await voice.dictation.finish()
      setAnchor(null)
      if (!r) return
      const value = r.text ? insertSpoken(r.text) : textRef.current
      if (andSend) void submit(false, value)
    } catch (e) {
      setAnchor(null)
      setDictError({ text: describeError(e), partial })
    }
  }

  const startDictation = async () => {
    if (recording || disabled) return
    const blocked = chatVoice.mic.text ?? voice.dictation.blocked(chatVoice.layers)
    if (blocked) {
      toast(blocked, 'danger')
      return
    }
    // a transcrição da persona não vale aqui: aviso discreto (usa a padrão deste aparelho)
    if (chatVoice.mic.note) toast(chatVoice.mic.note, 'info')
    setDictError(null)
    const a: DictationAnchor = { text, start: sel.start, end: sel.end }
    anchorRef.current = a
    setAnchor(a)
    voice.dictation.onAutoStop = () => void finishDictation(false)
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined)
    const err = await voice.dictation.start(chatVoice.layers, chatVoice.signature)
    if (err) {
      setAnchor(null)
      toast(err, 'danger')
    }
  }

  const cancelDictation = () => {
    pttRef.current = false
    voice.dictation.onAutoStop = null
    voice.dictation.cancel()
    setAnchor(null)
  }

  const preview = recording ? dictationPreview(text, anchor, dict.partial || '') : null

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
        {atts.length || picked.length || chip ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={c.atts}
            keyboardShouldPersistTaps="always"
          >
            {chip ? (
              <Pressable
                style={c.fileChip}
                onPress={() => setFileInfo(true)}
                accessibilityRole="button"
                accessibilityLabel={`Arquivo selecionado: ${chip.display}`}
                accessibilityHint="Mostra o texto que vai ao modelo com a mensagem"
                testID="composer-file-chip"
              >
                <Ionicons name="document-text-outline" size={14} color={colors.accentStrong} />
                <Text style={c.fileChipText} numberOfLines={1}>
                  {chip.name}
                </Text>
                <Pressable
                  onPress={onClearOpenFile}
                  hitSlop={10}
                  accessibilityLabel="Não mencionar este arquivo"
                  testID="composer-file-dismiss"
                >
                  <Ionicons name="close" size={14} color={colors.subtle} />
                </Pressable>
              </Pressable>
            ) : null}
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
                onRemove={() => {
                  // envio ao host em andamento (chat ao vivo): cancela lá também
                  if (a.status !== 'ready') a.cancel?.()
                  setAtts((x) => x.filter((y) => y.key !== a.key))
                }}
              />
            ))}
          </ScrollView>
        ) : null}
        {dictError ? (
          <View style={c.dictErr} testID="voice-error">
            <Text style={c.dictErrText}>{dictError.text}</Text>
            <View style={{ flexDirection: 'row', gap: 14 }}>
              {dictError.partial ? (
                <Pressable
                  onPress={() => {
                    insertSpoken(dictError.partial)
                    setDictError(null)
                  }}
                  testID="voice-insert-partial"
                >
                  <Text style={c.dictErrLink}>Inserir o texto parcial</Text>
                </Pressable>
              ) : null}
              <Pressable onPress={() => setDictError(null)} testID="voice-error-close">
                <Text style={c.dictErrLink}>Fechar</Text>
              </Pressable>
            </View>
          </View>
        ) : null}
        {mentionOpen && query ? (
          <View style={c.mentions} testID="mention-popup">
            <View style={c.mentionHead}>
              <Ionicons name="folder-open-outline" size={12} color={colors.subtle} />
              <Text style={c.mentionNote} numberOfLines={1}>
                Arquivos do host: pasta por pasta{dirPart ? ` · ${dirPart}` : ''}
              </Text>
              <Pressable
                onPress={() => setMentionOff(query.start)}
                hitSlop={10}
                accessibilityLabel="Fechar a lista de arquivos"
                testID="mention-close"
              >
                <Ionicons name="close" size={15} color={colors.subtle} />
              </Pressable>
            </View>
            {!listed ? (
              <ActivityIndicator
                size={12}
                color={colors.accentStrong}
                style={{ paddingVertical: 8 }}
              />
            ) : mentionItems.length ? (
              <ScrollView style={c.mentionList} keyboardShouldPersistTaps="always">
                {mentionItems.map((it) => (
                  <Pressable
                    key={it.path}
                    onPress={() => pickMention(it)}
                    style={({ pressed }) => [
                      c.mentionItem,
                      pressed && { backgroundColor: colors.hover }
                    ]}
                    accessibilityLabel={it.dir ? `Pasta ${it.path}` : it.path}
                    testID="mention-item"
                  >
                    <Ionicons
                      name={it.dir ? 'folder' : 'document-outline'}
                      size={15}
                      color={it.dir ? colors.accentStrong : colors.muted}
                    />
                    <Text style={c.mentionText} numberOfLines={1} ellipsizeMode="head">
                      <Text style={c.mentionParent}>{it.parent}</Text>
                      {it.name}
                      {it.dir ? '/' : ''}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            ) : (
              <Text style={c.mentionEmpty}>{listed.error ?? 'Nada encontrado nesta pasta.'}</Text>
            )}
          </View>
        ) : null}
        {preview ? (
          <Text style={[c.input, c.mirror]} testID="voice-draft">
            {preview.before}
            {preview.lead}
            <Text style={c.partial} testID="voice-partial">
              {preview.spoken || (dict.phase === 'transcribing' ? 'Transcrevendo…' : 'Ouvindo…')}
            </Text>
            {preview.trail}
            {preview.after}
          </Text>
        ) : null}
        <TextInput
          ref={inputRef}
          testID="composer-input"
          value={text}
          onChangeText={setText}
          onSelectionChange={(e) => setSel(e.nativeEvent.selection)}
          editable={!disabled}
          placeholder={disabled ?? placeholder}
          placeholderTextColor={colors.faint}
          multiline
          style={[c.input, preview ? c.hidden : null]}
          textAlignVertical="top"
        />
        {recording ? (
          <View style={c.bar} testID="voice-recording">
            <Pressable
              onPress={cancelDictation}
              hitSlop={6}
              style={c.iconBtn}
              accessibilityLabel="Cancelar o ditado"
              testID="voice-cancel-button"
            >
              <Ionicons name="close" size={21} color={colors.muted} />
            </Pressable>
            <View style={c.status}>
              {dict.phase === 'transcribing' || dict.phase === 'starting' ? (
                <ActivityIndicator size={10} color={colors.accentStrong} />
              ) : (
                <View style={c.recDotBox}>
                  <View
                    style={[c.recDot, { transform: [{ scale: 1 + Math.min(1, dict.level * 12) }] }]}
                  />
                </View>
              )}
              <Text style={c.statusText} numberOfLines={1} testID="voice-status">
                {dict.phase === 'transcribing'
                  ? 'Transcrevendo…'
                  : dict.phase === 'starting'
                    ? 'Abrindo o microfone…'
                    : `Ouvindo… ${clock(dict.startedAt && now > dict.startedAt ? now - dict.startedAt : 0)}`}
              </Text>
            </View>
            <Pressable
              onPress={() => void finishDictation(false)}
              disabled={dict.phase !== 'recording'}
              style={[c.stop, dict.phase !== 'recording' && { opacity: 0.4 }]}
              accessibilityLabel="Concluir o ditado"
              testID="voice-finish-button"
            >
              <Ionicons name="checkmark" size={18} color={colors.fg} />
            </Pressable>
            <Pressable
              onPress={() => void finishDictation(true)}
              disabled={dict.phase !== 'recording'}
              style={[c.send, dict.phase !== 'recording' && c.sendOff]}
              accessibilityLabel="Concluir e enviar"
              testID="voice-send-button"
            >
              <Ionicons name={busy ? 'add' : 'arrow-up'} size={19} color="#fff" />
            </Pressable>
          </View>
        ) : (
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
            {!disabled ? (
              <Pressable
                onPress={() => void startDictation()}
                onLongPress={() => {
                  // segurar para falar (audioInput.pttEnabled): soltar conclui
                  if (!voice.dictation.pttEnabled()) return
                  pttRef.current = true
                  void startDictation()
                }}
                onPressOut={() => {
                  if (pttRef.current) void finishDictation(false)
                }}
                delayLongPress={300}
                hitSlop={6}
                style={c.iconBtn}
                accessibilityLabel="Ditar"
                accessibilityHint={
                  chatVoice.mic.text ?? chatVoice.mic.note ?? 'Grava sua fala e transcreve no campo'
                }
                testID="composer-mic"
              >
                <Ionicons
                  name={chatVoice.mic.text ? 'mic-off-outline' : 'mic-outline'}
                  size={21}
                  color={chatVoice.mic.text ? colors.faint : colors.muted}
                  style={chatVoice.mic.text ? { opacity: 0.6 } : undefined}
                />
              </Pressable>
            ) : null}
            <View style={c.status}>
              {busy ? (
                <ActivityIndicator size={10} color={colors.accentStrong} />
              ) : (
                <View
                  style={[c.dot, { backgroundColor: tone.color }]}
                  accessibilityLabel={tone.label}
                  testID="composer-dot"
                />
              )}
              <Text style={c.statusText} numberOfLines={1} testID="composer-status">
                {statusText ??
                  (hostName === 'este celular'
                    ? 'Executa neste celular'
                    : `Executa em ${hostName}`)}
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
        )}
      </View>
      {chip ? (
        <Sheet
          visible={fileInfo}
          onClose={() => setFileInfo(false)}
          title="Arquivo selecionado"
          subtitle={chip.display}
          testID="composer-file-sheet"
        >
          <MonoBlock label="Vai ao modelo depois da sua mensagem" text={chip.modelText} />
          <SheetItem
            icon="close-circle-outline"
            label="Não mencionar este arquivo"
            detail="Volta quando você abrir um arquivo do host de novo"
            onPress={() => {
              setFileInfo(false)
              onClearOpenFile?.()
            }}
            testID="composer-file-sheet-dismiss"
          />
        </Sheet>
      ) : null}
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
  // o pé da tela inteiro é o campo (ui/BottomBar.tsx): sem caixa, sem borda — a superfície é a do
  // rodapé da conversa, que desce até a borda da tela
  box: {
    paddingTop: 2,
    paddingBottom: 2,
    paddingHorizontal: 4
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
  fileChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    maxWidth: 220,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.accentBorder,
    backgroundColor: colors.accentSoft,
    paddingHorizontal: 10,
    height: 32
  },
  fileChipText: { flexShrink: 1, color: colors.fg, fontSize: 12.5, fontFamily: font.mono },
  mentions: {
    marginHorizontal: 8,
    marginTop: 4,
    marginBottom: 2,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.elevated,
    paddingVertical: 4
  },
  mentionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 4
  },
  mentionNote: { flex: 1, color: colors.subtle, fontSize: 11.5 },
  mentionList: { maxHeight: 200 },
  mentionItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    paddingHorizontal: 10,
    paddingVertical: 8
  },
  mentionText: { flex: 1, color: colors.fg, fontSize: 13.5, fontFamily: font.mono },
  mentionParent: { color: colors.subtle },
  mentionEmpty: { color: colors.subtle, fontSize: 12.5, paddingHorizontal: 10, paddingVertical: 8 },
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
  recDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.danger },
  recDotBox: { width: 18, alignItems: 'center', justifyContent: 'center' },
  mirror: { color: colors.fg },
  partial: { color: colors.fg, opacity: 0.5, fontStyle: 'italic' },
  hidden: { position: 'absolute', opacity: 0, height: 0, minHeight: 0 },
  dictErr: {
    marginHorizontal: 10,
    marginTop: 4,
    marginBottom: 2,
    borderRadius: 10,
    backgroundColor: 'rgba(248,113,113,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(248,113,113,0.35)',
    padding: 8,
    gap: 6
  },
  dictErrText: { color: colors.fg, fontSize: 12.5, lineHeight: 17 },
  dictErrLink: { color: colors.accentStrong, fontSize: 12.5, fontWeight: '600' },
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
