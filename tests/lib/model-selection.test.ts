import { describe, expect, it } from 'vitest'
import {
  isStaleModelId,
  normalizeSelectedModel,
  sanitizeStaleModelText,
} from '../../shared/contracts/provider'

describe('model selection sanitizer', () => {
  const catalog = { models: ['grok-4.5'], defaultModel: 'grok-4.5' }

  it('заменяет снятые Grok ids на текущую модель', () => {
    expect(normalizeSelectedModel('grok-composer-2.5-fast', catalog)).toBe('grok-4.5')
    expect(normalizeSelectedModel('grok-build', catalog)).toBe('grok-4.5')
    expect(isStaleModelId(' GROK-COMPOSER-2.5 ')).toBe(true)
  })

  it('чистит stale id в уже сформированном тексте статуса', () => {
    expect(sanitizeStaleModelText('Grok · grok-composer-2.5-fast')).toBe('Grok · grok-4.5')
  })

  it('сохраняет custom model при пустом каталоге', () => {
    expect(normalizeSelectedModel('my-model', { models: [], defaultModel: 'fallback' })).toBe('my-model')
  })
})
