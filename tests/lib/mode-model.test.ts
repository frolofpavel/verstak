import { describe, it, expect } from 'vitest'
import { modeModelsKey, parseModeModels, resolveModeModel, serializeModeModels } from '../../src/lib/mode-model'

describe('mode-model (per-mode model binding)', () => {
  it('modeModelsKey — per-provider', () => {
    expect(modeModelsKey('claude')).toBe('mode_models_claude')
  })

  it('parseModeModels — валидный JSON; битый/не-объект/пусто → {}', () => {
    expect(parseModeModels('{"plan":"opus","auto":"deepseek"}')).toEqual({ plan: 'opus', auto: 'deepseek' })
    expect(parseModeModels('not json')).toEqual({})
    expect(parseModeModels('[1,2]')).toEqual({})
    expect(parseModeModels('')).toEqual({})
    expect(parseModeModels(null)).toEqual({})
    expect(parseModeModels('{"plan":"  "}')).toEqual({}) // пустое значение отброшено
  })

  it('resolveModeModel — модель режима или null (нет привязки → текущая)', () => {
    const m = { plan: 'opus', auto: 'deepseek' }
    expect(resolveModeModel(m, 'plan')).toBe('opus')
    expect(resolveModeModel(m, 'auto')).toBe('deepseek')
    expect(resolveModeModel(m, 'ask')).toBeNull() // нет привязки
  })

  it('serializeModeModels — round-trip, пустые отброшены', () => {
    expect(serializeModeModels({ plan: 'opus', auto: '' })).toBe('{"plan":"opus"}')
    expect(serializeModeModels({})).toBe('')
    expect(parseModeModels(serializeModeModels({ plan: 'opus' }))).toEqual({ plan: 'opus' })
  })
})
