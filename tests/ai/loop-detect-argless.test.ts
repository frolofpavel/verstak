// Д4 (приёмка браузера 10.08): детектор зацикливания душил безаргументные
// инструменты. Подпись «имя + аргументы» у browser_snapshot константна (у него
// нет параметров), поэтому третий снимок за прогон блокировался ВСЕГДА — даже
// после навигации на другую страницу. В ленте приёмки заблокированным оказался
// ровно тот инструмент, который вёл к решению.
//
// Это НЕ V2-4: тот считает факты прогона и лечит застой подсказкой. Здесь —
// старый signatureCounts/LOOP_THRESHOLD, который не даёт вызову исполниться.
import { describe, it, expect } from 'vitest'
import {
  createObservationState, hasNoArgs, shouldBlockArgless, recordObservation,
  changesObservation, noteContextChange,
} from '../../electron/ai/loop-detect'

const THRESHOLD = 3

/** Прогон снимков: массив наблюдений подряд → на каком по счёту вызов заблокирован. */
function firstBlockedAt(observations: Array<{ result?: unknown; error?: string }>): number | null {
  const state = createObservationState()
  for (let i = 0; i < observations.length; i++) {
    if (shouldBlockArgless(state, 'browser_snapshot', THRESHOLD)) return i + 1
    recordObservation(state, 'browser_snapshot', observations[i])
  }
  return null
}

describe('hasNoArgs — кого правило вообще касается', () => {
  it('пустой объект и отсутствие аргументов — безаргументный вызов', () => {
    expect(hasNoArgs({})).toBe(true)
    expect(hasNoArgs(undefined)).toBe(true)
    expect(hasNoArgs(null)).toBe(true)
  })

  it('КОНТРОЛЬ: вызов с аргументами правилом не затрагивается', () => {
    // Для них подпись «имя + аргументы» различает вызовы сама, и менять её
    // поведение нельзя — иначе read_file по кругу перестанет ловиться.
    expect(hasNoArgs({ path: 'a.ts' })).toBe(false)
    expect(hasNoArgs({ n: 1 })).toBe(false)
  })
})

describe('Д4: безаргументный вызов различается НАБЛЮДЕНИЕМ', () => {
  it('три снимка РАЗНЫХ страниц не блокируются (дефект приёмки)', () => {
    const blocked = firstBlockedAt([
      { result: { url: 'https://habr.com/', title: 'Хабр', count: 40 } },
      { result: { url: 'https://habr.com/ru/search/', title: 'Поиск', count: 12 } },
      { result: { url: 'https://habr.com/ru/search/?q=ai', title: 'Результаты', count: 31 } },
    ])
    expect(blocked, 'снимок другой страницы заблокирован — Д4 не закрыт').toBeNull()
  })

  it('КОНТРОЛЬНЫЙ КЕЙС: три снимка ОДНОЙ неизменной страницы по-прежнему ловятся', () => {
    // Обязателен по §3.1: пин «снимки больше не блокируются» зелен и тогда,
    // когда детектор сломан целиком. Здесь он обязан сработать — и на ТРЕТЬЕМ
    // вызове, ровно как для повторяющегося вызова с аргументами.
    const same = { result: { url: 'https://habr.com/', title: 'Хабр', count: 40 } }
    expect(firstBlockedAt([same, same, same])).toBe(3)
  })

  it('снимок изменившейся страницы ОБНУЛЯЕТ счёт — работа продолжается', () => {
    const a = { result: { url: 'https://habr.com/', count: 40 } }
    const b = { result: { url: 'https://habr.com/ru/search/', count: 12 } }
    // Разные наблюдения чередуются — до порога не доходит вовсе.
    expect(firstBlockedAt([a, b, a, b, a, b])).toBeNull()
    // А два одинаковых подряд по-прежнему доводят до порога на третьем.
    expect(firstBlockedAt([b, a, a, a])).toBe(4)
  })

  it('волатильные куски результата не считаются новым наблюдением', () => {
    // Иначе страница с часами или счётчиком времени выглядела бы вечно новой, и
    // топтание на месте не ловилось бы вовсе. Нормализация — та же, что у V2-4.
    const at = (ts: string) => ({ result: { url: 'https://habr.com/', renderedAt: ts } })
    expect(firstBlockedAt([at('2026-08-10T10:00:01Z'), at('2026-08-10T10:00:02Z'), at('2026-08-10T10:00:03Z')])).toBe(3)
  })

  it('повторяющаяся ОШИБКА — тоже наблюдение и тоже ловится', () => {
    const err = { error: 'Браузер ещё поднимался и не успел стать готов' }
    expect(firstBlockedAt([err, err, err])).toBe(3)
  })

  it('ДЕЙСТВИЕ агента обнуляет счёт: два одинаковых снимка + навигация → третий проходит', () => {
    // Без этой половины правила оставался ложный блок ровно того же рода, что
    // чинится: снимок другой страницы не исполнялся бы, потому что о смене
    // контекста рантайм узнаёт только из результата, которого ещё нет.
    const state = createObservationState()
    const same = { result: { url: 'https://habr.com/', count: 40 } }
    recordObservation(state, 'browser_snapshot', same)
    recordObservation(state, 'browser_snapshot', same)
    expect(shouldBlockArgless(state, 'browser_snapshot', THRESHOLD), 'два одинаковых довели до порога').toBe(true)

    noteContextChange(state)   // агент ушёл на другую страницу

    expect(shouldBlockArgless(state, 'browser_snapshot', THRESHOLD)).toBe(false)
  })

  it('какие вызовы считаются действием — перечень, а не литералы в условии', () => {
    // Тот же приём, что у MUTATING_BROWSER_TOOLS: новый мутирующий инструмент
    // (сегодня — browser_press_key из Д3) попадает сюда сам.
    for (const name of ['browser_navigate', 'browser_click', 'browser_click_by_number',
      'browser_type_by_number', 'browser_press_key', 'write_file', 'apply_patch', 'run_command']) {
      expect(changesObservation(name), `${name} не считается действием`).toBe(true)
    }
    // КОНТРОЛЬ: чтение действием НЕ является — иначе счёт обнулялся бы всегда
    // и правило не срабатывало бы вовсе (ложно-зелёный детектор).
    for (const name of ['browser_snapshot', 'browser_find', 'browser_read_page',
      'browser_screenshot', 'read_file', 'get_project_map']) {
      expect(changesObservation(name), `${name} ошибочно считается действием`).toBe(false)
    }
  })

  it('наблюдения разных инструментов не смешиваются', () => {
    const state = createObservationState()
    const snap = { result: { url: 'https://habr.com/' } }
    const map = { result: 'project map text' }
    for (let i = 0; i < 2; i++) {
      recordObservation(state, 'browser_snapshot', snap)
      recordObservation(state, 'get_project_map', map)
    }
    // Оба дошли до двух одинаковых наблюдений независимо друг от друга.
    expect(shouldBlockArgless(state, 'browser_snapshot', THRESHOLD)).toBe(true)
    expect(shouldBlockArgless(state, 'get_project_map', THRESHOLD)).toBe(true)
    // Инструмент, которого не звали, не блокируется чужим счётом.
    expect(shouldBlockArgless(state, 'browser_screenshot', THRESHOLD)).toBe(false)
  })
})
