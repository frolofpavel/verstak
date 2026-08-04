import { describe, it, expect } from 'vitest'
import { formatTaskForChat } from '../../src/lib/task-to-chat'

// Задача 4: кнопка в чеклисте «В работу» формирует из пункта задачу и шлёт её в чат
// (gg-resume-send). Формулировка — чистая функция, пинуется здесь.
describe('formatTaskForChat — пункт чеклиста → инструкция агенту', () => {
  it('включает текст пункта и явную инструкцию выполнить', () => {
    const out = formatTaskForChat('починить форму заявки')
    expect(out).toContain('починить форму заявки')
    expect(out.toLowerCase()).toContain('в работу')
  })

  it('обрезает пробелы вокруг пункта', () => {
    const out = formatTaskForChat('  добавить экспорт в CSV  ')
    expect(out).toContain('добавить экспорт в CSV')
    expect(out).not.toContain('  добавить')
  })

  it('пустой/пробельный пункт → пустая строка (нечего слать)', () => {
    expect(formatTaskForChat('   ')).toBe('')
    expect(formatTaskForChat('')).toBe('')
  })
})
