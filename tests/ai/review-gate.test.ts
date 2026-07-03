import { describe, it, expect } from 'vitest'
import {
  isAllowedVerifyCommand,
  evaluateVerify,
  parseReviewVerdict,
  buildVerdictReviewerPrompt,
  buildFixerPrompt,
  formatVerifyReport,
  REVIEW_CONFIDENCE_THRESHOLD,
  MAX_AUTOFIX_CYCLES,
} from '../../electron/ai/review-gate'

describe('isAllowedVerifyCommand', () => {
  it('разрешает проверочные команды', () => {
    expect(isAllowedVerifyCommand('npm run type')).toBe(true)
    expect(isAllowedVerifyCommand('npm run test:fast')).toBe(true)
    expect(isAllowedVerifyCommand('npm test')).toBe(true)
    expect(isAllowedVerifyCommand('pnpm run typecheck')).toBe(true)
    expect(isAllowedVerifyCommand('npx tsc --noEmit')).toBe(true)
    expect(isAllowedVerifyCommand('vitest run')).toBe(true)
    expect(isAllowedVerifyCommand('  npm run lint  ')).toBe(true)
  })
  it('блокирует прочие/опасные команды', () => {
    expect(isAllowedVerifyCommand('')).toBe(false)
    expect(isAllowedVerifyCommand('rm -rf /')).toBe(false)
    expect(isAllowedVerifyCommand('git push')).toBe(false)
    expect(isAllowedVerifyCommand('echo hi')).toBe(false)
    expect(isAllowedVerifyCommand('npm run type && rm x')).toBe(false) // fail-closed: составные команды отклоняются
    expect(isAllowedVerifyCommand('npm run type | tee log')).toBe(false)
    expect(isAllowedVerifyCommand('npm run type > out.txt')).toBe(false)
  })
})

describe('parseReviewVerdict — fail-closed', () => {
  const good = JSON.stringify({ verdict: 'pass', confidence: 0.9, inspected_diff: true, issues: [], summary: 'ок' })

  it('валидный pass', () => {
    const v = parseReviewVerdict(good)
    expect(v.pass).toBe(true)
    expect(v.confidence).toBe(0.9)
    expect(v.failReason).toBeNull()
  })
  it('confidence ниже порога = fail', () => {
    const v = parseReviewVerdict(JSON.stringify({ verdict: 'pass', confidence: 0.6, inspected_diff: true }))
    expect(v.pass).toBe(false)
    expect(v.failReason).toContain(String(REVIEW_CONFIDENCE_THRESHOLD))
  })
  it('inspected_diff false = fail', () => {
    const v = parseReviewVerdict(JSON.stringify({ verdict: 'pass', confidence: 0.95, inspected_diff: false }))
    expect(v.pass).toBe(false)
    expect(v.failReason).toContain('diff')
  })
  it('verdict fail = fail', () => {
    const v = parseReviewVerdict(JSON.stringify({ verdict: 'fail', confidence: 0.9, inspected_diff: true, summary: 'баг в X' }))
    expect(v.pass).toBe(false)
  })
  it('невалидный JSON = fail', () => {
    const v = parseReviewVerdict('это не json')
    expect(v.pass).toBe(false)
    expect(v.failReason).toContain('невалидный JSON')
  })
  it('пустой объект = fail (нет verdict)', () => {
    const v = parseReviewVerdict('{}')
    expect(v.pass).toBe(false)
    expect(v.failReason).toContain('пустой вердикт')
  })
  it('JSON в fenced-блоке парсится', () => {
    const v = parseReviewVerdict('Вот мой вердикт:\n```json\n' + good + '\n```\nконец')
    expect(v.pass).toBe(true)
  })
  it('boolean pass:true с inspected_diff и confidence', () => {
    const v = parseReviewVerdict(JSON.stringify({ pass: true, confidence: 0.8, inspected_diff: true }))
    expect(v.pass).toBe(true)
  })
  it('нет confidence = fail', () => {
    const v = parseReviewVerdict(JSON.stringify({ verdict: 'pass', inspected_diff: true }))
    expect(v.pass).toBe(false)
  })
  it('prefix [Delegate from ...] перед JSON не мешает', () => {
    const v = parseReviewVerdict('[Delegate from critic]\n\n' + good)
    expect(v.pass).toBe(true)
  })
})

describe('evaluateVerify — baseline-aware', () => {
  it('verify не запускалась = fail', () => {
    const g = evaluateVerify([])
    expect(g.ranAny).toBe(false)
    expect(g.pass).toBe(false)
  })
  it('чистый прогон без baseline = pass', () => {
    const g = evaluateVerify([{ command: 'npm run type', output: '✅ нет ошибок', exitCode: 0 }])
    expect(g.pass).toBe(true)
  })
  it('exit≠0 без baseline = блок', () => {
    const g = evaluateVerify([{ command: 'npm run type', output: 'src/a.ts(1,2): error TS2322: bad', exitCode: 1 }])
    expect(g.pass).toBe(false)
    expect(g.blocking.length).toBeGreaterThan(0)
  })
  it('pre-existing red не блокирует', () => {
    const err = 'src/a.ts(10,5): error TS2322: type mismatch'
    const g = evaluateVerify(
      [{ command: 'npm run type', output: err, exitCode: 1 }],
      [{ command: 'npm run type', output: err }],
    )
    expect(g.pass).toBe(true)
  })
  it('новая ошибка поверх baseline блокирует', () => {
    const g = evaluateVerify(
      [{ command: 'npm run type', output: 'src/b.ts(3,1): error TS1005: ; expected', exitCode: 1 }],
      [{ command: 'npm run type', output: '✅ нет ошибок' }],
    )
    expect(g.pass).toBe(false)
    expect(g.blocking.length).toBeGreaterThan(0)
  })
})

describe('промпт-билдеры', () => {
  it('reviewer prompt содержит diff, brief, verify и контракт JSON', () => {
    const p = buildVerdictReviewerPrompt('DIFF_HERE', 'BRIEF_HERE', 'VERIFY_HERE')
    expect(p).toContain('DIFF_HERE')
    expect(p).toContain('BRIEF_HERE')
    expect(p).toContain('VERIFY_HERE')
    expect(p).toContain('inspected_diff')
    expect(p).toContain('verdict')
  })
  it('fixer prompt перечисляет проблемы и требует повторный verify', () => {
    const p = buildFixerPrompt('B', 'D', ['проблема раз', 'проблема два'], 'VR')
    expect(p).toContain('проблема раз')
    expect(p).toContain('проблема два')
    expect(p).toMatch(/verify/i)
  })
  it('formatVerifyReport показывает блокирующие ошибки', () => {
    const r = formatVerifyReport(
      [{ command: 'npm run type', output: 'x', exitCode: 1 }],
      { ranAny: true, blocking: ['npm run type: err'], pass: false },
    )
    expect(r).toContain('npm run type')
    expect(r).toContain('err')
  })
})

describe('константы гейта', () => {
  it('порог и лимит autofix соответствуют решению Павла', () => {
    expect(REVIEW_CONFIDENCE_THRESHOLD).toBe(0.7)
    expect(MAX_AUTOFIX_CYCLES).toBe(2)
  })
})
