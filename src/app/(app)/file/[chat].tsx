// Visualizador de um arquivo do HOST (`fs.read` em pedaços, SYNC_PROTOCOL.md §8.6): texto/código/
// Markdown paginados ("Carregar mais", corte de UTF-8 respeitado, tamanho/mtime conferidos a cada
// pedaço), imagens inteiras com progresso, e os demais tipos com "Baixar e abrir". Somente leitura.
import Ionicons from '@expo/vector-icons/Ionicons'
import { File, Paths } from 'expo-file-system'
import { Image } from 'expo-image'
import { useLocalSearchParams, useRouter } from 'expo-router'
import * as Sharing from 'expo-sharing'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import {
  detectViewerKind,
  VIEWER_IMAGE_MIMES,
  viewerTypeLabel,
  fileExtOf
} from '@shared/fileViewer'
import { safeFileName, type RemoteFsFailure } from '@shared/remoteFs'
import type { ViewerKind } from '@shared/types'
import { Markdown } from '@/chat/Markdown'
import { concatBytes, fetchRange, formatBytes, RemoteFileError, splitUtf8 } from '@/remote/files'
import { remote } from '@/remote/react'
import { colors, font } from '@/ui/theme'

/** Bytes por página de texto (o host aceita até 512 KiB por pedido). */
const TEXT_PAGE = 128 * 1024
/** Imagens/arquivos baixados inteiros até isto. */
const FULL_MAX = 40 * 1024 * 1024
const LINES_PER_BLOCK = 80

interface TextState {
  text: string
  /** Bytes do arquivo já lidos (próximo offset). */
  offset: number
  /** Fim incompleto de um caractere UTF-8 (vai na frente do próximo pedaço). */
  carry: Uint8Array
}

export default function HostFile() {
  const {
    chat,
    path,
    name: nameParam
  } = useLocalSearchParams<{
    chat: string
    path: string
    name?: string
  }>()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const name = nameParam || path.split(/[\\/]/).pop() || 'arquivo'
  const host = remote.hostName(chat)
  const [info, setInfo] = useState<{ size: number; mtime: number; kind: ViewerKind } | null>(null)
  const [error, setError] = useState<RemoteFsFailure | string | null>(null)
  const [text, setText] = useState<TextState | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const [imageUri, setImageUri] = useState<string | null>(null)
  const [rendered, setRendered] = useState(true)
  const alive = useRef({ aborted: false })
  const read = useCallback(
    (offset: number, length: number) => remote.fsRead(chat, path, offset, length),
    [chat, path]
  )

  const fail = (e: unknown) =>
    setError(e instanceof RemoteFileError ? e.failure : e instanceof Error ? e.message : String(e))

  const downloadFull = useCallback(
    async (size: number, mtime: number): Promise<File> => {
      setProgress(0)
      const r = await fetchRange(read, {
        maxBytes: Math.min(size, FULL_MAX),
        expect: { size, mtime },
        onProgress: (d, t) => setProgress(t ? d / t : 1),
        signal: alive.current
      })
      const f = new File(Paths.cache, `host-${Date.now()}-${safeFileName(name)}`)
      f.create({ overwrite: true })
      f.write(r.bytes)
      setProgress(null)
      return f
    },
    [read, name]
  )

  useEffect(() => {
    const a = { aborted: false }
    alive.current = a
    void (async () => {
      try {
        const first = await fetchRange(read, { maxBytes: TEXT_PAGE, signal: a })
        if (a.aborted) return
        const kind = detectViewerKind(name, first.bytes.subarray(0, 8000))
        setInfo({ size: first.size, mtime: first.mtime, kind })
        if (kind === 'image') {
          if (first.size > FULL_MAX) return
          const f = first.complete ? null : await downloadFull(first.size, first.mtime)
          if (a.aborted) return
          if (f) setImageUri(f.uri)
          else {
            const tmp = new File(Paths.cache, `host-${Date.now()}-${safeFileName(name)}`)
            tmp.create({ overwrite: true })
            tmp.write(first.bytes)
            setImageUri(tmp.uri)
          }
          return
        }
        if (kind === 'markdown' || kind === 'code' || kind === 'text' || kind === 'html') {
          const [ok, carry] = first.complete
            ? [first.bytes, new Uint8Array(0)]
            : splitUtf8(first.bytes)
          setText({
            text: new TextDecoder().decode(ok),
            offset: first.bytes.length,
            carry
          })
        }
      } catch (e) {
        if (!a.aborted) fail(e)
      }
    })()
    return () => {
      a.aborted = true
    }
  }, [read, name, downloadFull])

  const more = async () => {
    if (!text || !info || loadingMore) return
    setLoadingMore(true)
    try {
      const r = await fetchRange(read, {
        offset: text.offset,
        maxBytes: TEXT_PAGE,
        expect: { size: info.size, mtime: info.mtime }
      })
      const all = concatBytes(text.carry, r.bytes)
      const done = text.offset + r.bytes.length >= info.size
      const [ok, carry] = done ? [all, new Uint8Array(0)] : splitUtf8(all)
      setText({
        text: text.text + new TextDecoder().decode(ok),
        offset: text.offset + r.bytes.length,
        carry
      })
    } catch (e) {
      fail(e)
    } finally {
      setLoadingMore(false)
    }
  }

  const openExternally = async () => {
    if (!info) return
    try {
      const f = await downloadFull(info.size, info.mtime)
      await Sharing.shareAsync(f.uri, {
        mimeType:
          info.kind === 'pdf'
            ? 'application/pdf'
            : (VIEWER_IMAGE_MIMES[fileExtOf(name)] ?? 'application/octet-stream'),
        dialogTitle: name
      })
    } catch (e) {
      setProgress(null)
      fail(e)
    }
  }

  const blocks = useMemo(() => {
    if (!text) return []
    const lines = text.text.split('\n')
    const out: { key: string; text: string; first: number }[] = []
    for (let i = 0; i < lines.length; i += LINES_PER_BLOCK)
      out.push({ key: String(i), text: lines.slice(i, i + LINES_PER_BLOCK).join('\n'), first: i })
    return out
  }, [text])

  const remaining = info && text ? info.size - text.offset : 0
  const isMd = info?.kind === 'markdown'

  return (
    <View style={st.root} testID="screen-host-file">
      <View style={[st.header, { paddingTop: insets.top + 4 }]}>
        <Pressable
          onPress={() => router.back()}
          hitSlop={10}
          style={st.iconBtn}
          accessibilityLabel="Voltar"
        >
          <Ionicons name="chevron-back" size={24} color={colors.fg} />
        </Pressable>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={st.title} numberOfLines={1}>
            {name}
          </Text>
          <Text style={st.sub} numberOfLines={1}>
            {[host, info && viewerTypeLabel(info.kind, name), info && formatBytes(info.size)]
              .filter(Boolean)
              .join(' · ')}
          </Text>
        </View>
        {isMd ? (
          <Pressable
            onPress={() => setRendered((r) => !r)}
            hitSlop={10}
            style={st.iconBtn}
            accessibilityLabel={rendered ? 'Ver texto puro' : 'Ver formatado'}
            testID="file-toggle-md"
          >
            <Ionicons
              name={rendered ? 'code-outline' : 'reader-outline'}
              size={20}
              color={colors.muted}
            />
          </Pressable>
        ) : null}
      </View>
      {error ? (
        <View style={st.center} testID="file-error">
          <Ionicons name="alert-circle-outline" size={30} color={colors.subtle} />
          <Text style={st.errText}>{typeof error === 'string' ? error : error.message}</Text>
        </View>
      ) : !info ? (
        <View style={st.center}>
          <ActivityIndicator color={colors.accentStrong} />
          <Text style={st.muted}>Lendo do {host}…</Text>
        </View>
      ) : info.kind === 'image' ? (
        <View style={st.center}>
          {imageUri ? (
            <Image
              source={{ uri: imageUri }}
              style={st.image}
              contentFit="contain"
              testID="file-image"
            />
          ) : info.size > FULL_MAX ? (
            <Text style={st.muted}>
              Imagem grande demais para a prévia ({formatBytes(info.size)}).
            </Text>
          ) : (
            <>
              <ActivityIndicator color={colors.accentStrong} />
              <Text style={st.muted}>
                Baixando… {progress != null ? `${Math.round(progress * 100)}%` : ''}
              </Text>
            </>
          )}
        </View>
      ) : text ? (
        isMd && rendered ? (
          <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24 }}>
            <Markdown text={text.text} />
            <MoreButton remaining={remaining} loading={loadingMore} onPress={() => void more()} />
          </ScrollView>
        ) : (
          <FlatList
            data={blocks}
            keyExtractor={(b) => b.key}
            contentContainerStyle={{ paddingVertical: 10, paddingBottom: insets.bottom + 24 }}
            renderItem={({ item }) => (
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <Text style={st.code} selectable testID="file-text">
                  {item.text}
                </Text>
              </ScrollView>
            )}
            ListFooterComponent={
              <MoreButton remaining={remaining} loading={loadingMore} onPress={() => void more()} />
            }
          />
        )
      ) : (
        <View style={st.center} testID="file-binary">
          <Ionicons
            name={info.kind === 'pdf' ? 'document-text-outline' : 'document-outline'}
            size={40}
            color={colors.subtle}
          />
          <Text style={st.errText}>
            {viewerTypeLabel(info.kind, name)} · {formatBytes(info.size)}
          </Text>
          <Text style={st.muted}>Sem prévia no celular.</Text>
          {info.size <= FULL_MAX ? (
            <Pressable
              onPress={() => void openExternally()}
              style={st.btn}
              disabled={progress != null}
              testID="file-open"
            >
              {progress != null ? (
                <ActivityIndicator size={14} color="#fff" />
              ) : (
                <Ionicons name="download-outline" size={17} color="#fff" />
              )}
              <Text style={st.btnText}>
                {progress != null ? `Baixando… ${Math.round(progress * 100)}%` : 'Baixar e abrir'}
              </Text>
            </Pressable>
          ) : (
            <Text style={st.muted}>Grande demais para baixar pelo celular.</Text>
          )}
        </View>
      )}
    </View>
  )
}

function MoreButton({
  remaining,
  loading,
  onPress
}: {
  remaining: number
  loading: boolean
  onPress: () => void
}) {
  if (remaining <= 0)
    return <Text style={[st.muted, { textAlign: 'center', padding: 16 }]}>— fim do arquivo —</Text>
  return (
    <Pressable onPress={onPress} disabled={loading} style={st.more} testID="file-more">
      {loading ? <ActivityIndicator size={14} color={colors.accentStrong} /> : null}
      <Text style={st.link}>Carregar mais · faltam {formatBytes(remaining)}</Text>
    </Pressable>
  )
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 6,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border
  },
  iconBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  title: { color: colors.fg, fontSize: 16.5, fontWeight: '600' },
  sub: { color: colors.subtle, fontSize: 11.5 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 24 },
  muted: { color: colors.subtle, fontSize: 13.5 },
  errText: { color: colors.muted, fontSize: 14, textAlign: 'center', lineHeight: 20 },
  image: { width: '100%', height: '100%' },
  code: {
    color: colors.fg,
    fontFamily: font.mono,
    fontSize: 12.5,
    lineHeight: 18,
    paddingHorizontal: 14
  },
  more: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    margin: 16,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.elevated
  },
  link: { color: colors.accentStrong, fontSize: 14, fontWeight: '500' },
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
    paddingHorizontal: 18,
    height: 46,
    borderRadius: 12,
    backgroundColor: colors.accent
  },
  btnText: { color: '#fff', fontSize: 15, fontWeight: '600' }
})
