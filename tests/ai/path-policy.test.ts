import { describe, it, expect } from 'vitest'
import { safeJoin } from '../../electron/ai/path-policy'

const WIN = process.platform === 'win32'
const ROOT = WIN ? 'C:\\Users\\Pavel\\proj' : '/home/pavel/proj'

describe('path-policy safeJoin', () => {
  it('пропускает путь внутри проекта', () => {
    expect(safeJoin(ROOT, 'src/foo.ts')).toBeTruthy()
    expect(() => safeJoin(ROOT, 'a/b/c.ts')).not.toThrow()
  })

  it('блокирует .. traversal', () => {
    expect(() => safeJoin(ROOT, '../secret')).toThrow()
    expect(() => safeJoin(ROOT, 'a/../../secret')).toThrow()
  })

  // Регрессия Windows Drive Bypass: relative() между разными дисками
  // возвращает АБСОЛЮТНЫЙ путь (D:\Secret), не начинающийся с '..' —
  // раньше проходил проверку и давал агенту доступ к любому диску.
  it.runIf(WIN)('блокирует выход на другой диск (Windows drive bypass)', () => {
    expect(() => safeJoin('C:\\Users\\Pavel\\proj', 'D:\\Secret')).toThrow()
    expect(() => safeJoin('C:\\Users\\Pavel\\proj', 'D:\\Windows\\System32\\config')).toThrow()
    expect(() => safeJoin('C:\\Users\\Pavel\\proj', 'E:\\')).toThrow()
  })

  it('блокирует абсолютный путь наружу', () => {
    const outside = WIN ? 'C:\\Windows\\System32' : '/etc/passwd'
    expect(() => safeJoin(ROOT, outside)).toThrow()
  })
})
