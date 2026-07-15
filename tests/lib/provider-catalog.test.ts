// Срез 2.0.7-D: единый каталог провайдеров. Settings перестаёт хардкодить models[]
// (второе зеркало реестра — источник дрейфа «UI предлагает модель, которой рантайм не
// знает»); теперь и Settings, и композер строят каталог из ОДНОГО источника —
// providers:list DTO. Здесь тестируем ЧИСТУЮ логику слияния DTO↔UI-мета и офлайн-fallback.
import { describe, it, expect } from 'vitest'
import {
  mergeProviderCatalog,
  resolveModelAvailability,
  PROVIDER_UI_META,
  BUNDLED_PROVIDERS,
} from '../../src/lib/model-catalog'
import { PROVIDER_IDS } from '../../shared/contracts/provider'
import type { ProviderDescriptorDTO } from '../../src/types/api'

// Минимальный валидный DTO для теста (honesty-поля выставлены вручную).
function dto(over: Partial<ProviderDescriptorDTO> & Pick<ProviderDescriptorDTO, 'id'>): ProviderDescriptorDTO {
  return {
    id: over.id,
    name: over.name ?? 'X',
    shortLabel: over.shortLabel ?? 'X',
    transport: over.transport ?? 'API',
    executionMode: over.executionMode ?? 'native-agent-loop',
    authKind: over.authKind ?? 'api-key',
    secretKey: over.secretKey ?? null,
    models: over.models ?? ['m1', 'm2'],
    defaultModel: over.defaultModel ?? 'm1',
    supportsTools: over.supportsTools ?? true,
    experimental: over.experimental ?? false,
    catalogSource: over.catalogSource ?? 'static',
    capabilities: over.capabilities ?? {
      tools: true, attachments: true, verification: true, liveTimeline: true,
      resumeSafe: true, mcp: true, delegation: true, perFileUndo: true,
    },
  }
}

describe('mergeProviderCatalog — DTO (функционал) + UI-мета (копия)', () => {
  it('модели/транспорт/дефолт берутся из DTO, а не из хардкода', () => {
    const [c] = mergeProviderCatalog([dto({ id: 'claude', transport: 'API', models: ['a', 'b'], defaultModel: 'b' })])
    expect(c.models).toEqual(['a', 'b'])
    expect(c.defaultModel).toBe('b')
    expect(c.transport).toBe('API')
    // источник = live: пришло из IPC
    expect(c.source).toBe('live')
  })

  it('описание/keyHint/keyLink берутся из UI-меты по id', () => {
    const [c] = mergeProviderCatalog([dto({ id: 'claude' })])
    expect(c.description).toBe(PROVIDER_UI_META['claude'].description)
    expect(c.keyHint).toBe(PROVIDER_UI_META['claude'].keyHint)
    expect(c.keyLink).toEqual(PROVIDER_UI_META['claude'].keyLink)
  })

  it('experimental и optIn-warning приходят из DTO/меты (Codex OAuth)', () => {
    const [c] = mergeProviderCatalog([dto({ id: 'openai-codex-oauth', experimental: true, secretKey: 'codex_oauth_risk_accepted' })])
    expect(c.experimental).toBe(true)
    expect(c.optIn?.label).toBeTruthy() // из UI-меты
  })

  it('порядок — из UI-меты (verstak-gateway первым, рекомендованный), не из порядка DTO', () => {
    const merged = mergeProviderCatalog([
      dto({ id: 'gemini-api' }),
      dto({ id: 'verstak-gateway' }),
    ])
    expect(merged[0].id).toBe('verstak-gateway')
  })

  it('имя из UI-меты переопределяет DTO там, где UI-текст должен отличаться (codex-cli)', () => {
    const [c] = mergeProviderCatalog([dto({ id: 'codex-cli', name: 'Codex', transport: 'CLI' })])
    // UI исторически показывает «Codex CLI», DTO говорит «Codex» — сохраняем UI-текст.
    expect(c.name).toBe('Codex CLI')
  })

  it('провайдер без UI-меты не роняет слияние (fallback-мета)', () => {
    const merged = mergeProviderCatalog([dto({ id: 'gemini-api' }), dto({ id: 'ЧУЖОЙ' as never })])
    expect(merged.length).toBe(2)
    const unknown = merged.find(c => c.id === ('ЧУЖОЙ' as never))
    expect(unknown?.description).toBe('') // пустая копия, но не падение
  })
})

describe('BUNDLED_PROVIDERS — офлайн-fallback', () => {
  it('источник помечается bundled (честная метка stale-каталога)', () => {
    const merged = mergeProviderCatalog(BUNDLED_PROVIDERS, { source: 'bundled' })
    expect(merged.every(c => c.source === 'bundled')).toBe(true)
  })

  it('все id bundled-снапшота существуют в контракте (не ссылается на мёртвых)', () => {
    for (const p of BUNDLED_PROVIDERS) {
      expect(PROVIDER_IDS as readonly string[]).toContain(p.id)
    }
  })

  it('bundled покрывает все 22 провайдера контракта (офлайн видно всё)', () => {
    expect(new Set(BUNDLED_PROVIDERS.map(p => p.id)).size).toBe(PROVIDER_IDS.length)
  })
})

describe('resolveModelAvailability — сохранённая модель vs живой каталог', () => {
  it('сохранённая модель есть в каталоге → ok', () => {
    expect(resolveModelAvailability(['a', 'b'], 'b')).toBe('ok')
  })

  it('сохранённая модель ОТСУТСТВУЕТ → unavailable (не молчаливая подмена, Doctor поверх)', () => {
    // Живой случай grok-build: сохранён id, которого нет в живом каталоге → пользователь
    // должен УВИДЕТЬ «недоступна», а не молча уехать в дефолт или в бэкенд.
    expect(resolveModelAvailability(['grok-4.5'], 'grok-build')).toBe('unavailable')
  })

  it('пустой сохранённый выбор → unset (это не «недоступна»)', () => {
    expect(resolveModelAvailability(['a'], null)).toBe('unset')
    expect(resolveModelAvailability(['a'], '')).toBe('unset')
  })

  it('провайдер с пользовательским списком (custom/ollama, models=[]) → любая непустая ok', () => {
    // Пустой каталог = пользователь задаёт модели сам; не флагуем как unavailable.
    expect(resolveModelAvailability([], 'что-угодно')).toBe('ok')
    expect(resolveModelAvailability([], null)).toBe('unset')
  })
})

describe('PROVIDER_UI_META — покрытие', () => {
  it('у каждого провайдера контракта есть UI-мета (иначе карточка без описания/ссылки)', () => {
    const missing = (PROVIDER_IDS as readonly string[]).filter(id => !PROVIDER_UI_META[id])
    expect(missing, `нет UI-меты для: ${missing.join(', ')}`).toEqual([])
  })

  it('UI-мета НЕ содержит models/defaultModel (иначе вернулся бы дрейф)', () => {
    for (const [id, meta] of Object.entries(PROVIDER_UI_META)) {
      expect(meta, `${id}: UI-мета не должна нести функциональные поля`).not.toHaveProperty('models')
      expect(meta).not.toHaveProperty('defaultModel')
    }
  })
})
