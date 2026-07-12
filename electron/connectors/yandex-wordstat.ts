/**
 * Yandex Wordstat connector via AI Studio Search API.
 *
 * Docs:
 *   https://aistudio.yandex.ru/docs/ru/search-api/operations/wordstat-gettop.html
 *
 * Credentials:
 *   yandex_wordstat_token     - API key or IAM token with yc.search-api.execute
 *   yandex_wordstat_auth_type - api-key | iam
 *   yandex_wordstat_folder_id - Yandex Cloud folder id
 */

import https from 'node:https'
import type { Connector, ConnectorInfo, ConnectorContext } from './types'
import { logRuntime } from '../runtime-log'

export const WORDSTAT_API_HOST = 'searchapi.api.cloud.yandex.net'
const API_PREFIX = '/v2/wordstat'

type WordstatAuthType = 'api-key' | 'iam'
type WordstatDevice = 'DEVICE_ALL' | 'DEVICE_DESKTOP' | 'DEVICE_PHONE' | 'DEVICE_TABLET'
type WordstatPeriod = 'weekly' | 'monthly'
type WordstatRegionType = 'all' | 'cities' | 'regions'

interface PhraseCount {
  phrase: string
  count: number
}

interface WordstatCredentials {
  token: string
  authType: WordstatAuthType
  folderId: string
}

export function createYandexWordstatConnector(): Connector {
  return {
    info(): ConnectorInfo {
      return {
        id: 'yandex_wordstat',
        label: 'Яндекс.Wordstat',
        kind: 'yandex_wordstat',
        status: 'ready',
        detail: 'Частотность ключевых слов через Yandex Search API. Нужны API-ключ Yandex AI Studio или IAM-токен и идентификатор каталога. Операции: get_top_requests { phrase, regions?, num_phrases? }, get_wordstat { phrases[], regions? }.'
      }
    },

    async query(args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
      const op = String(args.op ?? '')
      const credentials = readCredentials(ctx)
      if (!credentials.token) {
        return {
          error: 'no-token',
          message: 'Wordstat не настроен. Укажите API-ключ Yandex AI Studio или IAM-токен'
        }
      }
      if (!credentials.folderId) {
        return {
          error: 'no-folder-id',
          message: 'Wordstat не настроен. Укажите идентификатор каталога Yandex Cloud'
        }
      }

      try {
        switch (op) {
          case 'get_wordstat':
            return await getWordstatBatch(credentials, args, ctx)
          case 'get_top_requests':
            return await getTopRequests(credentials, args, ctx)
          case 'get_dynamics':
            return await getDynamics(credentials, args, ctx)
          case 'get_regions':
            return await getRegions(credentials, args, ctx)
          case 'get_regions_tree':
            return {
              error: 'unsupported-op',
              message: 'Yandex Search API Wordstat не предоставляет дерево регионов в этом методе. Используйте список регионов поиска Yandex Search API'
            }
          default:
            return {
              error: 'unknown-op',
              message: `Неизвестная op "${op}". Доступно: get_wordstat, get_top_requests, get_dynamics, get_regions.`
            }
        }
      } catch (err) {
        return { error: 'request-failed', message: err instanceof Error ? err.message : String(err), op }
      }
    }
  }
}

// ----------------------------------------------------------------- ops

function readCredentials(ctx: ConnectorContext): WordstatCredentials {
  const token = (ctx.getSecret('yandex_wordstat_token') ?? '').trim()
  const rawAuthType = (ctx.getSecret('yandex_wordstat_auth_type') ?? '').trim().toLowerCase()
  const authType: WordstatAuthType = rawAuthType === 'iam' ? 'iam' : 'api-key'
  const folderId = (ctx.getSecret('yandex_wordstat_folder_id') ?? '').trim()
  return { token, authType, folderId }
}

async function getWordstatBatch(credentials: WordstatCredentials, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  const phrases = (Array.isArray(args.phrases) ? args.phrases : [])
    .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
  if (phrases.length === 0) {
    return { error: 'bad-args', message: 'get_wordstat требует phrases: string[]' }
  }
  const regions = readRegions(args)
  const devices = readDevices(args)
  const numPhrases = readNumPhrases(args)
  const results = []
  for (let i = 0; i < Math.min(phrases.length, 10); i++) {
    const phrase = phrases[i].trim()
    const raw = await getTopRequests(credentials, {
      phrase,
      regions,
      geo_id: regions,
      devices,
      num_phrases: numPhrases
    }, ctx) as Record<string, unknown>
    if (raw.error) return raw
    results.push(raw)
    if (i < phrases.length - 1) await sleep(120)
  }
  return { count: results.length, results }
}

async function getTopRequests(credentials: WordstatCredentials, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  const phrase = String(args.phrase ?? '').trim()
  if (!phrase) return { error: 'bad-args', message: 'get_top_requests требует phrase: string' }

  const body: Record<string, unknown> = {
    phrase,
    devices: readDevices(args),
    numPhrases: readNumPhrases(args),
    folderId: credentials.folderId
  }
  const regions = readRegions(args)
  if (regions.length > 0) body.regions = regions

  const data = await wordstatApiPost('/topRequests', credentials, body, ctx) as Record<string, unknown>
  return normalizeTopRequests(phrase, data)
}

async function getDynamics(credentials: WordstatCredentials, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  const phrase = String(args.phrase ?? '').trim()
  const period = String(args.period ?? 'monthly').toLowerCase() as WordstatPeriod
  const from = String(args.from ?? args.date_from ?? '').trim()
  const to = String(args.to ?? args.date_to ?? '').trim()
  if (!phrase) return { error: 'bad-args', message: 'get_dynamics требует phrase: string' }
  if (!from || !to) return { error: 'bad-args', message: 'get_dynamics требует from и to в формате YYYY-MM-DD' }
  if (period !== 'weekly' && period !== 'monthly') {
    return { error: 'bad-args', message: 'period должен быть weekly или monthly' }
  }

  const body: Record<string, unknown> = {
    phrase,
    period,
    from,
    to,
    devices: readDevices(args),
    folderId: credentials.folderId
  }
  const regions = readRegions(args)
  if (regions.length > 0) body.regions = regions

  const data = await wordstatApiPost('/getDynamics', credentials, body, ctx)
  return { phrase, period, from, to, ...flattenDynamics(data) }
}

async function getRegions(credentials: WordstatCredentials, args: Record<string, unknown>, ctx: ConnectorContext): Promise<unknown> {
  const phrase = String(args.phrase ?? '').trim()
  if (!phrase) return { error: 'bad-args', message: 'get_regions требует phrase: string' }

  const regionType = String(args.region_type ?? args.regionType ?? 'all').toLowerCase() as WordstatRegionType
  if (!['all', 'cities', 'regions'].includes(regionType)) {
    return { error: 'bad-args', message: 'region_type должен быть all, cities или regions' }
  }

  const body: Record<string, unknown> = {
    phrase,
    regionType,
    devices: readDevices(args),
    folderId: credentials.folderId
  }
  const regions = readRegions(args)
  if (regions.length > 0) body.regions = regions

  const data = await wordstatApiPost('/getRegionsDistribution', credentials, body, ctx)
  return { phrase, region_type: regionType, ...flattenRegions(data) }
}

// ----------------------------------------------------------------- HTTP

export async function wordstatApiPost(
  pathSuffix: string,
  credentials: WordstatCredentials | string,
  body: Record<string, unknown>,
  ctx: ConnectorContext
): Promise<unknown> {
  const normalizedCredentials = typeof credentials === 'string'
    ? { token: credentials, authType: 'iam' as const, folderId: String(body.folderId ?? '') }
    : credentials
  const path = `${API_PREFIX}${pathSuffix.startsWith('/') ? pathSuffix : `/${pathSuffix}`}`
  const payload = JSON.stringify(body ?? {})
  const text = await wordstatHttpsText(path, normalizedCredentials, payload, ctx.signal)
  let json: Record<string, unknown>
  try {
    json = JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new Error(`Wordstat вернул не-JSON (${text.slice(0, 200)})`)
  }

  if (json.error || json.error_code || json.code) {
    const code = json.error_code ?? json.code ?? json.error
    const message = String(json.error_str ?? json.message ?? json.error_description ?? json.error ?? 'Wordstat API error')
    const detail = String(json.error_detail ?? json.details ?? '')
    throw new Error(formatWordstatApiError(Number(code) || 0, message, detail))
  }

  return json
}

function wordstatHttpsText(path: string, credentials: WordstatCredentials, payload: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: WORDSTAT_API_HOST,
      path,
      method: 'POST',
      headers: {
        Authorization: credentials.authType === 'iam' ? `Bearer ${credentials.token}` : `Api-key ${credentials.token}`,
        'Accept-Language': 'ru',
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (res.statusCode && res.statusCode >= 400) {
          logRuntime('connector.wordstat.http_error', {
            status: res.statusCode,
            path,
            authType: credentials.authType,
            folderId: maskId(credentials.folderId),
            responseEmpty: text.length === 0,
            responsePreview: text ? text.slice(0, 240) : ''
          }, 'warn')
          reject(new Error(formatWordstatHttpError(res.statusCode, text, credentials.authType, path)))
          return
        }
        resolve(text)
      })
    })

    const onAbort = () => {
      req.destroy(new Error('aborted'))
    }
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    req.on('error', (err) => {
      signal.removeEventListener('abort', onAbort)
      reject(err)
    })
    req.on('close', () => signal.removeEventListener('abort', onAbort))
    req.write(payload)
    req.end()
  })
}

function formatWordstatHttpError(status: number, text: string, authType: WordstatAuthType, path = ''): string {
  let detail = text.slice(0, 300)
  try {
    const json = JSON.parse(text) as Record<string, unknown>
    detail = String(json.message ?? json.error ?? json.error_str ?? json.error_description ?? detail)
  } catch { /* raw text */ }

  const authHint = authType === 'iam'
    ? 'Проверьте IAM-токен, роль search-api.webSearch.user и идентификатор каталога'
    : 'Проверьте API-ключ Yandex AI Studio с областью yc.search-api.execute, роль search-api.webSearch.user и идентификатор каталога'

  if (status === 401 || status === 403) {
    return `Wordstat HTTP ${status}: доступ к Yandex Search API не принят. ${authHint}. ${detail}`.trim()
  }
  if (status === 404) {
    const methodHint = path ? ` Метод ${path} не найден.` : ''
    return `Wordstat HTTP 404:${methodHint} Проверьте актуальность endpoint Yandex Search API. ${detail}`.trim()
  }
  if (status === 429) {
    return `Wordstat HTTP 429: превышена квота Yandex Search API. ${detail}`.trim()
  }
  return `Wordstat HTTP ${status}: ${detail}`.trim()
}

function formatWordstatApiError(code: number, message: string, detail: string): string {
  const suffix = detail ? ` (${detail})` : ''
  return `Wordstat error ${code}: ${message}${suffix}`.trim()
}

// ----------------------------------------------------------------- parsing

function normalizeTopRequests(fallbackPhrase: string, data: Record<string, unknown>) {
  const top = mapPhraseCounts(data.results ?? data.topRequests ?? data.top_requests)
  const assoc = mapPhraseCounts(data.associations ?? data.searchedAlso ?? data.searched_also)
  const phrase = String(data.requestPhrase ?? data.phrase ?? fallbackPhrase)
  const totalCount = Number(data.totalCount ?? data.total_count ?? top[0]?.count ?? 0)

  return {
    phrase,
    total_count: totalCount,
    top_requests: top,
    associations: assoc,
    searched_with: top.map(item => ({ phrase: item.phrase, shows: item.count })),
    searched_also: assoc.map(item => ({ phrase: item.phrase, shows: item.count }))
  }
}

function flattenDynamics(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== 'object') return { dynamics: [] }
  const obj = data as Record<string, unknown>
  const series = obj.dynamics ?? obj.points ?? obj.data ?? obj
  return { dynamics: series }
}

function flattenRegions(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== 'object') return { regions: [] }
  const obj = data as Record<string, unknown>
  const rows = obj.regions ?? obj.regionStats ?? obj.results ?? obj.data ?? obj
  return { regions: rows }
}

function mapPhraseCounts(raw: unknown): PhraseCount[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((item) => {
      if (!item || typeof item !== 'object') return null
      const row = item as Record<string, unknown>
      const phrase = String(row.phrase ?? row.query ?? '').trim()
      const count = Number(row.count ?? row.shows ?? row.value ?? 0)
      if (!phrase) return null
      return { phrase, count }
    })
    .filter((x): x is PhraseCount => x != null)
}

function readRegions(args: Record<string, unknown>): string[] {
  const raw = (args.regions ?? args.geo_id ?? args.geoId) as unknown
  if (!Array.isArray(raw)) return []
  return raw
    .map(n => String(n).trim())
    .filter(n => /^\d+$/.test(n))
}

function readDevices(args: Record<string, unknown>): WordstatDevice[] {
  const raw = args.devices
  if (!Array.isArray(raw) || raw.length === 0) return ['DEVICE_ALL']
  const aliases: Record<string, WordstatDevice> = {
    all: 'DEVICE_ALL',
    device_all: 'DEVICE_ALL',
    desktop: 'DEVICE_DESKTOP',
    device_desktop: 'DEVICE_DESKTOP',
    phone: 'DEVICE_PHONE',
    device_phone: 'DEVICE_PHONE',
    tablet: 'DEVICE_TABLET',
    device_tablet: 'DEVICE_TABLET'
  }
  const out = raw
    .map(v => aliases[String(v).trim().toLowerCase()])
    .filter((v): v is WordstatDevice => Boolean(v))
  return out.length > 0 ? out : ['DEVICE_ALL']
}

function readNumPhrases(args: Record<string, unknown>): number {
  const n = Number(args.num_phrases ?? args.numPhrases ?? 50)
  if (!Number.isFinite(n) || n <= 0) return 50
  return Math.min(Math.floor(n), 2000)
}

function maskId(value = ''): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (trimmed.length <= 10) return `${trimmed.slice(0, 2)}...${trimmed.slice(-2)}`
  return `${trimmed.slice(0, 8)}...${trimmed.slice(-4)}`
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
