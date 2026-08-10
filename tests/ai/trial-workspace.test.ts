// P1: изоляция исполнителей — «два исполнителя не видят работ друг друга».
//
// Это самый дорогой из пинов позиции: цена ошибки здесь измеряется не красным
// тестом, а потерянной работой человека. Проверяется на НАСТОЯЩЕМ git-репозитории,
// а не на моке: изоляцию даёт именно git worktree, и мок стерёг бы собственную
// выдумку.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createTrialWorkspaces, trialWorkspaceDiff, isGitRepo } from '../../electron/ai/trial-workspace'

describe('P1: изолированный workspace на исполнителя', () => {
  let repo: string
  let created: ReturnType<typeof createTrialWorkspaces> = []

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'verstak-trial-repo-'))
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' })
    execFileSync('git', ['init', repo], { stdio: 'pipe' })
    git('config', 'user.email', 'test@verstak')
    git('config', 'user.name', 'verstak-test')
    writeFileSync(join(repo, 'app.txt'), 'исходный текст\n')
    git('add', 'app.txt')
    git('commit', '-m', 'base')
  })
  afterEach(() => {
    for (const w of created) { try { w.dispose() } catch { /* уборка */ } }
    created = []
    rmSync(repo, { recursive: true, force: true })
  })

  it('ГЛАВНЫЙ ПИН: правка одного исполнителя НЕ видна второму и не трогает проект', () => {
    created = createTrialWorkspaces(repo, 2, 'iso')
    const [a, b] = created

    expect(a.path, 'исполнители получили один каталог').not.toBe(b.path)
    writeFileSync(join(a.path, 'app.txt'), 'работа исполнителя А\n')

    expect(readFileSync(join(b.path, 'app.txt'), 'utf8').trim(),
      'второй исполнитель видит чужую правку — работы затрут друг друга').toBe('исходный текст')
    expect(readFileSync(join(repo, 'app.txt'), 'utf8').trim(),
      'состязание залезло в рабочее дерево человека').toBe('исходный текст')
  })

  it('дифф показывает работу попытки — и принятой, и отклонённой', () => {
    created = createTrialWorkspaces(repo, 2, 'diff')
    const [a, b] = created
    writeFileSync(join(a.path, 'app.txt'), 'вариант А\n')
    writeFileSync(join(b.path, 'app.txt'), 'вариант Б\n')

    expect(trialWorkspaceDiff(a.path)).toContain('вариант А')
    // Отклонённую работу тоже можно посмотреть — она не пропадает.
    expect(trialWorkspaceDiff(b.path)).toContain('вариант Б')
  })

  it('проект без git → ОТКАЗ с причиной, а не тихое сведение в один каталог', () => {
    const plain = mkdtempSync(join(tmpdir(), 'verstak-nogit-'))
    try {
      expect(isGitRepo(plain)).toBe(false)
      expect(() => createTrialWorkspaces(plain, 2)).toThrow(/git-репозитори/)
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })

  it('dispose убирает каталог и не оставляет worktree в проекте', () => {
    const ws = createTrialWorkspaces(repo, 1, 'cleanup')
    const path = ws[0].path
    expect(existsSync(path)).toBe(true)

    ws[0].dispose()

    expect(existsSync(path)).toBe(false)
    const list = execFileSync('git', ['-C', repo, 'worktree', 'list'], { encoding: 'utf8' })
    expect(list.trim().split('\n').length, 'worktree остался висеть в проекте').toBe(1)
  })
})
