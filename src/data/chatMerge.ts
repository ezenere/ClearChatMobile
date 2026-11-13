// Merge LWW do registro `chat` com edição local pendente (SYNC_PROTOCOL.md §7.5) — num
// `rev_mismatch` do push e no pull de uma revisão mais nova. É o `merge3` do desktop
// (ClearChatDesktop/src/main/sync/records.ts): sobre o plaintext do servidor, só os campos que
// mudaram AQUI desde a base (a revisão que o servidor tinha quando a edição começou, guardada na
// outbox); a `config` chave a chave por `mergeChatConfig3` (@shared/chatInherit, vendorado) —
// desde 1.10.0 `config.overrides` mesclado por unidade e a cópia informativa de uma unidade que o
// celular herda não sobrescreve um valor próprio do servidor, enquanto um "voltar a herdar" daqui
// vence. `updatedAt` = o maior. Linhas antigas da outbox (sem base) caem no merge pelos campos do
// `patch`. Puro.
import { mergeChatConfig3 } from '@shared/chatInherit'
import type { Plain } from './types'

const isObj = (v: unknown): v is Plain => !!v && typeof v === 'object' && !Array.isArray(v)

/** JSON com as chaves ordenadas (sem `undefined`). */
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`
  if (isObj(v))
    return `{${Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon(v[k])}`)
      .join(',')}}`
  return JSON.stringify(v ?? null)
}

/** Merge 3-way (= `merge3` do desktop): servidor + o que mudou localmente desde `base`. */
export function mergeChat3(server: Plain, base: Plain | null, local: Plain): Plain {
  const out = JSON.parse(JSON.stringify(server)) as Plain
  const b = base ?? {}
  for (const k of new Set([...Object.keys(local), ...Object.keys(b)])) {
    if (k === 'sv' || k === 'updatedAt') continue
    if (k === 'config') {
      out.config = mergeChatConfig3(
        isObj(out.config) ? out.config : {},
        isObj(b.config) ? b.config : {},
        isObj(local.config) ? local.config : {}
      )
      continue
    }
    if (!(k in local)) continue
    if (canon(local[k]) !== canon(b[k])) out[k] = local[k]
  }
  if (server.updatedAt !== undefined || local.updatedAt !== undefined)
    out.updatedAt = Math.max(Number(server.updatedAt ?? 0), Number(local.updatedAt ?? 0))
  return out
}

/** Merge antigo pelos campos mudados (`patch`; a `config` mescla por chave) — linhas sem base. */
export function mergeChatPatch(server: Plain, patch: Plain | null): Plain {
  if (!patch) return server
  const out: Plain = { ...server, ...patch }
  const sc = server.config
  const pc = patch.config
  if (isObj(pc)) out.config = { ...(isObj(sc) ? sc : {}), ...pc }
  return out
}

/**
 * Registro `chat` do servidor + a revisão local pendente: com base (desde a versão 7 do cache) o
 * merge 3-way; sem ela, o merge antigo pelos campos de `patch`.
 */
export function mergeChatRecord(
  server: Plain,
  row: { base: Plain | null; plain: Plain | null; patch: Plain | null }
): Plain {
  if (row.base && row.plain) return mergeChat3(server, row.base, row.plain)
  return mergeChatPatch(server, row.patch)
}
