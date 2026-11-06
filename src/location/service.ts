// Tools de localização dos chats executados NESTE celular (puro: o aparelho — permissão, posição,
// geocodificador do sistema — e a rede entram por interfaces):
//   get_location  — posição atual (só com o app aberto), precisão e o lugar "humano" pelo
//                   geocodificador do sistema (Android Geocoder / Apple CLGeocoder), com o Nominatim
//                   do OpenStreetMap de reserva;
//   nearby_places — pontos de interesse em volta de um centro (posição atual, coordenadas ou um lugar
//                   pelo nome) pelo Overpass, com distância calculada aqui e links para o app de mapas.
// Modo "Aproximada" (padrão): a posição vai arredondada a ~1 km para o modelo, o OSM e o geocodificador.
// A aprovação (perguntar/sempre/nunca) é do aparelho (./settings.ts) e o runner a aplica.
import type { ToolDefinition } from '@shared/tools'
import type { ToolName } from '@shared/types'
import {
  fail,
  ok,
  optNumber,
  optString,
  requireString,
  ToolError,
  type ToolContext,
  type ToolResult
} from '@/agent/tools/util'
import {
  announcedAccuracy,
  APPROX_ACCURACY_M,
  atPrecision,
  fmtCoord,
  fmtDistance,
  validLatLon,
  type LatLon,
  type Precision
} from './geo'
import { mapLinks, type MapPlatform } from './links'
import { hasPlace, placeNameText, type OsmGeocoder, type PlaceName } from './nominatim'
import {
  buildOverpassQuery,
  clampLimit,
  clampRadius,
  FETCH_CAP,
  MAX_LIMIT,
  MAX_RADIUS_M,
  DEFAULT_LIMIT,
  DEFAULT_RADIUS_M,
  parseOverpass,
  type OverpassClient,
  type Place
} from './overpass'
import type { LocationSettings } from './settings'
import { resolveQuery } from './tags'

// ---------------- nomes e definições ----------------

export const LOCATION_TOOL_NAMES = ['get_location', 'nearby_places'] as const
export type LocationToolName = (typeof LOCATION_TOOL_NAMES)[number]
/** Os nomes no tipo das tools do protocolo (o tipo do desktop não os conhece — ver README). */
export const LOCATION_TOOLS: readonly ToolName[] = [
  ...LOCATION_TOOL_NAMES
] as string[] as ToolName[]

export const isLocationTool = (n: string): n is LocationToolName =>
  (LOCATION_TOOL_NAMES as readonly string[]).includes(n)

export const LOCATION_TOOL_LABELS: Record<LocationToolName, string> = {
  get_location: 'Localização',
  nearby_places: 'Lugares próximos'
}

export const LOCATION_TOOL_HELP: Record<LocationToolName, string> = {
  get_location: 'Sua posição atual (com a sua aprovação; Configurações → Localização).',
  nearby_places: 'Restaurantes, farmácias, mercados… por perto (OpenStreetMap).'
}

const def = (
  name: LocationToolName,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = []
): ToolDefinition =>
  ({
    type: 'function',
    function: {
      name,
      description,
      parameters: { type: 'object', properties, required, additionalProperties: false }
    }
  }) as unknown as ToolDefinition

/** Definições (o texto muda com a precisão e com a localização desligada). */
export function locationToolDefinition(
  name: LocationToolName,
  s: LocationSettings
): ToolDefinition {
  const approx = s.precision === 'approximate'
  const precisionText = approx
    ? 'O usuário escolheu a localização APROXIMADA: as coordenadas vêm arredondadas a ~1 km (não são o endereço exato dele).'
    : 'O usuário escolheu a localização exata.'
  if (name === 'get_location')
    return def(
      'get_location',
      `Obtém a localização atual do usuário pelo celular (GPS/rede; só com o app aberto). Retorna latitude/longitude, a precisão em metros e o lugar (bairro, cidade, estado, país) pelo geocodificador do sistema. ${precisionText} O usuário pode ter de aprovar cada uso. Chame só quando a localização ajudar no pedido (ex.: "perto de mim", "onde estou", clima ou fuso local); para procurar lugares em volta, use nearby_places direto.`,
      {}
    )
  const off = s.approval === 'never'
  return def(
    'nearby_places',
    `Busca lugares por perto no OpenStreetMap (Overpass): restaurantes, cafés, padarias, bares, farmácias, mercados, postos, hospitais, clínicas, bancos, caixas eletrônicos, hotéis, parques, museus, academias, estações… ${
      off
        ? 'A localização do aparelho está DESATIVADA pelo usuário: informe sempre `near` (nome do lugar/endereço) ou `latitude` + `longitude`.'
        : 'Centro: a localização atual do usuário (padrão, pode pedir aprovação), ou `near` (nome do lugar/endereço, geocodificado no OpenStreetMap), ou `latitude` + `longitude`.'
    } ${approx && !off ? 'Com a localização aproximada do usuário (~1 km), as distâncias também são aproximadas. ' : ''}Retorna por lugar: nome, categoria, culinária, distância, endereço, horário de funcionamento (opening_hours do OSM), telefone, site e links para abrir no app de mapas — repasse esses links ao usuário em Markdown ([nome](link)). O OpenStreetMap NÃO tem avaliações, notas, preços nem fotos: se o usuário pedir os melhores, avaliações ou opiniões, use web_search (se disponível) com os nomes encontrados. Dados colaborativos: podem estar incompletos ou desatualizados (confirme horários importantes).`,
    {
      what: {
        type: 'string',
        description:
          'O que procurar, em texto livre (português ou inglês): "restaurante", "pizzaria", "café", "farmácia", "mercado", "posto", "hospital", "restaurante japonês", "caixa eletrônico"… — ou o nome de um lugar ("Starbucks") — ou uma tag OSM ("amenity=cafe", "shop=bakery").'
      },
      cuisine: {
        type: 'string',
        description: 'Culinária, opcional (ex.: "japonesa", "pizza", "vegetariana", "árabe").'
      },
      radius_m: {
        type: 'number',
        description: `Raio em metros (padrão ${DEFAULT_RADIUS_M}, máximo ${MAX_RADIUS_M}).`
      },
      limit: {
        type: 'number',
        description: `Máximo de lugares, os mais próximos primeiro (padrão ${DEFAULT_LIMIT}, máximo ${MAX_LIMIT}).`
      },
      near: {
        type: 'string',
        description:
          'Centro da busca por nome/endereço (ex.: "Avenida Paulista, São Paulo"). Omita para usar a localização atual.'
      },
      latitude: { type: 'number', description: 'Centro da busca (com longitude).' },
      longitude: { type: 'number', description: 'Centro da busca (com latitude).' }
    },
    ['what']
  )
}

/** nearby_places usa a posição do aparelho (sem `near` nem coordenadas)? */
export function usesDeviceLocation(name: string, args: Record<string, unknown>): boolean {
  if (name === 'get_location') return true
  if (name !== 'nearby_places') return false
  const near = typeof args.near === 'string' && args.near.trim() !== ''
  return !near && args.latitude == null && args.longitude == null
}

/** Texto do card de aprovação (pt-BR): o que vai para quem. */
export function locationApprovalText(
  name: string,
  args: Record<string, unknown>,
  s: Pick<LocationSettings, 'precision'>,
  who = 'o agente',
  /** Dono do geocodificador do sistema ("Google" no Android, "Apple" no iOS). */
  geocoder = 'Google/Apple'
): { title: string; detail: string } {
  const which =
    s.precision === 'exact' ? 'Sua localização exata' : 'Sua localização aproximada (~1 km)'
  if (name === 'nearby_places') {
    const what =
      typeof args.what === 'string' && args.what.trim() ? ` (busca: “${args.what.trim()}”)` : ''
    return {
      title: `Permitir que ${who} use sua localização para buscar lugares por perto?`,
      detail: `${which} vai para o modelo e para o OpenStreetMap${what}.`
    }
  }
  return {
    title: `Permitir que ${who} veja sua localização?`,
    detail: `${which} vai para o modelo e, para achar o nome do lugar, para o geocodificador do sistema (${geocoder}) ou o OpenStreetMap.`
  }
}

// ---------------- aparelho ----------------

export interface DevicePermission {
  status: 'granted' | 'denied' | 'undetermined'
  /** Precisa (fina/"Precise Location") ou aproximada. */
  accuracy: 'full' | 'reduced' | 'none'
  canAskAgain: boolean
}

export interface DeviceFix extends LatLon {
  accuracyM: number | null
  timestamp: number
  /** O sistema marcou a posição como simulada (emulador/app de localização falsa). */
  mocked: boolean
}

export interface LocationDevice {
  platform: MapPlatform
  /** "geocodificador do Android" / "geocodificador da Apple". */
  geocoderName: string
  permission(): Promise<DevicePermission>
  /** Pede ao sistema (aproximada = só coarse no Android; exata = fine / precisão total no iOS). */
  request(precision: Precision): Promise<DevicePermission>
  servicesEnabled(): Promise<boolean>
  position(precision: Precision): Promise<DeviceFix | null>
  /** Geocodificador do sistema (vazio/null = nada). */
  reverseGeocode(p: LatLon): Promise<PlaceName | null>
}

export interface LocationServiceDeps {
  device: LocationDevice
  settings: () => LocationSettings
  overpass: OverpassClient
  geocoder: OsmGeocoder
  now?: () => number
  /** Teto da leitura da posição (padrão 25 s) e do geocodificador do sistema (padrão 8 s). */
  positionTimeoutMs?: number
  geocodeTimeoutMs?: number
}

export const MSG = {
  denied:
    'Erro: a permissão de localização do ClearChat está negada neste aparelho. O usuário pode liberar em Configurações → Localização (botão "Abrir configurações do sistema").',
  notGranted: 'Erro: o usuário não concedeu a permissão de localização.',
  servicesOff:
    'Erro: a localização do aparelho está desligada (GPS/serviços de localização). Peça ao usuário para ligá-la nas configurações rápidas do sistema.',
  noFix:
    'Erro: não foi possível obter a posição agora (sem sinal de GPS/rede). Tente de novo em instantes ou peça o bairro/endereço ao usuário.',
  off: 'Erro: o usuário desativou o uso da localização pelo agente (Configurações → Localização → Aprovação: Nunca). Peça o bairro ou endereço, se precisar.'
} as const

const abortError = (): Error => {
  const e = new Error('Aborted')
  e.name = 'AbortError'
  return e
}

/** Promessa com teto de tempo e cancelamento (o lado nativo não aceita AbortSignal). */
function bounded<T>(
  p: Promise<T>,
  ms: number,
  signal: AbortSignal,
  onTimeout: () => Error
): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      cleanup()
      reject(onTimeout())
    }, ms)
    const onAbort = (): void => {
      cleanup()
      reject(abortError())
    }
    const cleanup = (): void => {
      clearTimeout(t)
      signal.removeEventListener('abort', onAbort)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(
      (v) => {
        cleanup()
        resolve(v)
      },
      (e: unknown) => {
        cleanup()
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    )
  })
}

interface CurrentPosition {
  /** Já na precisão usada (arredondada no modo aproximado). */
  point: LatLon
  precision: Precision
  accuracyM: number | null
  ageS: number
  mocked: boolean
  notes: string[]
}

const OSM_CREDIT = '© colaboradores do OpenStreetMap (ODbL)'

export class LocationService {
  /** Já pedimos ao sistema a precisão total nesta execução do app (não insiste a cada uso). */
  private upgradeAsked = false
  private readonly now: () => number

  constructor(private readonly d: LocationServiceDeps) {
    this.now = d.now ?? Date.now
  }

  settings(): LocationSettings {
    return this.d.settings()
  }

  /** Tools oferecidas (o chat ainda precisa tê-las ligadas): "Nunca" tira a get_location. */
  tools(): ToolName[] {
    return this.d.settings().approval === 'never'
      ? LOCATION_TOOLS.filter((n) => (n as string) !== 'get_location')
      : [...LOCATION_TOOLS]
  }

  definition(name: string): ToolDefinition | undefined {
    return isLocationTool(name) ? locationToolDefinition(name, this.d.settings()) : undefined
  }

  /** Pede o card de aprovação? (só quando a posição do aparelho é usada e o modo é "Perguntar") */
  needsApproval(name: string, args: Record<string, unknown>): boolean {
    return this.d.settings().approval === 'ask' && usesDeviceLocation(name, args)
  }

  run(
    name: LocationToolName,
    args: Record<string, unknown>,
    ctx: ToolContext
  ): Promise<ToolResult> {
    return name === 'get_location' ? this.getLocation(args, ctx) : this.nearbyPlaces(args, ctx)
  }

  /** Permissão → precisão → serviços → posição (erros em pt-BR como ToolError). */
  private async current(ctx: ToolContext): Promise<CurrentPosition> {
    const s = this.d.settings()
    if (s.approval === 'never') throw new ToolError(MSG.off)
    const dev = this.d.device
    const notes: string[] = []
    let perm = await dev.permission()
    if (perm.status !== 'granted') {
      if (perm.status === 'denied' && !perm.canAskAgain) throw new ToolError(MSG.denied)
      ctx.onOutput?.('Pedindo a permissão de localização ao sistema…')
      perm = await dev.request(s.precision)
      if (ctx.signal.aborted) throw abortError()
      if (perm.status !== 'granted')
        throw new ToolError(perm.canAskAgain ? MSG.notGranted : MSG.denied)
    }
    let precision = s.precision
    if (precision === 'exact' && perm.accuracy !== 'full') {
      if (!this.upgradeAsked && perm.canAskAgain) {
        this.upgradeAsked = true
        ctx.onOutput?.('Pedindo a localização exata ao sistema…')
        perm = await dev.request('exact').catch(() => perm)
        if (ctx.signal.aborted) throw abortError()
      }
      if (perm.accuracy !== 'full') {
        precision = 'approximate'
        notes.push(
          'O usuário escolheu "Exata", mas o sistema só libera a localização aproximada para o ClearChat: o resultado é aproximado (~1 km). Para a exata, ele pode ativar "Localização precisa" nas configurações do sistema para o app.'
        )
      }
    }
    if (!(await dev.servicesEnabled())) throw new ToolError(MSG.servicesOff)
    ctx.onOutput?.('Lendo a posição…')
    const fix = await bounded(
      dev.position(precision),
      this.d.positionTimeoutMs ?? 25_000,
      ctx.signal,
      () => new ToolError(MSG.noFix)
    ).catch((e: unknown) => {
      if ((e as Error).name === 'AbortError' || e instanceof ToolError) throw e
      throw new ToolError(`${MSG.noFix} (${(e as Error).message})`)
    })
    if (!fix || !validLatLon(fix.lat, fix.lon)) throw new ToolError(MSG.noFix)
    return {
      point: atPrecision(fix, precision),
      precision,
      accuracyM: announcedAccuracy(fix.accuracyM, precision),
      ageS: Math.max(0, Math.round((this.now() - fix.timestamp) / 1000)),
      mocked: fix.mocked,
      notes
    }
  }

  /** Lugar humano: geocodificador do sistema → Nominatim. Nunca derruba a tool. */
  private async placeOf(
    p: LatLon,
    precision: Precision,
    signal: AbortSignal
  ): Promise<{ place: PlaceName | null; source: string; note?: string }> {
    let place: PlaceName | null = null
    try {
      place = await bounded(
        this.d.device.reverseGeocode(p),
        this.d.geocodeTimeoutMs ?? 8_000,
        signal,
        () => new Error('timeout')
      )
    } catch (e) {
      if (signal.aborted) throw abortError()
      void e
    }
    const strip = (x: PlaceName): PlaceName => (precision === 'exact' ? x : { ...x, street: null })
    if (hasPlace(place)) return { place: strip(place), source: this.d.device.geocoderName }
    try {
      const osm = await this.d.geocoder.reverse(p, signal, precision === 'exact' ? 16 : 14)
      if (hasPlace(osm)) return { place: strip(osm), source: 'OpenStreetMap (Nominatim)' }
      return { place: null, source: '', note: 'nenhum geocodificador devolveu o nome do lugar' }
    } catch (e) {
      if (signal.aborted) throw abortError()
      return {
        place: null,
        source: '',
        note: `nome do lugar indisponível (${(e as Error).message})`
      }
    }
  }

  async getLocation(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const cur = await this.current(ctx)
    ctx.onOutput?.('Procurando o nome do lugar…')
    const { place, source, note } = await this.placeOf(cur.point, cur.precision, ctx.signal)
    const approx = cur.precision === 'approximate'
    const links = mapLinks({ ...cur.point, name: 'Você está aqui' }, this.d.device.platform)
    const acc = cur.accuracyM != null ? ` (± ${fmtDistance(cur.accuracyM)})` : ''
    const lines = [
      approx
        ? 'Localização atual do usuário — APROXIMADA (arredondada a ~1 km; não é o endereço exato):'
        : 'Localização atual do usuário (exata):',
      `latitude: ${fmtCoord(cur.point.lat, cur.precision)}, longitude: ${fmtCoord(cur.point.lon, cur.precision)}${acc}`,
      place ? `lugar: ${placeNameText(place)} (${source})` : `lugar: — (${note ?? 'indisponível'})`,
      `mapa: [abrir no app de mapas](${links.app}) · [OpenStreetMap](${links.web})`,
      `leitura: ${cur.ageS <= 30 ? 'agora' : `há ${fmtAge(cur.ageS)}`}${cur.mocked ? ' — o sistema marcou a posição como simulada (emulador ou app de localização falsa)' : ''}`,
      ...cur.notes.map((n) => `obs.: ${n}`)
    ]
    return ok(lines.join('\n'))
  }

  async nearbyPlaces(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const what = requireString(args, 'what').trim()
    if (!what) throw new ToolError('Argumento "what" vazio: diga o que procurar.')
    const cuisine = optString(args, 'cuisine')?.trim()
    const radius = clampRadius(optNumber(args, 'radius_m'))
    const limit = clampLimit(optNumber(args, 'limit'))
    const near = optString(args, 'near')?.trim()
    const lat = optNumber(args, 'latitude')
    const lon = optNumber(args, 'longitude')

    let center: LatLon
    let centerText: string
    const notes: string[] = []
    let approxCenter = false
    if (lat != null || lon != null) {
      if (!validLatLon(lat, lon))
        return fail('Erro: informe latitude (−90 a 90) e longitude (−180 a 180) juntas.')
      center = { lat: lat!, lon: lon! }
      centerText = `${lat}, ${lon}`
    } else if (near) {
      ctx.onOutput?.(`Procurando “${near}” no OpenStreetMap…`)
      const hit = await this.d.geocoder.search(near, null, ctx.signal)
      if (!hit)
        return fail(
          `Erro: não encontrei “${near}” no OpenStreetMap. Tente um endereço mais completo (rua, bairro, cidade) ou coordenadas.`
        )
      center = { lat: hit.lat, lon: hit.lon }
      centerText = `${hit.label} (${hit.source})`
    } else {
      const cur = await this.current(ctx)
      center = cur.point
      approxCenter = cur.precision === 'approximate'
      centerText = approxCenter
        ? `sua localização atual, aproximada (${fmtCoord(center.lat, 'approximate')}, ${fmtCoord(center.lon, 'approximate')}; ± ${fmtDistance(cur.accuracyM ?? APPROX_ACCURACY_M)} — as distâncias também são aproximadas)`
        : `sua localização atual (${fmtCoord(center.lat, 'exact')}, ${fmtCoord(center.lon, 'exact')}${cur.accuracyM != null ? `; ± ${fmtDistance(cur.accuracyM)}` : ''})`
      notes.push(...cur.notes)
    }

    const rq = resolveQuery(what, cuisine)
    const ql = buildOverpassQuery({
      center,
      radiusM: radius,
      filters: rq.filters,
      nameRegex: rq.nameRegex,
      max: FETCH_CAP
    })
    ctx.onOutput?.('Buscando no OpenStreetMap…')
    const { json, fromCache } = await this.d.overpass.run(ql, ctx.signal)
    const all = parseOverpass(json, center).filter((p) => p.distanceM <= radius * 1.05 + 50)
    const top = all.slice(0, limit)
    const what2 = `“${what}”${cuisine ? ` (culinária: ${cuisine})` : ''}`
    const kinds = rq.labels.length ? ` — ${rq.labels.join(', ')}` : ''
    const head = top.length
      ? `${top.length} ${top.length === 1 ? 'lugar' : 'lugares'}${all.length > top.length ? ` (os mais próximos de ${all.length} encontrados)` : ''} para ${what2}${kinds} em até ${fmtDistance(radius)} de ${centerText}.`
      : `Nenhum lugar encontrado para ${what2}${kinds} em até ${fmtDistance(radius)} de ${centerText}.${radius < MAX_RADIUS_M ? ` Tente um raio maior (máx. ${fmtDistance(MAX_RADIUS_M)}) ou outro termo.` : ' Tente outro termo.'}`
    const lines = [
      head,
      `Busca: ${rq.tagsText}${rq.nameRegex ? ' (nenhuma categoria reconhecida: busquei pelo nome)' : ''}.`,
      `Fonte: OpenStreetMap via Overpass, ${OSM_CREDIT}${fromCache ? ' — resultado guardado há poucos minutos' : ''}. Sem avaliações nem preços; horários e telefones podem estar desatualizados.`,
      ...notes.map((n) => `Obs.: ${n}`)
    ]
    top.forEach((p, i) => lines.push('', ...this.placeLines(p, i + 1)))
    if (top.length)
      lines.push(
        '',
        'Ao responder, repasse os links de mapa em Markdown ([nome](link)) — no celular eles abrem o app de mapas.'
      )
    return ok(lines.join('\n'))
  }

  private placeLines(p: Place, n: number): string[] {
    const links = mapLinks(p, this.d.device.platform)
    const kind = [p.category, p.cuisine.length ? p.cuisine.join(', ') : null]
      .filter(Boolean)
      .join(' · ')
    const out = [`${n}. **${p.name ?? '(sem nome)'}** — ${kind} · ${fmtDistance(p.distanceM)}`]
    if (p.address) out.push(`   endereço: ${p.address}`)
    if (p.openingHours) out.push(`   horário (OSM): ${p.openingHours}`)
    if (p.phone) out.push(`   telefone: ${p.phone}`)
    if (p.website) out.push(`   site: ${p.website}`)
    out.push(`   mapa: [abrir no app de mapas](${links.app}) · [OpenStreetMap](${links.web})`)
    return out
  }
}

function fmtAge(s: number): string {
  if (s < 90) return `${s} s`
  if (s < 3600) return `${Math.round(s / 60)} min`
  return `${Math.round(s / 3600)} h`
}
