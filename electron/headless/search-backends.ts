import { htmlToText } from '../ai/web-fetch'
import { webSearch } from '../ai/web-search'
import type {
  SearchBackend,
  SearchCandidate,
  SearchIntent,
} from './search-executor'

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export class SearchBackendError extends Error {
  constructor(
    message: string,
    readonly errorClass: string,
    readonly statusCode: number | null,
    readonly rateLimited = false,
  ) {
    super(message)
    this.name = 'SearchBackendError'
  }
}

function responseError(backend: string, status: number): SearchBackendError {
  const rateLimited = status === 429
  const errorClass = rateLimited
    ? 'rate_limit'
    : status === 401 || status === 403
      ? 'auth'
      : status >= 500
        ? 'upstream'
        : 'http'
  return new SearchBackendError(`${backend} request failed (${status})`, errorClass, status, rateLimited)
}

function cleanMarkup(value: unknown): string {
  return htmlToText(String(value ?? '')).replace(/\s+/g, ' ').trim()
}

function xmlText(value: string): string {
  return cleanMarkup(value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<hlword>/gi, '')
    .replace(/<\/hlword>/gi, '')
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&'))
}

function xmlValue(block: string, tag: string): string {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, 'i').exec(block)
  return match ? xmlText(match[1]) : ''
}

function parseYandexDate(value: string): string | null {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/.exec(value)
  if (!match) return null
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

export function parseYandexSearchXml(
  xml: string,
  backend: 'yandex_ru' | 'yandex_global',
  limit: number,
): SearchCandidate[] {
  const results: SearchCandidate[] = []
  const docs = xml.match(/<doc(?:\s[^>]*)?>[\s\S]*?<\/doc>/gi) ?? []
  for (const doc of docs) {
    const url = xmlValue(doc, 'url')
    if (!url) continue
    const mimeType = xmlValue(doc, 'mime-type')
    results.push({
      url,
      canonicalUrl: url,
      title: xmlValue(doc, 'title'),
      snippet: xmlValue(doc, 'headline') || xmlValue(doc, 'passage'),
      rank: results.length + 1,
      backend,
      language: backend === 'yandex_ru' ? 'ru' : null,
      publishedAt: parseYandexDate(xmlValue(doc, 'modtime')),
      metadata: mimeType ? { mimeType } : {},
    })
    if (results.length >= limit) break
  }
  return results
}

export interface YandexSearchBackendOptions {
  apiKey: string
  folderId: string
  searchType: 'ru' | 'global'
  fetchImpl?: FetchLike
}

export function createYandexSearchBackend(options: YandexSearchBackendOptions): SearchBackend {
  const id = options.searchType === 'ru' ? 'yandex_ru' : 'yandex_global'
  const searchType = options.searchType === 'ru' ? 'SEARCH_TYPE_RU' : 'SEARCH_TYPE_COM'
  const fetchImpl = options.fetchImpl ?? fetch
  return {
    id,
    coverage: options.searchType === 'ru' ? 'ru' : 'global',
    structured: true,
    estimatedCost: { amount: 0.488, currency: 'RUB' },
    async search(query, opts) {
      const response = await fetchImpl('https://searchapi.api.cloud.yandex.net/v2/web/search', {
        method: 'POST',
        headers: {
          authorization: `Api-Key ${options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          query: {
            searchType,
            queryText: query,
            familyMode: 'FAMILY_MODE_NONE',
            fixTypoMode: 'FIX_TYPO_MODE_ON',
          },
          groupSpec: { groupsOnPage: opts.limit, docsInGroup: 1 },
          folderId: options.folderId,
          responseFormat: 'FORMAT_XML',
        }),
        signal: opts.signal,
      })
      if (!response.ok) throw responseError(id, response.status)
      const payload = await response.json() as { rawData?: unknown }
      if (typeof payload.rawData !== 'string' || !payload.rawData) {
        throw new SearchBackendError(`${id} returned no search payload`, 'invalid_response', response.status)
      }
      let xml: string
      try {
        xml = Buffer.from(payload.rawData, 'base64').toString('utf8')
      } catch {
        throw new SearchBackendError(`${id} returned invalid search payload`, 'invalid_response', response.status)
      }
      return parseYandexSearchXml(xml, id, opts.limit)
    },
  }
}

function parseIsoDate(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

interface BraveWebResult {
  url?: unknown
  title?: unknown
  description?: unknown
  language?: unknown
  page_age?: unknown
  age?: unknown
  profile?: { long_name?: unknown }
}

export function parseBraveSearchJson(payload: unknown, limit: number): SearchCandidate[] {
  const results = (payload as { web?: { results?: unknown } })?.web?.results
  if (!Array.isArray(results)) return []
  return results.slice(0, limit).flatMap((raw, index) => {
    const item = raw as BraveWebResult
    if (typeof item.url !== 'string' || !item.url.trim()) return []
    const publisher = typeof item.profile?.long_name === 'string'
      ? cleanMarkup(item.profile.long_name)
      : ''
    return [{
      url: item.url,
      canonicalUrl: item.url,
      title: cleanMarkup(item.title),
      snippet: cleanMarkup(item.description),
      rank: index + 1,
      backend: 'brave_global',
      language: typeof item.language === 'string' ? item.language : null,
      publishedAt: parseIsoDate(item.page_age) ?? parseIsoDate(item.age),
      metadata: publisher ? { publisher } : {},
    }]
  })
}

export interface BraveSearchBackendOptions {
  apiKey: string
  fetchImpl?: FetchLike
}

export function createBraveSearchBackend(options: BraveSearchBackendOptions): SearchBackend {
  const fetchImpl = options.fetchImpl ?? fetch
  return {
    id: 'brave_global',
    coverage: 'global',
    structured: true,
    estimatedCost: { amount: 0.005, currency: 'USD' },
    async search(query, opts) {
      const endpoint = new URL('https://api.search.brave.com/res/v1/web/search')
      endpoint.searchParams.set('q', query)
      endpoint.searchParams.set('count', String(opts.limit))
      endpoint.searchParams.set('safesearch', 'moderate')
      endpoint.searchParams.set('text_decorations', 'false')
      const response = await fetchImpl(endpoint, {
        headers: {
          accept: 'application/json',
          'x-subscription-token': options.apiKey,
        },
        signal: opts.signal,
      })
      if (!response.ok) throw responseError('brave_global', response.status)
      return parseBraveSearchJson(await response.json(), opts.limit)
    },
  }
}

export function createDuckDuckGoDiagnosticBackend(): SearchBackend {
  return {
    id: 'duckduckgo_html',
    coverage: 'diagnostic',
    structured: false,
    estimatedCost: { amount: 0, currency: 'USD' },
    async search(query, opts) {
      const results = await webSearch(query, {
        signal: opts.signal,
        timeoutMs: opts.timeoutMs,
        limit: opts.limit,
      })
      return results.map((item, index) => ({
        url: item.url,
        canonicalUrl: item.url,
        title: item.title,
        snippet: item.snippet,
        rank: index + 1,
        backend: 'duckduckgo_html',
        language: null,
        publishedAt: null,
        metadata: {},
      }))
    },
  }
}

export function createConfiguredSearchBackends(env: NodeJS.ProcessEnv = process.env): SearchBackend[] {
  const configured: SearchBackend[] = []
  const yandexKey = env.YANDEX_SEARCH_API_KEY?.trim()
  const yandexFolder = env.YANDEX_SEARCH_FOLDER_ID?.trim()
  if (yandexKey && yandexFolder) {
    configured.push(createYandexSearchBackend({ apiKey: yandexKey, folderId: yandexFolder, searchType: 'ru' }))
  }
  const braveKey = env.BRAVE_SEARCH_API_KEY?.trim()
  if (braveKey) configured.push(createBraveSearchBackend({ apiKey: braveKey }))
  if (yandexKey && yandexFolder) {
    configured.push(createYandexSearchBackend({ apiKey: yandexKey, folderId: yandexFolder, searchType: 'global' }))
  }
  configured.push(createDuckDuckGoDiagnosticBackend())
  return configured
}

export function classifySearchIntent(query: string): SearchIntent {
  const compact = query.toLowerCase()
  const hasCyrillic = /[а-яё]/i.test(compact)
  const explicitRu = /\b(?:росси[яи]|российск\S*|рф|рубл\S*|закон\S*|госуслуг\S*)\b/i.test(compact)
  const explicitGlobal = /\b(?:global|world|international|международн\S*|миров\S*)\b/i.test(compact)
  if ((explicitRu && explicitGlobal) || (hasCyrillic && explicitGlobal)) return 'mixed'
  if (explicitRu || hasCyrillic) return 'ru'
  return 'global'
}

function uniqueBackends(backends: SearchBackend[]): SearchBackend[] {
  const seen = new Set<string>()
  return backends.filter(item => {
    if (seen.has(item.id)) return false
    seen.add(item.id)
    return true
  })
}

export function planSearchBackends(intent: SearchIntent, available: SearchBackend[]): SearchBackend[][] {
  const diagnostic = available.filter(item => item.coverage === 'diagnostic' || item.structured === false)
  const ru = available.filter(item => item.structured !== false && (item.coverage === 'ru' || item.coverage === 'mixed'))
  const global = available.filter(item => item.structured !== false && (item.coverage === 'global' || item.coverage === 'mixed'))
  const unknown = available.filter(item => item.coverage == null && item.structured !== false)
  const waves: SearchBackend[][] = []
  const addWave = (items: SearchBackend[]): void => {
    const wave = uniqueBackends(items).filter(item => !waves.some(existing => existing.includes(item)))
    if (wave.length) waves.push(wave)
  }
  const addSequential = (items: SearchBackend[]): void => {
    for (const item of items) addWave([item])
  }
  if (intent === 'mixed') {
    addWave([...ru.slice(0, 1), ...global.slice(0, 1), ...unknown.slice(0, 1)])
    addWave([...ru.slice(1), ...global.slice(1), ...unknown.slice(1)])
  } else if (intent === 'ru') {
    addWave([...ru, ...unknown].slice(0, 1))
    addSequential(global)
    addSequential([...ru, ...unknown].slice(1))
  } else {
    addWave([...global, ...unknown].slice(0, 1))
    addSequential([...global, ...unknown].slice(1))
    addSequential(ru)
  }
  addWave(diagnostic)
  return waves
}
