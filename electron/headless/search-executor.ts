import { fetchUrl } from '../ai/web-fetch'
import { classifyFallbackReason } from '../ai/smart-fallback'
import type { ChatEvent, ChatProvider } from '../ai/types'
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
  /** True only when the candidate is a plausible primary source for this query. */
  isOfficialSource?: boolean
  score?: number
}

export interface SearchBackend {
  id: string
  coverage?: SearchBackendCoverage
  structured?: boolean
  costTier?: 'zero' | 'paid' | 'diagnostic'
  estimatedCost?: SearchCost
  search: (
    query: string,
    opts: { signal: AbortSignal; timeoutMs: number; limit: number; cacheScope?: string },
  ) => Promise<SearchCandidate[] | SearchBackendResponse>
}

export interface SearchBackendResponse {
  candidates: SearchCandidate[]
  cacheStatus?: 'hit' | 'miss' | 'bypass'
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
  cacheStatus: 'hit' | 'miss' | 'bypass' | null
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
  isOfficialSource?: boolean
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
  retrievalBackend: string | null
  attemptedBackends: string[]
  fallbackReason: 'zero_candidates' | 'insufficient_candidates' | 'retrieval_timeout' | 'retrieval_error' | 'insufficient_evidence' | null
  candidateCountByBackend: Record<string, number>
  normalizedCount: number
  paidBackendUsed: boolean
  paidBackendCalls: number
  estimatedSearchCost: SearchCost[]
  cacheHits: number
  cacheMisses: number
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
  cacheScope?: string
  allowPaidFallback?: boolean
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

/** Explicit user preference only. Merely mentioning a company/product must not
 * collapse normal mixed-source ranking into an official-only search. */
export function hasExplicitOfficialSourceIntent(query: string): boolean {
  const value = String(query || '')
  return /(?:только[^.!?]{0,48}официальн\S*|официальн\S*\s+(?:источник\S*|сайт\S*|документац\S*|документ\S*|текст\S*|публикац\S*|данн\S*)|по\s+данным\s+(?:правительств\S*|компани\S*|организац\S*))/.test(value.toLowerCase())
    || /(?:\bonly\b[^.!?]{0,48}\bofficial\b|\bofficial\s+(?:source|site|website|documentation|docs?|text|publication|data)\b|\baccording\s+to\s+(?:the\s+)?official\b)/i.test(value)
}

const PRIMARY_SOURCE_TYPES = new Set<PrimarySourceType>([
  'government', 'documentation', 'company', 'official', 'paper', 'repository',
])

function isOfficialSourceForQuery(
  query: string,
  item: SearchCandidate,
  sourceType: PrimarySourceType,
): boolean {
  if (sourceType === 'government' || sourceType === 'documentation') return true
  let host = ''
  try { host = new URL(item.url).hostname.toLowerCase().replace(/^www\./, '') } catch { return false }
  const queryTokens = normalizedTokens(query)
  const hostParts = host.split('.').filter(part => part.length >= 3 && !['com', 'org', 'net', 'gov', 'edu'].includes(part))
  const organizationMatches = hostParts.some(part => queryTokens.has(part))
  if (organizationMatches) return true
  return PRIMARY_SOURCE_TYPES.has(sourceType) && sourceType !== 'official'
}

function freshnessScore(value: string | null): number {
  if (!value) return 0
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return 0
  const days = Math.max(0, (Date.now() - timestamp) / 86_400_000)
  return Math.max(0, 1 - days / 730)
}

function candidateScore(
  query: string,
  item: SearchCandidate,
  sourceType: PrimarySourceType,
  isOfficialSource: boolean,
): number {
  const queryIsRu = /[а-яё]/i.test(query)
  const languageFit = item.language == null
    ? 0.5
    : queryIsRu === item.language.toLowerCase().startsWith('ru') ? 1 : 0.25
  const host = (() => { try { return new URL(item.url).hostname } catch { return '' } })()
  const geoFit = queryIsRu && (host.endsWith('.ru') || host.endsWith('.рф')) ? 1 : 0.4
  const officialIntentBoost = hasExplicitOfficialSourceIntent(query) && isOfficialSource ? 12 : 0
  return relevanceScore(query, item) * 4
    + sourceBoost(sourceType) * 3
    + (1 / Math.max(1, item.rank))
    + freshnessScore(item.publishedAt) * 0.5
    + languageFit * 0.25
    + geoFit * 0.15
    + officialIntentBoost
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
    item.isOfficialSource = isOfficialSourceForQuery(query, item, item.sourceType)
    item.score = candidateScore(query, item, item.sourceType, item.isOfficialSource)
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
  fallbackReason: SearchExecutionResult['fallbackReason'] = null,
): SearchExecutionResult {
  const telemetry = retrievalTelemetry(backendTraces, 0, fallbackReason)
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
    ...telemetry,
    timeoutReason,
    timings: { searchMs, fetchMs: 0, totalMs: Date.now() - startedAt },
  }
}

function backendCostTier(backend: SearchBackend): NonNullable<SearchBackend['costTier']> {
  if (backend.costTier) return backend.costTier
  if (backend.structured === false || backend.coverage === 'diagnostic') return 'diagnostic'
  return (backend.estimatedCost?.amount ?? 0) > 0 ? 'paid' : 'zero'
}

function retrievalTelemetry(
  traces: SearchBackendTrace[],
  normalizedCount: number,
  fallbackReason: SearchExecutionResult['fallbackReason'],
): Pick<SearchExecutionResult,
  'retrievalBackend' | 'attemptedBackends' | 'fallbackReason' | 'candidateCountByBackend'
  | 'normalizedCount' | 'paidBackendUsed' | 'paidBackendCalls' | 'estimatedSearchCost'
  | 'cacheHits' | 'cacheMisses'> {
  const attemptedBackends = [...new Set(traces.map(item => item.backend))]
  const candidateCountByBackend: Record<string, number> = {}
  const costs = new Map<SearchCost['currency'], number>()
  let paidBackendCalls = 0
  for (const trace of traces) {
    candidateCountByBackend[trace.backend] = (candidateCountByBackend[trace.backend] ?? 0) + trace.candidateCount
    if (trace.cost && trace.cost.amount > 0) {
      paidBackendCalls += 1
      costs.set(trace.cost.currency, (costs.get(trace.cost.currency) ?? 0) + trace.cost.amount)
    }
  }
  return {
    retrievalBackend: traces.find(item => item.candidateCount > 0)?.backend ?? null,
    attemptedBackends,
    fallbackReason,
    candidateCountByBackend,
    normalizedCount,
    paidBackendUsed: paidBackendCalls > 0,
    paidBackendCalls,
    estimatedSearchCost: [...costs].map(([currency, amount]) => ({ amount, currency })),
    cacheHits: traces.filter(item => item.cacheStatus === 'hit').length,
    cacheMisses: traces.filter(item => item.cacheStatus === 'miss').length,
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
  const retrievalLimit = Math.min(40, limit * 4)
  const evidenceTarget = Math.max(1, Math.floor(deps.evidenceTarget ?? DEFAULT_EVIDENCE_TARGET))
  const desiredCandidates = Math.min(limit, evidenceTarget)
  const rewrittenQuery = rewriteSearchQuery(query)
  const queries = rewrittenQuery && rewrittenQuery !== query ? [query, rewrittenQuery] : [query]
  const candidates: SearchCandidate[] = []
  const queriesAttempted: string[] = []
  const backendTraces: SearchBackendTrace[] = []
  const intent = classifySearchIntent(query)
  const plannedWaves = planSearchBackends(intent, backends)
  const wavesForTier = (tier: NonNullable<SearchBackend['costTier']>): SearchBackend[][] => plannedWaves
    .map(wave => wave.filter(item => backendCostTier(item) === tier))
    .filter(wave => wave.length > 0)
  let searchMs = 0
  let retrievalTimeoutReason: SearchExecutionResult['timeoutReason'] = null
  let fallbackReason: SearchExecutionResult['fallbackReason'] = null
  let paidAttempted = false

  deps.onStage?.('search')
  const retrieve = async (
    waves: SearchBackend[][],
    stopWhenEnough: boolean,
  ): Promise<void> => {
    const before = candidates.length
    for (const attemptedQuery of queries) {
      const traceStart = backendTraces.length
      for (const wave of waves) {
        if (stopWhenEnough && rankAndDedupeCandidates(candidates.slice(before), query, limit).length >= desiredCandidates) break
      const attemptResults = await Promise.all(wave.map(async searchBackend => {
        const attemptStarted = Date.now()
        queriesAttempted.push(attemptedQuery)
        try {
          const response = await withinBudget(
            signal => searchBackend.search(attemptedQuery, {
              signal,
              timeoutMs: budgets.searchMs,
              limit: retrievalLimit,
              cacheScope: deps.cacheScope,
            }),
            'search',
            budgets.searchMs,
            deadlineAt,
            deps.signal,
          )
          const found = Array.isArray(response) ? response : response.candidates
          const cacheStatus = Array.isArray(response) ? null : response.cacheStatus ?? null
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
            cacheStatus,
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
            cost: searchBackend.estimatedCost ?? null,
            errorClass: typeof details.errorClass === 'string'
              ? details.errorClass
              : timedOut ? 'timeout' : 'backend_error',
            rateLimited,
            cacheStatus: null,
          })
          if (timedOut && retrievalTimeoutReason == null) {
            retrievalTimeoutReason = error instanceof SearchTimeoutError ? error.stage : 'total'
          }
          return []
        }
      }))
      for (const found of attemptResults) candidates.push(...found)
      if (deps.signal?.aborted) break
    }
      if (candidates.length > before || deps.signal?.aborted) break
      if (backendTraces.slice(traceStart).some(item => item.status === 'error' || item.status === 'rate_limited' || item.status === 'timeout')) break
    }
  }

  await retrieve(wavesForTier('zero'), true)

  const allowPaidFallback = deps.allowPaidFallback
    ?? process.env.VERSTAK_SEARCH_PAID_FALLBACK_ENABLED !== '0'
  const runPaidFallback = async (reason: NonNullable<SearchExecutionResult['fallbackReason']>): Promise<void> => {
    const paidWaves = wavesForTier('paid')
    if (!allowPaidFallback || paidAttempted || paidWaves.length === 0) return
    fallbackReason ??= reason
    paidAttempted = true
    await retrieve(paidWaves, true)
  }

  let normalized = rankAndDedupeCandidates(candidates, query, limit)
  if (normalized.length === 0) {
    const zeroTraces = backendTraces.filter(trace => {
      const backend = backends.find(item => item.id === trace.backend)
      return backend != null && backendCostTier(backend) === 'zero'
    })
    const reason = zeroTraces.some(item => item.status === 'timeout')
      ? 'retrieval_timeout'
      : zeroTraces.some(item => item.status === 'error' || item.status === 'rate_limited')
        ? 'retrieval_error'
        : 'zero_candidates'
    await runPaidFallback(reason)
  } else if (normalized.length < desiredCandidates) {
    await runPaidFallback('insufficient_candidates')
  }

  normalized = rankAndDedupeCandidates(candidates, query, limit)
  if (normalized.length === 0) {
    await retrieve(wavesForTier('diagnostic'), true)
    normalized = rankAndDedupeCandidates(candidates, query, limit)
  }

  searchMs = backendTraces.reduce((sum, trace) => sum + trace.latencyMs, 0)
  for (const trace of backendTraces) {
    trace.acceptedCandidateCount = normalized.filter(item => candidateBackends(item).includes(trace.backend)).length
  }
  if (!normalized.length) {
    const allFailed = backendTraces.length > 0 && backendTraces.every(item => item.status === 'error' || item.status === 'rate_limited' || item.status === 'timeout')
    return emptyResult(
      retrievalTimeoutReason && allFailed ? 'timeout' : allFailed ? 'backend_error' : 'no_results',
      query,
      rewrittenQuery,
      backendIds,
      startedAt,
      searchMs,
      retrievalTimeoutReason,
      queriesAttempted,
      backendTraces,
      fallbackReason,
    )
  }

  const fetchStartedAt = Date.now()
  deps.onStage?.('fetch')
  const fetchPage = deps.fetchPage ?? defaultFetch
  const minEvidenceChars = Math.max(1, Math.floor(deps.minEvidenceChars ?? DEFAULT_MIN_EVIDENCE_CHARS))
  const concurrency = Math.max(1, Math.min(8, Math.floor(deps.fetchConcurrency ?? DEFAULT_CONCURRENCY)))
  const evidence: SearchEvidence[] = []
  const fetches: SearchFetchTrace[] = []
  const fetchedUrls = new Set<string>()

  const fetchCandidates = async (batch: SearchCandidate[]): Promise<void> => {
    const active = new Set<AbortController>()
    let cursor = 0
    let reachedTarget = evidence.length >= evidenceTarget
    const worker = async (): Promise<void> => {
      while (!reachedTarget) {
      const index = cursor
      cursor += 1
      if (index >= batch.length) return
      const item = batch[index]
      if (fetchedUrls.has(item.url)) continue
      fetchedUrls.add(item.url)
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
            isOfficialSource: item.isOfficialSource === true,
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
    await Promise.all(Array.from({ length: Math.min(concurrency, batch.length) }, () => worker()))
  }

  await fetchCandidates(normalized)

  if (evidence.length < evidenceTarget && !paidAttempted) {
    const before = candidates.length
    await runPaidFallback('insufficient_evidence')
    if (candidates.length > before) {
      normalized = rankAndDedupeCandidates(candidates, query, limit + evidenceTarget)
      await fetchCandidates(normalized.filter(item => !fetchedUrls.has(item.url)))
    }
  }

  searchMs = backendTraces.reduce((sum, trace) => sum + trace.latencyMs, 0)
  normalized = rankAndDedupeCandidates(candidates, query, limit)
  for (const trace of backendTraces) {
    trace.acceptedCandidateCount = normalized.filter(item => candidateBackends(item).includes(trace.backend)).length
  }

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

  if (hasExplicitOfficialSourceIntent(query)) {
    evidence.sort((a, b) => Number(b.isOfficialSource === true) - Number(a.isOfficialSource === true)
      || b.score - a.score
      || a.rank - b.rank)
  }

  const telemetry = retrievalTelemetry(backendTraces, normalized.length, fallbackReason)
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
    ...telemetry,
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
  const officialIntent = hasExplicitOfficialSourceIntent(result.originalQuery)
  const orderedEvidence = officialIntent
    ? [...result.evidence].sort((a, b) => Number(b.isOfficialSource === true) - Number(a.isOfficialSource === true)
      || b.score - a.score
      || a.rank - b.rank)
    : result.evidence
  const perSourceChars = Math.max(500, Math.floor(24_000 / Math.max(1, result.evidence.length)))
  const sources = orderedEvidence.map((item, index) => [
    `[${index + 1}] ${item.title || new URL(item.url).hostname}`,
    `URL: ${item.url}`,
    officialIntent ? `Тип: ${item.isOfficialSource === true ? 'официальный/primary' : 'secondary'}` : '',
    item.publishedAt ? `Дата публикации: ${item.publishedAt}` : '',
    `Проверенный текст:\n${item.text.slice(0, perSourceChars)}`,
  ].filter(Boolean).join('\n')).join('\n\n')
  return [
    'Ты синтезируешь ответ по уже загруженным источникам Search Executor.',
    'Используй только приведённые ниже материалы. Не добавляй факты из памяти модели.',
    'Для проверяемых утверждений ставь ссылки на источники в формате [1], [2].',
    'Если материалов недостаточно для части запроса, прямо назови ограничение.',
    officialIntent
      ? orderedEvidence.some(item => item.isOfficialSource === true)
        ? 'Пользователь явно запросил официальный источник: опирайся прежде всего на отмеченные официальные/primary источники; secondary используй только для контекста и не называй secondary-источник официальным.'
        : 'Пользователь явно запросил официальный источник, но подтверждённый primary не найден: прямо скажи об этом и не называй secondary-источник официальным.'
      : '',
    '',
    sources,
  ].join('\n')
}

export interface SearchSynthesisRetryHooks {
  onAttempt?: (attempt: number) => void
  onRetry?: (details: { attempt: number; errorClass: string; statusCode: number | null }) => void
  onFailure?: (details: { attempts: number; errorClass: string; statusCode: number | null }) => void
  onSuccess?: (attempts: number) => void
}

function synthesisFailure(message: string): { retryable: boolean; errorClass: string; statusCode: number | null } {
  const statusMatch = message.match(/\b([45]\d\d)\b/)
  const statusCode = statusMatch ? Number(statusMatch[1]) : null
  const reason = classifyFallbackReason(Object.assign(new Error(message), statusCode == null ? {} : { status: statusCode }))
  const retryable = reason === 'provider_network'
    || reason === 'provider_rate_limit'
    || /internal server error|upstream|temporar(?:y|ily)|service unavailable/i.test(message)
  return { retryable, errorClass: reason, statusCode }
}

function synthesisCommitsOutput(event: ChatEvent): boolean {
  return event.type === 'text' && event.text.length > 0
    || event.type === 'tool-call'
    || event.type === 'pending-write'
    || event.type === 'pending-command'
    || event.type === 'command-result'
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
  hooks: SearchSynthesisRetryHooks = {},
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
      try {
        const maxAttempts = 2
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          hooks.onAttempt?.(attempt)
          const iterator = delegate.send(messages, [], toolResults, ctrl.signal)[Symbol.asyncIterator]()
          const buffered: ChatEvent[] = []
          let committed = false
          let retry = false
          try {
            for (;;) {
              const next = await Promise.race([iterator.next(), timeout])
              if (next.done) {
                for (const bufferedEvent of buffered) yield bufferedEvent
                hooks.onSuccess?.(attempt)
                return
              }
              const event = next.value
              if (event.type === 'error') {
                const failure = synthesisFailure(event.message)
                if (!committed && failure.retryable && attempt < maxAttempts && !signal?.aborted) {
                  hooks.onRetry?.({ attempt, errorClass: failure.errorClass, statusCode: failure.statusCode })
                  retry = true
                  void iterator.return?.()
                  break
                }
                for (const bufferedEvent of buffered) yield bufferedEvent
                hooks.onFailure?.({ attempts: attempt, errorClass: failure.errorClass, statusCode: failure.statusCode })
                yield event
                return
              }
              if (event.type === 'done') {
                for (const bufferedEvent of buffered) yield bufferedEvent
                hooks.onSuccess?.(attempt)
                yield event
                return
              }
              if (!committed && synthesisCommitsOutput(event)) {
                committed = true
                for (const bufferedEvent of buffered) yield bufferedEvent
                buffered.length = 0
                yield event
              } else if (committed) {
                yield event
              } else {
                buffered.push(event)
              }
            }
          } catch (error) {
            if (timedOut) throw error
            const failure = synthesisFailure(errorText(error))
            if (!committed && failure.retryable && attempt < maxAttempts && !signal?.aborted) {
              hooks.onRetry?.({ attempt, errorClass: failure.errorClass, statusCode: failure.statusCode })
              retry = true
              void iterator.return?.()
            } else {
              hooks.onFailure?.({ attempts: attempt, errorClass: failure.errorClass, statusCode: failure.statusCode })
              throw error
            }
          }
          if (!retry) return
        }
      } catch (error) {
        if (!timedOut) throw error
        onTimeout()
        yield { type: 'text', text: controlledSearchMessage('timeout') }
        yield { type: 'done' }
      } finally {
        if (timer) clearTimeout(timer)
        detach()
      }
    },
  }
}
