import { describe, expect, it, vi } from 'vitest'

import {
  executeSearch,
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
