import { describe, expect, it } from 'vitest'
import { buildOutcomePassport, writeOutcomePassportFile } from '../../electron/ai/outcome-passport'
import type { OutcomePassportInput } from '../../electron/ai/outcome-passport'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('2.1.8 Outcome Passport', () => {
  it('собирает проверяемый отчёт и не выдумывает неизвестную стоимость', () => {
    const markdown = buildOutcomePassport(input())
    expect(markdown).toContain('# Паспорт результата #7')
    expect(markdown).toContain('1. [done] Исправить')
    expect(markdown).toContain('openai / gpt-test')
    expect(markdown).toContain('Проверки: 2/2')
    expect(markdown).toContain('Стоимость: неизвестно')
  })

  it('редактирует секреты, домашний и проектный путь', () => {
    const value = input()
    value.pipeline.brief.goal = 'token=sk-12345678901234567890 C:\\Users\\Pavel\\secret'
    value.verification!.htmlPath = 'C:\\Users\\Pavel\\project\\proof.html'
    const markdown = buildOutcomePassport(value)
    expect(markdown).not.toContain('sk-12345678901234567890')
    expect(markdown).not.toContain('C:\\Users\\Pavel')
    expect(markdown).toContain('[REDACTED:')
    expect(markdown).toContain('<проект>')
  })

  it('записывает и перечитывает паспорт без расхождения', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verstak-passport-'))
    try {
      const path = join(dir, 'result.md')
      const markdown = buildOutcomePassport(input())
      writeOutcomePassportFile(path, markdown)
      expect(readFileSync(path, 'utf8')).toBe(markdown)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

function input(): OutcomePassportInput {
  return {
    pipeline: {
      id: 7,
      projectPath: 'C:\\Users\\Pavel\\project',
      chatId: 1,
      agentRunId: 'run-1',
      mode: 'dev',
      effortLevel: 'controlled',
      workflowId: null,
      step: 'completed',
      brief: { goal: 'Исправить ошибку', constraints: 'не менять API', dod: 'tests pass' },
      planId: 2,
      taskContract: null,
      contractRevision: 0,
      contractDiagnostics: [],
      verifyAttempts: 1,
      createdAt: 1,
      updatedAt: 2,
    },
    plan: { title: 'Plan', steps: [{ title: 'Исправить', status: 'done', result: 'готово' }] },
    jobs: [],
    verification: {
      overall: 'passed',
      checksTotal: 2,
      checksPassed: 2,
      changedFilesCount: 1,
      htmlPath: 'C:\\Users\\Pavel\\project\\proof.html',
      artifactPath: null,
    },
    route: { providerId: 'openai', model: 'gpt-test' },
    metrics: {
      starts: 1,
      completed: 1,
      blocked: 0,
      cancelled: 0,
      replans: 0,
      retries: 0,
      interventions: 0,
      jobs: 0,
      filesChanged: 1,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      costCents: null,
      medianTimeToProofMs: null,
      noCorrectivePromptRuns: 1,
    },
    exportedAt: 0,
    homeDir: 'C:\\Users\\Pavel',
  }
}
