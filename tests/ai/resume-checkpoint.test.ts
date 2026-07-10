import { describe, it, expect } from 'vitest'
import { parseResumeCheckpoint, canReplayCheckpoint } from '../../electron/ai/resume-checkpoint'

/**
 * parseResumeCheckpoint — рубеж безопасности возобновления: снапшот мог записаться
 * частично при краше, поэтому любая невалидность → null (мягкий фоллбэк на свежий
 * старт), а не падение ai:send с битой историей.
 */
describe('parseResumeCheckpoint', () => {
  it('валидный массив сообщений → возвращает его', () => {
    const json = JSON.stringify([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'привет' },
      { role: 'assistant', content: 'ответ' }
    ])
    const out = parseResumeCheckpoint(json)
    expect(out).toHaveLength(3)
    expect(out![1].role).toBe('user')
  })

  it('битый JSON → null', () => {
    expect(parseResumeCheckpoint('{не json')).toBeNull()
    expect(parseResumeCheckpoint('[{"role":')).toBeNull()
  })

  it('пустой массив → null (нечего возобновлять)', () => {
    expect(parseResumeCheckpoint('[]')).toBeNull()
  })

  it('не массив (объект/строка/число) → null', () => {
    expect(parseResumeCheckpoint('{"role":"user"}')).toBeNull()
    expect(parseResumeCheckpoint('"строка"')).toBeNull()
    expect(parseResumeCheckpoint('42')).toBeNull()
    expect(parseResumeCheckpoint('null')).toBeNull()
  })

  it('элемент без валидной role → null (частичный/битый снапшот)', () => {
    expect(parseResumeCheckpoint('[{"content":"нет role"}]')).toBeNull()
    expect(parseResumeCheckpoint('[{"role":123}]')).toBeNull()
    expect(parseResumeCheckpoint('[{"role":"user"},null]')).toBeNull()
    expect(parseResumeCheckpoint('[{"role":"user"},"строка"]')).toBeNull()
  })

  it('null/undefined/пустая строка → null', () => {
    expect(parseResumeCheckpoint(null)).toBeNull()
    expect(parseResumeCheckpoint(undefined)).toBeNull()
    expect(parseResumeCheckpoint('')).toBeNull()
  })
})

describe('canReplayCheckpoint — гард совместимости возобновления (1.9.8 #4)', () => {
  it('тот же провайдер → реплей разрешён', () => {
    expect(canReplayCheckpoint({ providerId: 'claude' }, 'claude')).toBe(true)
  })
  it('другой провайдер → НЕ реплеим (формат tool_use несовместим)', () => {
    expect(canReplayCheckpoint({ providerId: 'claude' }, 'gemini-api')).toBe(false)
    // CLI↔API того же вендора — тоже разные форматы истории.
    expect(canReplayCheckpoint({ providerId: 'claude-cli' }, 'claude')).toBe(false)
  })
  it('нет чекпойнт-прогона / null providerId → не реплеим', () => {
    expect(canReplayCheckpoint(null, 'claude')).toBe(false)
    expect(canReplayCheckpoint(undefined, 'claude')).toBe(false)
    expect(canReplayCheckpoint({ providerId: null }, 'claude')).toBe(false)
  })
})
