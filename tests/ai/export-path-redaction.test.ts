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

describe('UNC edge-cases (ре-ревью C #3/#4/#5)', () => {
  // #3: host без trailing separator — \\FILESRV01 в конце строки или перед пробелом.
  it('bare UNC host в конце строки маскируется', () => {
    expect(redactPathsForExport('не достучаться до \\\\BACKUPSRV', {})).not.toContain('BACKUPSRV')
  })

  it('bare UNC host перед пробелом маскируется', () => {
    const out = redactPathsForExport('ping \\\\FILESRV01 сейчас', {})
    expect(out).not.toContain('FILESRV01')
    expect(out).toContain('сейчас') // остальной текст цел
  })

  it('UNC host\\share по-прежнему маскирует только host', () => {
    const out = redactPathsForExport('\\\\FILESRV01\\common\\report.xlsx', {})
    expect(out).not.toContain('FILESRV01')
    expect(out).toMatch(/\\common\\report\.xlsx/)
  })

  // Слепая замена //host сломала бы http://host — это ГРАНИЦА, а не дефект.
  it('http:// URL НЕ ломается UNC-маской (не путаем схему с UNC)', () => {
    const out = redactPathsForExport('открой https://api.example.com/path', {})
    expect(out).toContain('https://api.example.com/path')
  })

  // Точность UNC-маски: экранированный backslash в коде (JSON/regex/строка) — НЕ UNC.
  // UNC начинается с \\ в начале токена; escaped-путь имеет \\ в середине (слева буква/:).
  // Иначе экспорт для code-review искажал бы легитимный код.
  it('экранированный backslash в JSON-строке НЕ искажается (\\\\ в середине токена)', () => {
    const src = '"path": "C:\\\\Users\\\\shared"'
    expect(redactPathsForExport(src, {})).toBe(src) // нет контекста корней → не трогаем
  })

  // ГРАНИЦА: `\\` в НАЧАЛЕ токена (после пробела/начала) неотличимо от UNC — маскируется,
  // даже если это редкий regex-escape вроде `\\d`. Over-redaction в безопасную (приватную)
  // сторону; настоящий UNC важнее редкого escape. Главная утечка — escaped PATH в середине
  // токена — закрыта тестом выше (сохраняется).
  it('escaped backslash в СЕРЕДИНЕ токена (главный кейс кода) сохранён', () => {
    // Windows-путь в двойных кавычках как параметр — \\ в середине, слева буква/двоеточие.
    expect(redactPathsForExport('run "D:\\\\build\\\\out"', {})).toBe('run "D:\\\\build\\\\out"')
  })
})
