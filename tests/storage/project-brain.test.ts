import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { openDb } from '../../electron/storage/db'
import { createProjectBrainStore } from '../../electron/storage/project-brain'

describe('Project Brain storage (Итерация 2 — data layer)', () => {
  let dir: string
  let dbs: Array<ReturnType<typeof openDb>>
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gg-brain-'))
    dbs = []
  })
  afterEach(() => {
    for (const db of dbs) db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function store() {
    const db = openDb(join(dir, 't.db'))
    dbs.push(db)
    return createProjectBrainStore(db)
  }
  const P = 'C:/proj'

  it('createBrain → getBrain: пустой мозг с version=1', () => {
    const s = store()
    const b = s.createBrain(P)
    expect(b.projectPath).toBe(P)
    expect(b.version).toBe(1)
    expect(b.importantFiles).toEqual([])
    expect(s.getBrain(P)).toEqual(b)
  })

  it('createBrain идемпотентен (UNIQUE project_path)', () => {
    const s = store()
    const a = s.createBrain(P)
    const b = s.createBrain(P)
    expect(b.id).toBe(a.id)
  })

  it('updateBrain: overview + importantFiles (json) сохраняются', () => {
    const s = store()
    s.createBrain(P)
    const upd = s.updateBrain(P, { overview: 'Десктоп AI-агент', importantFiles: ['src/a.ts', 'README.md'] })
    expect(upd!.overview).toBe('Десктоп AI-агент')
    expect(upd!.importantFiles).toEqual(['src/a.ts', 'README.md'])
  })

  it('saveFileSummary upsert по (project, file) + get', () => {
    const s = store()
    s.saveFileSummary(P, { filePath: 'src/a.ts', fileHash: 'h1', summary: 'делает A', keyExports: ['foo'], keyDependencies: ['b'], risks: null, tokenEstimate: 120 })
    s.saveFileSummary(P, { filePath: 'src/a.ts', fileHash: 'h2', summary: 'делает A v2', keyExports: ['foo', 'bar'], keyDependencies: [], risks: 'none', tokenEstimate: 130 })
    const list = s.getFileSummaries(P)
    expect(list).toHaveLength(1)            // upsert, не дубль
    expect(list[0].summary).toBe('делает A v2')
    expect(list[0].keyExports).toEqual(['foo', 'bar'])
  })

  it('saveContextPack upsert по (project, type) + getContextPack', () => {
    const s = store()
    s.saveContextPack(P, { type: 'short', content: 'short ctx', tokenEstimate: 1500, sourceFiles: ['a.ts'] })
    s.saveContextPack(P, { type: 'medium', content: 'medium ctx', tokenEstimate: 6000, sourceFiles: ['a.ts', 'b.ts'] })
    s.saveContextPack(P, { type: 'short', content: 'short v2', tokenEstimate: 1600, sourceFiles: [] })
    expect(s.getContextPacks(P)).toHaveLength(2)
    expect(s.getContextPack(P, 'short')!.content).toBe('short v2')
    expect(s.getContextPack(P, 'long')).toBeNull()
  })

  it('saveDecisionRecord → getDecisionRecords (json-поля, newest first)', () => {
    const s = store()
    const rec = s.saveDecisionRecord(P, {
      sourceMessageId: 'm1', title: 'Берём Gateway', userRequest: 'как монетизировать?',
      finalDecision: 'Verstak Gateway в рублях', why: 'РФ-рынок без карт',
      keyArguments: ['рубли', 'без VPN'], objections: ['конкуренты дешевле'], risks: ['зависимость от upstream'],
      alternativesRejected: ['чистый BYOK'], nextActions: ['собрать провайдер'], confidence: 'high', revisitDate: null,
    })
    expect(rec.id).toBeGreaterThan(0)
    expect(rec.keyArguments).toEqual(['рубли', 'без VPN'])
    expect(rec.confidence).toBe('high')
    const all = s.getDecisionRecords(P)
    expect(all).toHaveLength(1)
    expect(all[0].title).toBe('Берём Gateway')
  })
})
