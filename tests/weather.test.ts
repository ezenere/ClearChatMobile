// Tool `weather` no celular (protocolo 1.16.0, @shared/weather vendorado): portátil e no padrão do app;
// sem lugar usa a posição do celular COM a aprovação de localização do aparelho (mesmo card, texto
// próprio, precisão aproximada arredondada); com lugar ou coordenadas roda sem perguntar; "Nunca" →
// erro legível; o OpenStreetMap é a reserva do nome. Sem rede: o Open-Meteo e o OSM são falsos (o
// `fetch` global só desvia as URLs deles; o modelo falso continua no servidor local).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CHAT_CONFIG } from '../src/vendor/shared/defaults'
import type { ToolName } from '../src/vendor/shared/types'
import { MOBILE_TOOLS, setLocationSource } from '../src/agent/request'
import { DENIED_TEXT } from '../src/agent/runner'
import { toolIcon, toolSummary } from '../src/chat/toolSummary'
import { OverpassClient } from '../src/location/overpass'
import { OsmGeocoder } from '../src/location/nominatim'
import {
  LocationService,
  locationApprovalText,
  MSG,
  usesDeviceLocation,
  usesLocationApproval
} from '../src/location/service'
import { DEFAULT_LOCATION_SETTINGS, type LocationSettings } from '../src/location/settings'
import { makeHarness, until, type Harness } from './hostHarness'
import { FakeDevice, fakeFetch, osmRoutes } from './fakes/osm'

const UA = 'ClearChat/0.0.0-test (+https://clear.ezenere.com)'
const ctx = () => ({ signal: new AbortController().signal })

function service(settings: Partial<LocationSettings> = {}) {
  const device = new FakeDevice()
  const s: LocationSettings = { ...DEFAULT_LOCATION_SETTINGS, ...settings }
  const net = fakeFetch(osmRoutes({ nominatimSearchEmpty: true }))
  const svc = new LocationService({
    device,
    settings: () => s,
    overpass: new OverpassClient({ fetch: net.fetch, userAgent: UA, minIntervalMs: 0 }),
    geocoder: new OsmGeocoder({ fetch: net.fetch, userAgent: UA, sleep: async () => undefined }),
    now: () => 30_000
  })
  return { svc, device, net, s }
}

// ---------------- Open-Meteo falso ----------------

const FORECAST = {
  latitude: -23.56,
  longitude: -46.65,
  utc_offset_seconds: -10800,
  timezone: 'America/Sao_Paulo',
  elevation: 790,
  current: { time: '2026-11-16T14:00', temperature_2m: 26.4, weather_code: 2, is_day: 1 },
  daily: {
    time: ['2026-11-16'],
    weather_code: [80],
    temperature_2m_max: [28.1],
    temperature_2m_min: [18.2],
    precipitation_sum: [4.5],
    precipitation_probability_max: [80]
  }
}
const GEO = {
  results: [
    {
      name: 'Curitiba',
      latitude: -25.42778,
      longitude: -49.27306,
      country: 'Brasil',
      admin1: 'Paraná',
      population: 1948626
    }
  ]
}

let meteoCalls: string[] = []
let googleCalls: Record<string, unknown>[] = []
const realFetch = globalThis.fetch
beforeEach(() => {
  meteoCalls = []
  googleCalls = []
  vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.startsWith('https://mapstools.googleapis.com/')) {
      googleCalls.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      const body = JSON.parse(String(init?.body ?? '{}')) as { date?: unknown }
      return new Response(
        JSON.stringify(
          body.date
            ? {
                weather: {
                  maxTemperature: { degrees: 27 },
                  minTemperature: { degrees: 18 },
                  weatherCondition: { description: { text: 'Ensolarado' } }
                },
                timeZone: 'America/Sao_Paulo'
              }
            : {
                weather: {
                  temperature: { degrees: 25 },
                  weatherCondition: { description: { text: 'Ensolarado' } },
                  attribution: { title: 'Weather for São Paulo - Google', url: 'https://g.co/x' },
                  dateTime: '2026-11-16T17:00:00Z'
                },
                timeZone: 'America/Sao_Paulo'
              }
        ),
        { status: 200 }
      )
    }
    if (!url.includes('open-meteo.com')) return realFetch(input, init)
    meteoCalls.push(url)
    const body = url.includes('geocoding-api') ? (url.includes('Curitiba') ? GEO : {}) : FORECAST
    return new Response(JSON.stringify(body), { status: 200 })
  }) as typeof fetch)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('weather no celular: contrato e aprovação', () => {
  it('portátil; aprovação de localização só sem lugar nem coordenadas; texto do card', () => {
    expect(MOBILE_TOOLS).toContain('weather')
    expect(DEFAULT_CHAT_CONFIG('').enabledTools).toContain('weather')
    expect(usesDeviceLocation('weather', {})).toBe(true)
    expect(usesDeviceLocation('weather', { place: 'Curitiba' })).toBe(false)
    expect(usesDeviceLocation('weather', { latitude: 1, longitude: 2 })).toBe(false)
    expect(usesLocationApproval('weather', {})).toBe(true)
    expect(usesLocationApproval('weather', { place: 'Curitiba' })).toBe(false)
    expect(usesLocationApproval('nearby_places', { near: 'x', what: 'café' })).toBe(true)
    expect(usesLocationApproval('web_search', {})).toBe(false)
    const ask = service().svc
    expect(ask.needsApproval('weather', {})).toBe(true)
    expect(ask.needsApproval('weather', { place: 'Lisboa' })).toBe(false)
    expect(service({ approval: 'always' }).svc.needsApproval('weather', {})).toBe(false)
    expect(locationApprovalText('weather', {}, { precision: 'approximate' })).toEqual({
      title: 'Permitir que o agente use sua localização para ver a previsão do tempo?',
      detail:
        'Sua localização aproximada (~1 km) vai para o modelo e para o Open-Meteo (previsão do tempo).'
    })
    expect(toolSummary('weather', { place: 'Curitiba', hours: 6 })).toBe('Curitiba · 3 dias · 6 h')
    expect(toolSummary('weather', {})).toBe('aqui · 3 dias')
    expect(toolIcon('weather')).toBe('partly-sunny-outline')
  })

  it('posição para a tool: aproximada arredondada (~1 km) ou exata com a precisão; reserva do OSM', async () => {
    const a = service()
    const p = await a.svc.devicePoint(ctx())
    expect(p).toEqual({
      lat: -23.56,
      lon: -46.65,
      label: 'sua localização atual, aproximada (~1 km)',
      notes: []
    })
    expect(a.device.positions).toEqual(['approximate'])
    const e = service({ precision: 'exact' })
    const q = await e.svc.devicePoint(ctx())
    expect(q.lat).toBe(-23.5614)
    expect(q.label).toBe('sua localização atual (± 10 m)') // fmtDistance arredonda a 10 m
    await expect(service({ approval: 'never' }).svc.devicePoint(ctx())).rejects.toThrow(MSG.off)
    // Nominatim vazio → Photon
    const hit = await a.svc.searchPlace('Praça da Sé', new AbortController().signal)
    expect(hit).toEqual({
      lat: -23.5505,
      lon: -46.6333,
      label: expect.stringContaining('Praça da Sé'),
      source: 'OpenStreetMap (Photon), © colaboradores do OpenStreetMap (ODbL)'
    })
  })
})

describe('runner: weather num chat deste celular', () => {
  let h: Harness
  let current: ReturnType<typeof service>
  const mk = async (settings: Partial<LocationSettings> = {}) => {
    current = service(settings)
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

  it('sem lugar: card de localização → Permitir → posição aproximada vai ao Open-Meteo', async () => {
    await mk()
    const { sid } = newChat(['weather'])
    await h.stack.runner.send(sid, '/weather {}')
    await until(() => h.stack.runner.approvals.list().length === 1, 8000, 'aprovação')
    const req = h.stack.runner.approvals.list()[0]
    expect(req.toolName).toBe('weather')
    expect(current.device.positions).toEqual([])
    expect(meteoCalls).toEqual([])
    h.stack.runner.approve(req.id, 'allow')
    await idle(sid)
    const t = tool(sid)
    expect(t.meta.toolStatus).toBe('ok')
    const out = String(t.message.content)
    expect(out).toMatch(/^Tempo em sua localização atual, aproximada \(~1 km\) · -23\.56, -46\.65/)
    expect(out).toContain('Agora (14:00): 26,4 °C · parcialmente nublado')
    expect(out).toContain('- hoje, seg 16/11: 18,2 a 28,1 °C · pancadas de chuva fracas')
    expect(out).toContain('Fonte: Open-Meteo.com (CC BY 4.0)')
    expect(meteoCalls).toHaveLength(1)
    const u = new URL(meteoCalls[0])
    expect(u.searchParams.get('latitude')).toBe('-23.56')
    expect(u.searchParams.get('longitude')).toBe('-46.65')
    const sent = h.llm.requests.find((r) => Array.isArray(r.body.tools))
    const names = (sent?.body.tools as { function: { name: string } }[]).map((x) => x.function.name)
    expect(names).toEqual(['weather', 'tool_search'])
  })

  it('Negar → negado, nada lido; com lugar não pergunta (e não lê a posição)', async () => {
    await mk()
    const { sid } = newChat(['weather'])
    await h.stack.runner.send(sid, '/weather {}')
    await until(() => h.stack.runner.approvals.list().length === 1, 8000, 'aprovação')
    h.stack.runner.approve(h.stack.runner.approvals.list()[0].id, 'deny')
    await idle(sid)
    expect(tool(sid).meta.toolStatus).toBe('denied')
    expect(tool(sid).message.content).toBe(DENIED_TEXT)
    expect(meteoCalls).toEqual([])

    await h.stack.runner.send(sid, '/weather {"place": "Curitiba", "days": 1}')
    await idle(sid)
    expect(h.stack.runner.approvals.list()).toEqual([])
    expect(tool(sid).meta.toolStatus).toBe('ok')
    expect(String(tool(sid).message.content)).toMatch(/^Tempo em Curitiba \(Paraná, Brasil\)/)
    expect(current.device.positions).toEqual([])
    expect(meteoCalls[0]).toContain('geocoding-api.open-meteo.com')
  })

  it('Google escolhido em Tempo e mapas (settings sincronizados): a tool usa o Google com a chave', async () => {
    await mk()
    // o PC escolheu o Google (settings sincronizados) e o celular recebe pelo sync
    await h.desk.put('setting', 'googleMapsApiKey', null, { sv: 1, value: 'AIza-chave-de-teste' })
    await h.desk.put('setting', 'weatherProvider', null, { sv: 1, value: 'google' })
    await h.engine.sync()
    const { sid } = newChat(['weather'])
    await h.stack.runner.send(sid, '/weather {"place": "São Paulo", "days": 1}')
    await idle(sid)
    expect(tool(sid).meta.toolStatus).toBe('ok')
    const out = String(tool(sid).message.content)
    expect(out).toContain('Agora (14:00): 25 °C · Ensolarado')
    expect(out).toContain('- hoje, seg 16/11: 18 a 27 °C · Ensolarado')
    expect(out).toContain('cite logo depois: [Weather for São Paulo - Google](https://g.co/x)')
    expect(googleCalls).toHaveLength(2)
    expect(googleCalls[0]).toMatchObject({
      location: { address: 'São Paulo' },
      languageCode: 'pt-BR'
    })
    expect(meteoCalls).toEqual([])
  })

  it('"Nunca": sem lugar vira erro legível (o turno segue); lugar desconhecido → reserva do OSM', async () => {
    await mk({ approval: 'never' })
    const { sid } = newChat(['weather'])
    await h.stack.runner.send(sid, '/weather {}')
    await idle(sid)
    expect(tool(sid).meta.toolStatus).toBe('error')
    expect(String(tool(sid).message.content)).toBe(MSG.off)
    expect(h.stack.repo.session(sid)?.status).toBe('idle')

    await h.stack.runner.send(sid, '/weather {"place": "Praça da Sé"}')
    await idle(sid)
    expect(tool(sid).meta.toolStatus).toBe('ok')
    const out = String(tool(sid).message.content)
    expect(out).toMatch(/^Tempo em Praça da Sé.* · -23\.5505, -46\.6333/)
    expect(out).toContain('lugar: OpenStreetMap (Photon)')
  })
})
