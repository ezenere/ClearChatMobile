// Peças puras da tela: prévia da lista, tokens do Markdown (fórmulas, cercas, tabelas), resumo das
// tools e o modelo da conversa (caminho ativo, troca de versão só na tela, linhas e compactação).
import { describe, expect, it } from 'vitest'
import type { Session, StoredMessage } from '../src/vendor/shared/types'
import { previewText } from '../src/data/decode'
import type { LoadedChat } from '../src/data/store'
import { lexMarkdown, tableColumnChars } from '../src/chat/markdownTokens'
import { toolSummary } from '../src/chat/toolSummary'
import { buildSessionView, localSelectFor, mainSession } from '../src/chat/viewModel'

describe('prévia', () => {
  it('limpa tabela, listas, títulos e código', () => {
    expect(
      previewText('## Para um app\n\n| Tipo | Ideia |\n|---|---|\n| Estado | junta |\n\n> Config')
    ).toBe('Para um app Tipo · Ideia Estado · junta Config')
    expect(previewText('- **Seg** — a\n- **Qui** — b')).toBe('Seg — a Qui — b')
    expect(previewText('veja:\n```ts\nx()\n```\nfim')).toBe('veja: [código] fim')
    expect(previewText('x'.repeat(300)).length).toBe(160)
  })
})

describe('markdown', () => {
  it('fórmulas viram tokens próprios; preço não é fórmula', () => {
    const t = lexMarkdown('Custa $5 e $10. A área é $\\pi r^2$.\n\n$$\nE = mc^2\n$$')
    const p = t[0] as { tokens: { type: string; text?: string }[] }
    expect(p.tokens.filter((x) => x.type === 'inlineMath').map((x) => x.text)).toEqual(['\\pi r^2'])
    expect(t.some((x) => x.type === 'blockMath')).toBe(true)
  })
  it('cercas aninhadas ficam num bloco só; tabela com larguras por coluna', () => {
    const t = lexMarkdown(
      '````md\n# t\n```py\nx\n```\n````\n\n| a | bbbb |\n|---|---|\n| ccccccc | d |'
    )
    expect(t.filter((x) => x.type === 'code')).toHaveLength(1)
    expect(
      tableColumnChars([{ text: 'a' }, { text: 'bbbb' }], [[{ text: 'ccccccc' }, { text: 'd' }]])
    ).toEqual([7, 4])
  })
  it('cache devolve os mesmos tokens', () => {
    expect(lexMarkdown('**oi**')).toBe(lexMarkdown('**oi**'))
  })
})

describe('tools', () => {
  it('resumo dos argumentos como no desktop', () => {
    expect(toolSummary('shell', { command: 'ls -la' })).toBe('ls -la')
    expect(toolSummary('read_file', { path: 'a.ts', offset: 10, limit: 5 })).toBe(
      'a.ts  · linhas 10–14'
    )
    expect(toolSummary('ask_user', { questions: [{ title: 'A?' }, { title: 'B?' }] })).toBe(
      '2 perguntas · A?'
    )
  })
})

const msg = (
  id: string,
  seq: number,
  role: 'user' | 'assistant' | 'tool',
  extra: Partial<StoredMessage> = {}
): StoredMessage => ({
  id,
  sessionId: 's',
  seq,
  message:
    role === 'tool'
      ? { role: 'tool', tool_call_id: 'c1', content: 'ok' }
      : role === 'assistant'
        ? { role: 'assistant', content: id }
        : { role: 'user', content: id },
  meta: {},
  createdAt: 1_700_000_000_000 + seq * 60_000,
  ...extra
})

function chat(
  messages: StoredMessage[],
  branchSel: Record<string, string | null> = {}
): LoadedChat {
  const session: Session = {
    id: 's',
    chatId: 'c',
    parentSessionId: null,
    parentToolCallId: null,
    depth: 0,
    model: 'm',
    providerId: null,
    title: '',
    task: null,
    status: 'idle',
    createdAt: 0,
    branchSel
  }
  return {
    chat: {
      id: 'c',
      sv: 1,
      title: 'T',
      config: {},
      mainSessionId: 's',
      createdAt: 0,
      updatedAt: 0
    },
    sessions: [session],
    messages: new Map([['s', messages]]),
    broken: 0
  }
}

describe('modelo da conversa', () => {
  it('caminho pelo branchSel, troca só na tela e queda da seleção local quando a sincronizada muda', () => {
    const ms = [
      msg('u1', 1, 'user', { parentId: null }),
      msg('a1', 2, 'assistant', { parentId: 'u1' }),
      msg('a2', 3, 'assistant', { parentId: 'u1' })
    ]
    const loaded = chat(ms, { u1: 'a1' })
    const s = mainSession(loaded)!
    const v = buildSessionView(loaded, s, null, true)
    expect(v.path.map((m) => m.id)).toEqual(['u1', 'a1'])
    expect(v.siblings.get('a1')).toMatchObject({ index: 0, count: 2, nextId: 'a2' })
    const local = localSelectFor(v, loaded, 'a2')
    const v2 = buildSessionView(loaded, s, local, true)
    expect(v2.path.map((m) => m.id)).toEqual(['u1', 'a2'])
    expect(v2.localOverride).toBe(true)
    // outro dispositivo mudou o branchSel: a seleção local cai
    const synced = chat(ms, {})
    const v3 = buildSessionView(synced, mainSession(synced)!, local, true)
    expect(v3.localOverride).toBe(false)
    expect(v3.path.map((m) => m.id)).toEqual(['u1', 'a2'])
  })

  it('resultado de tool fica no card; compactação esmaece o antigo e põe o divisor', () => {
    const ms = [
      msg('u1', 1, 'user'),
      msg('a1', 2, 'assistant', {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'shell', arguments: '{}' } }]
        }
      }),
      msg('t1', 3, 'tool'),
      msg('k', 4, 'user', { meta: { kind: 'compaction', synthetic: true } }),
      msg('u2', 5, 'user')
    ]
    const v = buildSessionView(chat(ms), mainSession(chat(ms))!, null, true)
    expect(v.results.get('c1')?.id).toBe('t1')
    expect(v.rows.map((r) => r.key)).toEqual(['u1', 'a1', 'compaction-divider', 'k', 'u2'])
    expect(v.rows.filter((r) => r.kind === 'message' && r.old).map((r) => r.key)).toEqual([
      'u1',
      'a1'
    ])
    const hidden = buildSessionView(chat(ms), mainSession(chat(ms))!, null, false)
    expect(hidden.rows.map((r) => r.key)).toEqual(['compaction-divider', 'k', 'u2'])
  })
})
