// C6 (13.08), ЧАСТЬ: одноимённые совпадения find помечаются как неоднозначные.
//
// Живой случай (docs/browser-spa-render-recon-2026-08-13.md, остаток 2): на Хабре по
// запросу «поиск» находятся ДВА элемента с одинаковой подписью — ссылка шапки (№5) и
// иконка формы (№46). Веса у них равны (точное совпадение имени + бонус роли), поэтому
// порядок решает DOM, и дешёвая модель берёт первое.
//
// Порядок здесь НЕ меняется сознательно: на ранжировании висят пины, а единственный
// признак, которым можно было бы предпочесть «элемент в форме» (структура/близость к
// полю ввода), в снимке отсутствует — добавление его в снимок меняет размер полезной
// нагрузки, ради которого весь этот путь и строился. Поэтому здесь закрывается вторая
// половина кандидата из очереди — «возвращать оба с пометкой»: модель получает явное
// предупреждение вместо молчаливого первого места.
import { describe, it, expect } from 'vitest'
import { vskFind, type PageSnapshot, type SnapshotElement } from '../../shared/browser-snapshot'

const el = (n: number, tag: string, role: string, name: string): SnapshotElement => ({ n, tag, role, name })

/** Разметка снята с живого Хабра (см. отчёт разведки): шапка раньше формы. */
function habrLike(): PageSnapshot {
  const elements = [
    el(1, 'a', 'link', 'Все потоки'),
    el(5, 'a', 'link', 'Поиск'),
    el(12, 'input', 'textbox', 'Поиск по сайту'),
    el(46, 'span', 'button', 'Поиск'),
  ]
  return { gen: 'g', count: elements.length, elements }
}

describe('C6: одноимённые совпадения find', () => {
  it('ПИН: два элемента с одной подписью → в результате есть пометка о неоднозначности', () => {
    const r = vskFind(habrLike(), 'поиск', 10)

    expect(r.totalHits).toBeGreaterThanOrEqual(2)
    expect(r.hint, 'модель получает первое место как единственный ответ, без предупреждения').toBeTruthy()
    expect(r.hint).toContain('Поиск')
    // Пометка обязана назвать НОМЕРА кандидатов: без них «уточни» — совет без действия.
    expect(r.hint).toContain('5')
    expect(r.hint).toContain('46')
  })

  it('ПИН: порядок совпадений НЕ изменён — ранжирование не тронуто', () => {
    const r = vskFind(habrLike(), 'поиск', 10)

    expect(r.matches[0].n, 'порядок поехал: это ломает существующие пины ранжирования').toBe(5)
    expect(r.matches.map(m => m.n)).toEqual([5, 46, 12])
  })

  it('КОНТРОЛЬ: одно совпадение по подписи → пометки нет (иначе шум на каждом вызове)', () => {
    const elements = [el(1, 'a', 'link', 'Войти'), el(2, 'button', 'button', 'Отправить')]
    const r = vskFind({ gen: 'g', count: 2, elements }, 'войти', 10)

    expect(r.count).toBe(1)
    expect(r.hint).toBeUndefined()
  })

  it('КОНТРОЛЬ: разные подписи, но оба совпали → это не одноимённость, пометки нет', () => {
    const elements = [el(1, 'a', 'link', 'Поиск по сайту'), el(2, 'button', 'button', 'Поисковая выдача')]
    const r = vskFind({ gen: 'g', count: 2, elements }, 'поиск', 10)

    expect(r.count).toBe(2)
    expect(r.hint, 'пометка про одинаковые подписи там, где подписи разные').toBeUndefined()
  })

  it('КОНТРОЛЬ: пустой результат сохраняет прежнюю подсказку', () => {
    const r = vskFind(habrLike(), 'зорблакс', 10)

    expect(r.count).toBe(0)
    expect(r.hint).toContain('browser_snapshot')
  })
})
