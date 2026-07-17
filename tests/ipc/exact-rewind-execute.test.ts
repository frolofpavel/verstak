import { describe, it, expect } from 'vitest'
import { executeRewind, unrevert, type RewindPlanItem } from '../../electron/ipc/exact-rewind'

/**
 * Срез 2.0.11-F: Exact Rewind — сам откат в транзакции с бэкапами + unrevert.
 *
 * Инвариант отката: перед КАЖДОЙ записью снимается бэкап ТЕКУЩЕГО состояния файла — чтобы
 * unrevert мог вернуть всё как было ДО отката (в т.ч. если откат сделал хуже). Бэкапы
 * снимаются ДО первой записи: частичный сбой не оставит файлы в состоянии, которое нечем
 * вернуть.
 */

// Виртуальная ФС для теста: карта путь → содержимое (null = файла нет).
function fakeFs(initial: Record<string, string | null>) {
  const files = new Map<string, string | null>(Object.entries(initial))
  return {
    files,
    deps: {
      readCurrent: async (p: string) => files.get(p) ?? null,
      writeFile: async (p: string, content: string) => { files.set(p, content) },
      deleteFile: async (p: string) => { files.set(p, null) },
    },
  }
}

const item = (over: Partial<RewindPlanItem>): RewindPlanItem =>
  ({ filePath: 'a.ts', action: 'restore', beforeContent: 'старое', ...over })

describe('executeRewind — откат с бэкапами', () => {
  it('restore возвращает прежнее содержимое', async () => {
    const fs = fakeFs({ 'a.ts': 'новое' })
    const r = await executeRewind([item({ filePath: 'a.ts', action: 'restore', beforeContent: 'старое' })], fs.deps)
    expect(fs.files.get('a.ts')).toBe('старое')
    expect(r.restored).toEqual(['a.ts'])
  })

  it('delete убирает файл, созданный правкой', async () => {
    const fs = fakeFs({ 'new.ts': 'создано' })
    await executeRewind([item({ filePath: 'new.ts', action: 'delete', beforeContent: null })], fs.deps)
    expect(fs.files.get('new.ts')).toBeNull()
  })

  // Бэкап снят ДО записи — иначе unrevert нечем было бы вернуть текущее состояние.
  it('возвращает бэкап ТЕКУЩЕГО состояния (для unrevert)', async () => {
    const fs = fakeFs({ 'a.ts': 'текущее-до-отката' })
    const r = await executeRewind([item({ filePath: 'a.ts', action: 'restore', beforeContent: 'старое' })], fs.deps)
    expect(r.backups['a.ts']).toBe('текущее-до-отката')
  })

  it('бэкап файла, которого не было → null (unrevert его удалит)', async () => {
    const fs = fakeFs({ 'new.ts': 'создано' })
    const r = await executeRewind([item({ filePath: 'new.ts', action: 'delete', beforeContent: null })], fs.deps)
    expect(r.backups['new.ts']).toBe('создано') // текущее содержимое = бэкап
  })

  it('несколько файлов — все откачены, бэкапы у всех', async () => {
    const fs = fakeFs({ 'a.ts': 'a-new', 'b.ts': 'b-new' })
    const r = await executeRewind([
      item({ filePath: 'a.ts', action: 'restore', beforeContent: 'a-old' }),
      item({ filePath: 'b.ts', action: 'restore', beforeContent: 'b-old' }),
    ], fs.deps)
    expect(fs.files.get('a.ts')).toBe('a-old')
    expect(fs.files.get('b.ts')).toBe('b-old')
    expect(Object.keys(r.backups)).toEqual(['a.ts', 'b.ts'])
  })
})

describe('unrevert — вернуть как было ДО отката', () => {
  it('восстанавливает из бэкапов (откат отменён)', async () => {
    const fs = fakeFs({ 'a.ts': 'после-отката' })
    await unrevert({ 'a.ts': 'до-отката' }, fs.deps)
    expect(fs.files.get('a.ts')).toBe('до-отката')
  })

  it('бэкап null → файл удаляется (его не было до отката)', async () => {
    const fs = fakeFs({ 'new.ts': 'восстановлено-откатом' })
    await unrevert({ 'new.ts': null }, fs.deps)
    expect(fs.files.get('new.ts')).toBeNull()
  })

  // Полный цикл: откат → unrevert возвращает точно исходное состояние.
  it('откат + unrevert = исходное состояние (round-trip)', async () => {
    const fs = fakeFs({ 'a.ts': 'исходное' })
    const r = await executeRewind([item({ filePath: 'a.ts', action: 'restore', beforeContent: 'старое' })], fs.deps)
    expect(fs.files.get('a.ts')).toBe('старое') // откат применён
    await unrevert(r.backups, fs.deps)
    expect(fs.files.get('a.ts')).toBe('исходное') // вернулись точно к тому, что было
  })
})
