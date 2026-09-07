// Происхождение прогона: какие возможности в нём участвовали.
//
// Без этой связи доверие считать не из чего — `agent_runs` не знал ни скилла, ни
// роли, а `skill_usage` считает использования без исходов. Пины стерегут связь и
// сборщик доказательств, который по ней работает.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { Database } from 'better-sqlite3'
import { openDb } from '../../electron/storage/db'
import { createRunCapabilities } from '../../electron/storage/run-capabilities'
import { collectEvidence } from '../../electron/capabilities/evidence'
import { createAgentRuns } from '../../electron/storage/agent-runs'
import { createVerifications } from '../../electron/storage/verifications'
import { capabilityId } from '../../shared/contracts/capability'

const SKILL = capabilityId('skill', 'github')
const V1 = 'версия-1'
const V2 = 'версия-2'

describe('связь прогона с возможностями', () => {
  let dir: string
  let db: Database
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'verstak-prov-'))
    db = openDb(join(dir, 'test.db'))
  })
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

  it('прогон без возможностей не ломает запись', () => {
    const store = createRunCapabilities(db)
    expect(() => store.link('run-1', [])).not.toThrow()
    expect(store.runsFor(SKILL)).toEqual([])
  })

  it('связь читается в обе стороны', () => {
    const store = createRunCapabilities(db)
    store.link('run-1', [{ id: SKILL, version: V1 }, { id: capabilityId('agent', 'planner'), version: 'p1' }])
    expect(store.runsFor(SKILL)).toEqual(['run-1'])
    expect(store.capabilitiesOf('run-1').sort()).toEqual(['agent:planner', 'skill:github'])
  })

  // Один прогон может писаться дважды (повтор, возобновление). Дубль связи не
  // должен удваивать доказательства — иначе доверие накручивается перезапуском.
  it('повторная привязка того же прогона не удваивает его', () => {
    const store = createRunCapabilities(db)
    store.link('run-1', [{ id: SKILL, version: V1 }])
    store.link('run-1', [{ id: SKILL, version: V1 }])
    expect(store.runsFor(SKILL)).toEqual(['run-1'])
  })
})

describe('сборщик доказательств', () => {
  let dir: string
  let db: Database
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'verstak-ev-'))
    db = openDb(join(dir, 'test.db'))
  })
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

  /** Прогон со статусом и, если задано, с итогом проверки. */
  const run = (id: string, status: 'done' | 'failed', verification?: 'passed' | 'failed' | 'not_run') => {
    const runs = createAgentRuns(db)
    runs.create({ runId: id, projectPath: '/p', chatId: 1, owner: 'main', title: `прогон ${id}`, providerId: 'gemini-api', model: 'gemini-2.5-flash' })
    runs.finish(id, status)
    createRunCapabilities(db).link(id, [{ id: SKILL, version: V1 }])
    if (verification) {
      createVerifications(db).insert({
        projectPath: '/p', chatId: 1, runId: id,
        overall: verification, checksTotal: 3, checksPassed: verification === 'passed' ? 3 : 1,
        changedFilesCount: 1, artifactPath: `/p/${id}.json`, htmlPath: null, taskSummary: null,
        createdAt: Date.now(),
      })
    }
  }

  it('у возможности без прогонов доказательств нет', () => {
    const e = collectEvidence(db, SKILL, V1)
    expect(e.completedTasks).toBe(0)
    expect(e.verificationsTotal).toBe(0)
    expect(e.successfulRuns).toBe(0)
  })

  it('успешные и завершённые считаются раздельно', () => {
    run('r1', 'done')
    run('r2', 'done')
    run('r3', 'failed')
    const e = collectEvidence(db, SKILL, V1)
    expect(e.successfulRuns).toBe(2)
    expect(e.completedTasks).toBe(3)
  })

  it('проверки берутся по прогонам возможности', () => {
    run('r1', 'done', 'passed')
    run('r2', 'done', 'passed')
    run('r3', 'done', 'failed')
    const e = collectEvidence(db, SKILL, V1)
    expect(e.verificationsPassed).toBe(2)
    expect(e.verificationsTotal).toBe(3)
  })

  // «Не запускалась» — это НЕ провал. Считать её провалом значило бы наказывать
  // возможность за то, что проверок вообще не было.
  it('непроведённая проверка не считается ни пройденной, ни проваленной', () => {
    run('r1', 'done', 'not_run')
    const e = collectEvidence(db, SKILL, V1)
    expect(e.verificationsTotal).toBe(0)
    expect(e.verificationsPassed).toBe(0)
  })

  // Контроль: без него пин выше зелен и у сборщика, который не считает проверок
  // вовсе.
  it('контроль: обычная проверка считается', () => {
    run('r1', 'done', 'passed')
    expect(collectEvidence(db, SKILL, V1).verificationsTotal).toBe(1)
  })

  it('чужие прогоны в доказательства не попадают', () => {
    run('r1', 'done', 'passed')
    const runs = createAgentRuns(db)
    runs.create({ runId: 'other', projectPath: '/p', chatId: 1, owner: 'main', title: 'чужой', providerId: 'gemini-api', model: 'm' })
    runs.finish('other', 'done')
    createRunCapabilities(db).link('other', [{ id: capabilityId('skill', 'другой'), version: V1 }])
    expect(collectEvidence(db, SKILL, V1).completedTasks).toBe(1)
  })

  // Слагаемые, у которых В ПРОДУКТЕ НЕТ ИСТОЧНИКА, обязаны быть нулями и не
  // подменяться пересказом чего-то другого: журнал пишет tool_call, error и
  // smart_approve, но не нарушения политики и безопасности. Ноль здесь честен,
  // а «переиспользованный» error врал бы про безопасность.
  it('нарушения остаются нулями, пока их никто не записывает', () => {
    run('r1', 'failed')
    const e = collectEvidence(db, SKILL, V1)
    expect(e.safetyViolations).toBe(0)
    expect(e.policyViolations).toBe(0)
    expect(e.unexpectedToolBehavior).toBe(0)
  })

  // ГЛАВНЫЙ ПИН шага: доказательства принадлежат ПРОВЕРЕННОМУ СОДЕРЖИМОМУ.
  // Без него правка файла скилла унаследовала бы всю прежнюю репутацию, и
  // правило «обновление не повышает доверие» обходилось бы редактором.
  it('после подмены версии прежние прогоны в доказательства НЕ идут', () => {
    run('r1', 'done', 'passed')
    run('r2', 'done', 'passed')
    expect(collectEvidence(db, SKILL, V1).verificationsPassed).toBe(2)
    expect(collectEvidence(db, SKILL, V2).verificationsPassed).toBe(0)
    expect(collectEvidence(db, SKILL, V2).completedTasks).toBe(0)
  })

  // Контроль: новая версия начинает копить своё — иначе пин выше зелен и у
  // сборщика, который после смены версии не считает вообще ничего и никогда.
  it('контроль: новая версия набирает доказательства заново', () => {
    run('r1', 'done', 'passed')
    const runs = createAgentRuns(db)
    runs.create({ runId: 'r-new', projectPath: '/p', chatId: 1, owner: 'main', title: 'после правки', providerId: 'gemini-api', model: 'm' })
    runs.finish('r-new', 'done')
    createRunCapabilities(db).link('r-new', [{ id: SKILL, version: V2 }])
    expect(collectEvidence(db, SKILL, V2).completedTasks).toBe(1)
    expect(collectEvidence(db, SKILL, V1).completedTasks).toBe(1)
  })
})
