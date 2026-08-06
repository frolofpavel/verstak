// ЗАДАЧА A (штаб, 06.08): таблицы цен ДУБЛИРУЮТСЯ — рендер (src/lib/pricing.ts) и
// main (electron/ai/cost-guard.ts). По ЦЕНАМ они не расходились, но разошлись по
// СОСТАВУ: 55 записей против 52 (main не хватало kimi-for-coding, glm-5.2,
// glm-5-turbo — все $0/$0 подписочные). Последствие: при ВКЛЮЧЁННОМ лимите расхода
// эти модели падали в FALLBACK_PRICE ($3/$15) — экран $0, а страж копил чужие деньги.
//
// Лучшая починка — переезд PRICES в shared/ (расходиться станет нечему); отложен
// сознательно (см. отчёт штабу: бюджет/blast-radius). Пока таблицы две — этот пин
// держит их состав И цены синхронными: разъедутся хоть по ключу, хоть по цене — красный.
import { describe, it, expect } from 'vitest'
import { PRICES as RENDERER_PRICES } from '../../src/lib/pricing'
import { PRICES as MAIN_PRICES } from '../../electron/ai/cost-guard'

describe('анти-дрейф таблиц цен renderer↔main (задача A)', () => {
  it('состав ключей совпадает (после синхронизации трёх недостающих)', () => {
    expect(Object.keys(RENDERER_PRICES).sort()).toEqual(Object.keys(MAIN_PRICES).sort())
  })

  it('три ранее недостающие подписочные модели теперь есть в main и стоят $0', () => {
    for (const k of ['kimi-for-coding', 'glm-5.2', 'glm-5-turbo']) {
      expect(MAIN_PRICES[k], k).toEqual({ input: 0, output: 0 })
    }
  })

  it('цена по каждому ключу совпадает (input/output/cached/cacheWrite)', () => {
    for (const k of Object.keys(RENDERER_PRICES)) {
      expect(MAIN_PRICES[k], k).toEqual(RENDERER_PRICES[k])
    }
  })
})
