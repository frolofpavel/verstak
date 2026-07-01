/**
 * web_search движок — поиск в вебе без API-ключа и без зависимостей, через
 * HTML-эндпоинт DuckDuckGo (html.duckduckgo.com/html/). Возвращает title/url/
 * snippet; агент дальше выбирает ссылку и читает её через web_fetch.
 *
 * Тот же гейт web_access, что у web_fetch (ai.ts). SSRF-периметр не актуален
 * (хост фиксированный и публичный, пользовательский ввод только в query-string),
 * но лимиты/таймаут наследуются от fetchUrl.
 *
 * Ограничение: скрейп HTML DDG хрупок (может смениться разметка/прилететь капча).
 * V1-компромисс за keyless-поиск; при пустом парсе деградируем в «ничего не нашёл».
 */
import { fetchUrl, htmlToText, type FetchUrlOpts } from './web-fetch'

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

/** Развернуть редирект-обёртку DDG (`/l/?uddg=<encoded>`) в реальный URL. */
function decodeDdgHref(href: string): string {
  const m = /[?&]uddg=([^&]+)/.exec(href)
  if (m) {
    try { return decodeURIComponent(m[1]) } catch { /* оставим как есть */ }
  }
  if (href.startsWith('//')) return 'https:' + href
  return href
}

const RESULT_A_RE = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
const SNIPPET_RE = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi

function clean(html: string): string {
  return htmlToText(html).replace(/\s+/g, ' ').trim()
}

/** Разобрать HTML-выдачу DDG в список результатов (чистая функция — тестируема). */
export function parseDdgHtml(html: string, limit = 8): SearchResult[] {
  // Ревью L1: сниппет паруем к ссылке ПО ПОЗИЦИИ в документе (сниппет между этой
  // ссылкой и следующей), а не по индексу — иначе результат без своего сниппета
  // «крал» бы сниппет следующего (сдвиг). lastIndex сбрасываем — global-regex.
  const anchors: Array<{ index: number; url: string; title: string }> = []
  RESULT_A_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = RESULT_A_RE.exec(html))) {
    const url = decodeDdgHref(m[1])
    const title = clean(m[2])
    if (url && title) anchors.push({ index: m.index, url, title })
  }
  const snips: Array<{ index: number; text: string }> = []
  SNIPPET_RE.lastIndex = 0
  let s: RegExpExecArray | null
  while ((s = SNIPPET_RE.exec(html))) snips.push({ index: s.index, text: clean(s[1]) })

  const results: SearchResult[] = []
  for (let i = 0; i < anchors.length && results.length < limit; i++) {
    const a = anchors[i]
    const nextIdx = i + 1 < anchors.length ? anchors[i + 1].index : Infinity
    const snip = snips.find(sn => sn.index > a.index && sn.index < nextIdx)
    results.push({ title: a.title, url: a.url, snippet: snip ? snip.text : '' })
  }
  return results
}

export interface WebSearchOpts extends Pick<FetchUrlOpts, 'signal' | 'timeoutMs' | 'fetchImpl' | 'lookupImpl'> {
  limit?: number
}

/** Выполнить веб-поиск. Пустой запрос → [] без обращения к сети. */
export async function webSearch(query: string, opts: WebSearchOpts = {}): Promise<SearchResult[]> {
  const q = query.trim()
  if (!q) return []
  const endpoint = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`
  const res = await fetchUrl(endpoint, {
    raw: true,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs ?? 15_000,
    maxBytes: 1_500_000,
    fetchImpl: opts.fetchImpl,
    lookupImpl: opts.lookupImpl
  })
  return parseDdgHtml(res.text, opts.limit ?? 8)
}
