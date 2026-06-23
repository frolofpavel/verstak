import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { Database } from 'better-sqlite3'
import { openDb } from '../../electron/storage/db'
import { createUndoStack } from '../../electron/storage/undo'

// review fix #4: prune (MAX_PER_PROJECT=50) тихо удалял пост-чекпоинт записи →
// revertToCheckpoint молча откатывал лишь последние 50 (частичный откат без сигнала).
// Фикс: protectFrom(checkpointId) защищает записи новее чекпоинта от prune.
describe('UndoStack — prune защищает пост-чекпоинт записи (review #4)', () => {
  let dir: string
  let db: Database | undefined
  const PP = 'C:/proj'
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gg-undo-')) })
  afterEach(() => { db?.close(); db = undefined; rmSync(dir, { recursive: true, force: true }) })

  it('без чекпоинта prune держит 50 (baseline)', () => {
    db = openDb(join(dir, 't.db'))
    const u = createUndoStack(db)
    for (let i = 0; i < 60; i++) u.push(PP, `f${i}.ts`, '', `v${i}`)
    expect(u.count(PP)).toBe(50)
  })

  it('protectFrom: все записи новее чекпоинта выживают (откат к чекпоинту полный)', () => {
    db = openDb(join(dir, 't.db'))
    const u = createUndoStack(db)
    for (let i = 0; i < 5; i++) u.push(PP, `pre${i}.ts`, '', 'x')
    const checkpointId = u.list(PP)[0].id
    u.protectFrom(PP, checkpointId)
    // 60 пост-чекпоинт правок — без защиты ранние (id > checkpoint, но вне top-50) пруньнулись бы
    for (let i = 0; i < 60; i++) u.push(PP, `post${i}.ts`, '', `v${i}`)
    const postCheckpoint = u.list(PP).filter(e => e.id > checkpointId)
    expect(postCheckpoint.length).toBe(60)
    expect(postCheckpoint.some(e => e.filePath === 'post0.ts')).toBe(true) // самая ранняя на месте
  })

  it('clearProtection: после снятия защиты prune снова режет до 50', () => {
    db = openDb(join(dir, 't.db'))
    const u = createUndoStack(db)
    u.push(PP, 'a.ts', '', 'x')
    u.protectFrom(PP, 0) // floor=0 → защитить всё
    for (let i = 0; i < 60; i++) u.push(PP, `f${i}.ts`, '', 'x')
    expect(u.count(PP)).toBeGreaterThan(50)
    u.clearProtection(PP)
    u.push(PP, 'trigger.ts', '', 'x')
    expect(u.count(PP)).toBe(50)
  })

  // F3 (ревью 23.06): два чата в одном проекте держат разные чекпоинты. Раньше
  // floor был один на проект → второй (cpB) перетирал первый (cpA), и записи
  // между ними пруньялись → откат чата A был неполным. Теперь floor = MIN.
  it('мульти-чекпоинт: floor\'ы не перетираются, защищён регион старейшего чекпоинта', () => {
    db = openDb(join(dir, 't.db'))
    const u = createUndoStack(db)
    for (let i = 0; i < 3; i++) u.push(PP, `pre${i}.ts`, '', 'x')
    const cpA = u.list(PP)[0].id          // чат A чекпоинтит
    u.protectFrom(PP, cpA)
    for (let i = 0; i < 3; i++) u.push(PP, `mid${i}.ts`, '', 'x')
    const cpB = u.list(PP)[0].id          // чат B чекпоинтит позже (cpB > cpA)
    u.protectFrom(PP, cpB)
    for (let i = 0; i < 60; i++) u.push(PP, `post${i}.ts`, '', `v${i}`)
    const survivors = u.list(PP)
    // Регион чата A (id > cpA) полон — включая mid* МЕЖДУ чекпоинтами (раньше пруньялись).
    expect(survivors.some(e => e.filePath === 'mid0.ts')).toBe(true)
    expect(survivors.filter(e => e.id > cpA).length).toBe(63) // 3 mid + 60 post

    // Чат B откатывает свой чекпоинт → защита cpB снята, cpA ещё держит регион A.
    u.clearProtection(PP, cpB)
    u.push(PP, 'trigger.ts', '', 'x')
    expect(u.list(PP).some(e => e.filePath === 'mid0.ts')).toBe(true) // A всё ещё защищён
  })

  // finding 1 (ревью Verstak 23.06): FloorTracker был in-memory → после краха floor
  // терялся, prune съедал пост-чекпоинт записи (неполный откат). Теперь персист в БД.
  it('floor переживает «рестарт» (новый createUndoStack на той же БД) — durability', () => {
    db = openDb(join(dir, 't.db'))
    let u = createUndoStack(db)
    for (let i = 0; i < 3; i++) u.push(PP, `pre${i}.ts`, '', 'x')
    const cp = u.list(PP)[0].id
    u.protectFrom(PP, cp)
    // Имитация краша: НОВЫЙ стек на той же БД — in-memory floors пусты, но в БД есть.
    u = createUndoStack(db)
    for (let i = 0; i < 60; i++) u.push(PP, `post${i}.ts`, '', `v${i}`)
    const survivors = u.list(PP)
    // Без durable floor самые ранние пост-чекпоинт (вне top-50) пруньнулись бы.
    expect(survivors.some(e => e.filePath === 'post0.ts')).toBe(true)
    expect(survivors.filter(e => e.id > cp).length).toBe(60)
  })

  it('clearProtection(floorId) снимает floor durably — не воскресает после рестарта', () => {
    db = openDb(join(dir, 't.db'))
    let u = createUndoStack(db)
    u.push(PP, 'a.ts', '', 'x')
    u.protectFrom(PP, 0)
    u.clearProtection(PP, 0)
    u = createUndoStack(db)  // рестарт — floor не должен воскреснуть из БД
    for (let i = 0; i < 60; i++) u.push(PP, `f${i}.ts`, '', 'x')
    expect(u.count(PP)).toBe(50) // floor снят durably → prune снова режет до 50
  })

  it('дубликат floor (два чата id=0): clearProtection убирает ОДИН row, второй durably держит', () => {
    db = openDb(join(dir, 't.db'))
    let u = createUndoStack(db)
    u.push(PP, 'a.ts', '', 'x')
    u.protectFrom(PP, 0)
    u.protectFrom(PP, 0)        // второй чат чекпоинтит на том же id
    u.clearProtection(PP, 0)    // один откатился
    u = createUndoStack(db)     // рестарт
    for (let i = 0; i < 60; i++) u.push(PP, `f${i}.ts`, '', 'x')
    expect(u.count(PP)).toBeGreaterThan(50) // второй floor=0 ещё держит (защита всего)
  })
})
