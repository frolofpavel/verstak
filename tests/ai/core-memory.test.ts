import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { appendCoreMemory, loadCoreMemory, saveCoreMemoryBlock, replaceCoreMemory } from '../../electron/ai/core-memory'

describe('core-memory — appendCoreMemory overflow (эвакуация, не потеря)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gg-core-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('без переполнения — просто добавляет, overflow=false, без эвакуации', () => {
    const evac: string[] = []
    const r = appendCoreMemory(dir, 'user', 'предпочитает кратко', (e) => evac.push(e))
    expect(r.overflow).toBe(false)
    expect(r.content).toContain('кратко')
    expect(evac).toHaveLength(0)
  })

  it('переполнение USER (>1500): старейшее эвакуируется, НОВЫЙ факт сохраняется', () => {
    // Забиваем блок под лимит уникальными строками
    for (let i = 0; i < 60; i++) appendCoreMemory(dir, 'user', `СТАРЫЙ_ФАКТ_${i} ${'x'.repeat(20)}`)
    const evac: string[] = []
    // Крупный append (каждый предыдущий сам трейзил под лимит → нужен большой, чтобы
    // гарантированно перелить через max и вызвать эвакуацию головы).
    const r = appendCoreMemory(dir, 'user', 'НОВЕЙШИЙ_ВАЖНЫЙ_ФАКТ ' + 'z'.repeat(300), (e) => evac.push(e))
    expect(r.overflow).toBe(true)
    // КЛЮЧЕВОЕ: только что добавленный факт НЕ потерян (раньше slice его ронял)
    expect(r.content).toContain('НОВЕЙШИЙ_ВАЖНЫЙ_ФАКТ')
    const saved = loadCoreMemory(dir).user
    expect(saved).toContain('НОВЕЙШИЙ_ВАЖНЫЙ_ФАКТ')
    // при финальном переполнении голова (старейшее из оставшегося) вытеснена в архив
    expect(evac.length).toBeGreaterThan(0)
    expect(evac.join('\n')).toContain('СТАРЫЙ_ФАКТ_')
    // блок не превышает лимит
    expect(saved.length).toBeLessThanOrEqual(1500)
  })

  it('эвакуированное — это ГОЛОВА (старейшее), хвост (новое) остаётся', () => {
    for (let i = 0; i < 80; i++) appendCoreMemory(dir, 'memory', `entry_${i} ${'y'.repeat(25)}`)
    const evac: string[] = []
    appendCoreMemory(dir, 'memory', 'ПОСЛЕДНЯЯ_ЗАПИСЬ ' + 'w'.repeat(300), (e) => evac.push(e))
    const saved = loadCoreMemory(dir).memory
    expect(saved).toContain('ПОСЛЕДНЯЯ_ЗАПИСЬ')          // новое на месте
    expect(evac.join('\n')).toContain('entry_')          // старейшее ушло в архив
    // новейшее НЕ должно оказаться в эвакуированном
    expect(evac.join('\n')).not.toContain('ПОСЛЕДНЯЯ_ЗАПИСЬ')
  })

  // Ревью HIGH: архив-первым — падение onEvacuate НЕ должно рушить core-файл.
  it('падение onEvacuate → core-файл НЕ обрезан, ошибка всплывает (нет потери)', () => {
    for (let i = 0; i < 80; i++) appendCoreMemory(dir, 'memory', `factline_${i} ${'q'.repeat(25)}`)
    const before = loadCoreMemory(dir).memory
    // onEvacuate имитирует SQLITE_BUSY
    expect(() => appendCoreMemory(dir, 'memory', 'NEW ' + 'r'.repeat(400), () => {
      throw new Error('SQLITE_BUSY')
    })).toThrow('SQLITE_BUSY')
    // core-файл остался ЦЕЛ — голова не потеряна (обрезка не случилась)
    const after = loadCoreMemory(dir).memory
    expect(after).toBe(before)
  })

  // Ревью MEDIUM: единственная строка длиннее max — хвост эвакуируется, не режется молча.
  it('единственная сверхдлинная строка → хвост уходит в архив, не теряется', () => {
    const evac: string[] = []
    const big = 'ОГРОМНЫЙ_ФАКТ ' + 'k'.repeat(2500)  // > MAX_MEMORY (2000)
    const r = appendCoreMemory(dir, 'memory', big, (e) => evac.push(e))
    expect(r.overflow).toBe(true)
    expect(r.content.length).toBeLessThanOrEqual(2000)
    // отрезанный хвост НЕ потерян — ушёл в архив
    expect(evac.length).toBeGreaterThan(0)
    expect(evac.join('').length).toBeGreaterThan(400)
  })
})

// 2.0.0 security (аудит HIGH): core-memory инжектится в system prompt КАЖДЫЙ turn.
// Секрет, записанный агентом в MEMORY.md/USER.md, утекал бы во все будущие сессии
// проекта и всем провайдерам. Единая точка записи saveCoreMemoryBlock обязана редактировать.
describe('core-memory — редакция секретов при записи (2.0.0 HIGH)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gg-core-sec-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('saveCoreMemoryBlock редактирует секрет в content', () => {
    saveCoreMemoryBlock(dir, 'memory', 'деплой: export API_KEY=sk-proj-abcdefghij1234567890 в окружении')
    const saved = loadCoreMemory(dir).memory
    expect(saved).not.toContain('sk-proj-abcdefghij1234567890')
    expect(saved).toContain('деплой')  // осмысленный текст сохранён
  })

  it('append/replace-путь тоже редактирует (идут через saveCoreMemoryBlock)', () => {
    appendCoreMemory(dir, 'user', 'токен пользователя Authorization: Bearer sk-ant-abcdefghij0123456789klmno')
    expect(loadCoreMemory(dir).user).not.toContain('sk-ant-abcdefghij0123456789klmno')
    saveCoreMemoryBlock(dir, 'memory', 'старое')
    replaceCoreMemory(dir, 'memory', 'старое', 'новое api_key=ABCDEFGHIJ0123456789KLMN')
    expect(loadCoreMemory(dir).memory).not.toContain('ABCDEFGHIJ0123456789KLMN')
  })
})
