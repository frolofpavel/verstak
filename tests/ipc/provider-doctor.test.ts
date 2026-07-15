// Срез 2.0.7-E: кеш живого каталога (TTL) + гейт модели перед child-процессом.
// Acceptance карточки: сохранённый grok-build, которого НЕТ в живом каталоге, НЕ уходит
// в backend (блокируется с вариантами), но когда каталога ещё нет — не гадаем и не ломаем.
import { describe, it, expect } from 'vitest'
import {
  saveLiveCatalog, loadLiveCatalog, catalogStatus, checkModelAvailable,
  catalogKey, CATALOG_TTL_MS, type CatalogStore,
} from '../../electron/ai/model-catalog-service'

function memStore(): CatalogStore & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return { data, get: k => data.get(k) ?? null, set: (k, v) => { data.set(k, v) } }
}

const T0 = 1_000_000_000_000 // фиксируем «сейчас» — детерминизм без Date.now()

describe('model-catalog-service: кеш только id+timestamp, TTL 24ч', () => {
  it('save → load возвращает id/дефолт/источник/authenticated, срок = now+24ч', () => {
    const s = memStore()
    const e = saveLiveCatalog(s, 'grok-cli', { models: ['grok-4.5', 'grok-composer-2.5-fast'], defaultModel: 'grok-4.5', authenticated: true }, T0)
    expect(e.ids).toEqual(['grok-4.5', 'grok-composer-2.5-fast'])
    expect(e.defaultModel).toBe('grok-4.5')
    expect(e.source).toBe('cli-live')
    expect(e.authenticated).toBe(true)
    expect(e.expiresAt).toBe(T0 + CATALOG_TTL_MS)
    const loaded = loadLiveCatalog(s, 'grok-cli')
    expect(loaded).toEqual(e)
  })

  it('в кеш попадают ТОЛЬКО обезличенные поля (нет токенов/путей/сырого stdout)', () => {
    const s = memStore()
    saveLiveCatalog(s, 'grok-cli', { models: ['grok-4.5'], defaultModel: 'grok-4.5', authenticated: true }, T0)
    const raw = s.data.get(catalogKey('grok-cli'))!
    const obj = JSON.parse(raw)
    expect(Object.keys(obj).sort()).toEqual(['authenticated', 'defaultModel', 'expiresAt', 'fetchedAt', 'ids', 'providerId', 'source'])
  })

  it('битый JSON в кеше → null, не падение', () => {
    const s = memStore()
    s.data.set(catalogKey('grok-cli'), '{не json')
    expect(loadLiveCatalog(s, 'grok-cli')).toBeNull()
  })

  it('старая запись без authenticated → консервативно false (не блокировать по ней)', () => {
    const s = memStore()
    s.data.set(catalogKey('grok-cli'), JSON.stringify({ providerId: 'grok-cli', source: 'cli-live', ids: ['grok-4.5'], defaultModel: 'grok-4.5', fetchedAt: T0, expiresAt: T0 + CATALOG_TTL_MS }))
    expect(loadLiveCatalog(s, 'grok-cli')!.authenticated).toBe(false)
  })

  it('статус: нет записи=unknown, свежая=available, протухшая=stale', () => {
    const s = memStore()
    expect(catalogStatus(null, T0)).toBe('unknown')
    const e = saveLiveCatalog(s, 'grok-cli', { models: ['grok-4.5'], defaultModel: 'grok-4.5', authenticated: true }, T0)
    expect(catalogStatus(e, T0)).toBe('available')
    expect(catalogStatus(e, T0 + CATALOG_TTL_MS + 1)).toBe('stale')
  })
})

describe('checkModelAvailable — гейт перед child-процессом (шаг 6)', () => {
  const fresh = { providerId: 'grok-cli', source: 'cli-live' as const, ids: ['grok-4.5', 'grok-composer-2.5-fast'], defaultModel: 'grok-4.5', authenticated: true, fetchedAt: T0, expiresAt: T0 + CATALOG_TTL_MS }

  it('ACCEPTANCE: сохранённый grok-build отсутствует в живом каталоге → блок + варианты', () => {
    const g = checkModelAvailable(fresh, 'grok-build', T0)
    expect(g.ok).toBe(false)
    expect(g.reasonCode).toBe('MODEL_UNAVAILABLE')
    expect(g.available).toEqual(['grok-4.5', 'grok-composer-2.5-fast'])
    expect(g.suggested).toBe('grok-4.5') // one-click repair — дефолт живого каталога
  })

  it('модель есть в живом каталоге → пропуск', () => {
    expect(checkModelAvailable(fresh, 'grok-4.5', T0).ok).toBe(true)
  })

  it('нет каталога (никогда не обнаруживали) → НЕ блокируем (unknown, не гадаем)', () => {
    expect(checkModelAvailable(null, 'grok-build', T0).ok).toBe(true)
  })

  it('каталог протух → НЕ блокируем (не уверены; doctor обновит)', () => {
    expect(checkModelAvailable(fresh, 'grok-build', T0 + CATALOG_TTL_MS + 1).ok).toBe(true)
  })

  it('НЕаутентифицированный каталог → НЕ блокируем (может быть неполным, ложно отсёк бы)', () => {
    // Реальный факт: unauth `grok models` отдаёт статический (возможно неполный) список.
    const unauth = { ...fresh, authenticated: false }
    expect(checkModelAvailable(unauth, 'grok-build', T0).ok).toBe(true)
  })

  it('ПУСТОЙ аутентифицированный каталог → НЕ блокируем (ревью F1: иначе самоблок ВСЕГО на 24ч)', () => {
    // grok сменил маркер списка / ANSI / пагинация → 0 моделей при exit 0 + logged in.
    // Из пустого списка нельзя подтвердить отсутствие → блокировать нельзя (даже дефолт).
    const empty = { ...fresh, ids: [], defaultModel: null }
    expect(checkModelAvailable(empty, 'grok-4.5', T0).ok).toBe(true)
    expect(checkModelAvailable(empty, 'grok-build', T0).ok).toBe(true)
  })

  it("'auto'/пустая модель → пропуск (CLI выберет сам)", () => {
    expect(checkModelAvailable(fresh, 'auto', T0).ok).toBe(true)
    expect(checkModelAvailable(fresh, null, T0).ok).toBe(true)
    expect(checkModelAvailable(fresh, '', T0).ok).toBe(true)
  })

  it('reasonCode — только машинный код (без секретов/путей)', () => {
    const g = checkModelAvailable(fresh, 'grok-build', T0)
    expect(g.reasonCode).toMatch(/^[A-Z_]+$/)
  })
})
