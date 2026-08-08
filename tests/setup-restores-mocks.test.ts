import { describe, it, expect, vi } from 'vitest'

// Тест не должен оставлять СЛЕДОВ соседям — тот же класс, что «тесты пишут в боевой
// журнал» (d89d46b). Мок реального http/https/глобала без восстановления в одном тесте
// ломал следующий (нативная линия: autoupdate-download-resume падал под нагрузкой, когда
// сосед оставлял мок). setup.ts делал только unstubAllGlobals (снимает stubGlobal), но НЕ
// restoreAllMocks (не снимает vi.spyOn). Контроль ниже: spy из первого it обязан быть
// восстановлен ко второму. Red на прежнем setup.ts, green после добавления restoreAllMocks.
//
// Общий объект-цель (одна ссылка на файл: spyOn мутирует именно её между it).
const shared = { probe: () => 'real' }

describe('setup.ts восстанавливает spy между тестами (не оставляет след)', () => {
  it('первый тест ставит spy на общий объект', () => {
    vi.spyOn(shared, 'probe').mockReturnValue('mocked')
    expect(shared.probe()).toBe('mocked')
  })

  it('второй тест видит ОРИГИНАЛ — spy снят автоматически (restoreAllMocks в afterEach)', () => {
    expect(shared.probe()).toBe('real')
  })
})
