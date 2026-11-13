// Tools de localização (get_location / nearby_places): texto → tags OSM, consulta Overpass,
// distância, arredondamento do modo aproximado, leitura do JSON do Overpass (fixture), links de mapa,
// permissão negada/pedida/precisão reduzida, geocodificador do sistema → Nominatim, reservas
// (Overpass e Photon), cache e intervalo; e o runner (oferta pelo chat + aparelho, aprovação do
// aparelho, negar, sempre, nunca). Sem rede: fetch e aparelho falsos.
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_CHAT_CONFIG } from '../src/vendor/shared/defaults'
import type { Chat, ChatConfig, ToolName } from '../src/vendor/shared/types'
import { availableTools, buildRequest, MOBILE_TOOLS, setLocationSource } from '../src/agent/request'
import {
  APP_TOOL_NAMES,
  COMPUTER_TOOL_NAMES,
  PHONE_TOOLS,
  runsOn
} from '../src/vendor/shared/deviceTools'
import { DENIED_TEXT } from '../src/agent/runner'
import { lexMarkdown } from '../src/chat/markdownTokens'
import {
  announcedAccuracy,
  atPrecision,
  distanceMeters,
  fmtDistance,
  roundCoord
} from '../src/location/geo'
import { mapLinks, SAFE_LINK, webFallback } from '../src/location/links'
import { OsmGeocoder, placeFromNominatim } from '../src/location/nominatim'
import {
  buildOverpassQuery,
  clampLimit,
  clampRadius,
  Gate,
  OverpassClient,
  parseOverpass
} from '../src/location/overpass'
import {
  LOCATION_TOOLS,
  LocationService,
  locationApprovalText,
  MSG,
  usesDeviceLocation
} from '../src/location/service'
import {
  DEFAULT_LOCATION_SETTINGS,
  LocationPrefs,
  readLocationSettings,
  type LocationSettings
} from '../src/location/settings'
import { fold, resolveQuery } from '../src/location/tags'
import { resolveNewChat } from '../src/host/newChat'
import { makeHarness, until, type Harness } from './hostHarness'
import {
  FakeDevice,
  fakeFetch,
  NOMINATIM_REVERSE,
  osmRoutes,
  OVERPASS_FIXTURE,
  PAULISTA
} from './fakes/osm'

const UA = 'ClearChat/0.0.0-test (+https://clear.ezenere.com)'
const ctx = () => ({ signal: new AbortController().signal })

function service(
  o: {
    settings?: Partial<LocationSettings>
    device?: FakeDevice
    routes?: Parameters<typeof osmRoutes>[0]
  } = {}
) {
  const device = o.device ?? new FakeDevice()
  const s: LocationSettings = { ...DEFAULT_LOCATION_SETTINGS, ...o.settings }
  const net = fakeFetch(osmRoutes(o.routes))
  const svc = new LocationService({
    device,
    settings: () => s,
    overpass: new OverpassClient({ fetch: net.fetch, userAgent: UA, minIntervalMs: 0 }),
    geocoder: new OsmGeocoder({
      fetch: net.fetch,
      userAgent: UA,
      sleep: async () => undefined
    }),
    now: () => 30_000
  })
  return { svc, device, net, s }
}

describe('tags: texto livre → OSM', () => {
  const tags = (what: string, cuisine?: string) => resolveQuery(what, cuisine).tagsText

  it('categorias comuns em pt-BR (com e sem acento) e em inglês', () => {
    expect(tags('restaurante')).toBe('amenity=restaurant')
    expect(tags('Farmácia 24h')).toBe('amenity=pharmacy · shop=chemist')
    expect(tags('farmacia')).toBe(tags('FARMÁCIA'))
    expect(tags('café')).toBe('amenity=cafe')
    expect(tags('mercado')).toBe('shop=supermarket|convenience|wholesale|greengrocer')
    expect(tags('posto')).toBe('amenity=fuel')
    expect(tags('hospital')).toBe('amenity=hospital')
    expect(tags('gas station')).toBe('amenity=fuel')
    expect(tags('caixa eletrônico')).toBe('amenity=atm')
    expect(tags('hotel ou pousada')).toBe('tourism=hotel|guest_house|hostel|motel|apartment')
  })

  it('frases mais longas vencem: clínica veterinária, posto de saúde, banco 24 horas', () => {
    expect(tags('clínica veterinária')).toBe('amenity=veterinary')
    expect(tags('posto de saúde')).toBe('amenity=clinic|doctors')
    expect(tags('banco 24 horas')).toBe('amenity=atm')
    expect(tags('café especial')).toBe('amenity=cafe + cuisine~coffee')
  })

  it('culinária: sozinha usa restaurantes/lanchonetes; com categoria de comida, filtra ela', () => {
    expect(tags('pizzaria')).toBe('amenity=restaurant|fast_food + cuisine~pizza')
    expect(tags('restaurante japonês')).toBe('amenity=restaurant + cuisine~japanese|sushi|ramen')
    expect(tags('restaurante', 'árabe')).toBe(
      'amenity=restaurant + cuisine~arab|lebanese|middle_eastern|kebab|turkish'
    )
    // vegetariana: cuisine OU diet:vegetarian OU diet:vegan
    const veg = resolveQuery('restaurante vegetariano')
    expect(veg.filters).toHaveLength(3)
    expect(veg.filters.map((f) => f.extra?.[0]?.key)).toEqual([
      'cuisine',
      'diet:vegetarian',
      'diet:vegan'
    ])
    expect(veg.labels).toEqual(['restaurante', 'culinária vegetariana'])
  })

  it('tag OSM direta e busca por nome (nada reconhecido, regex escapada)', () => {
    expect(tags('amenity=cafe')).toBe('amenity=cafe')
    expect(tags('shop=bakery|pastry')).toBe('shop=bakery|pastry')
    expect(tags('amenity=restaurant, cuisine~sushi')).toBe('amenity=restaurant + cuisine~sushi')
    const r = resolveQuery('Starbucks (Paulista)')
    expect(r.nameRegex).toBe('Starbucks \\(Paulista\\)')
    expect(r.filters.map((f) => f.key)).toEqual(['amenity', 'shop', 'tourism', 'leisure'])
    expect(fold('  Açaí  DO   Pará ')).toBe('acai do para')
  })
})

describe('Overpass: consulta', () => {
  const center = { lat: -23.56, lon: -46.65 }

  it('um valor, vários valores (regex ancorada), extras sem diferenciar maiúsculas, centro das vias', () => {
    const ql = buildOverpassQuery({
      center,
      radiusM: 800,
      filters: resolveQuery('pizzaria').filters,
      max: 40
    })
    expect(ql).toBe(
      '[out:json][timeout:20][maxsize:16777216];(nwr["amenity"~"^(restaurant|fast_food)$"]["cuisine"~"pizza",i](around:800,-23.56,-46.65););out center tags 40;'
    )
    const one = buildOverpassQuery({ center, radiusM: 500, filters: resolveQuery('café').filters })
    expect(one).toContain('nwr["amenity"="cafe"](around:500,-23.56,-46.65);')
    expect(one).toContain('out center tags 120;')
  })

  it('nome com aspas/barras escapado; raio e limite com teto; seletores repetidos uma vez', () => {
    const r = resolveQuery('Loja do "Zé" \\ 2')
    const ql = buildOverpassQuery({
      center,
      radiusM: 99_999,
      filters: r.filters,
      nameRegex: r.nameRegex
    })
    expect(ql).toContain('(around:5000,')
    expect(ql).toContain('["name"~"Loja do \\"Zé\\" \\\\\\\\ 2",i]')
    expect(clampRadius(10)).toBe(50)
    expect(clampRadius(undefined)).toBe(1000)
    expect(clampLimit(500)).toBe(25)
    expect(clampLimit(0)).toBe(1)
    const dup = buildOverpassQuery({
      center,
      radiusM: 100,
      filters: [...resolveQuery('café').filters, ...resolveQuery('cafeteria').filters]
    })
    expect(dup.match(/nwr/g)).toHaveLength(1)
  })
})

describe('geometria e arredondamento', () => {
  it('distância (haversine) e formato pt-BR', () => {
    expect(distanceMeters({ lat: 0, lon: 0 }, { lat: 1, lon: 0 })).toBeCloseTo(111_195, -1)
    const d = distanceMeters(PAULISTA, { lat: -23.5505, lon: -46.6333 })
    expect(d).toBeGreaterThan(2_400)
    expect(d).toBeLessThan(2_500)
    expect(fmtDistance(42)).toBe('40 m')
    expect(fmtDistance(3)).toBe('5 m')
    expect(fmtDistance(347)).toBe('350 m')
    expect(fmtDistance(1234)).toBe('1,2 km')
    expect(fmtDistance(12_400)).toBe('12 km')
  })

  it('aproximada = 2 casas (~1 km), exata = 5; sem -0; precisão anunciada nunca menor que 1 km', () => {
    expect(atPrecision(PAULISTA, 'approximate')).toEqual({ lat: -23.56, lon: -46.65 })
    expect(atPrecision({ lat: -23.565, lon: -46.655 }, 'approximate')).toEqual({
      lat: -23.56,
      lon: -46.65
    })
    expect(atPrecision({ lat: -23.5614321, lon: -46.6544987 }, 'exact')).toEqual({
      lat: -23.56143,
      lon: -46.6545
    })
    expect(Object.is(roundCoord(-0.001, 2), 0)).toBe(true)
    // o arredondamento desloca no máximo meia célula (~0,8 km na diagonal em SP)
    const moved = distanceMeters(PAULISTA, atPrecision(PAULISTA, 'approximate'))
    expect(moved).toBeLessThan(800)
    expect(announcedAccuracy(12, 'approximate')).toBe(1000)
    expect(announcedAccuracy(3000, 'approximate')).toBe(3000)
    expect(announcedAccuracy(12.4, 'exact')).toBe(12)
  })
})

describe('Overpass: leitura do JSON (fixture)', () => {
  it('ordena por distância, mescla ponto+prédio, descarta sem nome (salvo caixa eletrônico) e sem coordenadas', () => {
    const places = parseOverpass(OVERPASS_FIXTURE, PAULISTA)
    expect(places.map((p) => p.name)).toEqual([
      null,
      'Cantina do Teste',
      'Lanches Exemplo',
      'Café Distante'
    ])
    const atm = places[0]
    expect(atm.category).toBe('caixa eletrônico')
    const cantina = places[1]
    expect(cantina).toMatchObject({
      id: 'node/1',
      category: 'restaurante',
      tag: 'amenity=restaurant',
      cuisine: ['pizza', 'italiana'],
      address: 'Rua Fictícia, 100 — Bela Vista — São Paulo',
      openingHours: 'Mo-Su 11:00-23:00',
      phone: '+55 11 0000-0000',
      website: 'https://cantina.example'
    })
    expect(Math.round(cantina.distanceM)).toBe(Math.round(distanceMeters(PAULISTA, cantina)))
    expect(places[2]).toMatchObject({
      id: 'way/3',
      category: 'lanchonete',
      cuisine: ['hambúrguer']
    })
    // site que não é http(s) não passa
    expect(places[3].website).toBeNull()
    for (let i = 1; i < places.length; i++)
      expect(places[i].distanceM).toBeGreaterThanOrEqual(places[i - 1].distanceM)
    expect(parseOverpass({ remark: 'x' }, PAULISTA)).toEqual([])
    expect(parseOverpass(null, PAULISTA)).toEqual([])
  })
})

describe('links de mapa', () => {
  it('Android geo:, iOS maps:, web do OSM; rótulo sem parênteses', () => {
    const p = { lat: -23.5609, lon: -46.6551, name: 'Cantina (do) Teste' }
    expect(mapLinks(p, 'android').app).toBe(
      'geo:-23.5609,-46.6551?q=-23.5609,-46.6551%28Cantina%20do%20Teste%29'
    )
    expect(mapLinks(p, 'ios').app).toBe('maps://?q=Cantina%20do%20Teste&ll=-23.5609,-46.6551')
    expect(mapLinks(p, 'ios').web).toBe(
      'https://www.openstreetmap.org/?mlat=-23.5609&mlon=-46.6551#map=18/-23.5609/-46.6551'
    )
    expect(SAFE_LINK.test('geo:1,2')).toBe(true)
    expect(SAFE_LINK.test('maps://?q=x')).toBe(true)
    expect(SAFE_LINK.test('javascript:alert(1)')).toBe(false)
    expect(SAFE_LINK.test('intent://x')).toBe(false)
    expect(webFallback(mapLinks(p, 'android').app)).toBe(mapLinks(p, 'android').web)
    expect(webFallback(mapLinks(p, 'ios').app)).toBe(mapLinks(p, 'ios').web)
    expect(webFallback('https://x')).toBeNull()
  })

  it('o Markdown do chat reconhece o link geo: com o rótulo entre parênteses', () => {
    const app = mapLinks({ lat: -23.5, lon: -46.6, name: 'Bar X' }, 'android').app
    const tokens = lexMarkdown(`[abrir no app de mapas](${app}) · [OSM](https://osm.org)`)
    const links: string[] = []
    const walk = (ts: unknown[]): void => {
      for (const t of ts as { type: string; href?: string; tokens?: unknown[] }[]) {
        if (t.type === 'link' && t.href) links.push(t.href)
        if (t.tokens) walk(t.tokens)
      }
    }
    walk(tokens as unknown[])
    expect(links).toEqual([app, 'https://osm.org'])
  })

  it('link geo: sem parênteses: recortar no primeiro `)` (modelo/regex ingênuo) não o quebra', () => {
    const app = mapLinks({ lat: -23.559634, lon: -46.6524598, name: 'Le (Jardin)' }, 'android').app
    expect(app).not.toMatch(/[()]/)
    // o que um extrator ingênuo faz com `[abrir no app de mapas](<link>)`
    const cut = /\]\(([^)]+)\)/.exec(`[abrir no app de mapas](${app})`)?.[1]
    expect(cut).toBe(app)
    const hrefs = (md: string): string[] => {
      const out: string[] = []
      const walk = (ts: unknown[]): void => {
        for (const t of ts as {
          type: string
          href?: string
          tokens?: unknown[]
          items?: unknown[]
        }[]) {
          if (t.type === 'link' && t.href) out.push(t.href)
          if (t.tokens) walk(t.tokens)
          if (t.items) walk(t.items)
        }
      }
      walk(lexMarkdown(md) as unknown[])
      return out
    }
    expect(hrefs(`1. [Le Jardin](${cut}) — 250 m\n   Rua Pamplona, 315`)).toEqual([app])
    // links com parênteses balanceados continuam valendo (formato antigo, de outros apps)…
    const old = 'geo:-23.55,-46.65?q=-23.55,-46.65(Le%20Jardin)'
    expect(hrefs(`[Le Jardin](${old})`)).toEqual([old])
    // …e o recorte desbalanceado (o sintoma visto na captura de tela) vira texto, como no CommonMark
    expect(hrefs('[Le Jardin](geo:-23.55,-46.65?q=-23.55,-46.65(Le%20Jardin)')).toEqual([])
  })
})

describe('preferências do aparelho', () => {
  it('padrão aproximada + perguntar; valores inválidos voltam ao padrão; avisa quem ouve', () => {
    const data = new Map<string, string | null>()
    const kv = {
      get: (k: string) => data.get(k) ?? null,
      set: (k: string, v: string | null) => void data.set(k, v)
    }
    expect(readLocationSettings(kv)).toEqual({ precision: 'approximate', approval: 'ask' })
    data.set('location.precision', 'exata?')
    data.set('location.approval', 'talvez')
    expect(readLocationSettings(kv)).toEqual(DEFAULT_LOCATION_SETTINGS)
    const prefs = new LocationPrefs(kv)
    let n = 0
    prefs.subscribe(() => n++)
    prefs.set('precision', 'exact')
    prefs.set('approval', 'never')
    expect(prefs.get()).toEqual({ precision: 'exact', approval: 'never' })
    expect(n).toBe(2)
  })
})

describe('get_location', () => {
  it('aproximada: coordenadas arredondadas para o modelo E para o geocodificador do sistema; sem rua', async () => {
    const { svc, device, net } = service()
    const r = await svc.getLocation({}, ctx())
    expect(r.status).toBe('ok')
    expect(r.content).toContain('APROXIMADA')
    expect(r.content).toContain('latitude: -23.56, longitude: -46.65 (± 1,0 km)')
    expect(r.content).not.toContain('-23.5614')
    expect(r.content).not.toContain('Avenida Paulista')
    expect(r.content).toContain('lugar: Bela Vista, São Paulo, Brasil (geocodificador do Android)')
    expect(r.content).toContain('[abrir no app de mapas](geo:-23.56,-46.65?q=-23.56,-46.65%28')
    expect(device.geocoded).toEqual([{ lat: -23.56, lon: -46.65 }])
    expect(device.positions).toEqual(['approximate'])
    expect(device.requests).toEqual([])
    expect(net.calls).toEqual([])
  })

  it('exata: 5 casas, a precisão do GPS e a rua', async () => {
    const { svc } = service({ settings: { precision: 'exact' } })
    const r = await svc.getLocation({}, ctx())
    expect(r.content).toContain('latitude: -23.56140, longitude: -46.65440 (± 10 m)')
    expect(r.content).toContain('Avenida Paulista, Bela Vista')
  })

  it('geocodificador do sistema vazio ou com erro → Nominatim (coordenadas arredondadas, User-Agent)', async () => {
    for (const place of [null, 'throw'] as const) {
      const device = new FakeDevice()
      device.place = place
      const { svc, net } = service({ device })
      const r = await svc.getLocation({}, ctx())
      expect(r.content).toContain(
        'lugar: Bela Vista, São Paulo, Brasil (OpenStreetMap (Nominatim))'
      )
      expect(r.content).not.toContain('Rua Fictícia')
      expect(net.calls).toHaveLength(1)
      expect(net.calls[0].url).toContain('/reverse?format=jsonv2&lat=-23.56&lon=-46.65&zoom=14')
      expect(net.calls[0].headers['user-agent']).toBe(UA)
    }
    // nada em nenhum: a tool não cai
    const device = new FakeDevice()
    device.place = null
    const { svc } = service({ device, routes: { nominatimReverseEmpty: true } })
    const r = await svc.getLocation({}, ctx())
    expect(r.status).toBe('ok')
    expect(r.content).toContain('lugar: — (nenhum geocodificador devolveu o nome do lugar)')
    expect(placeFromNominatim(NOMINATIM_REVERSE.address)?.street).toBe('Rua Fictícia')
  })

  it('permissão: negada de vez não pergunta; sem resposta pede (só a aproximada); recusada', async () => {
    const d1 = new FakeDevice()
    d1.perm = { status: 'denied', accuracy: 'none', canAskAgain: false }
    await expect(service({ device: d1 }).svc.getLocation({}, ctx())).rejects.toThrow(MSG.denied)
    expect(d1.requests).toEqual([])

    const d2 = new FakeDevice()
    d2.perm = { status: 'undetermined', accuracy: 'none', canAskAgain: true }
    d2.onRequest = () => ({ status: 'granted', accuracy: 'reduced', canAskAgain: true })
    const r = await service({ device: d2 }).svc.getLocation({}, ctx())
    expect(r.status).toBe('ok')
    expect(d2.requests).toEqual(['approximate'])

    const d3 = new FakeDevice()
    d3.perm = { status: 'undetermined', accuracy: 'none', canAskAgain: true }
    d3.onRequest = () => ({ status: 'denied', accuracy: 'none', canAskAgain: true })
    await expect(service({ device: d3 }).svc.getLocation({}, ctx())).rejects.toThrow(MSG.notGranted)
  })

  it('"Exata" com o sistema só na aproximada: pede a precisa uma vez; recusada → aproximada com aviso', async () => {
    const device = new FakeDevice()
    device.perm = { status: 'granted', accuracy: 'reduced', canAskAgain: true }
    const { svc } = service({ device, settings: { precision: 'exact' } })
    const r = await svc.getLocation({}, ctx())
    expect(device.requests).toEqual(['exact'])
    expect(device.positions).toEqual(['approximate'])
    expect(r.content).toContain('APROXIMADA')
    expect(r.content).toContain('obs.: O usuário escolheu "Exata"')
    await svc.getLocation({}, ctx())
    expect(device.requests).toEqual(['exact']) // não insiste
    // concedida no pedido: exata
    const d2 = new FakeDevice()
    d2.perm = { status: 'granted', accuracy: 'reduced', canAskAgain: true }
    d2.onRequest = () => ({ status: 'granted', accuracy: 'full', canAskAgain: true })
    const r2 = await service({ device: d2, settings: { precision: 'exact' } }).svc.getLocation(
      {},
      ctx()
    )
    expect(r2.content).toContain('(exata)')
  })

  it('serviços desligados, sem posição, "Nunca"', async () => {
    const d1 = new FakeDevice()
    d1.services = false
    await expect(service({ device: d1 }).svc.getLocation({}, ctx())).rejects.toThrow(
      MSG.servicesOff
    )
    const d2 = new FakeDevice()
    d2.fix = null
    await expect(service({ device: d2 }).svc.getLocation({}, ctx())).rejects.toThrow(MSG.noFix)
    const off = service({ settings: { approval: 'never' } })
    await expect(off.svc.getLocation({}, ctx())).rejects.toThrow(MSG.off)
    expect(off.device.positions).toEqual([])
    expect(off.svc.tools()).toEqual(['nearby_places'])
  })
})

describe('nearby_places', () => {
  it('posição atual aproximada → Overpass com o centro arredondado → lista com distâncias e links', async () => {
    const { svc, net } = service()
    const r = await svc.nearbyPlaces({ what: 'pizzaria', limit: 2 }, ctx())
    expect(r.status).toBe('ok')
    expect(net.calls).toHaveLength(1)
    const call = net.calls[0]
    expect(call.url).toBe('https://overpass-api.de/api/interpreter')
    expect(call.method).toBe('POST')
    expect(call.headers['user-agent']).toBe(UA)
    const ql = decodeURIComponent(call.body.replace(/^data=/, ''))
    expect(ql).toContain('(around:1000,-23.56,-46.65)')
    expect(ql).not.toContain('-23.5614')
    expect(r.content).toContain('2 lugares (os mais próximos de 3 encontrados) para “pizzaria”')
    expect(r.content).toContain('sua localização atual, aproximada (-23.56, -46.65')
    expect(r.content).toContain('as distâncias também são aproximadas')
    expect(r.content).toContain('© colaboradores do OpenStreetMap')
    expect(r.content).toContain('**Cantina do Teste** — restaurante · pizza, italiana ·')
    expect(r.content).toContain('horário (OSM): Mo-Su 11:00-23:00')
    expect(r.content).toMatch(/\[abrir no app de mapas\]\(geo:-23\.5609,-46\.6551\?q=/)
    expect(r.content).toContain('[OpenStreetMap](https://www.openstreetmap.org/?mlat=-23.5609')
    expect(r.content).not.toContain('Café Distante')
    // consulta idêntica: cache, sem rede
    const again = await svc.nearbyPlaces({ what: 'pizzaria', limit: 2 }, ctx())
    expect(net.calls).toHaveLength(1)
    expect(again.content).toContain('resultado guardado há poucos minutos')
  })

  it('iOS: links maps://', async () => {
    const device = new FakeDevice()
    device.platform = 'ios'
    const r = await service({ device }).svc.nearbyPlaces({ what: 'restaurante' }, ctx())
    expect(r.content).toContain('(maps://?q=Cantina%20do%20Teste&ll=-23.5609,-46.6551)')
  })

  it('centro por nome (Nominatim; vazio → Photon) e por coordenadas — sem ler a posição', async () => {
    const a = service()
    const r = await a.svc.nearbyPlaces({ what: 'café', near: 'Av. Paulista' }, ctx())
    expect(r.content).toContain('Avenida Paulista, Bela Vista, São Paulo (Nominatim)')
    expect(a.net.calls[0].url).toContain('/search?format=jsonv2&limit=1')
    expect(a.device.positions).toEqual([])

    const b = service({ routes: { nominatimSearchEmpty: true } })
    const r2 = await b.svc.nearbyPlaces({ what: 'café', near: 'Praça da Sé' }, ctx())
    expect(r2.content).toContain('Praça da Sé, São Paulo, Brasil (Photon)')
    expect(b.net.calls.map((c) => new URL(c.url).host)).toEqual([
      'nominatim.openstreetmap.org',
      'photon.komoot.io',
      'overpass-api.de'
    ])

    const c = service({ settings: { approval: 'never' } })
    const r3 = await c.svc.nearbyPlaces(
      { what: 'café', latitude: -23.55, longitude: -46.63 },
      ctx()
    )
    expect(r3.status).toBe('ok')
    expect(decodeURIComponent(c.net.calls[0].body)).toContain('(around:1000,-23.55,-46.63)')
    expect(c.device.positions).toEqual([])
    await expect(c.svc.nearbyPlaces({ what: 'café' }, ctx())).rejects.toThrow(MSG.off)
    const bad = await c.svc.nearbyPlaces({ what: 'café', latitude: 120 }, ctx())
    expect(bad.status).toBe('error')
  })

  it('Overpass: sobrecarga na principal → reserva; consulta recusada (400) não tenta outra', async () => {
    const a = service({ routes: { overpassFirst: 504 } })
    const r = await a.svc.nearbyPlaces({ what: 'restaurante' }, ctx())
    expect(r.status).toBe('ok')
    expect(a.net.calls.map((c) => new URL(c.url).host)).toEqual([
      'overpass-api.de',
      'overpass.private.coffee'
    ])
    const b = service({ routes: { overpassFirst: 400 } })
    await expect(b.svc.nearbyPlaces({ what: 'restaurante' }, ctx())).rejects.toThrow(
      /consulta recusada pelo Overpass \(HTTP 400: falso\)/
    )
    expect(b.net.calls).toHaveLength(1)
  })

  it('nada encontrado sugere raio maior', async () => {
    const net = fakeFetch([
      (c) => (c.url.includes('interpreter') ? { json: { elements: [] } } : null)
    ])
    const svc = new LocationService({
      device: new FakeDevice(),
      settings: () => DEFAULT_LOCATION_SETTINGS,
      overpass: new OverpassClient({ fetch: net.fetch, userAgent: UA, minIntervalMs: 0 }),
      geocoder: new OsmGeocoder({ fetch: net.fetch, userAgent: UA })
    })
    const r = await svc.nearbyPlaces({ what: 'museu', radius_m: 300 }, ctx())
    expect(r.content).toContain('Nenhum lugar encontrado para “museu” — museu em até 300 m')
    expect(r.content).toContain('Tente um raio maior (máx. 5,0 km)')
  })
})

describe('fila com intervalo (política do Nominatim: ≤ 1 pedido/s)', () => {
  it('pedidos em sequência esperam o intervalo', async () => {
    let t = 0
    const waits: number[] = []
    const gate = new Gate(
      1100,
      () => t,
      async (ms) => {
        waits.push(ms)
        t += ms
      }
    )
    const order: number[] = []
    await Promise.all([1, 2, 3].map((i) => gate.run(async () => void order.push(i))))
    expect(order).toEqual([1, 2, 3])
    expect(waits).toEqual([1100, 1100])
  })
})

describe('aprovação e oferta', () => {
  it('pergunta só quando a posição do aparelho é usada; textos do card', () => {
    const { svc } = service()
    expect(svc.needsApproval('get_location', {})).toBe(true)
    expect(svc.needsApproval('nearby_places', { what: 'café' })).toBe(true)
    expect(svc.needsApproval('nearby_places', { what: 'café', near: 'Sé' })).toBe(false)
    expect(usesDeviceLocation('nearby_places', { what: 'x', latitude: 1, longitude: 2 })).toBe(
      false
    )
    expect(
      service({ settings: { approval: 'always' } }).svc.needsApproval('get_location', {})
    ).toBe(false)
    const t = locationApprovalText(
      'nearby_places',
      { what: 'pizzaria' },
      { precision: 'approximate' }
    )
    expect(t.detail).toBe(
      'Sua localização aproximada (~1 km) vai para o modelo e para o OpenStreetMap (busca: “pizzaria”).'
    )
    expect(locationApprovalText('get_location', {}, { precision: 'exact' }).detail).toMatch(
      /^Sua localização exata vai para o modelo/
    )
    // definição: avisa que o OSM não tem avaliações; com "Nunca", exige near/coordenadas
    const def = svc.definition('nearby_places')!
    expect(def.function.description).toContain('NÃO tem avaliações')
    expect(def.function.description).toContain('web_search')
    const off = service({ settings: { approval: 'never' } }).svc.definition('nearby_places')!
    expect(off.function.description).toContain('DESATIVADA')
  })

  afterEach(() => setLocationSource(null))

  it('request: só com o chat ligando a tool E o aparelho oferecendo; definição local', () => {
    const { svc } = service()
    const chat = (cfg: Partial<ChatConfig>): Chat => ({
      id: 'c',
      title: '',
      config: { ...DEFAULT_CHAT_CONFIG(''), providerId: 'p', model: 'm', ...cfg },
      mainSessionId: 's',
      createdAt: 0,
      updatedAt: 0
    })
    const withLoc = chat({ enabledTools: ['web_search', ...LOCATION_TOOLS] })
    expect(availableTools(withLoc, { depth: 0 })).toEqual(['web_search'])
    setLocationSource(svc)
    expect(availableTools(withLoc, { depth: 0 })).toEqual([
      'web_search',
      'get_location',
      'nearby_places'
    ])
    expect(availableTools(chat({ enabledTools: ['web_search'] }), { depth: 0 })).toEqual([
      'web_search'
    ])
    const req = buildRequest(withLoc, { depth: 0, model: 'm' }, [], {
      id: 'p',
      name: 'P',
      baseUrl: 'https://api.example/v1',
      apiKey: 'k',
      headers: {},
      createdAt: 0
    })
    const names = (req.body.tools as { function: { name: string } }[]).map((t) => t.function.name)
    // (compactadas por padrão, 1.11.0: a tool_search automática vai no fim)
    expect(names).toEqual(['web_search', 'get_location', 'nearby_places', 'tool_search'])
    // os nomes são os do protocolo (@shared/deviceTools, §4.3.6): as só do celular e o que ele roda
    expect(LOCATION_TOOLS).toEqual(PHONE_TOOLS)
    expect([...MOBILE_TOOLS].sort()).toEqual(
      APP_TOOL_NAMES.filter((t) => runsOn(t, 'phone')).sort()
    )
    // as do computador ficam na lista do chat mas nunca vão daqui (nem com o padrão do app)
    const all = chat({ enabledTools: [...APP_TOOL_NAMES] })
    const sent = availableTools(all, { depth: 0 })
    expect(sent).toEqual(expect.arrayContaining(['web_search', 'get_location', 'nearby_places']))
    for (const t of COMPUTER_TOOL_NAMES) expect(sent).not.toContain(t)
    // Novo chat: o padrão do app (persona sem tools) já as traz ligadas — e as do computador também
    const base = resolveNewChat({}, [], null)
    expect(base.enabledTools).toEqual([...APP_TOOL_NAMES])
    const persona = resolveNewChat({}, [], {
      id: 'x',
      name: 'Só web',
      description: '',
      icon: '',
      config: { enabledTools: ['web_search'] as ToolName[] },
      createdAt: 0,
      updatedAt: 0
    })
    expect(persona.enabledTools).toEqual(['web_search'])
  })
})

describe('runner: tools de localização num chat deste celular', () => {
  let h: Harness
  let current: ReturnType<typeof service>
  const mk = async (settings: Partial<LocationSettings> = {}) => {
    current = service({ settings })
    // a preferência pode mudar no meio (card "Sempre permitir")
    h = await makeHarness({ location: current.svc })
  }
  afterEach(async () => {
    await h?.close()
    setLocationSource(null)
  })
  const newChat = (tools: string[]) => {
    const { chat, session } = h.stack.repo.createChat({
      config: {
        ...DEFAULT_CHAT_CONFIG(''),
        providerId: h.providerId,
        model: 'fake/agent',
        enabledTools: tools as ToolName[]
      },
      title: ''
    })
    return { chatId: chat.id, sid: session.id }
  }
  const idle = (sid: string) => until(() => !h.stack.runner.isRunning(sid), 10_000, 'turno')
  const tool = (sid: string) =>
    h.stack.repo
      .path(sid)
      .filter((m) => m.message.role === 'tool')
      .pop()!

  it('Perguntar: card com o nome da tool → Permitir → resultado; o modelo recebe as definições', async () => {
    await mk()
    const { sid } = newChat(['get_location', 'nearby_places'])
    await h.stack.runner.send(sid, '/where')
    await until(() => h.stack.runner.approvals.list().length === 1, 8000, 'aprovação')
    const req = h.stack.runner.approvals.list()[0]
    expect(req.toolName).toBe('get_location')
    expect(h.stack.repo.session(sid)?.status).toBe('awaiting_approval')
    expect(current.device.positions).toEqual([]) // nada lido antes da aprovação
    h.stack.runner.approve(req.id, 'allow')
    await idle(sid)
    const t = tool(sid)
    expect(t.meta.toolStatus).toBe('ok')
    expect(String(t.message.content)).toContain('latitude: -23.56, longitude: -46.65')
    expect(t.meta.approval).toBeUndefined() // item fora dos itens sincronizados do protocolo
    const sent = h.llm.requests.find((r) => Array.isArray(r.body.tools))
    const names = (sent?.body.tools as { function: { name: string } }[]).map((x) => x.function.name)
    // compactas por padrão (1.11.0): a tool_search no fim devolve as definições do celular
    expect(names).toEqual(['get_location', 'nearby_places', 'tool_search'])
    const last = h.stack.repo.path(sid).pop()!
    expect(String(last.message.content)).toContain('Resultado recebido (get_location)')
  })

  it('Negar → texto de negado, nada lido; com near não pergunta', async () => {
    await mk()
    const { sid } = newChat(['get_location', 'nearby_places'])
    await h.stack.runner.send(sid, '/near pizzaria')
    await until(() => h.stack.runner.approvals.list().length === 1, 8000, 'aprovação')
    h.stack.runner.approve(h.stack.runner.approvals.list()[0].id, 'deny')
    await idle(sid)
    expect(tool(sid).meta.toolStatus).toBe('denied')
    expect(tool(sid).message.content).toBe(DENIED_TEXT)
    expect(current.device.positions).toEqual([])
    expect(current.net.calls).toEqual([])

    await h.stack.runner.send(sid, '/near-at Avenida Paulista | café')
    await idle(sid)
    expect(h.stack.runner.approvals.list()).toEqual([])
    expect(tool(sid).meta.toolStatus).toBe('ok')
    expect(String(tool(sid).message.content)).toContain('Cantina do Teste')
  })

  it('Sempre permitir: roda direto; Nunca: get_location não é oferecida nem roda', async () => {
    await mk({ approval: 'always' })
    const { sid } = newChat(['get_location', 'nearby_places'])
    await h.stack.runner.send(sid, '/near restaurante')
    await idle(sid)
    expect(h.stack.runner.approvals.list()).toEqual([])
    expect(tool(sid).meta.toolStatus).toBe('ok')
    expect(current.device.positions).toEqual(['approximate'])
    const reply = String(h.stack.repo.path(sid).pop()!.message.content)
    expect(reply).toContain('[abrir no app de mapas](geo:')
    await h.close()

    await mk({ approval: 'never' })
    const b = newChat(['get_location', 'nearby_places'])
    await h.stack.runner.send(b.sid, '/where')
    await idle(b.sid)
    expect(tool(b.sid).meta.toolStatus).toBe('error')
    expect(String(tool(b.sid).message.content)).toContain('não está disponível nesta sessão')
    const sent = h.llm.requests.filter((r) => Array.isArray(r.body.tools)).pop()
    const names = (sent?.body.tools as { function: { name: string } }[]).map((x) => x.function.name)
    expect(names).toEqual(['nearby_places', 'tool_search'])
    expect(current.device.positions).toEqual([])
  })

  it('chat sem as tools ligadas: não oferece nem executa', async () => {
    await mk({ approval: 'always' })
    const { sid } = newChat(['web_search'])
    await h.stack.runner.send(sid, '/where')
    await idle(sid)
    expect(String(tool(sid).message.content)).toContain('não está disponível nesta sessão')
    expect(current.device.positions).toEqual([])
  })

  it('permissão negada no sistema → erro legível para o modelo (o turno segue)', async () => {
    await mk({ approval: 'always' })
    current.device.perm = { status: 'denied', accuracy: 'none', canAskAgain: false }
    const { sid } = newChat(['get_location'])
    await h.stack.runner.send(sid, '/where')
    await idle(sid)
    expect(tool(sid).meta.toolStatus).toBe('error')
    expect(String(tool(sid).message.content)).toBe(MSG.denied)
    expect(h.stack.repo.session(sid)?.status).toBe('idle')
  })
})
