import { fetchUrl } from '../ai/web-fetch'
import type { ChatProvider } from '../ai/types'
import {
  classifySearchIntent,
  createConfiguredSearchBackends,
  planSearchBackends,
} from './search-backends'

export type SearchExecutionStatus =
  | 'success'
  | 'partial_success'
  | 'no_results'
  | 'no_evidence'
  | 'timeout'
  | 'backend_error'
  | 'fetch_error'
  | 'quality_rejected'

export type SearchIntent = 'ru' | 'global' | 'mixed'
export type SearchBackendCoverage = SearchIntent | 'diagnostic'
export type PrimarySourceType =
  | 'official'
  | 'government'
  | 'company'
  | 'documentation'
  | 'paper'
  | 'repository'
  | 'media'
  | 'aggregator'
  | 'secondary'

export interface SearchCost {
  amount: number
  currency: 'RUB' | 'USD'
}

export interface SearchCandidate {
  url: string
  canonicalUrl?: string | null
  title: string
  snippet: string
  rank: number
  backend: string
  language: string | null
  publishedAt: string | null
  metadata: Record<string, unknown>
  sourceType?: PrimarySourceType
  score?: number
}

export interface SearchBackend {
  id: string
  coverage?: SearchBackendCoverage
  structured?: boolean
  estimatedCost?: SearchCost
  search: (
    query: string,
    opts: { signal: AbortSignal; timeoutMs: number; limit: number },
  ) => Promise<SearchCandidate[]>
}

export interface SearchBackendTrace {
  backend: string
  query: string
  latencyMs: number
  status: 'success' | 'no_results' | 'error' | 'rate_limited' | 'timeout'
  candidateCount: number
  acceptedCandidateCount: number
  cost: SearchCost | null
  errorClass: string | null
  rateLimited: boolean
}

export interface SearchFetchResult {
  finalUrl: string
  status: number
  contentType: string
  text: string
  truncated: boolean
}

export interface SearchEvidence {
  url: string
  title: string
  snippet: string
  backend: string
  rank: number
  language: string | null
  publishedAt: string | null
  sourceType: PrimarySourceType
  score: number
  contentType: string
  text: string
  truncated: boolean
}

export interface SearchFetchTrace {
  url: string
  finalUrl: string | null
  status: number | null
  bodyChars: number
  usable: boolean
  reason: string | null
  elapsedMs: number
}

export interface SearchExecutionResult {
  status: SearchExecutionStatus
  originalQuery: string
  rewrittenQuery: string | null
  queriesAttempted: string[]
  backends: string[]
  candidateCount: number
  fetchAttempted: number
  fetchSuccess: number
  fetchRejected: number
  usableEvidenceCount: number
  evidence: SearchEvidence[]
  fetches: SearchFetchTrace[]
  backendTraces: SearchBackendTrace[]
  timeoutReason: 'search' | 'fetch' | 'total' | null
  timings: {
    searchMs: number
    fetchMs: number
    totalMs: number
  }
}

export interface SearchExecutionBudgets {
  searchMs: number
  fetchMs: number
  totalMs: number
}

export interface SearchExecutorDeps {
  backends?: SearchBackend[]
  fetchPage?: (
    candidate: SearchCandidate,
    opts: { signal: AbortSignal; timeoutMs: number },
  ) => Promise<SearchFetchResult>
  budgets?: Partial<SearchExecutionBudgets>
  signal?: AbortSignal
  limit?: number
  fetchConcurrency?: number
  evidenceTarget?: number
  minEvidenceChars?: number
  onStage?: (stage: 'search' | 'fetch') => void
}

const DEFAULT_BUDGETS: SearchExecutionBudgets = {
  searchMs: 8_000,
  fetchMs: 8_000,
  totalMs: 30_000,
}
const DEFAULT_LIMIT = 8
const DEFAULT_CONCURRENCY = 3
const DEFAULT_EVIDENCE_TARGET = 4
const DEFAULT_MIN_EVIDENCE_CHARS = 200
const MAX_EVIDENCE_CHARS = 12_000
const TRACKING_QUERY_KEYS = new Set([
  'fbclid', 'gclid', 'yclid', 'msclkid', 'ref', 'referrer', 'source',
])

class SearchTimeoutError extends Error {
  constructor(readonly stage: 'search' | 'fetch' | 'total') {
    super(`search timeout: ${stage}`)
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 180)
  return String(error).slice(0, 180)
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || /abort/i.test(error.message))
}

export function canonicalizeSearchUrl(raw: string): string | null {
  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    parsed.hash = ''
    parsed.hostname = parsed.hostname.toLowerCase()
    if ((parsed.protocol === 'https:' && parsed.port === '443') || (parsed.protocol === 'http:' && parsed.port === '80')) {
      parsed.port = ''
    }
    for (const key of [...parsed.searchParams.keys()]) {
      if (key.toLowerCase().startsWith('utm_') || TRACKING_QUERY_KEYS.has(key.toLowerCase())) {
        parsed.searchParams.delete(key)
      }
    }
    parsed.searchParams.sort()
    if (parsed.pathname !== '/') parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/'
    return parsed.toString().replace(/\/$/, parsed.pathname === '/' && !parsed.search ? '' : '/')
  } catch {
    return null
  }
}

const GOVERNMENT_HOSTS = [
  'government.ru', 'kremlin.ru', 'pravo.gov.ru', 'publication.pravo.gov.ru',
]
const REPOSITORY_HOSTS = ['github.com', 'gitlab.com', 'codeberg.org', 'sourcecraft.dev']
const PAPER_HOSTS = ['arxiv.org', 'doi.org', 'pubmed.ncbi.nlm.nih.gov', 'aclanthology.org']
const MEDIA_HOSTS = [
  'reuters.com', 'apnews.com', 'bbc.com', 'bbc.co.uk', 'tass.ru', 'interfax.ru',
  'rbc.ru', 'kommersant.ru',
]
const AGGREGATOR_HOSTS = ['news.google.com', 'dzen.ru', 'news.mail.ru', 'medium.com']

function hostMatches(hostname: string, domains: string[]): boolean {
  return domains.some(domain => hostname === domain || hostname.endsWith(`.${domain}`))
}

export function detectPrimarySourceType(url: string, title: string, snippet: string): PrimarySourceType {
  let parsed: URL
  try { parsed = new URL(url) } catch { return 'secondary' }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '')
  const path = parsed.pathname.toLowerCase()
  const text = `${title} ${snippet}`.toLowerCase()
  if (host.endsWith('.gov.ru') || hostMatches(host, GOVERNMENT_HOSTS)) return 'government'
  if (hostMatches(host, REPOSITORY_HOSTS)) return 'repository'
  if (hostMatches(host, PAPER_HOSTS)) return 'paper'
  if (host.startsWith('docs.') || host.startsWith('developer.') || /\/(?:docs?|documentation|reference|manual)(?:\/|$)/.test(path) || host === 'learn.microsoft.com') {
    return 'documentation'
  }
  if (hostMatches(host, AGGREGATOR_HOSTS)) return 'aggregator'
  if (hostMatches(host, MEDIA_HOSTS)) return 'media'
  if (/\b(?:официальн\S*|official)\b/i.test(text)) return 'official'
  const brand = host.split('.')[0].replace(/[^a-zа-яё0-9]/gi, '')
  if (brand.length >= 4 && text.replace(/[^a-zа-яё0-9]/gi, '').includes(brand)) return 'company'
  return 'secondary'
}

function normalizedTokens(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[a-zа-яё0-9]{2,}/gi) ?? [])
}

function relevanceScore(query: string, item: SearchCandidate): number {
  const queryTokens = normalizedTokens(query)
  if (!queryTokens.size) return 0
  const itemTokens = normalizedTokens(`${item.title} ${item.snippet} ${item.url}`)
  let matches = 0
  for (const token of queryTokens) if (itemTokens.has(token)) matches += 1
  return matches / queryTokens.size
}

function sourceBoost(type: PrimarySourceType): number {
  return {
    government: 1,
    documentation: 0.95,
    paper: 0.92,
    repository: 0.9,
    company: 0.86,
    official: 0.82,
    media: 0.45,
    secondary: 0.2,
    aggregator: 0,
  }[type]
}

function freshnessScore(value: string | null): number {
  if (!value) return 0
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return 0
  const days = Math.max(0, (Date.now() - timestamp) / 86_400_000)
  return Math.max(0, 1 - days / 730)
}

function candidateScore(query: string, item: SearchCandidate, sourceType: PrimarySourceType): number {
  const queryIsRu = /[а-яё]/i.test(query)
  const languageFit = item.language == null
    ? 0.5
    : queryIsRu === item.language.toLowerCase().startsWith('ru') ? 1 : 0.25
  const host = (() => { try { return new URL(item.url).hostname } catch { return '' } })()
  const geoFit = queryIsRu && (host.endsWith('.ru') || host.endsWith('.рф')) ? 1 : 0.4
  return relevanceScore(query, item) * 4
    + sourceBoost(sourceType) * 3
    + (1 / Math.max(1, item.rank))
    + freshnessScore(item.publishedAt) * 0.5
    + languageFit * 0.25
    + geoFit * 0.15
}

function titleFingerprint(title: string): string | null {
  const normalized = title.toLowerCase().replace(/[^a-zа-яё0-9]+/gi, ' ').replace(/\s+/g, ' ').trim()
  return normalized.length >= 24 ? normalized : null
}

function candidateBackends(item: SearchCandidate): string[] {
  const existing = Array.isArray(item.metadata?.backends)
    ? item.metadata.backends.filter((value): value is string => typeof value === 'string')
    : []
  return [...new Set([item.backend, ...existing])]
}

function mergeCandidates(preferred: SearchCandidate, other: SearchCandidate): SearchCandidate {
  const backends = [...new Set([...candidateBackends(preferred), ...candidateBackends(other)])]
  return {
    ...preferred,
    snippet: preferred.snippet || other.snippet,
    publishedAt: preferred.publishedAt || other.publishedAt,
    metadata: { ...other.metadata, ...preferred.metadata, backends },
  }
}

export function rankAndDedupeCandidates(
  input: SearchCandidate[],
  query: string,
  limit: number,
): SearchCandidate[] {
  const normalized: SearchCandidate[] = []
  for (const raw of input) {
    const url = canonicalizeSearchUrl(raw.canonicalUrl || raw.url)
    if (!url) continue
    const item: SearchCandidate = {
      ...raw,
      url,
      canonicalUrl: url,
      title: String(raw.title || '').trim(),
      snippet: String(raw.snippet || '').trim(),
      rank: Number.isFinite(raw.rank) ? raw.rank : normalized.length + 1,
      backend: String(raw.backend || 'unknown'),
      language: raw.language ? String(raw.language) : null,
      publishedAt: raw.publishedAt ? String(raw.publishedAt) : null,
      metadata: raw.metadata && typeof raw.metadata === 'object'
        ? { ...raw.metadata, backends: candidateBackends(raw) }
        : { backends: [String(raw.backend || 'unknown')] },
    }
    item.sourceType = detectPrimarySourceType(item.url, item.title, item.snippet)
    item.score = candidateScore(query, item, item.sourceType)
    normalized.push(item)
  }
  normalized.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.rank - b.rank)

  const byUrl = new Map<string, SearchCandidate>()
  for (const item of normalized) {
    const current = byUrl.get(item.url)
    byUrl.set(item.url, current ? mergeCandidates(current, item) : item)
  }
  const byTitle = new Map<string, SearchCandidate>()
  const withoutTitle: SearchCandidate[] = []
  for (const item of byUrl.values()) {
    const fingerprint = titleFingerprint(item.title)
    if (!fingerprint) {
      withoutTitle.push(item)
      continue
    }
    const current = byTitle.get(fingerprint)
    if (!current) byTitle.set(fingerprint, item)
    else {
      const preferred = (item.score ?? 0) > (current.score ?? 0) ? item : current
      const other = preferred === item ? current : item
      byTitle.set(fingerprint, mergeCandidates(preferred, other))
    }
  }
  const deduped = [...byTitle.values(), ...withoutTitle]
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.rank - b.rank)
  const result: SearchCandidate[] = []
  const hostCounts = new Map<string, number>()
  for (const item of deduped) {
    const host = new URL(item.url).hostname.replace(/^www\./, '')
    const count = hostCounts.get(host) ?? 0
    if (count >= 2 && deduped.length > limit) continue
    hostCounts.set(host, count + 1)
    result.push(item)
    if (result.length >= limit) break
  }
  return result
}

export function rewriteSearchQuery(query: string): string {
  const compact = query.replace(/\s+/g, ' ').trim()
  const firstRequest = compact.split(/(?<=[.!?])\s+/)[0] || compact
  const withoutLead = firstRequest.replace(/^(?:пожалуйста,?\s*)?(?:найди|поищи|проверь)\s+/i, '')
  const rewritten = withoutLead
    .replace(/\b(?:дай|укажи|добавь)\s+ссылк\S*.*$/i, '')
    .replace(/\b(?:кратко\s+)?(?:объясни|расскажи).*$/i, '')
    .trim()
  const base = rewritten || withoutLead || compact
  return `${base.slice(0, 240)} официальный источник`.replace(/\s+/g, ' ').trim()
}

async function defaultFetch(
  candidate: SearchCandidate,
  opts: { signal: AbortSignal; timeoutMs: number },
): Promise<SearchFetchResult> {
  return fetchUrl(candidate.url, {
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
    maxBytes: 800_000,
  })
}

function relayAbort(source: AbortSignal | undefined, target: AbortController): () => void {
  if (!source) return () => {}
  const abort = (): void => target.abort()
  if (source.aborted) target.abort()
  else source.addEventListener('abort', abort, { once: true })
  return () => source.removeEventListener('abort', abort)
}

async function withinBudget<T>(
  work: (signal: AbortSignal) => Promise<T>,
  stage: 'search' | 'fetch',
  stageMs: number,
  deadlineAt: number,
  outerSignal?: AbortSignal,
): Promise<T> {
  const remaining = deadlineAt - Date.now()
  if (remaining <= 0) throw new SearchTimeoutError('total')
  const timeoutMs = Math.max(1, Math.min(stageMs, remaining))
  const ctrl = new AbortController()
  const detach = relayAbort(outerSignal, ctrl)
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      work(ctrl.signal),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          ctrl.abort()
          reject(new SearchTimeoutError(timeoutMs === remaining ? 'total' : stage))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
    detach()
  }
}

function emptyResult(
  status: SearchExecutionStatus,
  query: string,
  rewrittenQuery: string | null,
  backends: string[],
  startedAt: number,
  searchMs: number,
  timeoutReason: SearchExecutionResult['timeoutReason'] = null,
  queriesAttempted: string[] = [],
  backendTraces: SearchBackendTrace[] = [],
): SearchExecutionResult {
  return {
    status,
    originalQuery: query,
    rewrittenQuery,
    queriesAttempted,
    backends,
    candidateCount: 0,
    fetchAttempted: 0,
    fetchSuccess: 0,
    fetchRejected: 0,
    usableEvidenceCount: 0,
    evidence: [],
    fetches: [],
    backendTraces,
    timeoutReason,
    timings: { searchMs, fetchMs: 0, totalMs: Date.now() - startedAt },
  }
}

export async function executeSearch(
  rawQuery: string,
  deps: SearchExecutorDeps = {},
): Promise<SearchExecutionResult> {
  const startedAt = Date.now()
  const query = rawQuery.replace(/\s+/g, ' ').trim()
  const budgets = { ...DEFAULT_BUDGETS, ...deps.budgets }
  const deadlineAt = startedAt + Math.max(1, budgets.totalMs)
  const backends = deps.backends?.length ? deps.backends : createConfiguredSearchBackends()
  const backendIds = backends.map(item => item.id)
  const limit = Math.max(1, Math.min(20, Math.floor(deps.limit ?? DEFAULT_LIMIT)))
  const desiredCandidates = Math.min(limit, DEFAULT_EVIDENCE_TARGET)
  const rewrittenQuery = rewriteSearchQuery(query)
  const queries = rewrittenQuery && rewrittenQuery !== query ? [query, rewrittenQuery] : [query]
  const candidates: SearchCandidate[] = []
  const queriesAttempted: string[] = []
  const backendTraces: SearchBackendTrace[] = []
  const intent = classifySearchIntent(query)
  const waves = planSearchBackends(intent, backends)
  let searchMs = 0
  let backendFailures = 0
  let retrievalTimeoutReason: SearchExecutionResult['timeoutReason'] = null

  deps.onStage?.('search')
  for (const attemptedQuery of queries) {
    for (const wave of waves) {
      if (rankAndDedupeCandidates(candidates, query, limit).length >= desiredCandidates) break
      const attemptResults = await Promise.all(wave.map(async searchBackend => {
        const attemptStarted = Date.now()
        queriesAttempted.push(attemptedQuery)
        try {
          const found = await withinBudget(
            signal => searchBackend.search(attemptedQuery, {
              signal,
              timeoutMs: budgets.searchMs,
              limit,
            }),
            'search',
            budgets.searchMs,
            deadlineAt,
            deps.signal,
          )
          const latencyMs = Date.now() - attemptStarted
          backendTraces.push({
            backend: searchBackend.id,
            query: attemptedQuery,
            latencyMs,
            status: found.length ? 'success' : 'no_results',
            candidateCount: found.length,
            acceptedCandidateCount: 0,
            cost: searchBackend.estimatedCost ?? null,
            errorClass: null,
            rateLimited: false,
          })
          return found.map(item => ({ ...item, backend: searchBackend.id }))
        } catch (error) {
          const latencyMs = Date.now() - attemptStarted
          const details = error as {
            errorClass?: unknown; rateLimited?: unknown; statusCode?: unknown
          }
          const timedOut = error instanceof SearchTimeoutError || deps.signal?.aborted || isAbortError(error)
          const rateLimited = details.rateLimited === true || details.statusCode === 429
          backendTraces.push({
            backend: searchBackend.id,
            query: attemptedQuery,
            latencyMs,
            status: timedOut ? 'timeout' : rateLimited ? 'rate_limited' : 'error',
            candidateCount: 0,
            acceptedCandidateCount: 0,
            cost: null,
            errorClass: typeof details.errorClass === 'string'
              ? details.errorClass
              : timedOut ? 'timeout' : 'backend_error',
            rateLimited,
          })
          backendFailures += 1
          if (timedOut && retrievalTimeoutReason == null) {
            retrievalTimeoutReason = error instanceof SearchTimeoutError ? error.stage : 'total'
          }
          return []
        }
      }))
      for (const found of attemptResults) candidates.push(...found)
      if (deps.signal?.aborted) break
    }
    if (candidates.length > 0 || deps.signal?.aborted) break
  }

  searchMs = backendTraces.reduce((sum, trace) => sum + trace.latencyMs, 0)
  const normalized = rankAndDedupeCandidates(candidates, query, limit)
  for (const trace of backendTraces) {
    trace.acceptedCandidateCount = normalized.filter(item => candidateBackends(item).includes(trace.backend)).length
  }
  if (!normalized.length) {
    return emptyResult(
      retrievalTimeoutReason ? 'timeout' : backendFailures === backendTraces.length ? 'backend_error' : 'no_results',
      query,
      rewrittenQuery,
      backendIds,
      startedAt,
      searchMs,
      retrievalTimeoutReason,
      queriesAttempted,
      backendTraces,
    )
  }

  const fetchStartedAt = Date.now()
  deps.onStage?.('fetch')
  const fetchPage = deps.fetchPage ?? defaultFetch
  const evidenceTarget = Math.max(1, Math.floor(deps.evidenceTarget ?? DEFAULT_EVIDENCE_TARGET))
  const minEvidenceChars = Math.max(1, Math.floor(deps.minEvidenceChars ?? DEFAULT_MIN_EVIDENCE_CHARS))
  const concurrency = Math.max(1, Math.min(8, Math.floor(deps.fetchConcurrency ?? DEFAULT_CONCURRENCY)))
  const evidence: SearchEvidence[] = []
  const fetches: SearchFetchTrace[] = []
  const active = new Set<AbortController>()
  let cursor = 0
  let reachedTarget = false

  const worker = async (): Promise<void> => {
    while (!reachedTarget) {
      const index = cursor
      cursor += 1
      if (index >= normalized.length) return
      const item = normalized[index]
      const itemStartedAt = Date.now()
      const ctrl = new AbortController()
      const detachOuter = relayAbort(deps.signal, ctrl)
      active.add(ctrl)
      try {
        const fetched = await withinBudget(
          signal => fetchPage(item, { signal, timeoutMs: budgets.fetchMs }),
          'fetch',
          budgets.fetchMs,
          deadlineAt,
          ctrl.signal,
        )
        const finalUrl = canonicalizeSearchUrl(fetched.finalUrl) ?? item.url
        const body = String(fetched.text || '').trim()
        const okStatus = fetched.status >= 200 && fetched.status < 300
        const usable = okStatus && body.length >= minEvidenceChars
        const reason = usable
          ? null
          : !okStatus
            ? `http_${fetched.status}`
            : body.length === 0
              ? 'empty_body'
              : 'body_too_short'
        fetches.push({
          url: item.url,
          finalUrl,
          status: fetched.status,
          bodyChars: body.length,
          usable,
          reason,
          elapsedMs: Date.now() - itemStartedAt,
        })
        if (usable) {
          evidence.push({
            url: finalUrl,
            title: item.title,
            snippet: item.snippet,
            backend: item.backend,
            rank: item.rank,
            language: item.language,
            publishedAt: item.publishedAt,
            sourceType: item.sourceType ?? 'secondary',
            score: item.score ?? 0,
            contentType: fetched.contentType,
            text: body.slice(0, MAX_EVIDENCE_CHARS),
            truncated: fetched.truncated || body.length > MAX_EVIDENCE_CHARS,
          })
          if (evidence.length >= evidenceTarget) {
            reachedTarget = true
            for (const pending of active) {
              if (pending !== ctrl) pending.abort()
            }
          }
        }
      } catch (error) {
        const cancelledAfterThreshold = reachedTarget && (ctrl.signal.aborted || isAbortError(error))
        if (!cancelledAfterThreshold) {
          fetches.push({
            url: item.url,
            finalUrl: null,
            status: null,
            bodyChars: 0,
            usable: false,
            reason: error instanceof SearchTimeoutError ? `timeout_${error.stage}` : errorText(error),
            elapsedMs: Date.now() - itemStartedAt,
          })
        }
      } finally {
        active.delete(ctrl)
        detachOuter()
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, normalized.length) }, () => worker()))

  const fetchSuccess = fetches.filter(item => item.usable).length
  const fetchRejected = fetches.filter(item => !item.usable).length
  const transportFailures = fetches.filter(item => item.status === null).length
  const qualityFailures = fetches.filter(item => item.status != null && item.status >= 200 && item.status < 300 && !item.usable).length
  let status: SearchExecutionStatus
  let timeoutReason: SearchExecutionResult['timeoutReason'] = null
  if (evidence.length > 0) {
    status = fetchRejected > 0 ? 'partial_success' : 'success'
  } else if (fetches.some(item => item.reason?.startsWith('timeout_'))) {
    status = 'timeout'
    timeoutReason = fetches.some(item => item.reason === 'timeout_total') ? 'total' : 'fetch'
  } else if (transportFailures === fetches.length) {
    status = 'fetch_error'
  } else if (qualityFailures > 0) {
    status = 'quality_rejected'
  } else {
    status = 'no_evidence'
  }

  return {
    status,
    originalQuery: query,
    rewrittenQuery,
    queriesAttempted,
    backends: backendIds,
    candidateCount: normalized.length,
    fetchAttempted: fetches.length,
    fetchSuccess,
    fetchRejected,
    usableEvidenceCount: evidence.length,
    evidence,
    fetches,
    backendTraces,
    timeoutReason,
    timings: {
      searchMs,
      fetchMs: Date.now() - fetchStartedAt,
      totalMs: Date.now() - startedAt,
    },
  }
}

export function controlledSearchMessage(status: SearchExecutionStatus): string {
  if (status === 'no_results') return 'Не удалось найти подходящие источники. Попробуйте уточнить запрос и повторить поиск.'
  if (status === 'no_evidence' || status === 'fetch_error' || status === 'quality_rejected') {
    return 'Источники найдены, но не удалось надёжно проверить их содержимое. Попробуйте повторить поиск позже.'
  }
  if (status === 'timeout') return 'Поиск занял слишком много времени и был остановлен. Попробуйте повторить запрос.'
  if (status === 'backend_error') return 'Сейчас не удалось обратиться к поиску. Попробуйте повторить запрос позже.'
  return ''
}

export function searchEvidencePrompt(result: SearchExecutionResult): string {
  const sources = result.evidence.map((item, index) => [
    `[${index + 1}] ${item.title || new URL(item.url).hostname}`,
    `URL: ${item.url}`,
    item.publishedAt ? `Дата публикации: ${item.publishedAt}` : '',
    `Проверенный текст:\n${item.text}`,
  ].filter(Boolean).join('\n')).join('\n\n')
  return [
    'Ты синтезируешь ответ по уже загруженным источникам Search Executor.',
    'Используй только приведённые ниже материалы. Не добавляй факты из памяти модели.',
    'Для проверяемых утверждений ставь ссылки на источники в формате [1], [2].',
    'Если материалов недостаточно для части запроса, прямо назови ограничение.',
    '',
    sources,
  ].join('\n')
}

/** Детерминированный ответ controlled failure проходит через обычный runner,
 * поэтому тред, done/status и durable assistant message остаются теми же. */
export function staticSearchProvider(text: string): ChatProvider {
  return {
    id: 'search-controlled',
    name: 'Search controlled result',
    models: ['search-controlled'],
    async *send() {
      yield { type: 'text', text }
      yield { type: 'done' }
    },
  }
}

/** Жёсткий остаточный budget синтеза. Abort передаётся реальному провайдеру, а
 * наружу вместо generic server error выходит управляемый search timeout. */
export function boundedSearchProvider(
  delegate: ChatProvider,
  deadlineAt: number,
  onTimeout: () => void,
): ChatProvider {
  return {
    id: delegate.id,
    name: delegate.name,
    models: delegate.models,
    async *send(messages, _tools, toolResults, signal) {
      const remaining = deadlineAt - Date.now()
      if (remaining <= 0) {
        onTimeout()
        yield { type: 'text', text: controlledSearchMessage('timeout') }
        yield { type: 'done' }
        return
      }

      const ctrl = new AbortController()
      const detach = relayAbort(signal, ctrl)
      let timedOut = false
      let timer: ReturnType<typeof setTimeout> | null = null
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true
          ctrl.abort()
          reject(new SearchTimeoutError('total'))
        }, remaining)
      })
      // Search synthesis is evidence-only. Do not merely deny tool execution in
      // the runner: hide the shared tool catalogue from the model as well, so it
      // cannot decide to start a second, unbounded retrieval path.
      const iterator = delegate.send(messages, [], toolResults, ctrl.signal)[Symbol.asyncIterator]()
      try {
        for (;;) {
          const next = await Promise.race([iterator.next(), timeout])
          if (next.done) break
          yield next.value
        }
      } catch (error) {
        if (!timedOut) throw error
        onTimeout()
        void iterator.return?.()
        yield { type: 'text', text: controlledSearchMessage('timeout') }
        yield { type: 'done' }
      } finally {
        if (timer) clearTimeout(timer)
        detach()
      }
    },
  }
}
