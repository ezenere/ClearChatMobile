// Texto livre (pt-BR/inglês) → filtros de tags do OpenStreetMap para o Overpass (puro).
// "pizzaria perto" → amenity=restaurant|fast_food + cuisine~pizza; "farmácia" → amenity=pharmacy +
// shop=chemist; "amenity=cafe" (tag OSM direta) também vale. Sem nenhuma categoria reconhecida, busca
// pelo nome (`name~texto`, sem diferenciar maiúsculas) nas chaves de lugares (amenity/shop/tourism/
// leisure). Rótulos pt-BR das tags e culinárias para o resultado.

/** Um "nwr[...]" do Overpass: chave com valores (null = qualquer valor) e filtros extras. */
export interface OsmFilter {
  key: string
  values: string[] | null
  /** Filtros adicionais (regex sem diferenciar maiúsculas), ex.: cuisine~pizza. */
  extra?: { key: string; regex: string }[]
}

export interface ResolvedQuery {
  filters: OsmFilter[]
  /** Categorias reconhecidas (pt-BR), para o cabeçalho do resultado. */
  labels: string[]
  /** Busca por nome (nada reconhecido): regex do Overpass já escapada. */
  nameRegex?: string
  /** Texto das tags, para o modelo saber o que foi buscado. */
  tagsText: string
}

/** Sem acentos, minúsculas, espaços simples. */
export function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}=:_|*;-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

type F = OsmFilter
const f = (key: string, values: string[] | null, extra?: F['extra']): F => ({
  key,
  values,
  ...(extra ? { extra } : {})
})
const amenity = (...v: string[]): F => f('amenity', v)
const shop = (...v: string[]): F => f('shop', v)
const tourism = (...v: string[]): F => f('tourism', v)
const leisure = (...v: string[]): F => f('leisure', v)

/** Onde se come (base das culinárias quando só a culinária foi dita). */
const FOOD = ['restaurant', 'fast_food', 'food_court']

interface Category {
  label: string
  /** Palavras/frases já "dobradas" (sem acento, minúsculas). */
  words: string[]
  filters: F[]
}

/**
 * Categorias. Frases mais longas casam antes (ver `resolveQuery`): "clínica veterinária" não vira
 * também "clínica"; "posto de saúde" não vira "posto" (combustível).
 */
export const CATEGORIES: Category[] = [
  // ---- comer e beber ----
  {
    label: 'restaurante',
    words: ['restaurante', 'restaurantes', 'restaurant', 'restaurants'],
    filters: [amenity('restaurant')]
  },
  {
    label: 'lugar para comer',
    words: ['comida', 'comer', 'almoco', 'almocar', 'jantar', 'janta', 'food'],
    filters: [amenity(...FOOD)]
  },
  {
    label: 'lanchonete',
    words: ['lanchonete', 'lanchonetes', 'lanche', 'lanches', 'fast food', 'fast-food', 'fastfood'],
    filters: [amenity('fast_food')]
  },
  {
    label: 'café',
    words: ['cafe', 'cafes', 'cafeteria', 'cafeterias', 'coffee', 'coffee shop'],
    filters: [amenity('cafe')]
  },
  {
    label: 'padaria',
    words: ['padaria', 'padarias', 'panificadora', 'bakery', 'confeitaria', 'doceria'],
    filters: [shop('bakery', 'pastry', 'confectionery')]
  },
  {
    label: 'bar',
    words: [
      'bar',
      'bares',
      'boteco',
      'botecos',
      'botequim',
      'pub',
      'pubs',
      'cervejaria',
      'chopperia'
    ],
    filters: [amenity('bar', 'pub', 'biergarten')]
  },
  {
    label: 'sorveteria',
    words: ['sorveteria', 'sorveterias', 'sorvete', 'sorvetes', 'gelato', 'ice cream'],
    filters: [amenity('ice_cream'), shop('ice_cream')]
  },
  {
    label: 'balada',
    words: ['balada', 'baladas', 'boate', 'boates', 'casa noturna', 'nightclub'],
    filters: [amenity('nightclub')]
  },
  // ---- compras ----
  {
    label: 'mercado',
    words: [
      'mercado',
      'mercados',
      'supermercado',
      'supermercados',
      'hipermercado',
      'atacadao',
      'atacarejo',
      'supermarket',
      'grocery'
    ],
    filters: [shop('supermarket', 'convenience', 'wholesale', 'greengrocer')]
  },
  {
    label: 'mercearia',
    words: [
      'mercearia',
      'minimercado',
      'conveniencia',
      'loja de conveniencia',
      'emporio',
      'convenience'
    ],
    filters: [shop('convenience')]
  },
  {
    label: 'hortifrúti',
    words: ['hortifruti', 'sacolao', 'quitanda', 'feira', 'feira livre', 'verdurao'],
    filters: [shop('greengrocer'), amenity('marketplace')]
  },
  { label: 'açougue', words: ['acougue', 'acougues', 'butcher'], filters: [shop('butcher')] },
  {
    label: 'farmácia',
    words: ['farmacia', 'farmacias', 'drogaria', 'drogarias', 'remedio', 'remedios', 'pharmacy'],
    filters: [amenity('pharmacy'), shop('chemist')]
  },
  {
    label: 'shopping',
    words: ['shopping', 'shoppings', 'shopping center', 'mall'],
    filters: [shop('mall')]
  },
  { label: 'livraria', words: ['livraria', 'livrarias', 'bookstore'], filters: [shop('books')] },
  {
    label: 'loja de roupas',
    words: ['roupa', 'roupas', 'loja de roupa', 'loja de roupas', 'clothes'],
    filters: [shop('clothes')]
  },
  { label: 'loja de calçados', words: ['sapataria', 'calcados'], filters: [shop('shoes')] },
  {
    label: 'eletrônicos',
    words: ['eletronicos', 'loja de celular', 'assistencia tecnica', 'informatica'],
    filters: [shop('electronics', 'mobile_phone', 'computer')]
  },
  {
    label: 'material de construção',
    words: ['material de construcao', 'ferragens', 'ferragem', 'loja de ferramentas', 'hardware'],
    filters: [shop('hardware', 'doityourself')]
  },
  {
    label: 'floricultura',
    words: ['floricultura', 'flores', 'florist'],
    filters: [shop('florist')]
  },
  { label: 'ótica', words: ['otica', 'oticas', 'optician'], filters: [shop('optician')] },
  {
    label: 'banca de jornal',
    words: ['banca de jornal', 'banca de revista', 'banca'],
    filters: [shop('newsagent', 'kiosk')]
  },
  {
    label: 'pet shop',
    words: ['pet shop', 'petshop', 'pet shops', 'racao'],
    filters: [shop('pet')]
  },
  {
    label: 'cabeleireiro',
    words: ['cabeleireiro', 'cabeleireira', 'salao de beleza', 'barbearia', 'barbeiro', 'manicure'],
    filters: [shop('hairdresser', 'beauty')]
  },
  {
    label: 'lavanderia',
    words: ['lavanderia', 'lavanderias', 'laundry'],
    filters: [shop('laundry', 'dry_cleaning')]
  },
  // ---- saúde ----
  {
    label: 'pronto-socorro',
    words: ['pronto socorro', 'pronto-socorro', 'emergencia', 'upa'],
    filters: [amenity('hospital', 'clinic'), f('healthcare', ['hospital'])]
  },
  {
    label: 'hospital',
    words: ['hospital', 'hospitais'],
    filters: [amenity('hospital')]
  },
  {
    label: 'clínica',
    words: ['clinica', 'clinicas', 'posto de saude', 'ubs', 'medico', 'medicos', 'consultorio'],
    filters: [amenity('clinic', 'doctors')]
  },
  {
    label: 'dentista',
    words: ['dentista', 'dentistas', 'odontologia', 'odontologica', 'dentist'],
    filters: [amenity('dentist')]
  },
  {
    label: 'veterinário',
    words: ['veterinario', 'veterinaria', 'veterinarios', 'clinica veterinaria', 'vet'],
    filters: [amenity('veterinary')]
  },
  // ---- serviços ----
  {
    label: 'posto de combustível',
    words: [
      'posto',
      'postos',
      'posto de gasolina',
      'posto de combustivel',
      'gasolina',
      'combustivel',
      'etanol',
      'gas station'
    ],
    filters: [amenity('fuel')]
  },
  {
    label: 'carregador de carro elétrico',
    words: ['carregador', 'eletroposto', 'recarga', 'carro eletrico', 'charging station'],
    filters: [amenity('charging_station')]
  },
  {
    label: 'banco',
    words: ['banco', 'bancos', 'agencia bancaria', 'bank'],
    filters: [amenity('bank')]
  },
  {
    label: 'caixa eletrônico',
    words: [
      'caixa eletronico',
      'caixas eletronicos',
      'caixa 24 horas',
      'banco 24 horas',
      'atm',
      'saque'
    ],
    filters: [amenity('atm')]
  },
  {
    label: 'casa de câmbio',
    words: ['cambio', 'casa de cambio'],
    filters: [amenity('bureau_de_change')]
  },
  {
    label: 'correios',
    words: ['correios', 'correio', 'agencia dos correios', 'post office'],
    filters: [amenity('post_office')]
  },
  { label: 'delegacia', words: ['delegacia', 'policia', 'police'], filters: [amenity('police')] },
  {
    label: 'banheiro público',
    words: ['banheiro', 'banheiros', 'sanitario', 'sanitarios', 'toalete', 'toilet', 'toilets'],
    filters: [amenity('toilets')]
  },
  {
    label: 'estacionamento',
    words: ['estacionamento', 'estacionamentos', 'parking'],
    filters: [amenity('parking')]
  },
  {
    label: 'bicicletário',
    words: ['bicicletario', 'paraciclo', 'bicycle parking'],
    filters: [amenity('bicycle_parking')]
  },
  {
    label: 'aluguel de bicicleta',
    words: ['aluguel de bicicleta', 'bicicleta compartilhada', 'bike'],
    filters: [amenity('bicycle_rental')]
  },
  {
    label: 'oficina mecânica',
    words: ['mecanico', 'oficina', 'oficina mecanica', 'borracharia', 'auto center'],
    filters: [shop('car_repair', 'tyres')]
  },
  {
    label: 'lava-rápido',
    words: ['lava rapido', 'lava-rapido', 'lava jato', 'lava-jato', 'car wash'],
    filters: [amenity('car_wash')]
  },
  {
    label: 'locadora de carros',
    words: ['aluguel de carro', 'aluguel de carros', 'locadora', 'car rental'],
    filters: [amenity('car_rental')]
  },
  { label: 'ponto de táxi', words: ['taxi', 'ponto de taxi'], filters: [amenity('taxi')] },
  {
    label: 'coworking',
    words: ['coworking'],
    filters: [amenity('coworking_space'), f('office', ['coworking'])]
  },
  // ---- transporte ----
  {
    label: 'ponto de ônibus',
    words: ['ponto de onibus', 'parada de onibus', 'onibus', 'bus stop'],
    filters: [f('highway', ['bus_stop'])]
  },
  {
    label: 'estação',
    words: ['metro', 'estacao', 'estacao de metro', 'estacao de trem', 'trem', 'cptm', 'subway'],
    filters: [f('railway', ['station', 'halt'])]
  },
  // ---- hospedagem e lazer ----
  {
    label: 'hotel',
    words: [
      'hotel',
      'hoteis',
      'hospedagem',
      'pousada',
      'pousadas',
      'hostel',
      'hostels',
      'albergue',
      'motel'
    ],
    filters: [tourism('hotel', 'guest_house', 'hostel', 'motel', 'apartment')]
  },
  { label: 'museu', words: ['museu', 'museus', 'museum'], filters: [tourism('museum')] },
  {
    label: 'galeria de arte',
    words: ['galeria de arte', 'galeria', 'exposicao'],
    filters: [tourism('gallery')]
  },
  {
    label: 'atração turística',
    words: ['atracao', 'atracoes', 'ponto turistico', 'pontos turisticos', 'turismo', 'passeio'],
    filters: [tourism('attraction', 'viewpoint', 'museum', 'gallery')]
  },
  {
    label: 'mirante',
    words: ['mirante', 'mirantes', 'viewpoint'],
    filters: [tourism('viewpoint')]
  },
  {
    label: 'parque',
    words: ['parque', 'parques', 'praca', 'pracas', 'park'],
    filters: [leisure('park', 'garden')]
  },
  {
    label: 'parquinho',
    words: ['parquinho', 'playground'],
    filters: [leisure('playground')]
  },
  {
    label: 'academia',
    words: ['academia', 'academias', 'musculacao', 'ginastica', 'crossfit', 'gym'],
    filters: [leisure('fitness_centre', 'sports_centre')]
  },
  { label: 'cinema', words: ['cinema', 'cinemas'], filters: [amenity('cinema')] },
  { label: 'teatro', words: ['teatro', 'teatros', 'theatre'], filters: [amenity('theatre')] },
  {
    label: 'biblioteca',
    words: ['biblioteca', 'bibliotecas', 'library'],
    filters: [amenity('library')]
  },
  { label: 'praia', words: ['praia', 'praias', 'beach'], filters: [f('natural', ['beach'])] },
  // ---- outros ----
  {
    label: 'igreja',
    words: ['igreja', 'igrejas', 'templo', 'paroquia', 'capela', 'church'],
    filters: [amenity('place_of_worship')]
  },
  { label: 'escola', words: ['escola', 'escolas', 'colegio'], filters: [amenity('school')] },
  {
    label: 'universidade',
    words: ['universidade', 'universidades', 'faculdade', 'faculdades'],
    filters: [amenity('university', 'college')]
  }
]

interface Cuisine {
  label: string
  words: string[]
  /** Alternativas (OR): cada uma vira um filtro extra; `cuisine` é o padrão. */
  alts: { key: string; regex: string }[]
  /** Base quando a culinária vem sozinha (padrão: restaurantes e lanchonetes). */
  base?: F[]
}

export const CUISINES: Cuisine[] = [
  {
    label: 'pizza',
    words: ['pizza', 'pizzas', 'pizzaria', 'pizzarias'],
    alts: [{ key: 'cuisine', regex: 'pizza' }]
  },
  {
    label: 'hambúrguer',
    words: ['hamburguer', 'hamburgueres', 'hamburgueria', 'hamburguerias', 'burger', 'burguer'],
    alts: [{ key: 'cuisine', regex: 'burger' }]
  },
  {
    label: 'japonesa',
    words: ['japones', 'japonesa', 'japoneses', 'sushi', 'temaki', 'ramen', 'lamen', 'japanese'],
    alts: [{ key: 'cuisine', regex: 'japanese|sushi|ramen' }]
  },
  {
    label: 'chinesa',
    words: ['chines', 'chinesa', 'chinese', 'pastelaria chinesa'],
    alts: [{ key: 'cuisine', regex: 'chinese' }]
  },
  {
    label: 'italiana',
    words: ['italiano', 'italiana', 'cantina', 'massa', 'massas', 'italian'],
    alts: [{ key: 'cuisine', regex: 'italian|pasta' }]
  },
  {
    label: 'árabe',
    words: ['arabe', 'arabes', 'libanes', 'libanesa', 'esfiha', 'esfirra', 'kebab'],
    alts: [{ key: 'cuisine', regex: 'arab|lebanese|middle_eastern|kebab|turkish' }]
  },
  {
    label: 'mexicana',
    words: ['mexicano', 'mexicana', 'taco', 'tacos', 'mexican'],
    alts: [{ key: 'cuisine', regex: 'mexican|tex-mex' }]
  },
  {
    label: 'brasileira',
    words: [
      'brasileira',
      'brasileiro',
      'mineira',
      'nordestina',
      'caseira',
      'comida caseira',
      'self service',
      'self-service',
      'por quilo',
      'por kilo',
      'buffet',
      'feijoada'
    ],
    alts: [{ key: 'cuisine', regex: 'brazilian|regional|buffet' }]
  },
  {
    label: 'churrascaria',
    words: ['churrascaria', 'churrascarias', 'churrasco', 'rodizio', 'steakhouse'],
    alts: [{ key: 'cuisine', regex: 'steak_house|barbecue|churrasco|grill' }]
  },
  {
    label: 'frutos do mar',
    words: ['frutos do mar', 'peixe', 'peixes', 'seafood'],
    alts: [{ key: 'cuisine', regex: 'seafood|fish' }]
  },
  {
    label: 'vegetariana',
    words: ['vegetariano', 'vegetariana', 'vegetarianos', 'vegano', 'vegana', 'veganos', 'vegan'],
    alts: [
      { key: 'cuisine', regex: 'vegetarian|vegan' },
      { key: 'diet:vegetarian', regex: '^(yes|only)$' },
      { key: 'diet:vegan', regex: '^(yes|only)$' }
    ],
    base: [amenity(...FOOD, 'cafe')]
  },
  {
    label: 'açaí',
    words: ['acai'],
    alts: [{ key: 'cuisine', regex: 'acai' }],
    base: [amenity(...FOOD, 'cafe', 'ice_cream')]
  },
  {
    label: 'café (bebida)',
    words: ['cafe especial', 'cafes especiais'],
    alts: [{ key: 'cuisine', regex: 'coffee' }],
    base: [amenity('cafe')]
  }
]

/** Categorias de comida às quais uma culinária se aplica. */
const FOOD_VALUES = new Set([
  'restaurant',
  'fast_food',
  'food_court',
  'cafe',
  'ice_cream',
  'bar',
  'pub'
])
const isFoodFilter = (x: F): boolean =>
  x.key === 'amenity' && !!x.values?.some((v) => FOOD_VALUES.has(v))

/** Escapa para regex do Overpass (POSIX estendida). */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const TAG_RE = /^([a-z][a-z0-9_:]*)\s*(=|~)\s*([^\s,]+)$/i

function tagFilter(token: string): F | null {
  const m = TAG_RE.exec(token.trim())
  if (!m) return null
  const [, key, op, raw] = m
  if (op === '~') return f(key.toLowerCase(), null, [{ key: key.toLowerCase(), regex: raw }])
  const values = raw === '*' ? null : raw.split('|').filter(Boolean)
  return f(key.toLowerCase(), values && values.length ? values : null)
}

interface Hit {
  start: number
  end: number
}

/** Procura as palavras (frases inteiras, mais longas primeiro), sem sobrepor trechos já usados. */
function findWords<T extends { words: string[] }>(text: string, list: T[], used: Hit[]): T[] {
  const entries = list.flatMap((item) => item.words.map((w) => ({ item, w })))
  entries.sort((a, b) => b.w.length - a.w.length)
  const found: T[] = []
  for (const { item, w } of entries) {
    const re = new RegExp(`(?:^| )${escapeRegex(w)}(?= |$)`, 'g')
    for (const m of text.matchAll(re)) {
      const start = (m.index ?? 0) + (m[0].startsWith(' ') ? 1 : 0)
      const end = start + w.length
      if (used.some((u) => start < u.end && end > u.start)) continue
      used.push({ start, end })
      if (!found.includes(item)) found.push(item)
    }
  }
  return found
}

function withExtras(base: F[], alts: { key: string; regex: string }[]): F[] {
  const out: F[] = []
  for (const b of base) for (const a of alts) out.push({ ...b, extra: [...(b.extra ?? []), a] })
  return out
}

/** "amenity=restaurant|fast_food + cuisine~pizza" (para o modelo). */
export function filtersText(filters: F[], nameRegex?: string): string {
  const parts = filters.map((x) => {
    const main = x.values ? `${x.key}=${x.values.join('|')}` : x.key
    const extra = (x.extra ?? []).map((e) => `${e.key}~${e.regex}`)
    return [main, ...extra].join(' + ')
  })
  const uniq = [...new Set(parts)]
  if (nameRegex) uniq.push(`name~"${nameRegex}"`)
  return uniq.join(' · ')
}

/**
 * Resolve "o que procurar" (+ culinária opcional) em filtros. Sem nada reconhecido → busca pelo
 * nome nas chaves de lugares.
 */
export function resolveQuery(what: string, cuisine?: string): ResolvedQuery {
  const raw = what.trim()
  // tags OSM diretas: "amenity=cafe", "shop=bakery, cuisine~pizza"
  const tokens = raw.split(/[,;+]/).map((t) => t.trim())
  const tagFilters = tokens.map(tagFilter)
  if (tokens.length && tagFilters.every(Boolean)) {
    const tags = tagFilters as F[]
    const mains = tags.filter((t) => !t.extra)
    const extras = tags.flatMap((t) => t.extra ?? [])
    const filters = (mains.length ? mains : [f(tags[0].key, null)]).map((m) =>
      extras.length ? { ...m, extra: [...(m.extra ?? []), ...extras] } : m
    )
    return { filters, labels: [], tagsText: filtersText(filters) }
  }

  const text = fold(`${raw} ${cuisine ?? ''}`)
  const used: Hit[] = []
  // culinárias primeiro ("pizzaria", "café especial"), depois as categorias no que sobrou
  const cuisines = findWords(text, CUISINES, used)
  const cats = findWords(text, CATEGORIES, used)

  let filters: F[] = cats.flatMap((c) => c.filters)
  const labels = [...cats.map((c) => c.label)]
  if (cuisines.length) {
    const alts = cuisines.flatMap((c) => c.alts)
    labels.push(...cuisines.map((c) => `culinária ${c.label}`))
    const food = filters.filter(isFoodFilter)
    const other = filters.filter((x) => !isFoodFilter(x))
    const base = food.length
      ? food
      : (cuisines.find((c) => c.base)?.base ?? [amenity('restaurant', 'fast_food')])
    filters = [...withExtras(base, alts), ...other]
  }
  if (filters.length) return { filters, labels, tagsText: filtersText(filters) }

  // nada reconhecido: pelo nome ("Starbucks", "Bráz Pizzaria")
  const nameRegex = escapeRegex(raw.replace(/\s+/g, ' ')).slice(0, 80)
  const keys = ['amenity', 'shop', 'tourism', 'leisure']
  filters = keys.map((k) => f(k, null))
  return { filters, labels: [], nameRegex, tagsText: filtersText(filters, nameRegex) }
}

// ---------------- rótulos do resultado ----------------

/** Chaves que dão a categoria de um lugar, na ordem de preferência. */
export const CATEGORY_KEYS = [
  'amenity',
  'shop',
  'tourism',
  'leisure',
  'healthcare',
  'office',
  'railway',
  'highway',
  'natural',
  'historic',
  'craft'
]

const TAG_LABEL: Record<string, string> = {
  'amenity=restaurant': 'restaurante',
  'amenity=fast_food': 'lanchonete',
  'amenity=food_court': 'praça de alimentação',
  'amenity=cafe': 'café',
  'amenity=bar': 'bar',
  'amenity=pub': 'pub',
  'amenity=biergarten': 'cervejaria ao ar livre',
  'amenity=ice_cream': 'sorveteria',
  'amenity=nightclub': 'balada',
  'amenity=pharmacy': 'farmácia',
  'amenity=hospital': 'hospital',
  'amenity=clinic': 'clínica',
  'amenity=doctors': 'consultório',
  'amenity=dentist': 'dentista',
  'amenity=veterinary': 'veterinário',
  'amenity=fuel': 'posto de combustível',
  'amenity=charging_station': 'carregador de carro elétrico',
  'amenity=bank': 'banco',
  'amenity=atm': 'caixa eletrônico',
  'amenity=bureau_de_change': 'casa de câmbio',
  'amenity=post_office': 'correios',
  'amenity=police': 'polícia',
  'amenity=toilets': 'banheiro público',
  'amenity=parking': 'estacionamento',
  'amenity=bicycle_parking': 'bicicletário',
  'amenity=bicycle_rental': 'aluguel de bicicleta',
  'amenity=car_wash': 'lava-rápido',
  'amenity=car_rental': 'locadora de carros',
  'amenity=taxi': 'ponto de táxi',
  'amenity=coworking_space': 'coworking',
  'amenity=cinema': 'cinema',
  'amenity=theatre': 'teatro',
  'amenity=library': 'biblioteca',
  'amenity=place_of_worship': 'templo religioso',
  'amenity=school': 'escola',
  'amenity=university': 'universidade',
  'amenity=college': 'faculdade',
  'amenity=marketplace': 'feira/mercado público',
  'shop=supermarket': 'supermercado',
  'shop=convenience': 'mercearia/conveniência',
  'shop=wholesale': 'atacado',
  'shop=greengrocer': 'hortifrúti',
  'shop=bakery': 'padaria',
  'shop=pastry': 'confeitaria',
  'shop=confectionery': 'doceria',
  'shop=butcher': 'açougue',
  'shop=chemist': 'drogaria',
  'shop=mall': 'shopping',
  'shop=books': 'livraria',
  'shop=clothes': 'loja de roupas',
  'shop=shoes': 'loja de calçados',
  'shop=electronics': 'eletrônicos',
  'shop=mobile_phone': 'loja de celulares',
  'shop=computer': 'informática',
  'shop=hardware': 'ferragens',
  'shop=doityourself': 'material de construção',
  'shop=florist': 'floricultura',
  'shop=optician': 'ótica',
  'shop=newsagent': 'banca de jornal',
  'shop=kiosk': 'banca',
  'shop=pet': 'pet shop',
  'shop=hairdresser': 'cabeleireiro',
  'shop=beauty': 'salão de beleza',
  'shop=laundry': 'lavanderia',
  'shop=dry_cleaning': 'lavanderia (a seco)',
  'shop=ice_cream': 'sorveteria',
  'shop=car_repair': 'oficina mecânica',
  'shop=tyres': 'borracharia',
  'tourism=hotel': 'hotel',
  'tourism=guest_house': 'pousada',
  'tourism=hostel': 'hostel',
  'tourism=motel': 'motel',
  'tourism=apartment': 'apartamento por temporada',
  'tourism=museum': 'museu',
  'tourism=gallery': 'galeria de arte',
  'tourism=attraction': 'atração turística',
  'tourism=viewpoint': 'mirante',
  'leisure=park': 'parque',
  'leisure=garden': 'jardim',
  'leisure=playground': 'parquinho',
  'leisure=fitness_centre': 'academia',
  'leisure=sports_centre': 'centro esportivo',
  'healthcare=hospital': 'hospital',
  'office=coworking': 'coworking',
  'railway=station': 'estação',
  'railway=halt': 'parada de trem',
  'highway=bus_stop': 'ponto de ônibus',
  'natural=beach': 'praia'
}

export function tagLabel(key: string, value: string): string {
  return TAG_LABEL[`${key}=${value}`] ?? `${key}=${value}`.replace(/_/g, ' ')
}

const CUISINE_LABEL: Record<string, string> = {
  pizza: 'pizza',
  burger: 'hambúrguer',
  japanese: 'japonesa',
  sushi: 'sushi',
  ramen: 'lámen',
  chinese: 'chinesa',
  italian: 'italiana',
  pasta: 'massas',
  arab: 'árabe',
  lebanese: 'libanesa',
  middle_eastern: 'oriente médio',
  kebab: 'kebab',
  turkish: 'turca',
  mexican: 'mexicana',
  brazilian: 'brasileira',
  regional: 'regional',
  buffet: 'bufê',
  steak_house: 'churrascaria',
  barbecue: 'churrasco',
  grill: 'grelhados',
  seafood: 'frutos do mar',
  fish: 'peixes',
  vegetarian: 'vegetariana',
  vegan: 'vegana',
  coffee_shop: 'cafeteria',
  coffee: 'café',
  ice_cream: 'sorvete',
  sandwich: 'sanduíches',
  salad: 'saladas',
  chicken: 'frango',
  french: 'francesa',
  portuguese: 'portuguesa',
  korean: 'coreana',
  thai: 'tailandesa',
  indian: 'indiana',
  peruvian: 'peruana',
  argentinian: 'argentina',
  international: 'internacional',
  bakery: 'padaria',
  cake: 'bolos',
  donut: 'donuts',
  crepe: 'crepes',
  juice: 'sucos',
  acai: 'açaí',
  tapioca: 'tapioca'
}

/** `cuisine=pizza;italian` → ["pizza", "italiana"]. */
export function cuisineLabels(v: string | undefined): string[] {
  if (!v) return []
  return v
    .split(';')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean)
    .map((x) => CUISINE_LABEL[x] ?? x.replace(/_/g, ' '))
}
