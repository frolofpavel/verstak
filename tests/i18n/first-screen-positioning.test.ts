// Первый экран (AuthScreen) не должен сужать продукт до программирования и не должен
// торговать списком провайдеров. Обе формулировки прямо названы в
// docs/PRODUCT_POSITIONING.md §9 тем, что позиционированием НЕ является; §7 задаёт,
// что стоит вместо них. Пин стережёт ЖИВЫЕ строки: ключи ниже читает AuthScreen.tsx
// (t.auth.tagline, t.auth.features.*). Блок onboarding.* в словаре не рендерит никто,
// поэтому он здесь не проверяется — пин на невидимую строку не защищает ничего.
import { describe, it, expect } from 'vitest'
import { ru } from '../../src/i18n/ru'
import { en } from '../../src/i18n/en'

const NARROWS_TO_DEV = /разработк|для разработ|development|\bIDE\b/i
const SELLS_PROVIDERS = /провайдер|provider/i

/** Строки левой панели AuthScreen — то, что человек читает до первого действия. */
function firstScreenStrings(t: typeof ru): Array<[string, string]> {
  return [
    ['auth.tagline', t.auth.tagline],
    ['auth.features.providers', t.auth.features.providers],
    ['auth.features.memory', t.auth.features.memory],
    ['auth.features.agents', t.auth.features.agents],
  ]
}

describe('первый экран не противоречит канону позиционирования', () => {
  for (const [locale, t] of [['ru', ru], ['en', en]] as const) {
    for (const [key, value] of firstScreenStrings(t)) {
      it(`${locale}: ${key} не сужает продукт до разработки`, () => {
        expect(value, `«${value}»`).not.toMatch(NARROWS_TO_DEV)
      })
      it(`${locale}: ${key} не торгует списком провайдеров`, () => {
        expect(value, `«${value}»`).not.toMatch(SELLS_PROVIDERS)
      })
    }
  }

  // Контрольная пара: пин «этого нет» зелен и тогда, когда он ничего не измеряет.
  it('контроль: сетка ловит прежний текст экрана', () => {
    expect('AI-ассистент для разработки').toMatch(NARROWS_TO_DEV)
    expect('AI assistant for development').toMatch(NARROWS_TO_DEV)
    expect('AI-провайдеры в одном окне').toMatch(SELLS_PROVIDERS)
    expect('AI providers in one window').toMatch(SELLS_PROVIDERS)
  })

  it('контроль: сетка пропускает канонную формулировку', () => {
    for (const canon of ['ИИ-помощник для твоей работы', 'An AI assistant for your work']) {
      expect(canon).not.toMatch(NARROWS_TO_DEV)
      expect(canon).not.toMatch(SELLS_PROVIDERS)
    }
  })
})
