import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { appendCoreMemory, loadCoreMemory } from '../../electron/ai/core-memory'

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
})
