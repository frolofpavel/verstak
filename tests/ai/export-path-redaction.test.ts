import { describe, it, expect } from 'vitest'
import { redactPathsForExport } from '../../electron/ai/export-path-redaction'

/**
 * Срез 2.0.11-C (безопасный экспорт): нормализация путей.
 *
 * ЗАЧЕМ. Экспорт человек отправляет на code-review / в багрепорт / в архив. Абсолютные
 * пути в тексте раскрывают имя пользователя (`C:\Users\Pavel`), структуру машины и
 * ВНУТРЕННИЕ сетевые шары (UNC `\\сервер\общая`). scanText ловит секреты, но не пути —
 * это отдельная утечка приватности.
 *
 * СТРУКТУРНО, НЕ СЛЕПЫМ REGEX (требование карточки). Заменяем ИЗВЕСТНЫЕ корни (домашняя
 * папка, корни проектов) — их мы знаем точно — и UNC по его чёткому структурному маркеру
 * `\\хост\шара`. Не пытаемся regex'ом угадать «что здесь похоже на путь»: это ломало бы
 * легитимный текст и пропускало бы нестандартное.
 */

const ctx = {
  homeDir: 'C:\\Users\\Pavel',
  projectRoots: ['C:\\Users\\Pavel\\Progetc\\Проекты\\verstak'],
}

describe('redactPathsForExport — приватность путей в экспорте', () => {
  it('корень проекта → <проект> (самый длинный корень заменяется первым)', () => {
    const out = redactPathsForExport('см. C:\\Users\\Pavel\\Progetc\\Проекты\\verstak\\src\\app.ts', ctx)
    expect(out).toContain('<проект>\\src\\app.ts')
    expect(out).not.toContain('Pavel')
  })

  // Главная утечка: имя пользователя.
  it('домашняя папка → ~ (имя пользователя не утекает)', () => {
    const out = redactPathsForExport('лог в C:\\Users\\Pavel\\Downloads\\err.log', ctx)
    expect(out).toContain('~\\Downloads\\err.log')
    expect(out).not.toContain('Pavel')
  })

  it('прямые слэши тоже нормализуются (пути в тексте бывают forward-slash)', () => {
    const out = redactPathsForExport('path: C:/Users/Pavel/Downloads/x', ctx)
    expect(out).not.toContain('Pavel')
  })

  // UNC раскрывает имя внутреннего сервера.
  it('UNC \\\\сервер\\шара → хост замаскирован', () => {
    const out = redactPathsForExport('файл на \\\\FILESRV01\\common\\report.xlsx', ctx)
    expect(out).not.toContain('FILESRV01')
    expect(out).toMatch(/\\\\.*\\common\\report\.xlsx/) // остальной путь сохранён
  })

  // Unicode в путях (кириллица в имени пользователя/проекта) не должен ломать замену.
  it('кириллица в пути не ломает нормализацию', () => {
    const uni = {
      homeDir: 'C:\\Users\\Павел',
      projectRoots: ['C:\\Users\\Павел\\Проекты\\вёрстка'],
    }
    const out = redactPathsForExport('открой C:\\Users\\Павел\\Проекты\\вёрстка\\файл.тс', uni)
    expect(out).toContain('<проект>\\файл.тс')
    expect(out).not.toContain('Павел')
  })

  it('несколько вхождений — все заменяются', () => {
    const out = redactPathsForExport('C:\\Users\\Pavel\\a и C:\\Users\\Pavel\\b', ctx)
    expect(out).not.toContain('Pavel')
    expect((out.match(/~/g) ?? []).length).toBe(2)
  })

  it('текст без путей возвращается как есть', () => {
    expect(redactPathsForExport('обычный текст без путей', ctx)).toBe('обычный текст без путей')
  })

  it('пустой вход не падает', () => {
    expect(redactPathsForExport('', ctx)).toBe('')
  })

  // Регистронезависимость диска: путь в тексте может прийти как c:\ при home C:\.
  it('регистр диска не мешает (c:\\ ~ C:\\)', () => {
    const out = redactPathsForExport('c:\\Users\\Pavel\\x', ctx)
    expect(out).not.toContain('Pavel')
  })

  // Порядок важен: home внутри project root не должен «съесть» начало и сломать замену на <проект>.
  it('project root побеждает home (длинный корень раньше короткого)', () => {
    const out = redactPathsForExport('C:\\Users\\Pavel\\Progetc\\Проекты\\verstak\\readme.md', ctx)
    expect(out).toContain('<проект>\\readme.md')
    expect(out).not.toContain('~\\Progetc') // home НЕ применён поверх project root
  })

  it('нет контекста → текст не меняется (нечего заменять — не угадываем)', () => {
    expect(redactPathsForExport('C:\\Users\\Pavel\\x', {})).toBe('C:\\Users\\Pavel\\x')
  })
})
