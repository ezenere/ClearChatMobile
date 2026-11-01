// Arquivos do HOST (aba Arquivos do desktop vista de um controle remoto, SYNC_PROTOCOL.md §8.6
// `fs.list`): a raiz do chat no host, pastas primeiro; tocar numa pasta abre outra tela (o voltar
// do sistema sobe um nível), num arquivo abre o visualizador. Somente leitura.
import Ionicons from '@expo/vector-icons/Ionicons'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useCallback, useEffect, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { fileExtOf, kindFromName } from '@shared/fileViewer'
import type { RemoteDirResult, RemoteFsEntry } from '@shared/remoteFs'
import { relativeTime } from '@/chat/format'
import { formatBytes } from '@/remote/files'
import { joinHost } from '@/remote/hostPaths'
import { remote } from '@/remote/react'
import type { IconName } from '@/ui/Button'
import { colors } from '@/ui/theme'

function fileIcon(e: RemoteFsEntry): IconName {
  if (e.kind === 'dir') return 'folder'
  const k = kindFromName(e.name)
  if (k === 'image') return 'image-outline'
  if (k === 'pdf') return 'document-text-outline'
  if (k === 'code' || k === 'html') return 'code-slash-outline'
  if (k === 'markdown') return 'reader-outline'
  if (['zip', 'gz', 'tar', '7z', 'rar'].includes(fileExtOf(e.name))) return 'archive-outline'
  return 'document-outline'
}

export default function HostFiles() {
  const { chat, path = '' } = useLocalSearchParams<{ chat: string; path?: string }>()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const [res, setRes] = useState<RemoteDirResult | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const host = remote.hostName(chat)

  const load = useCallback(async () => {
    setRes(await remote.fsList(chat, path))
  }, [chat, path])
  useEffect(() => {
    let alive = true
    void remote.fsList(chat, path).then((r) => alive && setRes(r))
    return () => {
      alive = false
    }
  }, [chat, path])

  const ok = res?.ok ? res : null
  const atRoot = !path || (ok ? ok.dir === ok.root : false)
  const title = atRoot ? 'Arquivos do host' : (path.split(/[\\/]/).filter(Boolean).pop() ?? path)

  return (
    <View style={st.root} testID="screen-host-files">
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
            {title}
          </Text>
          <Text style={st.sub} numberOfLines={1} ellipsizeMode="head">
            {host}
            {ok ? ` · ${ok.dir}` : ''}
          </Text>
        </View>
      </View>
      {!res ? (
        <View style={st.center}>
          <ActivityIndicator color={colors.accentStrong} />
          <Text style={st.muted}>Pedindo a lista ao {host}…</Text>
        </View>
      ) : !res.ok ? (
        <View style={st.center} testID="files-error">
          <Ionicons
            name={
              res.reason === 'host-offline'
                ? 'power-outline'
                : res.reason === 'denied'
                  ? 'lock-closed-outline'
                  : 'alert-circle-outline'
            }
            size={30}
            color={colors.subtle}
          />
          <Text style={st.errText}>{res.message}</Text>
          <Pressable onPress={() => void load()} style={st.retry} testID="files-retry">
            <Text style={st.link}>Tentar de novo</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={res.entries}
          keyExtractor={(e) => `${e.kind}:${e.name}`}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              tintColor={colors.accentStrong}
              colors={[colors.accent]}
              progressBackgroundColor={colors.elevated}
              onRefresh={() => {
                setRefreshing(true)
                void load().finally(() => setRefreshing(false))
              }}
            />
          }
          contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
          ListHeaderComponent={
            <View style={st.note}>
              <Ionicons
                name={res.confine ? 'shield-checkmark-outline' : 'warning-outline'}
                size={13}
                color={colors.subtle}
              />
              <Text style={st.noteText} numberOfLines={2}>
                {res.confine
                  ? `Raiz do chat no ${host}: ${res.root}`
                  : `Sem confinamento à raiz (${res.root})`}
              </Text>
            </View>
          }
          ListEmptyComponent={
            <Text style={[st.muted, { textAlign: 'center', marginTop: 40 }]}>Pasta vazia.</Text>
          }
          ListFooterComponent={
            res.truncated ? (
              <Text style={[st.muted, { padding: 16 }]}>
                Pasta com entradas demais — só as primeiras aparecem.
              </Text>
            ) : undefined
          }
          renderItem={({ item }) => (
            <Pressable
              testID={`file-${item.name}`}
              onPress={() =>
                item.kind === 'dir'
                  ? router.push({
                      pathname: '/files/[chat]',
                      params: { chat, path: joinHost(res.dir, item.name) }
                    })
                  : router.push({
                      pathname: '/file/[chat]',
                      params: { chat, path: joinHost(res.dir, item.name), name: item.name }
                    })
              }
              style={({ pressed }) => [st.item, pressed && { backgroundColor: colors.hover }]}
            >
              <Ionicons
                name={fileIcon(item)}
                size={21}
                color={item.kind === 'dir' ? colors.accentStrong : colors.muted}
              />
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={st.name} numberOfLines={1}>
                  {item.name}
                </Text>
                <Text style={st.meta}>
                  {[
                    item.kind === 'file' && item.size !== undefined && formatBytes(item.size),
                    item.mtime && relativeTime(item.mtime)
                  ]
                    .filter(Boolean)
                    .join(' · ') || (item.kind === 'dir' ? 'pasta' : '')}
                </Text>
              </View>
              {item.kind === 'dir' ? (
                <Ionicons name="chevron-forward" size={16} color={colors.faint} />
              ) : null}
            </Pressable>
          )}
        />
      )}
    </View>
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
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 32 },
  muted: { color: colors.subtle, fontSize: 13.5 },
  errText: { color: colors.muted, fontSize: 14, textAlign: 'center', lineHeight: 20 },
  retry: { padding: 10 },
  link: { color: colors.accentStrong, fontSize: 14.5, fontWeight: '500' },
  note: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 10
  },
  noteText: { flex: 1, color: colors.subtle, fontSize: 12 },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 16,
    paddingVertical: 11
  },
  name: { color: colors.fg, fontSize: 15 },
  meta: { color: colors.faint, fontSize: 12 }
})
