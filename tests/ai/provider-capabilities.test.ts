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
      perFileUndo: true, worktreeIsolation: true
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
    // Ре-ревью 2.0.11-B #3: изоляция чата в worktree работает только на НАШЕМ пути —
    // CLI-провайдер получает cwd реального проекта и правит настоящий репозиторий, а
    // интерфейс при этом показывал «🌿 Изолировано». Обещание изоляции = самая дорогая
    // ложь из возможных: человек думает, что работает на копии.
    expect(caps.worktreeIsolation).toBe(false)
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

/**
 * Ре-ревью 2.0.11-B, находка #3 (high) — honesty-срез.
 *
 * Изоляция чата (worktree) реализована на НАШЕМ пути: runRoot подменяется у file-тулзов
 * agent-loop'а. CLI-провайдер ходит своим бинарём с cwd = реальный проект и правит
 * настоящий репозиторий — при этом в UI горит «🌿 Изолировано». До фикса chatId (01a6754)
 * изоляция не работала вообще ни у кого; теперь она честная на API и лживая на CLI —
 * частичная ложь коварнее полной.
 *
 * Важно для Павла: его основной провайдер — Claude Code (CLI).
 */
describe('worktreeIsolation — честность изоляции (ре-ревью B #3)', () => {
  it('API + тулзы → изоляция реальна (правки идут через наши file-тулзы в worktree)', () => {
    expect(providerCapabilities({ transport: 'API', supportsTools: true }).worktreeIsolation).toBe(true)
  })

  it('API без тулзов → изолировать нечего, но и врать нечем: писать файлы агент не может', () => {
    expect(providerCapabilities({ transport: 'API', supportsTools: false }).worktreeIsolation).toBe(false)
  })

  it('ни один CLI-провайдер не заявляет изоляцию', () => {
    for (const p of Object.values(PROVIDERS)) {
      if (p.transport === 'CLI') {
        expect(providerCapabilities(p).worktreeIsolation, `${p.id} worktreeIsolation`).toBe(false)
      }
    }
  })

  it('claude-cli (основной провайдер Павла) — изоляция НЕ обещана', () => {
    expect(providerCapabilities(PROVIDERS['claude-cli']).worktreeIsolation).toBe(false)
  })

  // Изоляция держится на подмене корня у наших file-тулзов. Нет тулзов — нет и подмены.
  it('изоляция не обещана шире, чем perFileUndo (обе держатся на наших file-тулзах)', () => {
    for (const p of Object.values(PROVIDERS)) {
      const c = providerCapabilities(p)
      if (c.worktreeIsolation) expect(c.perFileUndo, `${p.id}`).toBe(true)
    }
  })
})
