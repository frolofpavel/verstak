import { describe, it, expect } from 'vitest'
import { resumeBannerActions, actionReplaysContext } from '../../src/lib/resume-actions'

describe('resumeBannerActions — действия баннера прерванного прогона (1.9.7 #1)', () => {
  it('autoResumable + есть запрос → реплей с контекстом + показать', () => {
    expect(resumeBannerActions({ autoResumable: true, lastUserRequest: 'почини баг' }))
      .toEqual(['resume-with-context', 'show-what-was-done'])
  })

  it('НЕ-auto (CLI/деструктив) + есть запрос → СВЕЖИЙ re-send + показать (раньше пряталось)', () => {
    expect(resumeBannerActions({ autoResumable: false, lastUserRequest: 'сделай рефактор' }))
      .toEqual(['resend-fresh', 'show-what-was-done'])
  })

  it('нет сохранённого запроса → только показать (re-send нечего слать)', () => {
    expect(resumeBannerActions({ autoResumable: false, lastUserRequest: '' }))
      .toEqual(['show-what-was-done'])
    expect(resumeBannerActions({ autoResumable: true, lastUserRequest: '   ' }))
      .toEqual(['show-what-was-done'])
  })

  it('реплей контекста только у resume-with-context (fresh re-send НЕ реплеит)', () => {
    expect(actionReplaysContext('resume-with-context')).toBe(true)
    expect(actionReplaysContext('resend-fresh')).toBe(false)
    expect(actionReplaysContext('show-what-was-done')).toBe(false)
  })
})
