// P1 (волна 2.6.0): цена принятого результата — хранилище состязания.
//
// Три пина постановки проверяются здесь и в tests/ai/trial-workspace.test.ts:
//  (1) два исполнителя не видят работ друг друга — изоляция workspace;
//  (2) принятие результата А не затирает работу Б;
//  (3) таблица строится из ФАКТА прогона (деньги/ходы), не из слов модели.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { openDb } from '../../electron/storage/db'
import { createResultTrials } from '../../electron/storage/result-trials'
import { createAgentRuns } from '../../electron/storage/agent-runs'

describe('P1: состязание исполнителей — хранилище', () => {
  let dir: string
  let db: ReturnType<typeof openDb>
  let trials: ReturnType<typeof createResultTrials>
  let runs: ReturnType<typeof createAgentRuns>

  const twoAttempts = [
    { providerId: 'deepseek', model: 'deepseek-chat', workspace: '/w/a' },
    { providerId: 'openai', model: 'gpt-5', workspace: '/w/b' },
  ]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'verstak-trials-'))
    db = openDb(join(dir, 'test.db'))
    trials = createResultTrials(db)
    runs = createAgentRuns(db)
  })
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

  it('миграция создала обе таблицы', () => {
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('result_trials','result_trial_attempts')")
      .all() as Array<{ name: string }>).map(r => r.name).sort()
    expect(names).toEqual(['result_trial_attempts', 'result_trials'])
  })

  it('ПИН 1: общий workspace у двух исполнителей ОТВЕРГАЕТСЯ на создании', () => {
    // Молча свести двоих в один каталог — значит потерять работу одного из них,
    // и увидит это человек только постфактум. Отказ громкий и с причиной.
    expect(() => trials.create({
      projectPath: '/p', prompt: 'сделай X',
      attempts: [
        { providerId: 'deepseek', workspace: '/w/same' },
        { providerId: 'openai', workspace: '/w/same' },
      ],
    })).toThrow(/СВОЙ workspace/)
  })

  it('КОНТРОЛЬ: разные workspace принимаются, попытки заводятся', () => {
    const trial = trials.create({ projectPath: '/p', prompt: 'сделай X', attempts: twoAttempts })
    const list = trials.attempts(trial.id)

    expect(trial.status).toBe('running')
    expect(list.map(a => a.workspace)).toEqual(['/w/a', '/w/b'])
    expect(list.every(a => a.status === 'pending')).toBe(true)
  })

  it('пустая постановка и ноль исполнителей отвергаются', () => {
    expect(() => trials.create({ projectPath: '/p', prompt: '   ', attempts: twoAttempts })).toThrow(/постановка/)
    expect(() => trials.create({ projectPath: '/p', prompt: 'x', attempts: [] })).toThrow(/исполнител/)
  })

  it('ПИН 3: таблица берёт деньги и ходы ИЗ ПРОГОНА, а не из слов модели', () => {
    const trial = trials.create({ projectPath: '/p', prompt: 'сделай X', attempts: twoAttempts })
    const [a, b] = trials.attempts(trial.id)

    runs.create({ runId: 'run-a', projectPath: '/w/a', title: 'A', providerId: 'deepseek', model: 'deepseek-chat', agentMode: 'auto' })
    runs.finish('run-a', 'done', { costCents: 12, toolCount: 7, filesCount: 2 })
    trials.bindRun(a.id, { runId: 'run-a', chatId: 11, status: 'running' })
    trials.bindRun(b.id, { runId: 'run-b', chatId: 12, status: 'running' })

    const rows = trials.summary(trial.id)
    const rowA = rows.find(r => r.id === a.id)!
    const rowB = rows.find(r => r.id === b.id)!

    expect(rowA.costCents, 'деньги не подтянулись из agent_runs').toBe(12)
    expect(rowA.toolCount).toBe(7)
    expect(rowA.filesCount).toBe(2)
    expect(rowA.runStatus).toBe('done')
    // Попытка без прогона остаётся СТРОКОЙ с честными null, а не исчезает.
    expect(rowB.costCents, 'неизвестную цену подменили нулём — это оценка, а не факт').toBeNull()
    expect(rowB.runStatus).toBeNull()
    expect(rows.length).toBe(2)
  })

  it('ПИН 2: принятие А не затирает работу Б — она в архиве, со своим workspace и прогоном', () => {
    const trial = trials.create({ projectPath: '/p', prompt: 'сделай X', attempts: twoAttempts })
    const [a, b] = trials.attempts(trial.id)
    trials.bindRun(a.id, { runId: 'run-a', chatId: 11 })
    trials.bindRun(b.id, { runId: 'run-b', chatId: 12 })

    trials.accept(trial.id, a.id)

    const after = trials.attempts(trial.id)
    const keptB = after.find(x => x.id === b.id)!
    expect(after.find(x => x.id === a.id)!.status).toBe('accepted')
    expect(keptB.status, 'отклонённая попытка удалена — работа потеряна').toBe('archived')
    expect(keptB.workspace, 'у отклонённой попытки отобрали каталог — diff не посмотреть').toBe('/w/b')
    expect(keptB.runId, 'у отклонённой попытки отобрали прогон — истории нет').toBe('run-b')

    const t = trials.get(trial.id)!
    expect(t.status).toBe('accepted')
    expect(t.acceptedAttemptId).toBe(a.id)
  })

  it('принять чужую попытку нельзя (состязание не перепутать)', () => {
    const one = trials.create({ projectPath: '/p', prompt: 'X', attempts: twoAttempts })
    const other = trials.create({ projectPath: '/p', prompt: 'Y', attempts: [{ providerId: 'grok', workspace: '/w/c' }] })
    const foreign = trials.attempts(other.id)[0]

    expect(() => trials.accept(one.id, foreign.id)).toThrow(/не найдена/)
  })

  it('список состязаний проекта — новые сверху', () => {
    trials.create({ projectPath: '/p', prompt: 'первое', attempts: [{ providerId: 'a', workspace: '/w/1' }] })
    trials.create({ projectPath: '/p', prompt: 'второе', attempts: [{ providerId: 'a', workspace: '/w/2' }] })
    trials.create({ projectPath: '/other', prompt: 'чужое', attempts: [{ providerId: 'a', workspace: '/w/3' }] })

    const list = trials.list('/p')
    expect(list.map(t => t.prompt)).toEqual(['второе', 'первое'])
  })
})
