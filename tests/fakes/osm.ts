// Respostas falsas do OpenStreetMap (formato do Overpass/Nominatim/Photon, dados inventados) e um
// `fetch` falso que as serve — sem rede nos testes. Também um aparelho falso (permissão/posição/
// geocodificador do sistema) para o LocationService.
import type { LatLon, Precision } from '../../src/location/geo'
import type { PlaceName } from '../../src/location/nominatim'
import type { DeviceFix, DevicePermission, LocationDevice } from '../../src/location/service'

/** Centro "real" do teste (Av. Paulista); o aproximado é -23.56, -46.65. */
export const PAULISTA = { lat: -23.5614, lon: -46.6544 }

export const OVERPASS_FIXTURE = {
  version: 0.6,
  generator: 'Overpass API (falso)',
  elements: [
    {
      type: 'node',
      id: 1,
      lat: -23.5609,
      lon: -46.6551,
      tags: {
        amenity: 'restaurant',
        name: 'Cantina do Teste',
        cuisine: 'pizza;italian',
        'addr:street': 'Rua Fictícia',
        'addr:housenumber': '100',
        'addr:suburb': 'Bela Vista',
        'addr:city': 'São Paulo',
        opening_hours: 'Mo-Su 11:00-23:00',
        'contact:phone': '+55 11 0000-0000',
        website: 'cantina.example'
      }
    },
    // o mesmo lugar como contorno do prédio (centro), a ~10 m: mescla
    {
      type: 'way',
      id: 2,
      center: { lat: -23.56095, lon: -46.65515 },
      tags: { amenity: 'restaurant', name: 'Cantina do Teste', 'addr:postcode': '01310-000' }
    },
    {
      type: 'way',
      id: 3,
      center: { lat: -23.5651, lon: -46.6521 },
      tags: { amenity: 'fast_food', name: 'Lanches Exemplo', cuisine: 'burger' }
    },
    // sem nome: restaurante descartado, caixa eletrônico mantido
    { type: 'node', id: 4, lat: -23.5615, lon: -46.6545, tags: { amenity: 'restaurant' } },
    { type: 'node', id: 5, lat: -23.5616, lon: -46.6546, tags: { amenity: 'atm' } },
    // sem coordenadas: ignorado
    { type: 'relation', id: 6, tags: { amenity: 'restaurant', name: 'Sem Centro' } },
    {
      type: 'node',
      id: 7,
      lat: -23.5702,
      lon: -46.6601,
      tags: { amenity: 'cafe', name: 'Café Distante', website: 'javascript:alert(1)' }
    }
  ]
}

export const NOMINATIM_REVERSE = {
  place_id: 1,
  address: {
    suburb: 'Bela Vista',
    road: 'Rua Fictícia',
    city: 'São Paulo',
    state: 'São Paulo',
    country: 'Brasil',
    country_code: 'br'
  }
}

export const NOMINATIM_SEARCH = [
  { lat: '-23.5614', lon: '-46.6544', display_name: 'Avenida Paulista, Bela Vista, São Paulo' }
]

export const PHOTON_SEARCH = {
  type: 'FeatureCollection',
  features: [
    {
      geometry: { type: 'Point', coordinates: [-46.6333, -23.5505] },
      properties: { name: 'Praça da Sé', city: 'São Paulo', country: 'Brasil' }
    }
  ]
}

export interface FakeCall {
  url: string
  method: string
  headers: Record<string, string>
  body: string
}

type Route = (call: FakeCall) => { status?: number; json?: unknown; text?: string } | null

/** `fetch` falso: a primeira rota que responder ganha; sem rota = 404. */
export function fakeFetch(routes: Route[]): {
  fetch: (url: string, init: RequestInit) => Promise<Response>
  calls: FakeCall[]
} {
  const calls: FakeCall[] = []
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>))
      headers[k.toLowerCase()] = v
    const call: FakeCall = {
      url,
      method: init.method ?? 'GET',
      headers,
      body: typeof init.body === 'string' ? init.body : ''
    }
    calls.push(call)
    if (init.signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' })
    for (const r of routes) {
      const out = r(call)
      if (!out) continue
      const body = out.text ?? JSON.stringify(out.json ?? null)
      return new Response(body, {
        status: out.status ?? 200,
        headers: { 'Content-Type': out.text ? 'text/html' : 'application/json' }
      })
    }
    return new Response('nada aqui', { status: 404 })
  }
  return { fetch, calls }
}

/** Overpass + Nominatim + Photon falsos (com opções para os casos de falha). */
export function osmRoutes(
  o: {
    overpassFirst?: number
    nominatimSearchEmpty?: boolean
    nominatimReverseEmpty?: boolean
  } = {}
): Route[] {
  return [
    (c) =>
      c.url.startsWith('https://overpass-api.de/') && o.overpassFirst
        ? { status: o.overpassFirst, text: '<p><strong>Error</strong>: falso</p>' }
        : null,
    (c) => (c.url.includes('/api/interpreter') ? { json: OVERPASS_FIXTURE } : null),
    (c) =>
      c.url.includes('nominatim') && c.url.includes('/reverse')
        ? { json: o.nominatimReverseEmpty ? { error: 'Unable to geocode' } : NOMINATIM_REVERSE }
        : null,
    (c) =>
      c.url.includes('nominatim') && c.url.includes('/search')
        ? { json: o.nominatimSearchEmpty ? [] : NOMINATIM_SEARCH }
        : null,
    (c) => (c.url.includes('photon') ? { json: PHOTON_SEARCH } : null)
  ]
}

export class FakeDevice implements LocationDevice {
  platform: 'android' | 'ios' = 'android'
  geocoderName = 'geocodificador do Android'
  perm: DevicePermission = { status: 'granted', accuracy: 'full', canAskAgain: true }
  /** Resposta ao pedido de permissão (null = mantém a atual). */
  onRequest: ((p: Precision) => DevicePermission) | null = null
  services = true
  fix: DeviceFix | null = { ...PAULISTA, accuracyM: 12, timestamp: 0, mocked: false }
  place: PlaceName | null | 'throw' = {
    neighbourhood: 'Bela Vista',
    city: 'São Paulo',
    state: 'São Paulo',
    country: 'Brasil',
    street: 'Avenida Paulista'
  }
  requests: Precision[] = []
  geocoded: LatLon[] = []
  positions: Precision[] = []

  async permission(): Promise<DevicePermission> {
    return this.perm
  }
  async request(p: Precision): Promise<DevicePermission> {
    this.requests.push(p)
    if (this.onRequest) this.perm = this.onRequest(p)
    return this.perm
  }
  async servicesEnabled(): Promise<boolean> {
    return this.services
  }
  async position(p: Precision): Promise<DeviceFix | null> {
    this.positions.push(p)
    return this.fix
  }
  async reverseGeocode(p: LatLon): Promise<PlaceName | null> {
    this.geocoded.push(p)
    if (this.place === 'throw') throw new Error('geocoder indisponível')
    return this.place
  }
}
