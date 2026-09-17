import { describe, expect, it, vi } from 'vitest'

import {
  classifySearchIntent,
  createBraveSearchBackend,
  createConfiguredSearchBackends,
  createSearxngSearchBackend,
  createYandexSearchBackend,
  parseSearxngSearchJson,
  planSearchBackends,
} from '../../electron/headless/search-backends'
import type { SearchBackend } from '../../electron/headless/search-executor'

function backend(
  id: string,
  coverage: SearchBackend['coverage'],
  structured = true,
): SearchBackend {
  return {
    id,
    coverage,
    structured,
    search: vi.fn(async () => []),
  }
}

describe('Search backends P3', () => {
  it('нормализует structured XML Yandex и не выпускает provider payload', async () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
      <yandexsearch><response><results><grouping>
        <group><doc>
          <url>https://publication.pravo.gov.ru/document/0001202609170001?utm_source=test</url>
          <domain>publication.pravo.gov.ru</domain>
          <title>Официальное <hlword>опубликование</hlword> закона</title>
          <headline>Текст официального документа</headline>
          <mime-type>text/html</mime-type>
          <modtime>20260917T031500</modtime>
        </doc></group>
      </grouping></results></response></yandexsearch>`
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      rawData: Buffer.from(xml, 'utf8').toString('base64'),
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const search = createYandexSearchBackend({
      apiKey: 'test-key',
      folderId: 'test-folder',
      searchType: 'ru',
      fetchImpl,
    })

    const found = await search.search('действующая редакция закона', {
      signal: new AbortController().signal,
      timeoutMs: 1_000,
      limit: 5,
    })

    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(found).toEqual([expect.objectContaining({
      url: 'https://publication.pravo.gov.ru/document/0001202609170001?utm_source=test',
      canonicalUrl: 'https://publication.pravo.gov.ru/document/0001202609170001?utm_source=test',
      title: 'Официальное опубликование закона',
      snippet: 'Текст официального документа',
      rank: 1,
      backend: 'yandex_ru',
      language: 'ru',
      publishedAt: '2026-09-17T03:15:00.000Z',
      metadata: { mimeType: 'text/html' },
    })])
    expect(JSON.stringify(found)).not.toContain('rawData')
  })

  it('нормализует JSON Brave для мирового web', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      web: { results: [{
        url: 'https://openai.com/research/example',
        title: '<strong>OpenAI</strong> research',
        description: 'Original publication',
        language: 'en',
        page_age: '2026-09-16T10:00:00Z',
        profile: { long_name: 'OpenAI' },
        extra_snippets: ['must stay private to backend layer'],
      }] },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const search = createBraveSearchBackend({ apiKey: 'test-key', fetchImpl })

    const found = await search.search('OpenAI research', {
      signal: new AbortController().signal,
      timeoutMs: 1_000,
      limit: 5,
    })

    expect(found).toEqual([expect.objectContaining({
      url: 'https://openai.com/research/example',
      canonicalUrl: 'https://openai.com/research/example',
      title: 'OpenAI research',
      snippet: 'Original publication',
      backend: 'brave_global',
      language: 'en',
      publishedAt: '2026-09-16T10:00:00.000Z',
      metadata: { publisher: 'OpenAI' },
    })])
    expect(JSON.stringify(found)).not.toContain('extra_snippets')
  })

  it('различает RU, global и mixed и не запускает оба structured backend всегда', () => {
    const available = [
      backend('yandex_ru', 'ru'),
      backend('brave_global', 'global'),
      backend('duckduckgo_html', 'diagnostic', false),
    ]

    expect(classifySearchIntent('официальный текст закона России')).toBe('ru')
    expect(classifySearchIntent('Python 3.14 documentation')).toBe('global')
    expect(classifySearchIntent('сравни рынок России и global AI market')).toBe('mixed')
    expect(planSearchBackends('ru', available).map(wave => wave.map(item => item.id)))
      .toEqual([['yandex_ru'], ['brave_global'], ['duckduckgo_html']])
    expect(planSearchBackends('global', available).map(wave => wave.map(item => item.id)))
      .toEqual([['brave_global'], ['yandex_ru'], ['duckduckgo_html']])
    expect(planSearchBackends('mixed', available).map(wave => wave.map(item => item.id)))
      .toEqual([['yandex_ru', 'brave_global'], ['duckduckgo_html']])
  })

  it('конфигурирует независимый global backend раньше резервного Yandex COM', () => {
    const configured = createConfiguredSearchBackends({
      YANDEX_SEARCH_API_KEY: 'yandex-key',
      YANDEX_SEARCH_FOLDER_ID: 'folder',
      BRAVE_SEARCH_API_KEY: 'brave-key',
    })

    expect(configured.map(item => item.id)).toEqual([
      'yandex_ru', 'brave_global', 'yandex_global', 'duckduckgo_html',
    ])
    expect(createConfiguredSearchBackends({}).map(item => item.id)).toEqual(['duckduckgo_html'])
  })

  it('помечает rate limit структурированной ошибкой без секрета', async () => {
    const search = createBraveSearchBackend({
      apiKey: 'secret-must-not-leak',
      fetchImpl: vi.fn(async () => new Response('rate limited', { status: 429 })),
    })

    await expect(search.search('query', {
      signal: new AbortController().signal,
      timeoutMs: 1_000,
      limit: 5,
    })).rejects.toEqual(expect.objectContaining({
      errorClass: 'rate_limit',
      rateLimited: true,
      statusCode: 429,
    }))
  })
})

describe('Search backends P3.1 zero-cost retrieval', () => {
  it('нормализует SearXNG JSON и не выпускает названия внутренних engines', () => {
    const found = parseSearxngSearchJson({
      results: [{
        url: 'https://developers.openai.com/api/docs/responses',
        title: '<b>Responses API</b>',
        content: 'Official API documentation',
        publishedDate: '2026-09-17T10:00:00Z',
        engines: ['google', 'bing'],
        positions: [1, 2],
        score: 4.2,
      }],
      unresponsive_engines: [['duckduckgo', 'timeout']],
    }, 5)

    expect(found).toEqual([expect.objectContaining({
      url: 'https://developers.openai.com/api/docs/responses',
      title: 'Responses API',
      snippet: 'Official API documentation',
      backend: 'searxng_zero_cost',
      publishedAt: '2026-09-17T10:00:00.000Z',
    })])
    expect(JSON.stringify(found)).not.toContain('google')
    expect(JSON.stringify(found)).not.toContain('bing')
    expect(JSON.stringify(found)).not.toContain('duckduckgo')
  })

  it('кэширует только внутри tenant scope и сообщает hit/miss/bypass', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      results: [{ url: 'https://example.org/a', title: 'A', content: 'Body' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const search = createSearxngSearchBackend({
      baseUrl: 'http://127.0.0.1:8888',
      engines: ['google'],
      fetchImpl,
      cacheTtlMs: 60_000,
      cacheMaxEntries: 8,
    })
    const opts = { signal: new AbortController().signal, timeoutMs: 1_000, limit: 5 }

    const first = await search.search('  Same QUERY ', { ...opts, cacheScope: 'tenant-a' })
    const second = await search.search('same query', { ...opts, cacheScope: 'tenant-a' })
    const otherTenant = await search.search('same query', { ...opts, cacheScope: 'tenant-b' })
    const bypass = await search.search('same query', opts)

    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(Array.isArray(first) ? null : first.cacheStatus).toBe('miss')
    expect(Array.isArray(second) ? null : second.cacheStatus).toBe('hit')
    expect(Array.isArray(otherTenant) ? null : otherTenant.cacheStatus).toBe('miss')
    expect(Array.isArray(bypass) ? null : bypass.cacheStatus).toBe('bypass')
  })

  it('ставит SearXNG первым, а платные backend оставляет fallback', () => {
    const configured = createConfiguredSearchBackends({
      SEARXNG_SEARCH_URL: 'http://127.0.0.1:8888',
      SEARXNG_SEARCH_ENGINES: 'google,bing',
      YANDEX_SEARCH_API_KEY: 'yandex-key',
      YANDEX_SEARCH_FOLDER_ID: 'folder',
    })

    expect(configured.map(item => [item.id, item.costTier])).toEqual([
      ['searxng_zero_cost', 'zero'],
      ['yandex_ru', 'paid'],
      ['yandex_global', 'paid'],
      ['duckduckgo_html', 'diagnostic'],
    ])
  })
})
