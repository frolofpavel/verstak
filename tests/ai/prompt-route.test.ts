// Срез 2.0.7-F: модель на один prompt. Чистый резолвер маршрута — определяет
// requested route (провайдер/модель/источник) и разрешён ли fallback ДО отправки.
// Explicit route по умолчанию strict (карточка шаг 3): пользователь выбрал модель на
// один запрос осознанно — молча уезжать на другого провайдера нельзя.
import { describe, it, expect } from 'vitest'
import {
  resolvePromptRoute, type PromptRouteOverride,
} from '../../shared/contracts/provider'

const chatDefault = { providerId: 'claude' as const, model: 'claude-sonnet-4-6' }

describe('resolvePromptRoute — requested route до отправки', () => {
  it('нет override → chat-default, fallback разрешён', () => {
    const r = resolvePromptRoute(chatDefault, null)
    expect(r.providerId).toBe('claude')
    expect(r.model).toBe('claude-sonnet-4-6')
    expect(r.source).toBe('chat-default')
    expect(r.fallbackAllowed).toBe(true)
  })

  it('override strict → prompt-explicit, fallback ЗАПРЕЩЁН', () => {
    const ov: PromptRouteOverride = { providerId: 'grok', model: 'grok-4.5', fallbackPolicy: 'strict' }
    const r = resolvePromptRoute(chatDefault, ov)
    expect(r.providerId).toBe('grok')
    expect(r.model).toBe('grok-4.5')
    expect(r.source).toBe('prompt-explicit')
    expect(r.fallbackAllowed).toBe(false)
  })

  it('override allow → prompt-explicit, fallback РАЗРЕШЁН', () => {
    const ov: PromptRouteOverride = { providerId: 'grok', model: 'grok-4.5', fallbackPolicy: 'allow' }
    const r = resolvePromptRoute(chatDefault, ov)
    expect(r.source).toBe('prompt-explicit')
    expect(r.fallbackAllowed).toBe(true)
  })

  it('override НЕ мутирует chat-default (one-shot: следующий вызов без override — снова default)', () => {
    const ov: PromptRouteOverride = { providerId: 'grok', model: 'grok-4.5', fallbackPolicy: 'strict' }
    resolvePromptRoute(chatDefault, ov)
    const again = resolvePromptRoute(chatDefault, null)
    expect(again.providerId).toBe('claude')
    expect(again.source).toBe('chat-default')
  })
})
