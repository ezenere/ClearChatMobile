// Geocodificação pelo OpenStreetMap (puro: `fetch` injetado): Nominatim reverso (reserva do
// geocodificador do sistema quando ele não devolve nada) e busca de um lugar pelo nome para o centro
// do nearby_places (Nominatim e, na falha, Photon). Política de uso do Nominatim: no máximo 1 pedido
// por segundo (fila única), User-Agent identificado, sem uso em lote e com cache dos resultados.
import type { LatLon } from './geo'
import { Gate, OsmHttpError, type FetchFn } from './overpass'

export const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org'
export const PHOTON_BASE = 'https://photon.komoot.io'

/** Lugar "humano" (bairro, cidade, estado, país). */
export interface PlaceName {
  neighbourhood: string | null
  city: string | null
  state: string | null
  country: string | null
  /** Rua — só no modo exato. */
  street?: string | null
}

export const placeNameText = (p: PlaceName | null): string =>
  p
    ? [p.street, p.neighbourhood, p.city, p.state, p.country]
        .filter((x, i, a): x is string => !!x && a.indexOf(x) === i)
        .join(', ')
    : ''

export const hasPlace = (p: PlaceName | null | undefined): p is PlaceName =>
  !!p && !!(p.neighbourhood || p.city || p.state || p.country)

export interface GeoHit extends LatLon {
  label: string
  source: 'Nominatim' | 'Photon'
}

export interface GeocoderDeps {
  fetch: FetchFn
  userAgent: string
  nominatimBase?: string
  photonBase?: string
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** Idioma dos nomes (padrão pt-BR). */
  language?: string
  cacheMs?: number
}

const s = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

/** `address` do Nominatim → PlaceName. */
export function placeFromNominatim(addr: unknown): PlaceName | null {
  if (!addr || typeof addr !== 'object') return null
  const a = addr as Record<string, unknown>
  const p: PlaceName = {
    neighbourhood:
      s(a.suburb) ?? s(a.neighbourhood) ?? s(a.quarter) ?? s(a.city_district) ?? s(a.borough),
    city: s(a.city) ?? s(a.town) ?? s(a.village) ?? s(a.municipality) ?? s(a.county),
    state: s(a.state) ?? s(a.region),
    country: s(a.country),
    street: s(a.road) ?? s(a.pedestrian)
  }
  return hasPlace(p) ? p : null
}

export class OsmGeocoder {
  private nominatim: Gate
  private photon: Gate
  private cache = new Map<string, { at: number; v: unknown }>()
  private readonly now: () => number

  constructor(private readonly d: GeocoderDeps) {
    this.now = d.now ?? Date.now
    // 1 pedido/s (com folga) — política do Nominatim; o Photon também pede uso moderado
    this.nominatim = new Gate(1100, this.now, d.sleep)
    this.photon = new Gate(1100, this.now, d.sleep)
  }

  private memo<T>(key: string, v?: T): T | undefined {
    const ttl = this.d.cacheMs ?? 10 * 60_000
    const now = this.now()
    for (const [k, e] of this.cache) if (now - e.at > ttl) this.cache.delete(k)
    if (v !== undefined) {
      this.cache.set(key, { at: now, v })
      while (this.cache.size > 50) {
        const oldest = this.cache.keys().next().value
        if (oldest === undefined) break
        this.cache.delete(oldest)
      }
      return v
    }
    return this.cache.get(key)?.v as T | undefined
  }

  private async getJson(url: string, gate: Gate, signal: AbortSignal): Promise<unknown> {
    return gate.run(async () => {
      const timeout = AbortSignal.timeout(15_000)
      let res: Response
      try {
        res = await this.d.fetch(url, {
          headers: {
            'User-Agent': this.d.userAgent,
            Accept: 'application/json',
            'Accept-Language': this.d.language ?? 'pt-BR,pt;q=0.9,en;q=0.5'
          },
          signal: AbortSignal.any([signal, timeout])
        })
      } catch (e) {
        if (signal.aborted) throw e
        throw new OsmHttpError(
          timeout.aborted ? 'timeout de 15 s' : (e as Error).message || 'falha de rede',
          true
        )
      }
      if (!res.ok) {
        void res.body?.cancel().catch(() => undefined)
        throw new OsmHttpError(`${new URL(url).host}: HTTP ${res.status}`, res.status >= 429)
      }
      return res.json()
    })
  }

  /** Nominatim reverso (zoom 16 = rua/bairro; o modo aproximado usa 14 = bairro/cidade). */
  async reverse(p: LatLon, signal: AbortSignal, zoom = 14): Promise<PlaceName | null> {
    const key = `rev:${zoom}:${p.lat.toFixed(4)},${p.lon.toFixed(4)}`
    const hit = this.memo<PlaceName | 'none'>(key)
    if (hit) return hit === 'none' ? null : hit
    const base = this.d.nominatimBase ?? NOMINATIM_BASE
    const url = `${base}/reverse?format=jsonv2&lat=${p.lat}&lon=${p.lon}&zoom=${zoom}&addressdetails=1`
    const json = (await this.getJson(url, this.nominatim, signal)) as { address?: unknown } | null
    const place = placeFromNominatim(json?.address)
    this.memo(key, place ?? 'none')
    return place
  }

  /** Um lugar pelo nome (centro do nearby_places), com viés perto de `near` quando houver. */
  async search(query: string, near: LatLon | null, signal: AbortSignal): Promise<GeoHit | null> {
    const qn = query.trim().replace(/\s+/g, ' ').slice(0, 200)
    if (!qn) return null
    const key = `q:${qn.toLowerCase()}:${near ? `${near.lat.toFixed(2)},${near.lon.toFixed(2)}` : ''}`
    const hit = this.memo<GeoHit | 'none'>(key)
    if (hit) return hit === 'none' ? null : hit
    let found: GeoHit | null = null
    let err: Error | null = null
    try {
      found = await this.searchNominatim(qn, near, signal)
    } catch (e) {
      if (signal.aborted) throw e
      err = e as Error
    }
    if (!found) {
      try {
        found = await this.searchPhoton(qn, near, signal)
      } catch (e) {
        if (signal.aborted) throw e
        if (err) throw new OsmHttpError(`busca do lugar falhou (${err.message})`, true)
        throw e
      }
    }
    this.memo(key, found ?? 'none')
    return found
  }

  private async searchNominatim(
    qn: string,
    near: LatLon | null,
    signal: AbortSignal
  ): Promise<GeoHit | null> {
    const base = this.d.nominatimBase ?? NOMINATIM_BASE
    const bias = near
      ? `&viewbox=${near.lon - 0.5},${near.lat + 0.5},${near.lon + 0.5},${near.lat - 0.5}`
      : ''
    const url = `${base}/search?format=jsonv2&limit=1&addressdetails=0&q=${encodeURIComponent(qn)}${bias}`
    const json = await this.getJson(url, this.nominatim, signal)
    const first = Array.isArray(json) ? (json[0] as Record<string, unknown> | undefined) : undefined
    const lat = Number(first?.lat)
    const lon = Number(first?.lon)
    if (!first || !Number.isFinite(lat) || !Number.isFinite(lon)) return null
    return { lat, lon, label: s(first.display_name) ?? qn, source: 'Nominatim' }
  }

  private async searchPhoton(
    qn: string,
    near: LatLon | null,
    signal: AbortSignal
  ): Promise<GeoHit | null> {
    const base = this.d.photonBase ?? PHOTON_BASE
    const bias = near ? `&lat=${near.lat}&lon=${near.lon}` : ''
    const url = `${base}/api/?limit=1&q=${encodeURIComponent(qn)}${bias}`
    const json = (await this.getJson(url, this.photon, signal)) as {
      features?: { geometry?: { coordinates?: unknown }; properties?: Record<string, unknown> }[]
    } | null
    const f = json?.features?.[0]
    const c = f?.geometry?.coordinates
    if (!Array.isArray(c) || typeof c[0] !== 'number' || typeof c[1] !== 'number') return null
    const pr = f?.properties ?? {}
    const label =
      [s(pr.name), s(pr.district), s(pr.city), s(pr.state), s(pr.country)]
        .filter((x, i, a): x is string => !!x && a.indexOf(x) === i)
        .join(', ') || qn
    return { lat: c[1], lon: c[0], label, source: 'Photon' }
  }
}
