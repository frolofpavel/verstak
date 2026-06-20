import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { attestVerificationHandler } from '../../electron/ipc/tool-handlers/verification'
import type { ToolContext } from '../../electron/ipc/tool-handlers/shared'
import { artifactsDir } from '../../electron/ai/artifacts'
import type { ToolCall } from '../../electron/ai/types'
import type { VerificationArtifact } from '../../electron/ai/verification'

/**
 * Ядро DoD-харнеса: attest_verification — «модель не вправе соврать про готово».
 *  - статус проверки ставится по РЕАЛЬНОМУ exitCode перепрогона, не по слову модели;
 *  - changed_files сверяются: claimed (заявлено агентом) vs actual (реально записано);
 *  - денилист/лимит/ручные проверки фиксируются как not_run, а не молча проглатываются.
 * Тестируем через настоящий writeVerificationArtifact (temp dir) + чтение артефакта.
 */

type ClassifyResult = { allowed: boolean; reason?: string }
type RunResult = { exitCode: number; stdout: string; stderr: string }

interface CtxOverrides {
  classify?: (cmd: string) => ClassifyResult
  run?: (cmd: string) => Promise<RunResult>
  filesTouched?: (() => string[]) | null
}

function ctxFor(projectPath: string, o: CtxOverrides = {}): ToolContext {
  return {
    projectPath,
    sendId: 't',
    sender: { send: () => {} },
    pendingAttachments: [],
    tools: {
      classifyCommand: o.classify ?? (() => ({ allowed: true })),
      runCommand: o.run ?? (async () => ({ exitCode: 0, stdout: '', stderr: '' }))
    },
    runFilesTouched: o.filesTouched === null ? undefined : (o.filesTouched ?? (() => [])),
    recordJournal: () => {},
    recordRunEvent: () => {},
    verifications: { insert: () => 1 }
  } as unknown as ToolContext
}

function call(args: Record<string, unknown>): ToolCall {
  return { id: '1', name: 'attest_verification', args }
}

function readArtifact(projectPath: string): VerificationArtifact {
  const dir = artifactsDir(projectPath)
  const jsonFile = readdirSync(dir).find(f => f.endsWith('.json'))
  if (!jsonFile) throw new Error('артефакт .json не записан')
  return JSON.parse(readFileSync(join(dir, jsonFile), 'utf8'))
}

describe('attest_verification — ядро DoD', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gg-attest-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('task_summary обязателен', async () => {
    const res = await attestVerificationHandler.handle(call({ task_summary: '   ' }), ctxFor(dir))
    expect(res.error).toBeTruthy()
    expect(res.result).toBe('')
  })

  it('статус по exitCode, НЕ по слову модели — модель пишет «ок», exit=1 → failed', async () => {
    const res = await attestVerificationHandler.handle(call({
      task_summary: 'фикс бага',
      checks: [{ command: 'npm test', summary: 'всё зелёное, готово' }]
    }), ctxFor(dir, { run: async () => ({ exitCode: 1, stdout: '', stderr: '2 failed' }) }))
    const art = readArtifact(dir)
    expect(art.checks[0].status).toBe('failed')
    expect(art.checks[0].exitCode).toBe(1)
    expect(art.overall).toBe('failed')          // провал доминирует
    expect(res.result).toContain('overall=failed')
  })

  it('exit=0 → passed; смесь passed+failed → overall failed', async () => {
    const res = await attestVerificationHandler.handle(call({
      task_summary: 'две проверки',
      checks: [{ command: 'npm run type' }, { command: 'npm test' }]
    }), ctxFor(dir, {
      run: async (cmd) => cmd.includes('type') ? { exitCode: 0, stdout: 'ok', stderr: '' } : { exitCode: 2, stdout: '', stderr: 'fail' }
    }))
    const art = readArtifact(dir)
    const byCmd = Object.fromEntries(art.checks.map(c => [c.command, c.status]))
    expect(byCmd['npm run type']).toBe('passed')
    expect(byCmd['npm test']).toBe('failed')
    expect(res.result).toContain('overall=failed')
  })

  it('claimed-vs-actual: заявлен файл, который НЕ трогали → actual=false (модель соврала)', async () => {
    await attestVerificationHandler.handle(call({
      task_summary: 'правка',
      changed_files: ['src/foo.ts', 'src/bar.ts']
    }), ctxFor(dir, { filesTouched: () => ['src/foo.ts'] }))  // реально тронут только foo
    const art = readArtifact(dir)
    const byPath = Object.fromEntries(art.changedFiles.map(f => [f.path, f]))
    expect(byPath['src/foo.ts']).toMatchObject({ claimed: true, actual: true })
    expect(byPath['src/bar.ts']).toMatchObject({ claimed: true, actual: false })  // ← враньё поймано
  })

  it('реально тронутый, но НЕ заявленный файл → попадает в артефакт claimed=false', async () => {
    await attestVerificationHandler.handle(call({
      task_summary: 'правка',
      changed_files: ['src/foo.ts']
    }), ctxFor(dir, { filesTouched: () => ['src/foo.ts', 'src/secret-touch.ts'] }))
    const art = readArtifact(dir)
    const sneaky = art.changedFiles.find(f => f.path === 'src/secret-touch.ts')
    expect(sneaky).toMatchObject({ claimed: false, actual: true })
  })

  it('источник actual недоступен → actual=claimed (не блокируем фазу)', async () => {
    await attestVerificationHandler.handle(call({
      task_summary: 'правка',
      changed_files: ['src/foo.ts']
    }), ctxFor(dir, { filesTouched: null }))  // нет runFilesTouched
    const art = readArtifact(dir)
    expect(art.changedFiles[0]).toMatchObject({ path: 'src/foo.ts', claimed: true, actual: true })
  })

  it('денилист: заблокированная команда → not_run+manual, runCommand НЕ вызывается', async () => {
    let ran = 0
    await attestVerificationHandler.handle(call({
      task_summary: 'опасная проверка',
      checks: [{ command: 'rm -rf /', summary: 'почистить' }]
    }), ctxFor(dir, {
      classify: () => ({ allowed: false, reason: 'destructive' }),
      run: async () => { ran++; return { exitCode: 0, stdout: '', stderr: '' } }
    }))
    const art = readArtifact(dir)
    expect(ran).toBe(0)
    expect(art.checks[0]).toMatchObject({ status: 'not_run', manual: true })
    expect(art.checks[0].summary).toContain('destructive')
  })

  it('лимит 10 команд: сверх лимита — not_run, не прогоняются', async () => {
    let ran = 0
    const checks = Array.from({ length: 13 }, (_, i) => ({ command: `echo ${i}` }))
    await attestVerificationHandler.handle(call({ task_summary: 'много проверок', checks }),
      ctxFor(dir, { run: async () => { ran++; return { exitCode: 0, stdout: '', stderr: '' } } }))
    const art = readArtifact(dir)
    expect(ran).toBe(10)                                            // прогнали ровно лимит
    expect(art.checks.filter(c => c.status === 'passed').length).toBe(10)
    expect(art.checks.filter(c => c.status === 'not_run').length).toBe(3)  // остаток зафиксирован честно
  })
})
