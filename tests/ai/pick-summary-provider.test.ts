import { describe, it, expect, vi } from 'vitest'
import { pickSummaryProvider, pickSummaryProviderGated } from '../../electron/ai/pick-summary-provider'
import { PROVIDERS } from '../../electron/ai/registry'
import type { ProviderId } from '../../electron/ai/registry'

/**
 * Срез 2.0.11-B: кем сжимать контекст.
 *
 * Главный сценарий здесь — человек на подписке: активным стоит claude-cli, и правило
 * «сжимаем только активным» сделало бы кнопку сжатия вечно серой. Фича есть, работать
 * не может. Поэтому проверяется именно запасной путь.
 */

const keys = (...ids: ProviderId[]) => {
  const set = new Set(ids.map(id => PROVIDERS[id].secretKey).filter(Boolean) as string[])
  return (k: string) => set.has(k)
}
const noModel = () => null

describe('выбор провайдера для summary', () => {
  it('активный API с ключом → он же (разговор и сжатие на одной модели)', () => {
    const c = pickSummaryProvider('claude', keys('claude'), noModel)
    expect(c?.providerId).toBe('claude')
    expect(c?.model).toBe(PROVIDERS['claude'].defaultModel)
  })

  it('уважает модель, выбранную пользователем', () => {
    const c = pickSummaryProvider('claude', keys('claude'), id => (id === 'claude' ? 'claude-haiku-4-5-20251001' : null))
    expect(c?.model).toBe('claude-haiku-4-5-20251001')
  })

  // Сценарий подписки: активен CLI. Без запасного пути кнопка сжатия была бы мертва.
  it('активен CLI, но есть API-ключ → сжимаем этим API, а не отказываем', () => {
    const c = pickSummaryProvider('claude-cli', keys('gemini-api'), noModel)
    expect(c?.providerId).toBe('gemini-api')
  })

  it('активный API без ключа → берём другой настроенный', () => {
    const c = pickSummaryProvider('claude', keys('gemini-api'), noModel)
    expect(c?.providerId).toBe('gemini-api')
  })

  it('ключей нет вовсе → null (честный отказ, а не тихая заглушка)', () => {
    expect(pickSummaryProvider('claude-cli', () => false, noModel)).toBeNull()
  })

  it('активного нет, ключ есть → берём настроенный', () => {
    expect(pickSummaryProvider(null, keys('openai'), noModel)?.providerId).toBe('openai')
  })

  // «Как повезёт» — плохой ответ: один и тот же набор ключей обязан давать один выбор.
  it('выбор детерминирован при нескольких ключах', () => {
    const k = keys('openai', 'gemini-api', 'claude')
    const first = pickSummaryProvider('claude-cli', k, noModel)
    for (let i = 0; i < 5; i++) {
      expect(pickSummaryProvider('claude-cli', k, noModel)?.providerId).toBe(first?.providerId)
    }
  })

  it('CLI-провайдер не выбирается запасным даже если «ключ» его есть', () => {
    const cliIds = (Object.keys(PROVIDERS) as ProviderId[]).filter(id => PROVIDERS[id].transport !== 'API')
    const c = pickSummaryProvider(null, () => true, noModel)
    expect(c).not.toBeNull()
    expect(cliIds).not.toContain(c!.providerId) // сжатие через CLI = сериализация всей истории
  })

  it('возвращает secretKey — вызывающему не нужно снова угадывать имя ключа', () => {
    expect(pickSummaryProvider('claude', keys('claude'), noModel)?.secretKey).toBe(PROVIDERS['claude'].secretKey)
  })
})


// ─── EF-R2 Б3: compaction — Codex через canonical resolver, без default ~/.codex ───

describe('EF-R2 Б3: gated summary provider (ручная компакция)', () => {
  const codexKeys = (...extra: ProviderId[]) => keys('openai-codex-oauth', ...extra)

  it('codex-oauth выбран + аккаунт готов → codexHome из resolver (configDir аккаунта)', () => {
    const c = pickSummaryProviderGated('openai-codex-oauth', codexKeys(), noModel,
      () => ({ configDir: '/home/user/.codex-acc-a' }))
    expect(c?.providerId).toBe('openai-codex-oauth')
    expect(c?.codexHome).toBe('/home/user/.codex-acc-a')
  })

  it('codex-oauth + allBlocked → fallback на ДРУГОЙ настроенный API (без codexHome)', () => {
    const c = pickSummaryProviderGated('openai-codex-oauth', codexKeys('gemini-api'), noModel,
      () => ({ allBlocked: true }))
    expect(c?.providerId).toBe('gemini-api')
    expect(c?.codexHome).toBeNull()
  })

  it('codex-oauth + blocked и других ключей нет → null (нейтральный отказ, НЕ default credential)', () => {
    const c = pickSummaryProviderGated('openai-codex-oauth', codexKeys(), noModel,
      () => ({ blocked: true }))
    expect(c).toBeNull()
  })

  it('codex-oauth + unavailable (аккаунт удалён) → тоже не default ~/.codex', () => {
    const c = pickSummaryProviderGated('openai-codex-oauth', codexKeys(), noModel,
      () => ({ unavailable: true }))
    expect(c).toBeNull()
  })

  it('codex-oauth + resolver вернул null (парка нет) → legacy-путь без codexHome', () => {
    const c = pickSummaryProviderGated('openai-codex-oauth', codexKeys(), noModel, () => null)
    expect(c?.providerId).toBe('openai-codex-oauth')
    expect(c?.codexHome).toBeNull()
  })

  it('выбран НЕ codex → resolver вообще не вызывается', () => {
    const resolve = vi.fn(() => ({ blocked: true }) as const)
    const c = pickSummaryProviderGated('claude', keys('claude'), noModel, resolve)
    expect(c?.providerId).toBe('claude')
    expect(c?.codexHome).toBeNull()
    expect(resolve).not.toHaveBeenCalled()
  })
})
