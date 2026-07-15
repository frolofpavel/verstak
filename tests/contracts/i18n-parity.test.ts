// Срез 2.0.7-G: паритет ключей локалей ru ↔ en.
//
// `ru: Translations = {...}` (Translations = typeof en) — tsc уже структурно требует
// совпадения формы. Этот тест — второй рубеж: (1) даёт ВНЯТНУЮ ошибку «нет ключа X /
// лишний ключ Y» вместо простыни tsc; (2) переживёт ослабление типизации (если кто-то
// сделает Translations шире/Partial); (3) ловит расхождение ВЕТВЛЕНИЯ (leaf в одной локали,
// объект в другой), которое структурный тип не всегда подсвечивает явно.
import { describe, it, expect } from 'vitest'
import { en } from '../../src/i18n/en'
import { ru } from '../../src/i18n/ru'

type Dict = Record<string, unknown>
const isDict = (v: unknown): v is Dict =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Рекурсивно собирает все ключ-пути. Ветку помечаем суффиксом '/' (leaf vs branch различимы). */
function keyPaths(obj: Dict, prefix = ''): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k
    if (isDict(v)) {
      out.push(`${path}/`)
      out.push(...keyPaths(v, path))
    } else {
      out.push(path)
    }
  }
  return out
}

describe('i18n parity: ru ↔ en', () => {
  const enKeys = new Set(keyPaths(en as Dict))
  const ruKeys = new Set(keyPaths(ru as Dict))

  it('локали непусты (страж не «молча зелёный»)', () => {
    expect(enKeys.size).toBeGreaterThan(100)
    expect(ruKeys.size).toBeGreaterThan(100)
  })

  it('в ru нет пропущенных относительно en ключей', () => {
    const missing = [...enKeys].filter(k => !ruKeys.has(k)).sort()
    expect(missing, `ru не переводит: ${missing.join(', ')}`).toEqual([])
  })

  it('в ru нет ЛИШНИХ относительно en ключей', () => {
    const extra = [...ruKeys].filter(k => !enKeys.has(k)).sort()
    expect(extra, `ru имеет ключи, которых нет в en: ${extra.join(', ')}`).toEqual([])
  })

  it('структура branch/leaf совпадает (нет строки против объекта)', () => {
    // keyPaths помечает ветки суффиксом '/'. Если ключ в en — объект, а в ru — строка,
    // в наборах будут 'x/' vs 'x' → предыдущие два теста это уже поймают как missing+extra,
    // но фиксируем инвариант явно для читабельности отчёта.
    const branchMismatch = [...enKeys].filter(k => k.endsWith('/')).filter(k => !ruKeys.has(k))
    expect(branchMismatch, `ветки en, отсутствующие/иные в ru: ${branchMismatch.join(', ')}`).toEqual([])
  })
})
