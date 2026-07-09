import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { captureControlCheckpoint, buildRunProvenance, CLI_WITH_TIMELINE } from '../../electron/ai/control-envelope'

// Реальные git-субпроцессы под параллельной нагрузкой suite — щедрый таймаут.
vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 })

const CLEAN_ENV = (() => {
  const e: NodeJS.ProcessEnv = { ...process.env }
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR', 'GIT_PREFIX', 'GIT_NAMESPACE', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete e[k]
  return e
})()
const gitRun = (dir: string, args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore', env: CLEAN_ENV })
function gitInit(dir: string) {
  gitRun(dir, ['init'])
  gitRun(dir, ['config', 'user.email', 't@t.t'])
  gitRun(dir, ['config', 'user.name', 'T'])
  gitRun(dir, ['config', 'commit.gpgsign', 'false'])
}

const SHA = /^[0-9a-f]{40}$/

describe('captureControlCheckpoint — честный git-якорь отката CLI-правок', () => {
  let repo: string
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'gg-env-repo-'))
    gitInit(repo)
    writeFileSync(join(repo, 'a.txt'), 'hello\n')
    gitRun(repo, ['add', '-A'])
    gitRun(repo, ['commit', '-m', 'init'])
  })
  afterEach(() => { try { rmSync(repo, { recursive: true, force: true }) } catch { /* win lock */ } })

  it('одиночный (one-shot) прогон в git-репо — checkpoint ставится, HEAD зафиксирован', () => {
    // Ключевой инвариант: якорь ставится ДАЖЕ на one-shot (без agent-loop).
    const cp = captureControlCheckpoint(repo, 111)
    expect(cp.isGit).toBe(true)
    expect(cp.gitHead).toMatch(SHA)
    expect(cp.stashRef).toBeNull() // чисто → нечего стэшить
    expect(cp.capturedAt).toBe(111)
  })

  it('грязное отслеживаемое изменение — stash-снапшот создаётся НЕДЕСТРУКТИВНО', () => {
    writeFileSync(join(repo, 'a.txt'), 'hello\nDIRTY\n')
    const cp = captureControlCheckpoint(repo, 222)
    expect(cp.gitHead).toMatch(SHA)
    expect(cp.stashRef).toMatch(SHA) // снапшот грязных tracked-правок
    // НЕДЕСТРУКТИВНОСТЬ: рабочее дерево после снапшота осталось грязным.
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toContain('DIRTY')
    // stash-список не тронут (git stash create не пушит в стек).
    const list = execFileSync('git', ['-C', repo, 'stash', 'list'], { encoding: 'utf8', env: CLEAN_ENV })
    expect(list.trim()).toBe('')
  })

  it('не-git папка — graceful, никакого якоря, не кидает', () => {
    const plain = mkdtempSync(join(tmpdir(), 'gg-env-plain-'))
    try {
      const cp = captureControlCheckpoint(plain, 333)
      expect(cp.isGit).toBe(false)
      expect(cp.gitHead).toBeNull()
      expect(cp.stashRef).toBeNull()
    } finally { rmSync(plain, { recursive: true, force: true }) }
  })

  it('null repoRoot — graceful', () => {
    const cp = captureControlCheckpoint(null, 444)
    expect(cp.isGit).toBe(false)
    expect(cp.gitHead).toBeNull()
  })
})

describe('buildRunProvenance — provenance без секретов', () => {
  const cp = { isGit: true, gitHead: 'a'.repeat(40), stashRef: null, capturedAt: 1 }

  it('CLI с проекцией (claude-cli) = observed, нота честно про правки вне undo + git-якорь', () => {
    const p = buildRunProvenance({ providerId: 'claude-cli', model: 'auto', transport: 'CLI', checkpoint: cp })
    expect(p.observed).toBe(true)
    expect(p.note).toContain('внутри CLI')
    expect(p.note).toContain('aaaaaaa') // короткий sha якоря
  })

  it('прочий CLI (grok-cli) = НЕ observed', () => {
    const p = buildRunProvenance({ providerId: 'grok-cli', model: 'auto', transport: 'CLI', checkpoint: cp })
    expect(p.observed).toBe(false)
    expect(p.note).toContain('внутри CLI')
  })

  it('API-путь = полный контроль, нота про per-file undo', () => {
    const p = buildRunProvenance({ providerId: 'claude', model: 'sonnet', transport: 'API', checkpoint: cp })
    expect(p.observed).toBe(false)
    expect(p.note).toContain('Полный контроль')
  })

  it('нет якоря (git без коммитов) — нота честно говорит про отсутствие точки отката', () => {
    const p = buildRunProvenance({ providerId: 'claude-cli', model: null, transport: 'CLI', checkpoint: { isGit: true, gitHead: null, stashRef: null, capturedAt: 1 } })
    expect(p.note).toContain('без коммитов')
  })

  it('провенанс НЕ несёт секретов: сериализация не содержит token/key/authorization', () => {
    const p = buildRunProvenance({ providerId: 'claude-cli', model: 'auto', transport: 'CLI', checkpoint: cp })
    const json = JSON.stringify(p).toLowerCase()
    for (const bad of ['token', 'authorization', 'bearer', 'sk-', 'oauth', 'secret', 'password']) {
      expect(json, bad).not.toContain(bad)
    }
  })

  it('CLI_WITH_TIMELINE синхронен с renderer-набором (claude/codex)', () => {
    expect([...CLI_WITH_TIMELINE].sort()).toEqual(['claude-cli', 'codex-cli'])
  })
})
