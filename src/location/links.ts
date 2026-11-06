// Links que abrem o app de mapas do usuário (puro). Android: `geo:` (o sistema oferece Google
// Maps, OsmAnd, Waze…); iOS: `maps://` (Apple Mapas). Sempre junto um link https do OpenStreetMap,
// que abre em qualquer lugar (inclusive no computador, se o chat for aberto lá).

export type MapPlatform = 'android' | 'ios'

export interface MapLinks {
  /** Link do app de mapas do aparelho. */
  app: string
  /** Link universal (navegador). */
  web: string
}

/** Rótulo seguro para dentro do link (sem parênteses/colchetes, que quebram o geo:/Markdown). */
const cleanLabel = (name: string): string =>
  name
    .replace(/[()[\]<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)

export function mapLinks(
  p: { lat: number; lon: number; name?: string | null },
  platform: MapPlatform
): MapLinks {
  const ll = `${p.lat},${p.lon}`
  const label = cleanLabel(p.name ?? '') || 'Local'
  const app =
    platform === 'ios'
      ? `maps://?q=${encodeURIComponent(label)}&ll=${ll}`
      : `geo:${ll}?q=${ll}(${encodeURIComponent(label)})`
  const web = `https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lon}#map=18/${p.lat}/${p.lon}`
  return { app, web }
}

/** Esquemas de link que o chat deixa abrir (Markdown): web, e-mail e os de mapas. */
export const SAFE_LINK = /^(https?:|mailto:|geo:|maps:)/i

/** Link de mapa do aparelho → OpenStreetMap (nenhum app abriu o `geo:`/`maps:`). */
export function webFallback(href: string): string | null {
  const geo = /^geo:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/i.exec(href)
  const ll = /^maps:.*[?&]ll=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/i.exec(href)
  const m = geo ?? ll
  if (!m) return null
  const [lat, lon] = [m[1], m[2]]
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=18/${lat}/${lon}`
}
