import { describe, it, expect } from 'vitest'
import { parseResumeCheckpoint } from '../../electron/ai/resume-checkpoint'

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
