import { describe, it, expect } from 'vitest'
import { lookupLoader } from '../../electron/ai/skills/loaders'

describe('skills/loaders registry', () => {

  it('lookupLoader находит существующий', () => {
    const fn = lookupLoader('load_today_brief')
    expect(fn).toBeTruthy()
    expect(typeof fn).toBe('function')
  })

  it('lookupLoader возвращает null для неизвестного', () => {
    expect(lookupLoader('does_not_exist')).toBeNull()
  })
})

describe('load_today_brief', () => {
  it('возвращает день недели + дату на русском', async () => {
    const fn = lookupLoader('load_today_brief')!
    const result = await fn({ projectPath: null })
    expect(result).toBeTruthy()
    expect(result!.markdown).toMatch(/Сейчас/)
    expect(result!.markdown).toMatch(/(понедельник|вторник|среда|четверг|пятница|суббота|воскресенье)/)
    expect(result!.markdown).toMatch(/\d{4}/)  // год
  })
})

describe('load_client_card без arg', () => {
  it('возвращает подсказку про slug', async () => {
    const fn = lookupLoader('load_client_card')!
    const result = await fn({ projectPath: null })
    expect(result).toBeTruthy()
    expect(result!.markdown).toMatch(/slug/)
    expect(result!.label).toBe('нет slug')
  })
})

describe('load_client_card с несуществующим slug', () => {
  it('возвращает дружелюбное not-found сообщение', async () => {
    const fn = lookupLoader('load_client_card')!
    const result = await fn({ projectPath: null, arg: 'no-such-client-xxxxx' })
    expect(result).toBeTruthy()
    expect(result!.markdown).toMatch(/не нашёл/)
  })
})
