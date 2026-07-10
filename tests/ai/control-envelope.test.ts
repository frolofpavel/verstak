import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { captureControlCheckpoint, buildRunProvenance, CLI_WITH_TIMELINE, serializeEnvelope, parseEnvelope, previewControlRestore, applyControlRestore, anchorStash, isStashAlive, pruneEnvelopeStashes } from '../../electron/ai/control-envelope'

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

describe('serializeEnvelope / parseEnvelope — queryable-персист якоря', () => {
  it('roundtrip сохраняет gitHead/stashRef без секретов', () => {
    const raw = serializeEnvelope({ isGit: true, gitHead: 'a'.repeat(40), stashRef: 'b'.repeat(40), capturedAt: 1 })
    const back = parseEnvelope(raw)
    expect(back).toEqual({ gitHead: 'a'.repeat(40), stashRef: 'b'.repeat(40) })
    for (const bad of ['token', 'authorization', 'secret', 'password']) expect(raw.toLowerCase()).not.toContain(bad)
  })
  it('битый/пустой JSON → null', () => {
    expect(parseEnvelope('не json')).toBeNull()
    expect(parseEnvelope('')).toBeNull()
    expect(parseEnvelope(null)).toBeNull()
    expect(parseEnvelope('{"foo":1}')).toBeNull()
  })
})

describe('previewControlRestore / applyControlRestore — откат CLI-прогона по git-якорю', () => {
  let repo: string
  let headSha: string
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'gg-restore-'))
    gitInit(repo)
    writeFileSync(join(repo, 'a.txt'), 'hello\n')
    gitRun(repo, ['add', '-A'])
    gitRun(repo, ['commit', '-m', 'init'])
    headSha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: CLEAN_ENV }).trim()
  })
  afterEach(() => { try { rmSync(repo, { recursive: true, force: true }) } catch { /* win lock */ } })

  it('preview: показывает изменённые CLI файлы, откат недеструктивен (только чтение)', () => {
    // Симулируем правку CLI после якоря.
    writeFileSync(join(repo, 'a.txt'), 'hello\nCLI-НАПИСАЛ\n')
    writeFileSync(join(repo, 'new.txt'), 'создан CLI\n')
    const pre = previewControlRestore(repo, { gitHead: headSha, stashRef: null })
    expect(pre.ok).toBe(true)
    expect(pre.changedFiles).toContain('a.txt')
    expect(pre.untrackedFiles).toContain('new.txt')
    // Недеструктивно: файлы на месте после preview.
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toContain('CLI-НАПИСАЛ')
  })

  it('apply: откатывает отслеживаемый файл к состоянию якоря', () => {
    writeFileSync(join(repo, 'a.txt'), 'hello\nCLI-НАПИСАЛ\n')
    const res = applyControlRestore(repo, { gitHead: headSha, stashRef: null })
    expect(res.ok).toBe(true)
    expect(res.restoredFiles).toContain('a.txt')
    // Вернулось к якорю (CRLF-толерантно — git на Windows может нормализовать \n→\r\n).
    const restored = readFileSync(join(repo, 'a.txt'), 'utf8')
    expect(restored.replace(/\r/g, '')).toBe('hello\n')
    expect(restored).not.toContain('CLI-НАПИСАЛ')
  })

  it('apply со stash: возвращает грязные pre-run правки поверх якоря', () => {
    // Грязная pre-run правка → снапшот якоря.
    writeFileSync(join(repo, 'a.txt'), 'hello\nМОЁ-ДО-ПРОГОНА\n')
    const cp = captureControlCheckpoint(repo, 1)
    expect(cp.stashRef).toBeTruthy()
    // CLI переписал файл иначе.
    writeFileSync(join(repo, 'a.txt'), 'hello\nCLI-ЗАТЁР\n')
    const res = applyControlRestore(repo, { gitHead: cp.gitHead, stashRef: cp.stashRef })
    expect(res.ok).toBe(true)
    expect(res.stashApplied).toBe(true)
    // Вернулась именно МОЯ pre-run правка, не CLI-затирание.
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toContain('МОЁ-ДО-ПРОГОНА')
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).not.toContain('CLI-ЗАТЁР')
  })

  it('отказ moved-on: HEAD сдвинулся с момента якоря — не трогаем ушедшую историю', () => {
    // Пользователь закоммитил поверх — HEAD != gitHead якоря.
    writeFileSync(join(repo, 'a.txt'), 'hello\nновый коммит\n')
    gitRun(repo, ['commit', '-am', 'moved on'])
    const pre = previewControlRestore(repo, { gitHead: headSha, stashRef: null })
    expect(pre.ok).toBe(false)
    expect(pre.reason).toBe('moved-on')
    const res = applyControlRestore(repo, { gitHead: headSha, stashRef: null })
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('moved-on')
  })

  it('не-git и нет-якоря → честный отказ, не кидает', () => {
    const plain = mkdtempSync(join(tmpdir(), 'gg-restore-plain-'))
    try {
      expect(previewControlRestore(plain, { gitHead: 'x', stashRef: null }).reason).toBe('not-git')
      expect(previewControlRestore(repo, { gitHead: null, stashRef: null }).reason).toBe('no-anchor')
    } finally { rmSync(plain, { recursive: true, force: true }) }
  })

  it('РЕВЬЮ: откат из проекта-СУБДИРЕКТОРИИ откатывает весь репо (root+sub), не только cwd', () => {
    // Проект открыт как поддиректория монорепо. CLI правит файл ВНЕ неё.
    mkdirSync(join(repo, 'sub'))
    writeFileSync(join(repo, 'root.txt'), 'root-clean\n')
    writeFileSync(join(repo, 'sub', 's.txt'), 'sub-clean\n')
    gitRun(repo, ['add', '-A']); gitRun(repo, ['commit', '-m', 'base2'])
    const subHead = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: CLEAN_ENV }).trim()
    const subDir = join(repo, 'sub')
    writeFileSync(join(repo, 'root.txt'), 'root-CLI\n')       // правка ВНЕ субдира
    writeFileSync(join(repo, 'sub', 's.txt'), 'sub-CLI\n')    // правка в субдире
    const res = applyControlRestore(subDir, { gitHead: subHead, stashRef: null })
    expect(res.ok).toBe(true)
    // ОБА файла откачены — раньше root.txt молча оставался (checkout был cwd-scoped).
    expect(readFileSync(join(repo, 'root.txt'), 'utf8')).not.toContain('root-CLI')
    expect(readFileSync(join(repo, 'sub', 's.txt'), 'utf8')).not.toContain('sub-CLI')
  })

  it('stash закреплён ref → переживает git gc --prune=now (1.9.7 #2)', () => {
    writeFileSync(join(repo, 'a.txt'), 'hello\nГРЯЗНОЕ\n')
    const cp = captureControlCheckpoint(repo, 1)
    expect(cp.stashRef).toBeTruthy()
    // Без закрепления висячий stash-commit выгребается gc. Закрепляем ref'ом.
    expect(anchorStash(repo, 'run_gc_1', cp.stashRef!)).toBe(true)
    gitRun(repo, ['gc', '--prune=now'])
    // Пережил gc — объект достижим через ref.
    expect(isStashAlive(repo, cp.stashRef!)).toBe(true)
  })

  it('НЕзакреплённый stash выгребается gc → isStashAlive=false, откат не применяет мёртвый', () => {
    writeFileSync(join(repo, 'a.txt'), 'hello\nГРЯЗНОЕ2\n')
    const cp = captureControlCheckpoint(repo, 1)
    // НЕ закрепляем. Агрессивный gc выгребает висячий commit.
    gitRun(repo, ['gc', '--prune=now'])
    expect(isStashAlive(repo, cp.stashRef!)).toBe(false)
    // preview честно говорит hasStash=false (не обещает возврат из мёртвого объекта).
    writeFileSync(join(repo, 'a.txt'), 'hello\n') // вернём чистое чтобы preview ok
    gitRun(repo, ['checkout', '--', 'a.txt'])
    const pre = previewControlRestore(repo, { gitHead: headSha, stashRef: cp.stashRef })
    expect(pre.hasStash).toBe(false)
  })

  it('pruneEnvelopeStashes чистит ref старше TTL, свежий оставляет', () => {
    writeFileSync(join(repo, 'a.txt'), 'hello\nX\n')
    const cp = captureControlCheckpoint(repo, 1)
    anchorStash(repo, 'run_old', cp.stashRef!)
    // now через год вперёд → ref старше TTL 7 дней удаляется.
    const yearAhead = Date.now() + 365 * 24 * 3600 * 1000
    const pruned = pruneEnvelopeStashes(repo, 7 * 24 * 3600 * 1000, yearAhead)
    expect(pruned).toBeGreaterThanOrEqual(1)
    // Свежий (now=сейчас) НЕ трогается.
    anchorStash(repo, 'run_fresh', cp.stashRef!)
    expect(pruneEnvelopeStashes(repo, 7 * 24 * 3600 * 1000, Date.now())).toBe(0)
  })
})
