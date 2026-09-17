import { webSearch } from '../ai/web-search'
import { fetchUrl } from '../ai/web-fetch'
import type { ChatProvider } from '../ai/types'

export type SearchExecutionStatus =
  | 'success'
  | 'partial_success'
  | 'no_results'
  | 'no_evidence'
  | 'timeout'
  | 'backend_error'
  | 'fetch_error'
  | 'quality_rejected'

export interface SearchCandidate {
  url: string
  title: string
  snippet: string
  rank: number
  backend: string
  language: string | null
  publishedAt: string | null
  metadata: Record<string, unknown>
}

export interface SearchBackend {
  id: string
  search: (
    query: string,
    opts: { signal: AbortSignal; timeoutMs: number; limit: number },
  ) => Promise<SearchCandidate[]>
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

function canonicalizeUrl(raw: string): string | null {
  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    parsed.hash = ''
    parsed.hostname = parsed.hostname.toLowerCase()
    if ((parsed.protocol === 'https:' && parsed.port === '443') || (parsed.protocol === 'http:' && parsed.port === '80')) {
      parsed.port = ''
    }
    return parsed.toString().replace(/\/$/, parsed.pathname === '/' && !parsed.search ? '' : '/')
  } catch {
    return null
  }
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

function defaultBackend(): SearchBackend {
  return {
    id: 'duckduckgo_html',
    async search(query, opts) {
      const results = await webSearch(query, {
        signal: opts.signal,
        timeoutMs: opts.timeoutMs,
        limit: opts.limit,
      })
      return results.map((item, index) => ({
        url: item.url,
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

function dedupeCandidates(input: SearchCandidate[], limit: number): SearchCandidate[] {
  const seen = new Set<string>()
  const result: SearchCandidate[] = []
  for (const item of input) {
    const url = canonicalizeUrl(item.url)
    if (!url || seen.has(url)) continue
    seen.add(url)
    result.push({
      url,
      title: String(item.title || '').trim(),
      snippet: String(item.snippet || '').trim(),
      rank: Number.isFinite(item.rank) ? item.rank : result.length + 1,
      backend: String(item.backend || 'unknown'),
      language: item.language ? String(item.language) : null,
      publishedAt: item.publishedAt ? String(item.publishedAt) : null,
      metadata: item.metadata && typeof item.metadata === 'object' ? item.metadata : {},
    })
    if (result.length >= limit) break
  }
  return result
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
  const backends = deps.backends?.length ? deps.backends : [defaultBackend()]
  const backendIds = backends.map(item => item.id)
  const limit = Math.max(1, Math.min(20, Math.floor(deps.limit ?? DEFAULT_LIMIT)))
  const rewrittenQuery = rewriteSearchQuery(query)
  const queries = rewrittenQuery && rewrittenQuery !== query ? [query, rewrittenQuery] : [query]
  const candidates: SearchCandidate[] = []
  const queriesAttempted: string[] = []
  let searchMs = 0
  let backendFailures = 0

  deps.onStage?.('search')
  for (let backendIndex = 0; backendIndex < backends.length && candidates.length === 0; backendIndex += 1) {
    const searchBackend = backends[backendIndex]
    for (let queryIndex = 0; queryIndex < queries.length && candidates.length === 0; queryIndex += 1) {
      const attemptStarted = Date.now()
      queriesAttempted.push(queries[queryIndex])
      try {
        const found = await withinBudget(
          signal => searchBackend.search(queries[queryIndex], {
            signal,
            timeoutMs: budgets.searchMs,
            limit,
          }),
          'search',
          budgets.searchMs,
          deadlineAt,
          deps.signal,
        )
        candidates.push(...dedupeCandidates(found, limit))
      } catch (error) {
        if (error instanceof SearchTimeoutError) {
          return emptyResult(
            'timeout', query, rewrittenQuery, backendIds, startedAt,
            searchMs + Date.now() - attemptStarted, error.stage, queriesAttempted,
          )
        }
        if (deps.signal?.aborted || isAbortError(error)) {
          return emptyResult(
            'timeout', query, rewrittenQuery, backendIds, startedAt,
            searchMs + Date.now() - attemptStarted, 'total', queriesAttempted,
          )
        }
        backendFailures += 1
      } finally {
        searchMs += Date.now() - attemptStarted
      }
    }
  }

  const normalized = dedupeCandidates(candidates, limit)
  if (!normalized.length) {
    return emptyResult(
      backendFailures === backends.length * queries.length ? 'backend_error' : 'no_results',
      query,
      rewrittenQuery,
      backendIds,
      startedAt,
      searchMs,
      null,
      queriesAttempted,
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
        const finalUrl = canonicalizeUrl(fetched.finalUrl) ?? item.url
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
