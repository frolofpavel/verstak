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
  isMutatingToolName,
  snapshotVerifyBaseline,
  isReviewGatePassResult,
  decideReviewGate,
  buildReviewGateRequiredNudge,
  REVIEW_GATE_PASS_MARKER,
  REVIEW_GATE_STOP_MESSAGE,
  MAX_REVIEW_GATE_NUDGES,
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

// ─────────────────────────────────────────────────────────────────────────────
// Этап 6 P1: авто-снапшот baseline
// ─────────────────────────────────────────────────────────────────────────────

describe('isMutatingToolName', () => {
  it('распознаёт file-edit/patch тулзы', () => {
    expect(isMutatingToolName('write_file')).toBe(true)
    expect(isMutatingToolName('apply_patch')).toBe(true)
    expect(isMutatingToolName('edit_file')).toBe(true)
  })
  it('не считает read/verify тулзы мутирующими', () => {
    expect(isMutatingToolName('read_file')).toBe(false)
    expect(isMutatingToolName('run_command')).toBe(false)
    expect(isMutatingToolName('review_before_commit')).toBe(false)
    expect(isMutatingToolName('get_project_map')).toBe(false)
  })
})

describe('snapshotVerifyBaseline — P1', () => {
  const okClassify = () => ({ allowed: true as const })

  it('снимает baseline по allowlisted verify-командам (output+exit)', async () => {
    const calls: string[] = []
    const runs = await snapshotVerifyBaseline(['npm run type'], {
      classifyCommand: okClassify,
      runCommand: async (cmd) => { calls.push(cmd); return { stdout: '✅ нет ошибок', stderr: '', exitCode: 0 } },
    })
    expect(calls).toEqual(['npm run type'])
    expect(runs).toEqual([{ command: 'npm run type', output: '✅ нет ошибок', exitCode: 0 }])
  })

  it('пропускает не-allowlisted команды (fail-closed, не в baseline)', async () => {
    let ran = false
    const runs = await snapshotVerifyBaseline(['rm -rf /', 'git push'], {
      classifyCommand: okClassify,
      runCommand: async () => { ran = true; return { stdout: '', stderr: '', exitCode: 0 } },
    })
    expect(ran).toBe(false)
    expect(runs).toEqual([])
  })

  it('пропускает команды, заблокированные политикой (не обходим command-policy)', async () => {
    const runs = await snapshotVerifyBaseline(['npm run type'], {
      classifyCommand: () => ({ allowed: false, reason: 'денилист' }),
      runCommand: async () => { throw new Error('не должно запуститься') },
    })
    expect(runs).toEqual([])
  })

  it('throw в runCommand → нет baseline для команды (без false-pass)', async () => {
    const runs = await snapshotVerifyBaseline(['npm run type'], {
      classifyCommand: okClassify,
      runCommand: async () => { throw new Error('spawn failed') },
    })
    expect(runs).toEqual([])
  })

  it('baseline unavailable + красный после правки → evaluateVerify блокирует (нет false-pass)', async () => {
    // baseline не снялся (пустой) → gate идёт строгим путём: exit≠0/сигнатуры блокируют.
    const baseline = await snapshotVerifyBaseline(['npm run type'], {
      classifyCommand: () => ({ allowed: false }),
      runCommand: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    })
    expect(baseline).toEqual([])
    const gate = evaluateVerify(
      [{ command: 'npm run type', output: 'src/a.ts(1,2): error TS2322: bad', exitCode: 1 }],
      baseline,
    )
    expect(gate.pass).toBe(false)
    expect(gate.blocking.length).toBeGreaterThan(0)
  })

  it('снятый baseline reused: pre-existing red не блокирует, новая — блокирует', async () => {
    const preExisting = 'src/a.ts(10,5): error TS2322: type mismatch'
    const baseline = await snapshotVerifyBaseline(['npm run type'], {
      classifyCommand: okClassify,
      runCommand: async () => ({ stdout: preExisting, stderr: '', exitCode: 1 }),
    })
    expect(baseline).toHaveLength(1)
    // тот же red после правки → не блок
    expect(evaluateVerify([{ command: 'npm run type', output: preExisting, exitCode: 1 }], baseline).pass).toBe(true)
    // новая ошибка поверх baseline → блок
    const g = evaluateVerify([{ command: 'npm run type', output: preExisting + '\nsrc/b.ts(3,1): error TS1005: ; expected', exitCode: 1 }], baseline)
    expect(g.pass).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Этап 6 P2: mandatory review gate enforcement
// ─────────────────────────────────────────────────────────────────────────────

describe('isReviewGatePassResult', () => {
  it('распознаёт успешный результат гейта по маркеру', () => {
    const ok = `✅ ${REVIEW_GATE_PASS_MARKER} (confidence 0.9).\nок`
    expect(isReviewGatePassResult(ok)).toBe(true)
  })
  it('провал гейта (❌) не считается pass', () => {
    expect(isReviewGatePassResult('❌ REVIEW GATE: НЕ ПРОЙДЕНО.\nПричина: X')).toBe(false)
  })
  it('результат с ошибкой tool-вызова не pass даже с маркером', () => {
    expect(isReviewGatePassResult(`✅ ${REVIEW_GATE_PASS_MARKER}`, true)).toBe(false)
  })
  it('не-строка не pass', () => {
    expect(isReviewGatePassResult(undefined)).toBe(false)
    expect(isReviewGatePassResult({ pass: true })).toBe(false)
  })
})

describe('decideReviewGate — enforcement', () => {
  const max = MAX_REVIEW_GATE_NUDGES
  it('recipe без reviewer.required → финал разрешён', () => {
    expect(decideReviewGate({ required: false, passed: false, nudges: 0, maxNudges: max })).toBe('allow')
  })
  it('обычный skill (required=false) не задет даже без гейта', () => {
    expect(decideReviewGate({ required: false, passed: false, nudges: 5, maxNudges: max })).toBe('allow')
  })
  it('reviewer.required и гейт не пройден, есть бюджет nudge → retry', () => {
    expect(decideReviewGate({ required: true, passed: false, nudges: 0, maxNudges: max })).toBe('retry')
  })
  it('после успешного гейта → финал разрешён', () => {
    expect(decideReviewGate({ required: true, passed: true, nudges: 0, maxNudges: max })).toBe('allow')
  })
  it('гейт не пройден и nudge исчерпан → fail-closed stop', () => {
    expect(decideReviewGate({ required: true, passed: false, nudges: max, maxNudges: max })).toBe('stop')
  })
  it('MAX_REVIEW_GATE_NUDGES bounded = 1', () => {
    expect(MAX_REVIEW_GATE_NUDGES).toBe(1)
  })
})

describe('сообщения enforcement', () => {
  it('nudge перечисляет verify-команды и требует вызвать гейт', () => {
    const n = buildReviewGateRequiredNudge(['npm run type', 'npm test'])
    expect(n).toContain('review_before_commit')
    expect(n).toContain('npm run type')
    expect(n).toContain('npm test')
    expect(n).toContain(REVIEW_GATE_PASS_MARKER)
  })
  it('stop-сообщение объясняет причину', () => {
    expect(REVIEW_GATE_STOP_MESSAGE).toContain('reviewer.required')
    expect(REVIEW_GATE_STOP_MESSAGE.length).toBeGreaterThan(20)
  })
})
