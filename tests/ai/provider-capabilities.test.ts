import { describe, it, expect } from 'vitest'
import { providerCapabilities, PROVIDERS } from '../../electron/ai/registry'

/**
 * Ревью F3: матрица возможностей — единый источник правды. API-провайдер даёт
 * полный контроль, CLI деградирует (инструменты/проверка/таймлайн/resume идут
 * внутри бинаря, Verstak их не видит). Раньше это подразумевалось разрозненно
 * и не показывалось пользователю.
 */
describe('providerCapabilities (F3)', () => {
  it('API + supportsTools → полный контроль', () => {
    const caps = providerCapabilities({ transport: 'API', supportsTools: true })
    // 2.0.7-C: возможностей стало 8 — добавлен perFileUndo (наш undo-стек ведёт только
    // наш loop). Литерал намеренно полный: новая возможность обязана быть осознанной.
    expect(caps).toEqual({
      tools: true, verification: true, liveTimeline: true,
      resumeSafe: true, mcp: true, delegation: true, attachments: true,
      perFileUndo: true
    })
  })

  it('CLI → деградация (всё кроме нуля выключено)', () => {
    const caps = providerCapabilities({ transport: 'CLI', supportsTools: false })
    expect(caps.tools).toBe(false)
    expect(caps.verification).toBe(false)
    expect(caps.liveTimeline).toBe(false)
    expect(caps.resumeSafe).toBe(false)   // ключевое: CLI не resume-safe
    expect(caps.mcp).toBe(false)
    expect(caps.delegation).toBe(false)
    expect(caps.attachments).toBe(false)  // → текстовый хинт
    expect(caps.perFileUndo).toBe(false)  // CLI пишет мимо undo-стека → git-якорь
  })

  // Ревью 2.0.7-C: perFileUndo считался как `transport === 'API'` — то есть обещал откат
  // даже провайдеру БЕЗ тулзов, который физически не пишет файлы (undo-стек наполняют
  // write_file/apply_patch). Поле, которое врёт о поведении, хуже отсутствующего поля.
  it('API без тулзов → per-file undo НЕ обещаем (писать файлы нечем)', () => {
    const caps = providerCapabilities({ transport: 'API', supportsTools: false })
    expect(caps.perFileUndo).toBe(false)
    expect(caps.tools).toBe(false)
    // attachments/resumeSafe от тулзов не зависят — это свойства нашего пути, а не тулзов.
    expect(caps.attachments).toBe(true)
    expect(caps.resumeSafe).toBe(true)
  })

  it('реальные дескрипторы: claude=полный, claude-cli=урезанный', () => {
    expect(providerCapabilities(PROVIDERS['claude']).verification).toBe(true)
    expect(providerCapabilities(PROVIDERS['claude-cli']).verification).toBe(false)
    expect(providerCapabilities(PROVIDERS['claude-cli']).resumeSafe).toBe(false)
  })

  it('инвариант: ни один CLI-провайдер не заявляет verification/resumeSafe', () => {
    for (const p of Object.values(PROVIDERS)) {
      if (p.transport === 'CLI') {
        const c = providerCapabilities(p)
        expect(c.verification, `${p.id} verification`).toBe(false)
        expect(c.resumeSafe, `${p.id} resumeSafe`).toBe(false)
        expect(c.tools, `${p.id} tools`).toBe(false)
      }
    }
  })
})
