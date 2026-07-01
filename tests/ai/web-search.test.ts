import { describe, it, expect } from 'vitest'
import { parseDdgHtml, webSearch } from '../../electron/ai/web-search'

// Фрагмент, повторяющий разметку html.duckduckgo.com/html/ (result__a + result__snippet,
// href через редирект-обёртку /l/?uddg=...).
const DDG_HTML = `
<div class="result results_links">
  <h2 class="result__title">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&rut=abc">Example <b>Docs</b></a>
  </h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs">Официальная документация &amp; гайды.</a>
</div>
<div class="result results_links">
  <h2 class="result__title">
    <a class="result__a" href="https://direct.example.org/page">Direct Link</a>
  </h2>
  <a class="result__snippet">Второй результат.</a>
</div>
`

describe('web-search — parseDdgHtml', () => {
  it('извлекает title/url/snippet, декодирует uddg-редирект', () => {
    const r = parseDdgHtml(DDG_HTML)
    expect(r).toHaveLength(2)
    expect(r[0].url).toBe('https://example.com/docs')
    expect(r[0].title).toBe('Example Docs')
    expect(r[0].snippet).toContain('документация & гайды')
  })
  it('прямой href (без обёртки) сохраняется как есть', () => {
    const r = parseDdgHtml(DDG_HTML)
    expect(r[1].url).toBe('https://direct.example.org/page')
    expect(r[1].title).toBe('Direct Link')
  })
  it('лимит числа результатов соблюдается', () => {
    expect(parseDdgHtml(DDG_HTML, 1)).toHaveLength(1)
  })
  it('пустой/мусорный html → []', () => {
    expect(parseDdgHtml('')).toEqual([])
    expect(parseDdgHtml('<div>ничего</div>')).toEqual([])
  })
  it('результат без своего сниппета НЕ крадёт сниппет следующего (ревью L1)', () => {
    // Первый результат без result__snippet, второй — со сниппетом. При спаривании по
    // индексу сниппет второго прилип бы к первому (сдвиг). По позиции — корректно.
    const html = `
      <a class="result__a" href="https://a.example/1">Первый без сниппета</a>
      <a class="result__a" href="https://b.example/2">Второй</a>
      <a class="result__snippet">Сниппет ВТОРОГО.</a>
    `
    const r = parseDdgHtml(html)
    expect(r).toHaveLength(2)
    expect(r[0].snippet).toBe('')                  // первому — пусто, не украл
    expect(r[1].snippet).toContain('Сниппет ВТОРОГО')
  })
})

describe('web-search — webSearch (инъекция fetch)', () => {
  const okLookup = async () => [{ address: '93.184.216.34', family: 4 }]

  it('пустой запрос → [] без сети', async () => {
    let called = false
    const fakeFetch = async () => { called = true; return new Response('') }
    expect(await webSearch('   ', { fetchImpl: fakeFetch, lookupImpl: okLookup })).toEqual([])
    expect(called).toBe(false)
  })

  it('запрос → распарсенные результаты', async () => {
    const fakeFetch = async () => new Response(DDG_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
    const r = await webSearch('example docs', { fetchImpl: fakeFetch, lookupImpl: okLookup })
    expect(r).toHaveLength(2)
    expect(r[0].url).toBe('https://example.com/docs')
  })

  it('запрос уходит на html.duckduckgo.com с encode', async () => {
    let seenUrl = ''
    const fakeFetch = async (input: string | URL) => { seenUrl = String(input); return new Response(DDG_HTML) }
    await webSearch('русский запрос', { fetchImpl: fakeFetch as typeof fetch, lookupImpl: okLookup })
    expect(seenUrl).toContain('html.duckduckgo.com')
    expect(seenUrl).toContain(encodeURIComponent('русский запрос'))
  })
})
