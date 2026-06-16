import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  computeOverall,
  renderVerificationHtml,
  type VerificationCheck,
  type VerificationArtifact
} from '../../electron/ai/verification'
import { writeVerificationArtifact } from '../../electron/ai/artifacts'

function check(status: VerificationCheck['status'], extra: Partial<VerificationCheck> = {}): VerificationCheck {
  return { command: 'npm test', status, manual: false, ...extra }
}

function art(over: VerificationArtifact, patch: Partial<VerificationArtifact> = {}): VerificationArtifact {
  return { ...over, ...patch }
}

const baseArt: VerificationArtifact = {
  version: 1,
  taskSummary: 'Добавил фичу X',
  overall: 'passed',
  changedFiles: [],
  checks: [],
  risks: [],
  createdAt: Date.parse('2026-06-15T10:00:00Z')
}

describe('computeOverall', () => {
  it('пусто → not_run', () => {
    expect(computeOverall([])).toBe('not_run')
  })

  it('все passed → passed', () => {
    expect(computeOverall([check('passed'), check('passed')])).toBe('passed')
  })

  it('один failed → failed (доминирует)', () => {
    expect(computeOverall([check('passed'), check('failed'), check('not_run')])).toBe('failed')
  })

  it('passed + not_run → partial', () => {
    expect(computeOverall([check('passed'), check('not_run')])).toBe('partial')
  })

  it('passed + manual(not_run) → partial', () => {
    expect(computeOverall([
      check('passed'),
      check('not_run', { command: null, manual: true })
    ])).toBe('partial')
  })

  it('все not_run → not_run', () => {
    expect(computeOverall([check('not_run'), check('not_run')])).toBe('not_run')
  })

  it('partial без failed → partial', () => {
    expect(computeOverall([check('passed'), check('partial')])).toBe('partial')
  })
})

describe('renderVerificationHtml', () => {
  it('содержит overall-бейдж нужного цвета (passed=#4ec9b0)', () => {
    const html = renderVerificationHtml(art(baseArt, { overall: 'passed' }))
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('#4ec9b0')
  })

  it('failed → красный бейдж #f47174', () => {
    const html = renderVerificationHtml(art(baseArt, { overall: 'failed' }))
    expect(html).toContain('#f47174')
  })

  it('partial/not_run → жёлтый бейдж #d7ba7d', () => {
    const html = renderVerificationHtml(art(baseArt, { overall: 'partial', checks: [check('not_run')] }))
    expect(html).toContain('#d7ba7d')
  })

  it('экранирует HTML в taskSummary (XSS-безопасно)', () => {
    const html = renderVerificationHtml(art(baseArt, { taskSummary: 'Сломал <script>alert(1)</script>' }))
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('экранирует tail вывода проверки', () => {
    const html = renderVerificationHtml(art(baseArt, {
      checks: [check('failed', { tail: 'Error: <b>boom</b> & co', exitCode: 1 })]
    }))
    expect(html).not.toContain('<b>boom</b>')
    expect(html).toContain('&lt;b&gt;boom&lt;/b&gt;')
    expect(html).toContain('&amp; co')
  })

  it('таблица checks присутствует с командой и exitCode', () => {
    const html = renderVerificationHtml(art(baseArt, {
      checks: [check('passed', { command: 'npm run type', exitCode: 0 })]
    }))
    expect(html).toContain('<table>')
    expect(html).toContain('npm run type')
    expect(html).toContain('<thead>')
  })

  it('подсвечивает расхождение claimed≠actual у changedFiles', () => {
    const html = renderVerificationHtml(art(baseArt, {
      changedFiles: [
        { path: 'src/a.ts', claimed: true, actual: false },
        { path: 'src/b.ts', claimed: false, actual: true }
      ]
    }))
    expect(html).toContain('заявлен, но не тронут')
    expect(html).toContain('тронут, но не заявлен')
  })

  it('рендерит screenshot если есть путь', () => {
    const html = renderVerificationHtml(art(baseArt, { screenshotPath: '/tmp/shot.png' }))
    expect(html).toContain('<img')
    expect(html).toContain('/tmp/shot.png')
  })
})

describe('writeVerificationArtifact', () => {
  let projectPath: string

  beforeAll(async () => {
    projectPath = await mkdtemp(join(tmpdir(), 'gg-verify-'))
  })

  afterAll(async () => {
    if (projectPath) await rm(projectPath, { recursive: true, force: true })
  })

  it('пишет json + html и переиспользует artifactsDir/sanitizeFilename', async () => {
    const r = await writeVerificationArtifact(projectPath, art(baseArt, {
      taskSummary: 'kp/with/slash',  // спец-символы должны быть очищены slug-ом
      checks: [check('passed', { exitCode: 0 })],
      overall: 'passed'
    }))
    expect(r.filename).toMatch(/\.verification\.html$/)
    expect(r.filename).not.toMatch(/[\/\\]/)
    expect(r.jsonPath).toMatch(/[/\\]\.verstak[/\\]artifacts[/\\]\d{4}-\d{2}-\d{2}[/\\]/)
    expect(r.sizeBytes).toBeGreaterThan(0)

    const jsonRaw = await readFile(r.jsonPath, 'utf8')
    const parsed = JSON.parse(jsonRaw) as VerificationArtifact
    expect(parsed.version).toBe(1)
    expect(parsed.overall).toBe('passed')

    const htmlRaw = await readFile(r.htmlPath, 'utf8')
    expect(htmlRaw).toContain('<!DOCTYPE html>')
  })

  it('fallback slug = verification если taskSummary пуст (+ суффикс уникальности)', async () => {
    const r = await writeVerificationArtifact(projectPath, art(baseArt, { taskSummary: '' }))
    // Базовый slug 'verification' + суффикс уникальности (runId/timestamp), чтобы
    // повторная аттестация не затирала прежний артефакт.
    expect(r.filename).toMatch(/^verification-[a-z0-9]+\.verification\.html$/)
  })

  it('повторная аттестация не затирает прежний артефакт (разные имена)', async () => {
    const a = await writeVerificationArtifact(projectPath, art(baseArt, { taskSummary: 'fix bug', runId: 'run-aaaa1111' }))
    const b = await writeVerificationArtifact(projectPath, art(baseArt, { taskSummary: 'fix bug', runId: 'run-bbbb2222' }))
    expect(a.filename).not.toBe(b.filename)
  })
})
