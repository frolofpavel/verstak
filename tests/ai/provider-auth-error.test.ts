// Б3.3 (живая приёмка 11.08): провайдер с неактивной подпиской падал голым
// отказом за 1.5 с — kimi-coding с протухшим ключом Павла отдал в карточку
// ошибки сырое сообщение SDK, по которому не понять ни причину, ни что делать.
//
// Правило: 401/403/402 от OpenAI-совместимого провайдера переводятся на язык
// человека («подписка неактивна / ключ отклонён провайдером» + куда идти),
// причём для ВСЕХ провайдеров openai-compat, а не только Verstak Gateway (у
// того свой mapGatewayError — он не тронут). Неизвестный статус → null: сырое
// сообщение честнее выдуманного перевода.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { mapProviderAuthError } from '../../electron/ai/provider-errors'

const ROOT = join(__dirname, '..', '..')

describe('Б3 · mapProviderAuthError: понятная причина вместо голого отказа', () => {
  it('401 (живой факт: kimi-coding, подписка кончилась) — «подписка неактивна / ключ отклонён»', () => {
    const msg = mapProviderAuthError('Kimi Code (подписка)', 401, undefined)
    expect(msg).toBeTruthy()
    expect(msg!).toContain('Kimi Code')
    expect(msg!.toLowerCase()).toContain('ключ отклон')
    expect(msg!.toLowerCase()).toContain('подписка')
    // Человеку сказано, куда идти, а не только что всё плохо.
    expect(msg!).toContain('Настройк')
  })

  it('403 — тот же класс, что 401', () => {
    const msg = mapProviderAuthError('DeepSeek', 403, undefined)
    expect(msg).toBeTruthy()
    expect(msg!.toLowerCase()).toContain('ключ отклон')
  })

  it('402 / insufficient_balance — про деньги/квоту, не про ключ', () => {
    for (const [status, code] of [[402, undefined], [undefined, 'insufficient_balance'], [undefined, 'insufficient_quota']] as const) {
      const msg = mapProviderAuthError('Moonshot Kimi', status, code)
      expect(msg, `status=${status} code=${code}`).toBeTruthy()
      expect(msg!.toLowerCase()).toMatch(/баланс|квот|средств/)
    }
  })

  // КОНТРОЛЬ: не переводим то, чего не понимаем, — сырое сообщение честнее.
  it('контроль: 429/500/сеть/без статуса → null (остаётся исходное сообщение)', () => {
    expect(mapProviderAuthError('DeepSeek', 429, undefined)).toBeNull()
    expect(mapProviderAuthError('DeepSeek', 500, undefined)).toBeNull()
    expect(mapProviderAuthError('DeepSeek', undefined, undefined)).toBeNull()
  })
})

// Пин на ИСТОЧНИК: перевод, который catch openai-compat не зовёт, — ложная
// закрытость (приём проекта: SEC-CMD-08, Б1, Б2).
describe('Б3 · openai-compat реально переводит ошибку, а Gateway-ветка не тронута', () => {
  const compat = readFileSync(join(ROOT, 'electron', 'ai', 'openai-compat.ts'), 'utf8')

  it('catch зовёт mapProviderAuthError для не-gateway провайдеров', () => {
    expect(compat).toContain('mapProviderAuthError')
  })

  it('Gateway остаётся на своём mapGatewayError', () => {
    expect(compat).toContain('mapGatewayError')
  })
})
