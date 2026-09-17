import { describe, expect, it, vi } from 'vitest'

import {
  detectPrimarySourceType,
  executeSearch,
  rankAndDedupeCandidates,
  type SearchBackend,
  type SearchCandidate,
  type SearchFetchResult,
} from '../../electron/headless/search-executor'

const candidate = (url: string, rank: number): SearchCandidate => ({
  url,
  title: `Документ ${rank}`,
  snippet: `Описание ${rank}`,
  rank,
  backend: 'test',
  language: 'ru',
  publishedAt: null,
  metadata: {},
})

function backend(results: SearchCandidate[]): SearchBackend {
  return {
    id: 'test',
    search: vi.fn(async () => results),
  }
}

function page(url: string, text = 'Проверенный текст '.repeat(30)): SearchFetchResult {
  return { finalUrl: url, status: 200, contentType: 'text/html', text, truncated: false }
}

describe('Search Executor P2', () => {
  it('нормализует URL, убирает дубли и считает только реально прочитанные страницы evidence', async () => {
    const primary = backend([
      candidate('https://example.org/report#part', 1),
      candidate('https://EXAMPLE.org/report', 2),
      candidate('https://blocked.example/doc', 3),
    ])
    const fetchPage = vi.fn(async (item: SearchCandidate) => {
      if (item.url.includes('blocked')) return { ...page(item.url), status: 403, text: '' }
      return page(item.url)
    })

    const result = await executeSearch('официальный отчёт', {
      backends: [primary],
      fetchPage,
    })

    expect(result.status).toBe('partial_success')
    expect(result.candidateCount).toBe(2)
    expect(result.fetchAttempted).toBe(2)
    expect(result.evidence).toHaveLength(1)
    expect(result.evidence[0].url).toBe('https://example.org/report')
    expect(result.fetches.find(item => item.status === 403)?.usable).toBe(false)
  })

  it('при нуле candidates делает ровно один ограниченный rewrite и возвращает no_results', async () => {
    const primary = backend([])
    const result = await executeSearch(
      'Найди действующую редакцию закона. Дай ссылку и кратко объясни.',
      { backends: [primary], fetchPage: vi.fn() },
    )

    expect(result.status).toBe('no_results')
    expect(primary.search).toHaveBeenCalledTimes(2)
    expect(result.rewrittenQuery).not.toBe(result.originalQuery)
    expect(result.fetchAttempted).toBe(0)
  })

  it('отличает найденные, но недоступные страницы от пустой выдачи', async () => {
    const result = await executeSearch('закрытые источники', {
      backends: [backend([candidate('https://closed.example/a', 1)])],
      fetchPage: vi.fn(async item => ({ ...page(item.url), status: 403, text: '' })),
    })

    expect(result.status).toBe('no_evidence')
    expect(result.candidateCount).toBe(1)
    expect(result.usableEvidenceCount).toBe(0)
  })

  it('отличает системный transport failure fetch от no_evidence', async () => {
    const result = await executeSearch('источник с сетевой ошибкой', {
      backends: [backend([candidate('https://broken.example/a', 1)])],
      fetchPage: vi.fn(async () => { throw new Error('DNS unavailable') }),
    })

    expect(result.status).toBe('fetch_error')
    expect(result.fetchRejected).toBe(1)
  })

  it('помечает слишком короткие 2xx страницы как quality_rejected', async () => {
    const result = await executeSearch('пустая страница', {
      backends: [backend([candidate('https://thin.example/a', 1)])],
      fetchPage: vi.fn(async item => page(item.url, 'слишком коротко')),
    })

    expect(result.status).toBe('quality_rejected')
    expect(result.evidence).toEqual([])
  })

  it('ограничивает зависший search backend собственным timeout', async () => {
    const hanging: SearchBackend = {
      id: 'hang',
      search: vi.fn(() => new Promise<SearchCandidate[]>(() => {})),
    }
    const started = Date.now()
    const result = await executeSearch('зависший поиск', {
      backends: [hanging],
      fetchPage: vi.fn(),
      budgets: { searchMs: 15, fetchMs: 15, totalMs: 50 },
    })

    expect(result.status).toBe('timeout')
    expect(result.timeoutReason).toBe('search')
    expect(Date.now() - started).toBeLessThan(500)
  })

  it('после достаточного evidence set не запускает оставшиеся fetch', async () => {
    const fetchPage = vi.fn(async (item: SearchCandidate) => page(item.url))
    const result = await executeSearch('много источников', {
      backends: [backend([
        candidate('https://one.example/a', 1),
        candidate('https://two.example/a', 2),
        candidate('https://three.example/a', 3),
        candidate('https://four.example/a', 4),
      ])],
      fetchPage,
      evidenceTarget: 2,
      fetchConcurrency: 1,
    })

    expect(result.status).toBe('success')
    expect(result.evidence).toHaveLength(2)
    expect(fetchPage).toHaveBeenCalledTimes(2)
  })
})

describe('Search Executor P3 retrieval and ranking', () => {
  it('убирает tracking variants, объединяет backend и предпочитает первоисточник перепечатке', () => {
    const ranked = rankAndDedupeCandidates([
      {
        ...candidate('https://publication.pravo.gov.ru/document/42?utm_source=mail', 3),
        title: 'Официальное опубликование федерального закона 42',
        backend: 'yandex_ru',
      },
      {
        ...candidate('https://publication.pravo.gov.ru/document/42?yclid=123', 1),
        title: 'Официальное опубликование федерального закона 42',
        backend: 'brave_global',
      },
      {
        ...candidate('https://news.example/repost', 1),
        title: 'Официальное опубликование федерального закона 42',
        backend: 'brave_global',
      },
    ], 'федеральный закон 42', 8)

    expect(ranked).toHaveLength(1)
    expect(ranked[0]).toEqual(expect.objectContaining({
      url: 'https://publication.pravo.gov.ru/document/42',
      canonicalUrl: 'https://publication.pravo.gov.ru/document/42',
      sourceType: 'government',
    }))
    expect(ranked[0].metadata.backends).toEqual(expect.arrayContaining(['yandex_ru', 'brave_global']))
  })

  it('оценивает первоисточник по смыслу запроса, а не по языку', () => {
    const ranked = rankAndDedupeCandidates([
      { ...candidate('https://blog.example.ru/python-3-14', 1), title: 'Пересказ Python 3.14' },
      { ...candidate('https://docs.python.org/3.14/whatsnew/3.14.html', 5), title: 'What is new in Python 3.14', language: 'en' },
      { ...candidate('https://openai.com/research/example', 4), title: 'OpenAI research release', language: 'en' },
      { ...candidate('https://ru-news.example/openai', 1), title: 'Пересказ исследования OpenAI' },
    ], 'Python 3.14 documentation OpenAI research', 8)

    expect(ranked.slice(0, 2).map(item => item.url)).toEqual([
      'https://docs.python.org/3.14/whatsnew/3.14.html',
      'https://openai.com/research/example',
    ])
    expect(detectPrimarySourceType('https://github.com/org/repo', 'repo', 'repo')).toBe('repository')
    expect(detectPrimarySourceType('https://arxiv.org/abs/1234.5678', 'paper', 'paper')).toBe('paper')
  })

  it('сохраняет telemetry каждого backend и считает accepted после общего ranking', async () => {
    const limited: SearchBackend = {
      id: 'yandex_ru', coverage: 'ru', structured: true,
      estimatedCost: { amount: 0.488, currency: 'RUB' },
      search: vi.fn(async () => {
        const error = new Error('rate limited') as Error & {
          errorClass: string; rateLimited: boolean; statusCode: number
        }
        error.errorClass = 'rate_limit'; error.rateLimited = true; error.statusCode = 429
        throw error
      }),
    }
    const global: SearchBackend = {
      id: 'brave_global', coverage: 'global', structured: true,
      estimatedCost: { amount: 0.005, currency: 'USD' },
      search: vi.fn(async () => [candidate('https://openai.com/research/example', 1)]),
    }
    const result = await executeSearch('сравни рынок России и global AI market', {
      backends: [limited, global],
      fetchPage: vi.fn(async item => page(item.url)),
    })

    expect(result.status).toBe('success')
    expect(result.backendTraces).toEqual(expect.arrayContaining([
      expect.objectContaining({
        backend: 'yandex_ru', status: 'rate_limited', candidateCount: 0,
        acceptedCandidateCount: 0, rateLimited: true, errorClass: 'rate_limit',
      }),
      expect.objectContaining({
        backend: 'brave_global', status: 'success', candidateCount: 1,
        acceptedCandidateCount: 1, rateLimited: false,
        cost: { amount: 0.005, currency: 'USD' },
      }),
    ]))
    expect(result.evidence[0].url).toBe('https://openai.com/research/example')
  })

  it('не вызывает diagnostic DDG, когда structured primary дал достаточно candidates', async () => {
    const primary: SearchBackend = {
      id: 'yandex_ru', coverage: 'ru', structured: true,
      search: vi.fn(async () => [1, 2, 3, 4].map(index => ({
        ...candidate(`https://official-${index}.example/doc`, index),
        backend: 'yandex_ru',
      }))),
    }
    const diagnostic: SearchBackend = {
      id: 'duckduckgo_html', coverage: 'diagnostic', structured: false,
      search: vi.fn(async () => [candidate('https://fallback.example/doc', 1)]),
    }

    const result = await executeSearch('документы российского рынка', {
      backends: [primary, diagnostic],
      fetchPage: vi.fn(async item => page(item.url)),
    })

    expect(primary.search).toHaveBeenCalledOnce()
    expect(diagnostic.search).not.toHaveBeenCalled()
    expect(result.backendTraces.map(item => item.backend)).toEqual(['yandex_ru'])
  })

  it('использует diagnostic DDG только после degradation structured backend', async () => {
    const primary: SearchBackend = {
      id: 'yandex_ru', coverage: 'ru', structured: true,
      search: vi.fn(async () => { throw new Error('upstream unavailable') }),
    }
    const diagnostic: SearchBackend = {
      id: 'duckduckgo_html', coverage: 'diagnostic', structured: false,
      search: vi.fn(async () => [candidate('https://fallback.example/doc', 1)]),
    }

    const result = await executeSearch('документы российского рынка', {
      backends: [primary, diagnostic],
      fetchPage: vi.fn(async item => page(item.url)),
    })

    expect(primary.search).toHaveBeenCalledOnce()
    expect(diagnostic.search).toHaveBeenCalledOnce()
    expect(result.status).toBe('success')
    expect(result.backendTraces.map(item => item.backend)).toEqual(['yandex_ru', 'duckduckgo_html'])
  })
})
