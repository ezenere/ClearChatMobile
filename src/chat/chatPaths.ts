// Caminhos citados no chat (protocolo 1.13.0 — arquivo selecionado, SYNC_PROTOCOL.md §4.3.8 — e as
// menções `@caminho` no texto das mensagens). Partes PURAS (testadas em Node), espelho do
// `lib/chatPaths.ts` + `PathMentions.tsx` do desktop:
// - a linha "Arquivo selecionado: <caminho>" de uma mensagem do usuário e o texto EXATO que foi ao
//   modelo (`openFileText` — nada escondido: a folha de detalhes mostra);
// - os trechos do texto com os `@caminho` destacados (fora de código);
// - "abrir" um caminho citado num chat executado em outro dispositivo: confere ANTES pela listagem
//   da pasta-mãe no host (`fs.list`, §8.6 — relativo resolve contra a raiz DELE) e só então abre o
//   visualizador (arquivo) ou a aba Arquivos (pasta); ausente/sem acesso → aviso discreto, nada aberto;
// - o chip do composer (arquivo aberto por último no visualizador do host) e a listagem pasta a
//   pasta do popup de `@` (não há índice da raiz no protocolo).
import {
  isAbsolutePath,
  isWindowsPath,
  normalizeOpenFilePath,
  openFileText,
  pathBaseName,
  storedOpenFile
} from '@shared/openFile'
import { findPathMentions, splitPathMentions, type PathMention } from '@shared/pathMentions'
import type { RemoteDirResult } from '@shared/remoteFs'
import type { MessageMeta } from '@shared/types'
import { joinHost } from '@/remote/hostPaths'

// ---------------- linha "Arquivo selecionado" ----------------

export const OPEN_FILE_LABEL = 'Arquivo selecionado:'

export interface OpenFileLine {
  /** Caminho como foi gravado (relativo à raiz do host ou absoluto). */
  path: string
  /** "Arquivo selecionado: <path>" (leitores de tela). */
  label: string
  /** Texto EXATO acrescentado à mensagem enviada ao modelo. */
  modelText: string
}

/**
 * Linha discreta acima de uma mensagem do usuário com `meta.openFile` válido (o mesmo critério da
 * request: `storedOpenFile` — inválido não vai ao modelo, então não aparece). Outras roles → null.
 */
export function openFileLineOf(
  meta: MessageMeta | undefined | null,
  role: string
): OpenFileLine | null {
  if (role !== 'user') return null
  const of = storedOpenFile(meta)
  if (!of) return null
  return {
    path: of.path,
    label: `${OPEN_FILE_LABEL} ${of.path}`,
    modelText: openFileText(of.path)
  }
}

// ---------------- @caminho no texto ----------------

export type TextSegment = { text: string } | { text: string; mention: PathMention }

/**
 * Texto de uma mensagem do usuário com os `@caminho` em trechos próprios (só os que parecem
 * caminho, fora de cercas/crases — `findPathMentions`). Sem menções → null (o texto vai inteiro).
 */
export function mentionSegments(text: string): TextSegment[] | null {
  if (!text || !text.includes('@')) return null
  const found = findPathMentions(text)
  return found.length ? splitPathMentions(text, found) : null
}

// ---------------- conferir e abrir no host ----------------

/** Pasta-mãe de um caminho (POSIX ou Windows); relativo sem pasta → '' (= a raiz do chat no host). */
export function parentDir(path: string): string {
  const win = isWindowsPath(path) || (!isAbsolutePath(path) && path.includes('\\'))
  const i = Math.max(path.lastIndexOf('/'), win ? path.lastIndexOf('\\') : -1)
  if (i < 0) return ''
  if (i === 0) return path.slice(0, 1)
  // `C:\arquivo` → `C:\`
  if (win && /^[A-Za-z]:$/.test(path.slice(0, i))) return path.slice(0, i + 1)
  return path.slice(0, i)
}

export type HostPathCheck =
  | {
      kind: 'file' | 'dir'
      /** Caminho absoluto no formato do host (pasta listada + nome). */
      abs: string
      name: string
      /** Raiz do chat no host (normaliza o caminho mostrado no chip). */
      root: string
    }
  | { kind: 'missing'; message: string }

/** `fs.list` do host (vazio = a raiz do chat lá; relativo resolve contra ela). Nunca lança. */
export type HostLister = (dir: string) => Promise<RemoteDirResult>

/**
 * Confere um caminho citado (o do arquivo selecionado ou de um `@caminho`) pela listagem da
 * pasta-mãe no host — sem abrir nada. O celular não resolve contra raiz nenhuma: o host resolve o
 * relativo contra a raiz dele (§8.6). Host fora do ar → o aviso dele; pasta ausente, fora da raiz
 * confinada ou entrada ausente → o mesmo aviso "Não encontrei…".
 */
export async function checkHostPath(list: HostLister, path: string): Promise<HostPathCheck> {
  const clean = path.replace(/[\\/]+$/, '') || path
  const name = pathBaseName(clean)
  const r = await list(parentDir(clean))
  if (!r.ok && r.reason === 'host-offline') return { kind: 'missing', message: r.message }
  const e = r.ok ? r.entries.find((x) => x.name === name) : undefined
  if (!r.ok || !e) return { kind: 'missing', message: `Não encontrei ${path} na raiz do chat.` }
  return { kind: e.kind, abs: joinHost(r.dir, e.name), name: e.name, root: r.root }
}

/** Rotas das telas de arquivos do host (expo-router). */
export type HostPathRoute =
  | {
      pathname: '/file/[chat]'
      params: { chat: string; path: string; name: string; root: string }
    }
  | { pathname: '/files/[chat]'; params: { chat: string; path: string } }

/**
 * Toque num caminho citado: confere no host e abre — arquivo → visualizador; pasta → aba Arquivos
 * nela. Ausente → `notice` (aviso discreto) e nada é aberto. true = abriu.
 */
export async function openHostPath(
  chatId: string,
  path: string,
  deps: {
    list: HostLister
    open: (route: HostPathRoute) => void
    notice: (text: string) => void
  }
): Promise<boolean> {
  const r = await checkHostPath(deps.list, path)
  if (r.kind === 'missing') {
    deps.notice(r.message)
    return false
  }
  deps.open(
    r.kind === 'dir'
      ? { pathname: '/files/[chat]', params: { chat: chatId, path: r.abs } }
      : {
          pathname: '/file/[chat]',
          params: { chat: chatId, path: r.abs, name: r.name, root: r.root }
        }
  )
  return true
}

// ---------------- composer: chip e popup de @ ----------------

/** Arquivo aberto por último no visualizador do host, neste chat (o chip do composer). */
export interface OpenFileSelection {
  /** Caminho absoluto no host (o que vai em `meta.openFile.path` — o host normaliza). */
  path: string
  /** Raiz do chat no host, quando conhecida (só para mostrar o caminho como vai ficar). */
  root?: string | null
}

export interface OpenFileChip {
  /** Nome do arquivo (`[app.ts ×]`). */
  name: string
  /** Caminho como deve ficar gravado (relativo à raiz do host quando dentro dela). */
  display: string
  /** Texto EXATO que o modelo vai receber com a mensagem. */
  modelText: string
}

/** O chip do composer para a seleção (null = sem arquivo / caminho inválido). */
export function openFileChipOf(sel: OpenFileSelection | null | undefined): OpenFileChip | null {
  if (!sel) return null
  const display = normalizeOpenFilePath(sel.path, sel.root ?? null)
  if (!display) return null
  return { name: pathBaseName(sel.path), display, modelText: openFileText(display) }
}

/** Pasta do token em digitação (até a última `/`, com ela) — o popup lista essa pasta no host. */
export function mentionDirPart(query: string): string {
  const slash = query.lastIndexOf('/')
  return slash >= 0 ? query.slice(0, slash + 1) : ''
}

/**
 * Listagem do host → entradas do popup (relativas à raiz, `/`, pastas com `/` no fim) para o
 * filtro vendorado `filterMentionIndex`. Falha → nenhuma.
 */
export function mentionEntries(dirPart: string, r: RemoteDirResult): string[] {
  if (!r.ok) return []
  return r.entries.map((e) => `${dirPart}${e.name}${e.kind === 'dir' ? '/' : ''}`)
}
