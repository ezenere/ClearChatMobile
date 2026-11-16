// nearby_places pelo Google Maps (protocolo 1.17.0, @shared/googlePlaces vendorado): com o provedor
// escolhido em Tempo e mapas (settings sincronizados) a tool usa o searchText do Google — viés no centro
// (posição aproximada arredondada / coordenadas), `near` no texto (sem ler a posição nem o OSM),
// 5 lugares por padrão, a definição e o card de aprovação dizem Google Maps; qualquer falha do Google →
// OpenStreetMap com o motivo. Sem rede: Google, Overpass e Nominatim/Photon falsos.
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_CHAT_CONFIG } from '../src/vendor/shared/defaults'
import type { ToolName } from '../src/vendor/shared/types'
import { setLocationSource } from '../src/agent/request'
import { OverpassClient } from '../src/location/overpass'
import { OsmGeocoder } from '../src/location/nominatim'
import { LocationService, locationApprovalText } from '../src/location/service'
import { DEFAULT_LOCATION_SETTINGS, type LocationSettings } from '../src/location/settings'
import type { MapsToolsFetch } from '../src/vendor/shared/googleMapsTools'
import { makeHarness, until, type Harness } from './hostHarness'
import { FakeDevice, fakeFetch, osmRoutes } from './fakes/osm'

const UA = 'ClearChat/0.0.0-test (+https://clear.ezenere.com)'
const ctx = () => ({ signal: new AbortController().signal })

const GOOGLE = {
  summary: '**Café do Teste** [0] (4.7★ (321)) é um café aconchegante com wi-fi.',
  places: [
    {
      place: 'places/C1',
      id: 'C1',
      location: { latitude: -23.5605, longitude: -46.6555 },
      googleMapsLinks: {
        placeUrl: 'https://www.google.com/maps/place//data=C1',
        directionsUrl: 'https://www.google.com/maps/dir//data=C1'
      },
      attribution: {
        title: 'Café do Teste - Google Maps',
        url: 'https://www.google.com/maps/place//data=C1'
      }
    }
  ]
}

function service(settings: Partial<LocationSettings> = {}, googleFail = false) {
  const device = new FakeDevice()
  const s: LocationSettings = { ...DEFAULT_LOCATION_SETTINGS, ...settings }
  const net = fakeFetch(osmRoutes())
  const google: { body: Record<string, unknown>; key?: string }[] = []
  const mapsFetch: MapsToolsFetch = async (url, init) => {
    google.push({ body: JSON.parse(init.body!), key: init.headers['X-Goog-Api-Key'] })
    if (!url.endsWith(':searchText')) throw new Error(`rota inesperada: ${url}`)
    return googleFail
      ? {
          ok: false,
          status: 400,
          text: async () => JSON.stringify({ error: { details: [{ reason: 'API_KEY_INVALID' }] } })
        }
      : { ok: true, status: 200, text: async () => JSON.stringify(GOOGLE) }
  }
  const svc = new LocationService({
    device,
    settings: () => s,
    overpass: new OverpassClient({ fetch: net.fetch, userAgent: UA, minIntervalMs: 0 }),
    geocoder: new OsmGeocoder({ fetch: net.fetch, userAgent: UA, sleep: async () => undefined }),
    mapsFetch,
    now: () => 30_000
  })
  return { svc, device, net, google, s }
}

describe('nearby_places com o Google Maps (serviço)', () => {
  it('sem fonte: OpenStreetMap (definição e card); com a chave: Google Maps', () => {
    const { svc } = service()
    expect(svc.placesVia()).toBe('osm')
    expect(svc.definition('nearby_places')!.function.description).toMatch(
      /OpenStreetMap \(Overpass\)/
    )
    svc.setPlacesSource(() => ({ key: 'AIza-teste' }))
    expect(svc.placesVia()).toBe('google')
    const d = svc.definition('nearby_places')!.function
    expect(d.description).toMatch(/^Busca lugares por perto no Google Maps/)
    expect(d.description).toMatch(/cite cada lugar com o link do Google Maps/)
    expect(JSON.stringify(d.parameters)).toMatch(/padrão 5, máximo 10/)
    expect(
      locationApprovalText(
        'nearby_places',
        { what: 'café' },
        { precision: 'approximate' },
        'o agente',
        'Google',
        {
          places: 'google'
        }
      ).detail
    ).toBe(
      'Sua localização aproximada (~1 km) vai para o modelo e para o Google Maps (busca: “café”).'
    )
    expect(
      locationApprovalText('weather', {}, { precision: 'exact' }, 'o agente', 'Google', {
        weather: 'google'
      }).detail
    ).toBe('Sua localização exata vai para o modelo e para o Google (previsão do tempo).')
    svc.setPlacesSource(null)
    expect(svc.placesVia()).toBe('osm')
  })

  it('posição atual: viés no ponto aproximado, 5 lugares, distância e links; nada no OSM', async () => {
    const t = service({ approval: 'always' })
    t.svc.setPlacesSource(() => ({ key: 'AIza-teste' }))
    const r = await t.svc.nearbyPlaces({ what: 'café', radius_m: 800 }, ctx())
    expect(r.status).toBe('ok')
    expect(t.google).toHaveLength(1)
    expect(t.google[0].key).toBe('AIza-teste')
    expect(t.google[0].body).toEqual({
      textQuery: 'café',
      languageCode: 'pt-BR',
      pageSize: 5,
      locationBias: {
        circle: { center: { latitude: -23.56, longitude: -46.65 }, radiusMeters: 800 }
      }
    })
    expect(t.net.calls).toEqual([])
    expect(r.content).toMatch(
      /^1 lugar do Google Maps para “café” perto de sua localização atual, aproximada/
    )
    expect(r.content).toContain('**Café do Teste** [0] (4.7★ (321))')
    expect(r.content).toMatch(
      /\[0\] \*\*Café do Teste\*\* — \d+ m · \[Google Maps\]\(https:\/\/www\.google\.com\/maps\/place\/\/data=C1\)/
    )
    expect(r.content).toContain('Ao responder, cite cada lugar com o link do Google Maps')
  })

  it('near: vai no texto ("perto de"), sem ler a posição nem geocodificar no OSM; limit explícito', async () => {
    const t = service()
    t.svc.setPlacesSource(() => ({ key: 'k' }))
    const r = await t.svc.nearbyPlaces({ what: 'café', near: 'Avenida Paulista', limit: 8 }, ctx())
    expect(r.status).toBe('ok')
    expect(t.google[0].body).toEqual({
      textQuery: 'café perto de Avenida Paulista',
      languageCode: 'pt-BR',
      pageSize: 8
    })
    expect(t.device.positions).toEqual([])
    expect(t.net.calls).toEqual([])
    expect(r.content).toMatch(/^1 lugar do Google Maps para “café” perto de Avenida Paulista\.\n/)
  })

  it('Google falha → OpenStreetMap com o motivo (centro por near geocodificado no OSM)', async () => {
    const t = service({}, true)
    t.svc.setPlacesSource(() => ({ key: 'ruim' }))
    const r = await t.svc.nearbyPlaces({ what: 'restaurante', near: 'Avenida Paulista' }, ctx())
    expect(r.status).toBe('ok')
    expect(t.google).toHaveLength(1)
    expect(r.content).toContain(
      'Obs.: o Google Maps falhou (a chave do Google Maps é inválida (Configurações → Tempo e mapas)) — usei o OpenStreetMap.'
    )
    expect(r.content).toContain('Fonte: OpenStreetMap via Overpass')
    expect(r.content).toContain('Cantina do Teste')
  })
})

describe('runner: o PC escolhe o Google Maps e o celular usa', () => {
  let h: Harness
  afterEach(async () => {
    await h?.close()
    setLocationSource(null)
  })

  it('placesProvider + chave sincronizados → nearby_places pelo Google; tirar a chave volta ao OSM', async () => {
    const t = service({ approval: 'always' })
    h = await makeHarness({ location: t.svc })
    await h.desk.put('setting', 'googleMapsApiKey', null, { sv: 1, value: 'AIza-do-pc' })
    await h.desk.put('setting', 'placesProvider', null, { sv: 1, value: 'google' })
    await h.engine.sync()
    expect(t.svc.placesVia()).toBe('google')
    const { session } = h.stack.repo.createChat({
      config: {
        ...DEFAULT_CHAT_CONFIG(''),
        providerId: h.providerId,
        model: 'fake/agent',
        enabledTools: ['nearby_places'] as unknown as ToolName[]
      },
      title: ''
    })
    const sid = session.id
    const idle = () => until(() => !h.stack.runner.isRunning(sid), 10_000, 'turno')
    const last = () =>
      h.stack.repo
        .path(sid)
        .filter((m) => m.message.role === 'tool')
        .pop()!
    await h.stack.runner.send(sid, '/near café')
    await idle()
    expect(last().meta.toolStatus).toBe('ok')
    expect(String(last().message.content)).toMatch(/lugar do Google Maps para “café”/)
    expect(t.google[0].key).toBe('AIza-do-pc')
    // a definição enviada ao modelo é a do Google (pela tool_search, na versão compacta)
    expect(t.svc.definition('nearby_places')!.function.description).toMatch(/Google Maps/)

    await h.desk.put('setting', 'googleMapsApiKey', null, { sv: 1, value: null })
    await h.engine.sync()
    expect(t.svc.placesVia()).toBe('osm')
    await h.stack.runner.send(sid, '/near café')
    await idle()
    expect(String(last().message.content)).toContain('Fonte: OpenStreetMap via Overpass')
    expect(t.google).toHaveLength(1)
  })
})
