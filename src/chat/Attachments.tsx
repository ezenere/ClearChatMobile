// Anexos na conversa (§14): miniaturas de imagem (baixadas e decifradas sob demanda, cache em
// arquivo), visualizador em tela cheia com pinça/duplo toque e compartilhar, e chips de arquivo
// (PDF, áudio, texto) que abrem no app do sistema ou mostram o conteúdo (texto inline).
import Ionicons from '@expo/vector-icons/Ionicons'
import { File } from 'expo-file-system'
import { Image } from 'expo-image'
import * as Sharing from 'expo-sharing'
import { memo, useState } from 'react'
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native'
import {
  GestureDetector,
  usePanGesture,
  usePinchGesture,
  useSimultaneousGestures,
  useTapGesture,
  useExclusiveGestures
} from 'react-native-gesture-handler'
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { formatSize, KIND_LABEL, textFileBody } from '@shared/attachments'
import type { AttachmentKind, AttachmentMeta, ContentPart } from '@shared/types'
import { useAttachment } from '@/data/react'
import { useToast } from '@/ui/Toast'
import type { IconName } from '@/ui/Button'
import { colors, font, radius } from '@/ui/theme'

const KIND_ICON: Record<AttachmentKind, IconName> = {
  image: 'image-outline',
  pdf: 'document-text-outline',
  audio: 'musical-notes-outline',
  text: 'document-outline'
}
const KIND_TINT: Record<AttachmentKind, { fg: string; bg: string }> = {
  image: { fg: colors.accentStrong, bg: colors.accentSoft },
  pdf: { fg: 'rgba(248,113,113,0.9)', bg: 'rgba(248,113,113,0.1)' },
  audio: { fg: 'rgba(74,222,128,0.9)', bg: 'rgba(74,222,128,0.1)' },
  text: { fg: colors.muted, bg: 'rgba(255,255,255,0.05)' }
}

function ImageViewer({
  uri,
  name,
  mime,
  onClose
}: {
  uri: string
  name: string
  mime?: string
  onClose: () => void
}) {
  const insets = useSafeAreaInsets()
  const scale = useSharedValue(1)
  const baseScale = useSharedValue(1)
  const tx = useSharedValue(0)
  const ty = useSharedValue(0)
  const baseX = useSharedValue(0)
  const baseY = useSharedValue(0)
  const pinch = usePinchGesture({
    onUpdate: (e) => {
      scale.value = Math.max(1, Math.min(6, baseScale.value * e.scale))
    },
    onDeactivate: () => {
      baseScale.value = scale.value
      if (scale.value <= 1.01) {
        tx.value = withTiming(0)
        ty.value = withTiming(0)
        baseX.value = 0
        baseY.value = 0
      }
    }
  })
  const pan = usePanGesture({
    onUpdate: (e) => {
      if (scale.value <= 1) return
      tx.value = baseX.value + e.translationX
      ty.value = baseY.value + e.translationY
    },
    onDeactivate: () => {
      baseX.value = tx.value
      baseY.value = ty.value
    }
  })
  const doubleTap = useTapGesture({
    numberOfTaps: 2,
    onDeactivate: () => {
      const zoomed = scale.value > 1.01
      scale.value = withTiming(zoomed ? 1 : 2.5)
      baseScale.value = zoomed ? 1 : 2.5
      tx.value = withTiming(0)
      ty.value = withTiming(0)
      baseX.value = 0
      baseY.value = 0
    }
  })
  const gesture = useExclusiveGestures(doubleTap, useSimultaneousGestures(pinch, pan))
  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: scale.value }]
  }))
  return (
    <Modal
      visible
      transparent
      animationType="fade"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}
    >
      <View style={st.viewer} testID="image-viewer">
        <GestureDetector gesture={gesture}>
          <Animated.View style={[StyleSheet.absoluteFill, style]}>
            <Image
              source={{ uri }}
              style={StyleSheet.absoluteFill}
              contentFit="contain"
              accessibilityLabel={name}
            />
          </Animated.View>
        </GestureDetector>
        <View style={[st.viewerBar, { paddingTop: insets.top + 6 }]}>
          <Pressable
            onPress={onClose}
            hitSlop={10}
            accessibilityLabel="Fechar"
            testID="image-viewer-close"
            style={st.viewerBtn}
          >
            <Ionicons name="close" size={24} color="#fff" />
          </Pressable>
          <Text style={st.viewerName} numberOfLines={1}>
            {name}
          </Text>
          <Pressable
            onPress={() =>
              void Sharing.shareAsync(uri, { mimeType: mime, dialogTitle: name }).catch(
                () => undefined
              )
            }
            hitSlop={10}
            accessibilityLabel="Compartilhar"
            style={st.viewerBtn}
          >
            <Ionicons name="share-outline" size={22} color="#fff" />
          </Pressable>
        </View>
      </View>
    </Modal>
  )
}

/** Imagem de anexo: miniatura que baixa sozinha; toque abre em tela cheia. */
export const ImageThumb = memo(function ImageThumb({
  file,
  name,
  mime,
  size,
  maxWidth = 250,
  maxHeight = 190
}: {
  file: string
  name: string
  mime?: string
  size?: number
  maxWidth?: number
  maxHeight?: number
}) {
  const a = useAttachment(file, true)
  const [ratio, setRatio] = useState<number | null>(null)
  const [zoom, setZoom] = useState(false)
  const [broken, setBroken] = useState(false)
  if (a.error || broken)
    return (
      <Pressable style={st.missing} onPress={a.load} testID="attachment-missing">
        <Ionicons name="warning-outline" size={16} color={colors.danger} />
        <Text style={st.missingText}>{broken ? 'imagem inválida' : 'arquivo ausente'}</Text>
        <Text style={st.missingName} numberOfLines={1}>
          {name}
        </Text>
        {!broken ? <Text style={st.retry}>Tocar para tentar de novo</Text> : null}
      </Pressable>
    )
  if (!a.uri)
    return (
      <View style={[st.thumbLoading, { width: Math.min(maxWidth, 180) }]}>
        <ActivityIndicator color={colors.accentStrong} />
        <Text style={st.loadingText} numberOfLines={1}>
          {name}
          {size ? ` · ${formatSize(size)}` : ''}
        </Text>
      </View>
    )
  const r = ratio ?? 4 / 3
  let w = maxWidth
  let h = w / r
  if (h > maxHeight) {
    h = maxHeight
    w = h * r
  }
  return (
    <>
      <Pressable
        onPress={() => setZoom(true)}
        accessibilityLabel={`Ampliar ${name}`}
        testID="attachment-image"
      >
        <Image
          source={{ uri: a.uri }}
          style={[st.thumb, { width: Math.max(64, w), height: Math.max(48, h) }]}
          contentFit="cover"
          recyclingKey={file}
          onLoad={(e) => {
            const { width, height } = e.source
            if (width && height) setRatio(width / height)
          }}
          onError={() => setBroken(true)}
        />
      </Pressable>
      {zoom ? (
        <ImageViewer uri={a.uri} name={name} mime={mime} onClose={() => setZoom(false)} />
      ) : null}
    </>
  )
})

/** Imagem de anexo citada no Markdown (`![](clearchat-attachment://…)`). */
export function InlineAttachmentImage({ file, name }: { file: string; name?: string }) {
  return (
    <View style={{ marginVertical: 6 }}>
      <ImageThumb file={file} name={name || 'imagem'} maxWidth={300} maxHeight={260} />
    </View>
  )
}

/** Chip de arquivo (PDF/áudio/texto): abre no app do sistema; texto inline expande. */
export const FileChip = memo(function FileChip({
  meta,
  text
}: {
  meta: AttachmentMeta
  text?: string
}) {
  const [open, setOpen] = useState(false)
  const body = text != null ? textFileBody(text) : null
  const a = useAttachment(body == null ? meta.file : null, false)
  const toast = useToast()
  const tint = KIND_TINT[meta.kind] ?? KIND_TINT.text
  const openFile = async () => {
    if (body != null) {
      setOpen((o) => !o)
      return
    }
    let uri = a.uri
    if (!uri) {
      a.load()
      return
    }
    try {
      const f = new File(uri)
      if (await f.canPreview({ mimeType: meta.mime }).catch(() => false)) {
        await f.preview({ mimeType: meta.mime, title: meta.name })
        return
      }
    } catch {
      /* sem visualizador: compartilha */
    }
    try {
      await Sharing.shareAsync(uri, { mimeType: meta.mime, dialogTitle: meta.name })
    } catch {
      toast('Nenhum app para abrir este arquivo.', 'info')
    }
    uri = null
  }
  return (
    <View style={[st.fileWrap, open && { alignSelf: 'stretch' }]}>
      <Pressable
        onPress={() => void openFile()}
        style={({ pressed }) => [st.chip, pressed && { backgroundColor: colors.hover }]}
        accessibilityLabel={`Abrir ${meta.name}`}
        testID="attachment-file"
      >
        <View style={[st.chipIcon, { backgroundColor: tint.bg }]}>
          <Ionicons name={KIND_ICON[meta.kind] ?? 'document-outline'} size={17} color={tint.fg} />
        </View>
        <View style={st.chipText}>
          <Text style={st.chipName} numberOfLines={1}>
            {meta.name}
          </Text>
          <Text style={st.chipSub} numberOfLines={1}>
            {KIND_LABEL[meta.kind] ?? 'Arquivo'} · {formatSize(meta.size)}
            {meta.truncated ? ' · cortado' : ''}
            {a.error ? ` · ${a.error}` : ''}
          </Text>
        </View>
        {a.loading ? (
          <ActivityIndicator size="small" color={colors.accentStrong} />
        ) : (
          <Ionicons
            name={
              body != null
                ? open
                  ? 'chevron-up'
                  : 'chevron-down'
                : a.uri
                  ? 'open-outline'
                  : 'download-outline'
            }
            size={16}
            color={colors.subtle}
          />
        )}
      </Pressable>
      {open && body != null ? (
        <View style={st.textBody}>
          <Text style={st.textBodyText} selectable>
            {body.length > 8000 ? `${body.slice(0, 8000)}\n…` : body}
          </Text>
        </View>
      ) : null}
    </View>
  )
})

/** Anexos de uma mensagem do usuário (acima do balão). */
export function MessageAttachments({
  parts,
  align = 'end'
}: {
  parts: ContentPart[]
  align?: 'end' | 'start'
}) {
  const items = parts.filter((p) => p._attachment || (p.type === 'text' && p._skill))
  if (!items.length) return null
  return (
    <View style={[st.list, { justifyContent: align === 'end' ? 'flex-end' : 'flex-start' }]}>
      {items.map((p, i) => {
        if (p.type === 'text' && p._skill)
          return (
            <View key={i} style={[st.chip, st.skill]}>
              <View style={[st.chipIcon, { backgroundColor: 'rgba(139,92,246,0.15)' }]}>
                <Ionicons name="bulb-outline" size={16} color={colors.accentStrong} />
              </View>
              <View style={st.chipText}>
                <Text style={st.chipName} numberOfLines={1}>
                  Skill carregada: <Text style={{ fontFamily: font.mono }}>{p._skill.name}</Text>
                </Text>
                <Text style={st.chipSub}>SKILL.md</Text>
              </View>
            </View>
          )
        const meta = p._attachment!
        if (meta.kind === 'image')
          return (
            <ImageThumb
              key={i}
              file={meta.file}
              name={meta.name}
              mime={meta.mime}
              size={meta.size}
            />
          )
        return <FileChip key={i} meta={meta} text={p.type === 'text' ? p.text : undefined} />
      })}
    </View>
  )
}

const st = StyleSheet.create({
  list: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, maxWidth: '88%' },
  thumb: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg
  },
  thumbLoading: {
    height: 110,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 10
  },
  loadingText: { color: colors.subtle, fontSize: 11 },
  missing: {
    width: 170,
    paddingVertical: 12,
    paddingHorizontal: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(248,113,113,0.25)',
    backgroundColor: 'rgba(248,113,113,0.05)',
    alignItems: 'center',
    gap: 3
  },
  missingText: { color: colors.danger, fontSize: 12 },
  missingName: { color: colors.subtle, fontSize: 11 },
  retry: { color: colors.accentStrong, fontSize: 11, marginTop: 2 },
  fileWrap: { maxWidth: '100%' },
  chip: {
    height: 48,
    maxWidth: 290,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingLeft: 6,
    paddingRight: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: 'rgba(23,23,30,0.7)'
  },
  skill: { borderColor: 'rgba(139,92,246,0.25)', backgroundColor: 'rgba(139,92,246,0.08)' },
  chipIcon: {
    width: 34,
    height: 34,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center'
  },
  chipText: { flexShrink: 1, minWidth: 60 },
  chipName: { color: 'rgba(230,230,234,0.92)', fontSize: 13 },
  chipSub: { color: colors.subtle, fontSize: 11.5 },
  textBody: {
    marginTop: 6,
    maxHeight: 320,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: 'rgba(11,11,15,0.7)',
    padding: 10
  },
  textBodyText: {
    color: 'rgba(230,230,234,0.85)',
    fontFamily: font.mono,
    fontSize: 12,
    lineHeight: 18
  },
  viewer: { flex: 1, backgroundColor: '#000' },
  viewerBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 8,
    paddingBottom: 8,
    backgroundColor: 'rgba(0,0,0,0.45)'
  },
  viewerBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  viewerName: { flex: 1, color: 'rgba(255,255,255,0.85)', fontSize: 14 }
})
