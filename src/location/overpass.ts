// Overpass API (OpenStreetMap) para nearby_places (puro: o `fetch` é injetado). Uso justo da
// instância pública: raio limitado, teto de resultados, timeout no servidor e no cliente, User-Agent
// identificado, um pedido por vez com intervalo mínimo e cache das consultas idênticas por alguns
// minutos; instância de reserva só quando a principal falha (sobrecarga/timeout/rede).
import { distanceMeters, type LatLon } from './geo'
import { CATEGORY_KEYS, cuisineLabels, tagLabel, type OsmFilter } from './tags'

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
]

export const MAX_RADIUS_M = 5_000
export const DEFAULT_RADIUS_M = 1_000
export const MIN_RADIUS_M = 50
export const MAX_LIMIT = 25
export const DEFAULT_LIMIT = 10
/** Teto do servidor (`[timeout:]`), em segundos. */
export const SERVER_TIMEOUT_S = 20
/** Elementos pedidos ao Overpass (ordenados por distância aqui; o servidor não ordena). */
export const FETCH_CAP = 120

export interface OverpassQuery {
  center: LatLon
  radiusM: number
  filters: OsmFilter[]
  nameRegex?: string
  /** Teto de elementos (`out … N`). */
  max?: number
  timeoutS?: number
}

/** Valor entre aspas do Overpass QL. */
const q = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

const valuesRe = (values: string[]): string =>
  `^(${values.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`

function selector(fl: OsmFilter, nameRegex: string | undefined, around: string): string {
  let s = 'nwr'
  if (!fl.values) s += `[${q(fl.key)}]`
  else if (fl.values.length === 1) s += `[${q(fl.key)}=${q(fl.values[0])}]`
  else s += `[${q(fl.key)}~${q(valuesRe(fl.values))}]`
  for (const e of fl.extra ?? []) s += `[${q(e.key)}~${q(e.regex)},i]`
  if (nameRegex) s += `["name"~${q(nameRegex)},i]`
  return `${s}${around};`
}

export function clampRadius(r: number | undefined): number {
  const v = r == null || !Number.isFinite(r) ? DEFAULT_RADIUS_M : Math.round(r)
  return Math.min(MAX_RADIUS_M, Math.max(MIN_RADIUS_M, v))
}

export function clampLimit(n: number | undefined): number {
  const v = n == null || !Number.isFinite(n) ? DEFAULT_LIMIT : Math.floor(n)
  return Math.min(MAX_LIMIT, Math.max(1, v))
}

/** Consulta Overpass QL: união dos filtros em volta do centro, com centro das vias/relações. */
export function buildOverpassQuery(o: OverpassQuery): string {
  const r = clampRadius(o.radiusM)
  const around = `(around:${r},${o.center.lat},${o.center.lon})`
  const seen = new Set<string>()
  const parts: string[] = []
  for (const fl of o.filters) {
    const s = selector(fl, o.nameRegex, around)
    if (seen.has(s)) continue
    seen.add(s)
    parts.push(s)
  }
  const max = Math.min(FETCH_CAP, Math.max(1, Math.floor(o.max ?? FETCH_CAP)))
  const timeout = Math.min(
    SERVER_TIMEOUT_S,
    Math.max(5, Math.floor(o.timeoutS ?? SERVER_TIMEOUT_S))
  )
  return `[out:json][timeout:${timeout}][maxsize:16777216];(${parts.join('')});out center tags ${max};`
}

// ---------------- resultado ----------------

export interface Place {
  /** `node/123`, `way/456`. */
  id: string
  name: string | null
  /** Rótulo pt-BR da categoria ("restaurante"). */
  category: string
  /** Tag principal (`amenity=restaurant`). */
  tag: string
  cuisine: string[]
  lat: number
  lon: number
  distanceM: number
  address: string | null
  openingHours: string | null
  phone: string | null
  website: string | null
}

type Tags = Record<string, string>

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

/** Tags em que um lugar sem nome ainda é útil (caixa eletrônico, banheiro, estacionamento…). */
const NAME_OPTIONAL = new Set([
  'amenity=atm',
  'amenity=toilets',
  'amenity=parking',
  'amenity=bicycle_parking',
  'amenity=bicycle_rental',
  'amenity=charging_station',
  'amenity=fuel',
  'amenity=taxi',
  'amenity=car_wash',
  'highway=bus_stop',
  'leisure=playground',
  'tourism=viewpoint',
  'natural=beach'
])

function addressOf(t: Tags): string | null {
  const street = str(t['addr:street'])
  const num = str(t['addr:housenumber'])
  const first = street ? (num ? `${street}, ${num}` : street) : null
  const area = str(t['addr:suburb']) ?? str(t['addr:neighbourhood']) ?? str(t['addr:district'])
  const city = str(t['addr:city'])
  const parts = [first, area, city].filter((x): x is string => !!x)
  if (!parts.length) return str(t['addr:full'])
  return [...new Set(parts)].join(' — ')
}

function websiteOf(t: Tags): string | null {
  const w = str(t.website) ?? str(t['contact:website']) ?? str(t.url)
  if (!w) return null
  // outro esquema (javascript:, intent:…) nunca vira link; sem esquema = https
  if (!/^https?:\/\//i.test(w) && /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(w)) return null
  const u = /^https?:\/\//i.test(w) ? w : `https://${w}`
  return /^https?:\/\/[^\s]+$/i.test(u) ? u : null
}

const phoneOf = (t: Tags): string | null =>
  str(t.phone) ?? str(t['contact:phone']) ?? str(t['contact:mobile'])

function mainTag(t: Tags): { key: string; value: string } | null {
  for (const k of CATEGORY_KEYS) {
    const v = str(t[k])
    if (v) return { key: k, value: v.split(';')[0].trim() }
  }
  return null
}

/**
 * JSON do Overpass → lugares ordenados por distância (calculada aqui a partir do centro), sem
 * duplicatas (o mesmo lugar como ponto e como prédio); sem nome só onde o nome é dispensável.
 */
export function parseOverpass(json: unknown, center: LatLon): Place[] {
  const els = (json as { elements?: unknown } | null)?.elements
  if (!Array.isArray(els)) return []
  const out: Place[] = []
  for (const raw of els) {
    if (!raw || typeof raw !== 'object') continue
    const e = raw as {
      type?: unknown
      id?: unknown
      lat?: unknown
      lon?: unknown
      center?: { lat?: unknown; lon?: unknown }
      tags?: unknown
    }
    const tags = (e.tags && typeof e.tags === 'object' ? e.tags : null) as Tags | null
    if (!tags) continue
    const lat = typeof e.lat === 'number' ? e.lat : e.center?.lat
    const lon = typeof e.lon === 'number' ? e.lon : e.center?.lon
    if (typeof lat !== 'number' || typeof lon !== 'number') continue
    const main = mainTag(tags)
    if (!main) continue
    const tag = `${main.key}=${main.value}`
    const name = str(tags.name) ?? str(tags.brand) ?? null
    if (!name && !NAME_OPTIONAL.has(tag)) continue
    out.push({
      id: `${String(e.type ?? 'node')}/${String(e.id ?? '')}`,
      name,
      category: tagLabel(main.key, main.value),
      tag,
      cuisine: cuisineLabels(str(tags.cuisine) ?? undefined),
      lat,
      lon,
      distanceM: distanceMeters(center, { lat, lon }),
      address: addressOf(tags),
      openingHours: str(tags.opening_hours),
      phone: phoneOf(tags),
      website: websiteOf(tags)
    })
  }
  out.sort((a, b) => a.distanceM - b.distanceM)
  // mesmo nome e categoria a menos de 40 m: é o mesmo lugar (ponto + contorno do prédio)
  const kept: Place[] = []
  for (const p of out) {
    const dup = kept.find(
      (k) =>
        !!p.name &&
        k.name?.toLowerCase() === p.name.toLowerCase() &&
        k.tag === p.tag &&
        distanceMeters(k, p) < 40
    )
    if (dup) {
      dup.address ??= p.address
      dup.openingHours ??= p.openingHours
      dup.phone ??= p.phone
      dup.website ??= p.website
      if (!dup.cuisine.length) dup.cuisine = p.cuisine
      continue
    }
    kept.push(p)
  }
  return kept
}

// ---------------- cliente ----------------

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>

export class OsmHttpError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean
  ) {
    super(message)
  }
}

/** Fila única com intervalo mínimo entre pedidos (um serviço por instância). */
export class Gate {
  private last = Number.NEGATIVE_INFINITY
  private chain: Promise<unknown> = Promise.resolve()
  constructor(
    private readonly intervalMs: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms))
  ) {}

  run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(async () => {
      const wait = this.last + this.intervalMs - this.now()
      if (wait > 0) await this.sleep(wait)
      try {
        return await fn()
      } finally {
        this.last = this.now()
      }
    })
    this.chain = p.catch(() => undefined)
    return p
  }
}

export interface OverpassDeps {
  fetch: FetchFn
  userAgent: string
  endpoints?: string[]
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** Cache das consultas idênticas (padrão 5 min). */
  cacheMs?: number
  /** Intervalo mínimo entre pedidos (padrão 1 s). */
  minIntervalMs?: number
  /**
   * Teto por instância (padrão 45 s: a fila da instância pública soma vários segundos ao
   * `[timeout:20]` do servidor) e de todas as tentativas juntas (padrão 70 s).
   */
  timeoutMs?: number
  totalMs?: number
}

const abortError = (): Error => {
  const e = new Error('Aborted')
  e.name = 'AbortError'
  return e
}

export class OverpassClient {
  private cache = new Map<string, { at: number; json: unknown }>()
  private gate: Gate
  private readonly now: () => number
  constructor(private readonly d: OverpassDeps) {
    this.now = d.now ?? Date.now
    this.gate = new Gate(d.minIntervalMs ?? 1000, this.now, d.sleep)
  }

  /** Resultado do cache (consulta idêntica há pouco)? */
  cached(ql: string): unknown {
    const ttl = this.d.cacheMs ?? 5 * 60_000
    const now = this.now()
    for (const [k, v] of this.cache) if (now - v.at > ttl) this.cache.delete(k)
    return this.cache.get(ql)?.json ?? null
  }

  async run(ql: string, signal: AbortSignal): Promise<{ json: unknown; fromCache: boolean }> {
    const hit = this.cached(ql)
    if (hit) return { json: hit, fromCache: true }
    const json = await this.gate.run(() => this.fetchAny(ql, signal))
    this.cache.set(ql, { at: this.now(), json })
    while (this.cache.size > 30) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
    return { json, fromCache: false }
  }

  private async fetchAny(ql: string, signal: AbortSignal): Promise<unknown> {
    const endpoints = this.d.endpoints ?? OVERPASS_ENDPOINTS
    const errors: string[] = []
    const t0 = this.now()
    const total = this.d.totalMs ?? 70_000
    for (const url of endpoints) {
      if (signal.aborted) throw abortError()
      const left = total - (this.now() - t0)
      if (left < 5_000) break
      try {
        return await this.fetchOne(url, ql, signal, Math.min(this.d.timeoutMs ?? 45_000, left))
      } catch (e) {
        if (signal.aborted) throw abortError()
        if (e instanceof OsmHttpError && !e.retryable) throw e
        errors.push(`${new URL(url).host}: ${(e as Error).message}`)
      }
    }
    throw new OsmHttpError(
      `o OpenStreetMap (Overpass) não respondeu agora (${errors.join('; ') || 'sem tempo'}). Tente de novo em alguns minutos.`,
      true
    )
  }

  private async fetchOne(
    url: string,
    ql: string,
    signal: AbortSignal,
    ms: number
  ): Promise<unknown> {
    const timeout = AbortSignal.timeout(ms)
    let res: Response
    try {
      res = await this.d.fetch(url, {
        method: 'POST',
        headers: {
          'User-Agent': this.d.userAgent,
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          Accept: 'application/json'
        },
        body: `data=${encodeURIComponent(ql)}`,
        signal: AbortSignal.any([signal, timeout])
      })
    } catch (e) {
      if (signal.aborted) throw abortError()
      if (timeout.aborted) throw new OsmHttpError(`timeout de ${ms / 1000} s`, true)
      throw new OsmHttpError((e as Error).message || 'falha de rede', true)
    }
    if (res.status === 429 || res.status >= 500) {
      void res.body?.cancel().catch(() => undefined)
      throw new OsmHttpError(`HTTP ${res.status}`, true)
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      const why = /<strong[^>]*>Error<\/strong>:\s*([^<]{0,200})/i.exec(text)?.[1]?.trim()
      throw new OsmHttpError(
        `consulta recusada pelo Overpass (HTTP ${res.status}${why ? `: ${why}` : ''})`,
        false
      )
    }
    let json: unknown
    try {
      json = await res.json()
    } catch {
      throw new OsmHttpError('resposta inválida', true)
    }
    const remark = (json as { remark?: unknown }).remark
    const els = (json as { elements?: unknown }).elements
    if (
      typeof remark === 'string' &&
      /timed out|out of memory|runtime error/i.test(remark) &&
      (!Array.isArray(els) || !els.length)
    )
      throw new OsmHttpError(remark.slice(0, 120), true)
    return json
  }
}
