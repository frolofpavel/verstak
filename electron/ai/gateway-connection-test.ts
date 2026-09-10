import { EXTRA_PROVIDERS } from './extra-providers'

export interface GatewayConnectionResult {
  ok: boolean
  message: string
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Pick<Response, 'ok' | 'status'>>

function gatewayUrls(): string[] {
  const gateway = EXTRA_PROVIDERS.find(provider => provider.id === 'verstak-gateway')
  if (!gateway?.baseUrl) return []
  return [gateway.baseUrl, gateway.fallbackBaseUrl]
    .filter((value): value is string => Boolean(value))
    .map(value => `${value.replace(/\/$/, '')}/usage`)
}

/**
 * Проверяет ключ бесплатным запросом к учёту Gateway. Содержимое ответа не читаем:
 * оно не нужно для решения и не должно попадать в renderer или логи.
 */
export async function testGatewayConnection(
  apiKey: string,
  fetchImpl: FetchLike = fetch
): Promise<GatewayConnectionResult> {
  const key = apiKey.trim()
  if (!key) return { ok: false, message: 'Вставьте API-ключ IRI Gateway.' }

  let lastStatus: number | null = null
  for (const url of gatewayUrls()) {
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(12_000),
      })
      lastStatus = response.status
      if (response.ok) return { ok: true, message: 'Ключ работает. IRI Gateway подключён.' }
      if (response.status === 401) {
        return { ok: false, message: 'Ключ не принят. Скопируйте его заново из кабинета IRI Gateway.' }
      }
      if (response.status === 403) {
        return { ok: false, message: 'Ключ найден, но доступ ещё не активен. Подтвердите email в кабинете IRI Gateway.' }
      }
      // Ошибка самого релея может исчезнуть на прямом endpoint — пробуем запасной.
      if (response.status >= 500) continue
      return { ok: false, message: `IRI Gateway вернул ошибку ${response.status}. Проверьте ключ и доступ в кабинете.` }
    } catch {
      // Сетевой отказ основного РФ-релея не делает ключ невалидным: есть прямой fallback.
    }
  }

  return {
    ok: false,
    message: lastStatus
      ? `IRI Gateway временно недоступен (ошибка ${lastStatus}). Попробуйте ещё раз.`
      : 'Не удалось связаться с IRI Gateway. Проверьте интернет и попробуйте ещё раз.',
  }
}
