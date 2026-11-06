// Geometria das tools de localização (puro): distância no aparelho, arredondamento do modo
// aproximado (~1 km) e formatação pt-BR.

export interface LatLon {
  lat: number
  lon: number
}

/** "Aproximada" (padrão) arredonda a posição do usuário; "Exata" usa a do sistema. */
export type Precision = 'approximate' | 'exact'

/** Casas decimais do modo aproximado: 0,01° ≈ 1,1 km de latitude (menos de longitude fora do equador). */
export const APPROX_DECIMALS = 2
/** Casas no modo exato (≈ 1 m): sem ruído de ponto flutuante no texto. */
export const EXACT_DECIMALS = 5
/** Incerteza mínima anunciada no modo aproximado (meia diagonal da célula de 0,01°, arredondada). */
export const APPROX_ACCURACY_M = 1_000

export function roundCoord(v: number, decimals: number): number {
  const f = 10 ** decimals
  const r = Math.round(v * f) / f
  return Object.is(r, -0) ? 0 : r
}

/** Posição como vai para o modelo/OSM na precisão escolhida. */
export function atPrecision(p: LatLon, precision: Precision): LatLon {
  const d = precision === 'exact' ? EXACT_DECIMALS : APPROX_DECIMALS
  return { lat: roundCoord(p.lat, d), lon: roundCoord(p.lon, d) }
}

export const fmtCoord = (v: number, precision: Precision): string =>
  v.toFixed(precision === 'exact' ? EXACT_DECIMALS : APPROX_DECIMALS)

export function validLatLon(lat: unknown, lon: unknown): boolean {
  return (
    typeof lat === 'number' &&
    typeof lon === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180
  )
}

const R = 6_371_008.8
const rad = (d: number): number => (d * Math.PI) / 180

/** Distância em metros (haversine). */
export function distanceMeters(a: LatLon, b: LatLon): number {
  const dLat = rad(b.lat - a.lat)
  const dLon = rad(b.lon - a.lon)
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** 40 m · 350 m · 1,2 km · 12 km. */
export function fmtDistance(m: number): string {
  if (!Number.isFinite(m) || m < 0) return '?'
  if (m < 100) return `${Math.max(5, Math.round(m / 5) * 5)} m`
  if (m < 1000) return `${Math.round(m / 10) * 10} m`
  if (m < 10_000) return `${(m / 1000).toFixed(1).replace('.', ',')} km`
  return `${Math.round(m / 1000)} km`
}

/** Precisão anunciada: no modo aproximado, nunca menos que a célula do arredondamento. */
export function announcedAccuracy(accuracyM: number | null, precision: Precision): number | null {
  if (precision === 'approximate')
    return Math.max(APPROX_ACCURACY_M, Math.round(accuracyM ?? APPROX_ACCURACY_M))
  return accuracyM == null ? null : Math.round(accuracyM)
}
