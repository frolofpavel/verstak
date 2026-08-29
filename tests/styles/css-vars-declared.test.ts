import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// ДЕФЕКТ (живой замер 22.08): пустое состояние браузера ссылалось на var(--bg-primary),
// а такой переменной в теме нет — есть --bg-base/--bg-elevated/--bg-overlay. CSS не
// ругается: неизвестная переменная молча даёт пустое значение, фон стал прозрачным,
// светлый текст лёг на белый webview и объяснение исчезло с экрана.
//
// Тем же поиском нашлись ЕЩЁ ЧЕТЫРЕ таких ссылки — в .gg-agent-progress-now и
// .gg-agent-progress-focus, то есть в полосе прогресса, которую человек видит на КАЖДОМ
// прогоне. Там внутри color-mix(): от неизвестной переменной вся функция становится
// невалидной, и фон пропадает целиком. Дефект жил незамеченным.
//
// Класс не ловится ни типами, ни jsdom (в нём нет CSS), ни глазами — только сверкой
// объявленного с использованным. Поэтому страж текстовый.
const ROOT = join(__dirname, '..', '..')
// ВСЕ файлы стилей: объявление может жить в любом из них, и неполный список породил бы
// ложные срабатывания — страж, кричащий на исправное, снимут первым же движением.
const STYLE_FILES = ['theme.css', 'layout.css', 'markdown.css', 'atelier-global.css', 'shell-atelier.css', 'title-bar.css']
const read = (f: string) => readFileSync(join(ROOT, 'src/styles', f), 'utf8')
const ALL = STYLE_FILES.map(read)
const LAYOUT = read('layout.css')
const MARKDOWN = read('markdown.css')

/** Имена переменных, объявленных где-либо в стилях (`--name:`). */
function declared(): Set<string> {
  const out = new Set<string>()
  for (const css of ALL) {
    for (const m of css.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) out.add(m[1])
  }
  return out
}

/** Имена переменных, использованных через var(--name). */
function used(css: string): Map<string, number> {
  const out = new Map<string, number>()
  for (const m of css.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)) {
    out.set(m[1], (out.get(m[1]) ?? 0) + 1)
  }
  return out
}

/**
 * ЗАМОРОЖЕННЫЙ ДОЛГ на 22.08.2026. Эти имена используются, но нигде не объявлены —
 * 150 обращений суммарно (--bg-surface 59, --border 39, --text-muted 23). Из кода они
 * тоже не задаются: `setProperty` ставит только --gg-rail-w и --gg-sidebar-target-w.
 *
 * Почему не исправлены здесь и сейчас: это внешний вид половины экранов, и каждую
 * замену надо ВИДЕТЬ. Слепая правка 150 мест — не уборка, а лотерея.
 *
 * Список заморожен, чтобы класс не РОС: новая необъявленная переменная уронит тест.
 * Разбор долга — отдельной работой, с живой проверкой каждого экрана.
 * СНИМАТЬ ПО МЕРЕ ИСПРАВЛЕНИЯ: имя, исчезнувшее из стилей, тоже уронит тест ниже.
 */
const FROZEN_DEBT = [
  '--bg-card', '--bg-elev', '--bg-panel', '--bg-secondary', '--bg-surface', '--bg-tertiary',
  '--border', '--green', '--muted', '--panel', '--project-accent', '--surface', '--surface-1',
  '--text', '--text-muted', '--yellow'
]

describe('CSS: каждая используемая переменная объявлена', () => {
  it('НОВЫХ необъявленных переменных не появилось', () => {
    const have = declared()
    const missing: string[] = []
    for (const [name] of used(LAYOUT)) {
      // var(--x, fallback) с запасным значением допустим: он переживает отсутствие.
      const hasFallback = new RegExp(`var\\(\\s*${name}\\s*,`).test(LAYOUT)
      if (!have.has(name) && !hasFallback && !FROZEN_DEBT.includes(name)) missing.push(name)
    }
    expect(missing, `новые необъявленные переменные: ${missing.join(', ')}`).toEqual([])
  })

  it('замороженный долг не разросся и не протух', () => {
    // Обе стороны: имя из списка, которого в стилях больше нет, — тоже расхождение.
    // Иначе список переживёт свою правду и будет врать о размере долга (§3.1).
    const have = declared()
    const stillBroken = FROZEN_DEBT.filter(n => used(LAYOUT).has(n) && !have.has(n))
    expect(stillBroken.sort(), 'список долга разошёлся с фактом').toEqual([...FROZEN_DEBT].sort())
  })

  it('в markdown.css нет ссылок на необъявленные переменные', () => {
    const have = declared()
    const missing: string[] = []
    for (const [name] of used(MARKDOWN)) {
      const hasFallback = new RegExp(`var\\(\\s*${name}\\s*,`).test(MARKDOWN)
      if (!have.has(name) && !hasFallback) missing.push(name)
    }
    expect(missing, `необъявленные переменные: ${missing.join(', ')}`).toEqual([])
  })

  // КОНТРОЛЬНЫЙ КЕЙС: без него оба утверждения зелены и тогда, когда разбор сломан и
  // не находит ни одного использования — «нет пропавших» неотличимо от «нечего искать».
  it('разбор действительно находит переменные — иначе проверка пустая', () => {
    expect(declared().size).toBeGreaterThan(20)
    expect(used(LAYOUT).size).toBeGreaterThan(20)
    expect(declared().has('--bg-base')).toBe(true)
  })
})
