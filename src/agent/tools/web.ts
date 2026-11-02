// web_search e browse_url no celular (porta de ClearChatDesktop/src/main/tools/web.ts sem
// Electron): a orquestração e os parsers são os vendorados (webSearch.ts, ddg/brave/searchApis,
// pageExtract.ts); aqui ficam só os "backends" HTTP. O Brave pelo site precisa de um navegador
// oculto (BrowserWindow no desktop) — no celular fica fora do plano. browse_url baixa o HTML com
// `fetch` (sem executar JavaScript da página) e extrai o conteúdo como no desktop.
import { LIMITS } from '@shared/limits'
import {
  API_ENGINE_IDS,
  ENGINE_DEFAULT_BASE,
  isApiEngine,
  normalizeEngines,
  normalizeKeys,
  normalizeSearchInterval,
  SEARCH_ENGINES_SETTING,
  SEARCH_INTERVAL_SETTING,
  SEARCH_KEYS_SETTING,
  type ApiEngineId,
  type EngineHttpRequest,
  type SearchEngineId
} from '@shared/webSearchSettings'
import { extractPage, formatExtracted, type ExtractMode } from '@vendor/desktop/tools/pageExtract'
import {
  fmtSecs,
  runGatedWebSearch,
  SearchGate,
  type HttpResponse,
  type PlanEntry,
  type SearchBackends
} from '@vendor/desktop/tools/webSearch'
import {
  abortError,
  fail,
  ok,
  optBool,
  optNumber,
  optString,
  requireString,
  type ToolContext,
  type ToolResult
} from './util'

const UA =
  'Mozilla/5.0 (Linux; Android 15; Pixel 9 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36'

/** Settings sincronizados que o web_search lê (registros `setting`, §4.3.2). */
export type SettingReader = (id: string) => unknown

let bases: Partial<Record<SearchEngineId, string>> = {}
/** Base de cada buscador (testes/E2E apontam para um falso local). */
export function setSearchBases(b: Partial<Record<SearchEngineId, string>>): void {
  bases = { ...b }
}
const baseOf = (id: SearchEngineId): string => bases[id]?.trim() || ENGINE_DEFAULT_BASE[id]

/** Buscadores habilitados, na ordem, com as chaves — sem o Brave pelo site (sem navegador aqui). */
export function searchPlan(setting: SettingReader): PlanEntry[] {
  const keys = normalizeKeys(setting(SEARCH_KEYS_SETTING))
  return normalizeEngines(setting(SEARCH_ENGINES_SETTING), (id) => !!keys[id])
    .filter((e) => e.enabled && e.id !== 'brave-site')
    .map((e) => ({ id: e.id, options: e.options, key: isApiEngine(e.id) ? keys[e.id] : undefined }))
}

async function ddgFetch(
  query: string,
  method: 'POST' | 'GET',
  signal: AbortSignal
): Promise<string> {
  const base = baseOf('ddg')
  const sig = AbortSignal.any([signal, AbortSignal.timeout(20_000)])
  const res =
    method === 'POST'
      ? await fetch(base, {
          method: 'POST',
          headers: {
            'User-Agent': UA,
            'Content-Type': 'application/x-www-form-urlencoded',
            Referer: 'https://html.duckduckgo.com/',
            'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8'
          },
          body: new URLSearchParams({ q: query, b: '' }).toString(),
          signal: sig
        })
      : await fetch(`${base}?q=${encodeURIComponent(query)}`, {
          headers: { 'User-Agent': UA, 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' },
          signal: sig
        })
  const text = await res.text()
  if (!res.ok && res.status !== 202) throw new Error(`HTTP ${res.status}`)
  return text
}

const API_TIMEOUT = 20_000

async function apiFetch(req: EngineHttpRequest, signal: AbortSignal): Promise<HttpResponse> {
  const timeout = AbortSignal.timeout(API_TIMEOUT)
  try {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: AbortSignal.any([signal, timeout])
    })
    return { status: res.status, text: await res.text() }
  } catch (e) {
    if (signal.aborted) throw abortError()
    if (timeout.aborted) throw new Error(`timeout de ${API_TIMEOUT / 1000} s`, { cause: e })
    throw new Error((e as Error).message, { cause: e })
  }
}

function backends(): SearchBackends {
  const b: Partial<Record<ApiEngineId, string>> = {}
  for (const id of API_ENGINE_IDS) b[id] = baseOf(id)
  return {
    ddg: ddgFetch,
    brave: () => Promise.reject(new Error('o Brave pelo site não está disponível no celular')),
    http: apiFetch,
    bases: b
  }
}

let gate: SearchGate | null = null
let readSetting: SettingReader = () => undefined

export async function webSearch(
  args: Record<string, unknown>,
  ctx: ToolContext,
  setting: SettingReader
): Promise<ToolResult> {
  readSetting = setting
  // intervalo mínimo GLOBAL entre pesquisas (todas as sessões deste aparelho)
  gate ??= new SearchGate({
    intervalMs: () => normalizeSearchInterval(readSetting(SEARCH_INTERVAL_SETTING)) * 1000
  })
  const query = requireString(args, 'query').trim()
  let waited = false
  const r = await runGatedWebSearch(
    query,
    backends(),
    ctx.signal,
    gate,
    (ms) => {
      waited = true
      ctx.onOutput?.(`Aguardando intervalo entre pesquisas… (${fmtSecs(ms)} s)`)
    },
    searchPlan(setting)
  )
  if (waited) ctx.onOutput?.('Pesquisando…')
  return r
}

// ---------------- browse_url ----------------

const BROWSE_TIMEOUT = 25_000

interface LoadedPage {
  html: string
  url: string
  title: string
}

const pageCache = new Map<string, { at: number; page: LoadedPage; timedOut: boolean }>()

function cacheGet(key: string): { page: LoadedPage; timedOut: boolean } | null {
  const now = Date.now()
  for (const [k, v] of pageCache) if (now - v.at > LIMITS.browseCacheMs) pageCache.delete(k)
  return pageCache.get(key) ?? null
}

function cacheSet(key: string, page: LoadedPage, timedOut: boolean): void {
  pageCache.delete(key)
  pageCache.set(key, { at: Date.now(), page, timedOut })
  while (pageCache.size > LIMITS.browseCacheEntries) {
    const oldest = pageCache.keys().next().value
    if (oldest === undefined) break
    pageCache.delete(oldest)
  }
}

function renderPage(
  page: LoadedPage,
  opts: { mode: ExtractMode; links: boolean; offset: number },
  timedOut: boolean,
  fromCache: boolean
): string {
  const p = extractPage(page.html, page.url, {
    mode: opts.mode,
    links: opts.links,
    maxLinks: LIMITS.browseMaxLinks
  })
  if (!p.title) p.title = page.title
  return formatExtracted(p, {
    timedOut,
    timeoutS: BROWSE_TIMEOUT / 1000,
    fromCache,
    offset: opts.offset
  })
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'))

/** Corpo como texto, com teto de caracteres (lê em pedaços quando há stream). */
async function readCapped(res: Response, max: number, signal: AbortSignal): Promise<string> {
  const body = res.body
  if (!body || typeof body.getReader !== 'function') return (await res.text()).slice(0, max)
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let out = ''
  try {
    for (;;) {
      if (signal.aborted) throw abortError()
      const { value, done } = await reader.read()
      if (done) break
      out += decoder.decode(value, { stream: true })
      if (out.length >= max) {
        void reader.cancel().catch(() => undefined)
        return out.slice(0, max)
      }
    }
    return out + decoder.decode()
  } finally {
    reader.releaseLock?.()
  }
}

export async function browseUrl(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const raw = requireString(args, 'url').trim()
  const modeArg = optString(args, 'mode')
  if (modeArg && modeArg !== 'main' && modeArg !== 'full')
    return fail(
      'Erro: mode deve ser "main" (padrão: só o conteúdo principal) ou "full" (página inteira).'
    )
  const opts = {
    mode: (modeArg ?? 'main') as ExtractMode,
    links: optBool(args, 'links'),
    offset: Math.max(0, Math.floor(optNumber(args, 'offset') ?? 0))
  }
  let url: URL
  try {
    url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`)
  } catch {
    return fail(`Erro: URL inválida: ${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return fail('Erro: apenas URLs http/https são permitidas.')
  if (ctx.signal.aborted) throw abortError()
  const cacheKey = `${ctx.cacheKey ?? ''}|${url.toString()}`
  const reuse = opts.offset > 0 || modeArg !== undefined || args.links !== undefined
  const hit = reuse ? cacheGet(cacheKey) : null
  if (hit) return ok(renderPage(hit.page, opts, hit.timedOut, true))
  const timeout = AbortSignal.timeout(BROWSE_TIMEOUT)
  const signal = AbortSignal.any([ctx.signal, timeout])
  try {
    const res = await fetch(url.toString(), {
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8'
      },
      signal
    })
    const finalUrl = res.url || url.toString()
    if (!res.ok) {
      void res.body?.cancel().catch(() => undefined)
      return fail(`Erro ao abrir ${url.toString()}: HTTP ${res.status}`)
    }
    const ctype = (res.headers.get('content-type') ?? '').toLowerCase()
    const isHtml = !ctype || /html|xml/.test(ctype)
    const isText = /^text\/|json/.test(ctype)
    if (!isHtml && !isText) {
      void res.body?.cancel().catch(() => undefined)
      return fail(
        `Erro: ${url.toString()} não é uma página (${ctype.split(';')[0] || 'tipo desconhecido'}) — browse_url só lê HTML/texto.`
      )
    }
    const text = await readCapped(res, LIMITS.browseMaxHtmlChars, signal)
    const html = isHtml ? text : `<html><body><pre>${escapeHtml(text)}</pre></body></html>`
    const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? ''
    const page: LoadedPage = { html, url: finalUrl, title }
    cacheSet(cacheKey, page, false)
    return ok(renderPage(page, opts, false, false))
  } catch (e) {
    if (ctx.signal.aborted) throw abortError()
    if (timeout.aborted)
      return fail(`Erro ao abrir ${url.toString()}: timeout de ${BROWSE_TIMEOUT / 1000}s`)
    return fail(`Erro ao abrir ${url.toString()}: ${(e as Error).message}`)
  }
}
