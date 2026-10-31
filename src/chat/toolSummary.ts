// Resumo de uma linha dos argumentos de cada tool (cabeçalho do card) e ícone — mesmo texto do
// ToolCard do desktop (ClearChatDesktop/src/renderer/src/components/chat/ToolCard.tsx).
import { isMemoryTool, memoryToolSummary } from '@vendor/renderer/memory'
import { isSkillTool, skillToolSummary } from '@vendor/renderer/skills'
import type { IconName } from '@/ui/Button'

const shortId = (id: string): string => (id.length > 12 ? `${id.slice(0, 8)}…` : id)

export function parseArgs(raw: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

export function toolSummary(name: string, args: Record<string, unknown> | null): string {
  if (!args) return ''
  if (isMemoryTool(name)) return memoryToolSummary(name, args)
  if (isSkillTool(name)) return skillToolSummary(name, args)
  const pick = (k: string): string => (typeof args[k] === 'string' ? (args[k] as string) : '')
  const join = (xs: unknown[]) => xs.filter(Boolean).join(' · ')
  switch (name) {
    case 'shell':
    case 'bash':
      return pick('command')
    case 'process_start':
      return [pick('name') && `[${pick('name')}]`, pick('command')].filter(Boolean).join(' ')
    case 'process_logs':
      return join([
        pick('id'),
        pick('pattern') && `/${pick('pattern')}/${args.case_insensitive === true ? 'i' : ''}`,
        args.since_line != null && `desde a linha ${String(args.since_line)}`,
        args.offset != null && `a partir da linha ${String(args.offset)}`,
        args.tail != null && `últimas ${String(args.tail)}`
      ])
    case 'process_list':
      return ''
    case 'process_stop':
      return join([pick('id'), pick('signal')])
    case 'web_search':
      return pick('query')
    case 'browse_url':
      return join([
        pick('url'),
        pick('mode') === 'full' && 'página inteira',
        args.links === true && 'links'
      ])
    case 'delegate_task':
      return pick('title') || pick('task')
    case 'search_files': {
      const where = [pick('glob'), pick('path')].filter(Boolean).join(' · ')
      return `/${pick('pattern')}/${where ? `  ${where}` : ''}`
    }
    case 'list_models':
      return join([
        pick('provider') && `@${pick('provider')}`,
        pick('query') && `"${pick('query')}"`,
        args.tools_only === true && 'tools',
        args.free_only === true && 'grátis',
        pick('sort') && `por ${pick('sort')}`,
        args.limit != null && `limite ${String(args.limit)}`
      ])
    case 'find_files':
      return pick('glob') + (pick('path') ? `  ${pick('path')}` : '')
    case 'list_chats':
      return join([
        pick('query') && `"${pick('query')}"`,
        args.limit != null && `limite ${String(args.limit)}`
      ])
    case 'send_to_chat':
      return join([
        `→ ${shortId(pick('chat_id'))}`,
        args.wait_for_reply === true && 'aguarda resposta',
        pick('message')
      ])
    case 'read_history': {
      const range =
        args.from_seq != null || args.to_seq != null
          ? `#${args.from_seq != null ? String(args.from_seq) : '…'}–#${args.to_seq != null ? String(args.to_seq) : '…'}`
          : ''
      return join([
        pick('scope') === 'all' && 'todos os outros chats',
        pick('chat_id') && `chat ${shortId(pick('chat_id'))}`,
        pick('query') && `"${pick('query')}"`,
        range,
        args.include_tool_results === true && 'com resultados de tools'
      ])
    }
    case 'wait_subagents': {
      const ids = Array.isArray(args.ids) ? args.ids.length : 0
      return join([
        ids ? `${ids} subagente${ids > 1 ? 's' : ''}` : 'todos os pendentes',
        pick('mode') === 'any' ? 'o primeiro' : '',
        args.timeout_s != null && `até ${String(args.timeout_s)}s`
      ])
    }
    case 'cancel_subagent':
      return shortId(pick('id'))
    case 'ask_user': {
      const qs = Array.isArray(args.questions) ? args.questions : []
      const first = qs[0] as { title?: unknown } | undefined
      const t = typeof first?.title === 'string' ? first.title : ''
      return qs.length > 1 ? `${qs.length} perguntas · ${t}` : t
    }
    case 'message_subagent':
      return join([
        `→ ${shortId(pick('id'))}`,
        args.wait_for_reply === true && 'aguarda resposta',
        pick('message')
      ])
    case 'read_file': {
      const o = Number(args.offset ?? 1) || 1
      const l = args.limit != null ? Number(args.limit) : null
      const range =
        args.offset == null && l == null
          ? ''
          : l
            ? `  · linhas ${o}–${o + l - 1}`
            : `  · a partir da linha ${o}`
      return pick('path') + range
    }
    case 'present_file':
      return Array.isArray(args.files)
        ? (args.files as unknown[])
            .map((f) => (typeof f === 'string' ? f : ((f as { path?: string })?.path ?? '')))
            .join(', ')
        : pick('path')
    default:
      return pick('path') || (name === 'list_dir' ? '.' : '')
  }
}

const ICONS: Record<string, IconName> = {
  list_dir: 'folder-open-outline',
  read_file: 'document-text-outline',
  search_files: 'search-outline',
  find_files: 'folder-outline',
  present_file: 'easel-outline',
  write_file: 'document-attach-outline',
  edit_file: 'create-outline',
  shell: 'terminal-outline',
  bash: 'terminal-outline',
  process_start: 'play-outline',
  process_logs: 'reader-outline',
  process_list: 'pulse-outline',
  process_stop: 'stop-circle-outline',
  web_search: 'search',
  browse_url: 'globe-outline',
  list_models: 'hardware-chip-outline',
  delegate_task: 'git-network-outline',
  get_chat_info: 'information-circle-outline',
  list_chats: 'chatbubbles-outline',
  send_to_chat: 'send-outline',
  read_history: 'time-outline',
  check_subagents: 'list-outline',
  wait_subagents: 'hourglass-outline',
  cancel_subagent: 'stop-circle-outline',
  message_subagent: 'chatbox-ellipses-outline',
  ask_user: 'help-circle-outline',
  memory_search: 'bookmark-outline',
  memory_read: 'bookmark-outline',
  memory_write: 'bookmarks-outline',
  memory_rewrite: 'bookmarks-outline',
  memory_delete: 'trash-outline',
  list_skills: 'bulb-outline',
  skill_load: 'bulb-outline',
  skill_read: 'bulb-outline'
}

export const toolIcon = (name: string): IconName => ICONS[name] ?? 'construct-outline'
