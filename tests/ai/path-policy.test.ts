import { describe, it, expect } from 'vitest'
import { join } from 'path'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { safeJoin, isWithinKnownRoots, resolveReadOnlyPath, resolveWritablePath } from '../../electron/ai/path-policy'

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

describe('path-policy isWithinKnownRoots', () => {
  it('true для пути внутри известного корня', () => {
    expect(isWithinKnownRoots(join(ROOT, 'src', 'foo.ts'), [ROOT])).toBe(true)
  })

  it('true для самого корня', () => {
    expect(isWithinKnownRoots(ROOT, [ROOT])).toBe(true)
  })

  it('false для пути вне всех корней', () => {
    const outside = WIN ? 'C:\\Windows\\System32' : '/etc'
    expect(isWithinKnownRoots(outside, [ROOT])).toBe(false)
  })

  it('false когда корней нет', () => {
    expect(isWithinKnownRoots(ROOT, [])).toBe(false)
  })

  it('false для .. traversal из корня', () => {
    expect(isWithinKnownRoots(join(ROOT, '..', 'secret'), [ROOT])).toBe(false)
  })

  it.runIf(WIN)('false для другого диска (drive bypass)', () => {
    expect(isWithinKnownRoots('D:\\Secret', ['C:\\Users\\Pavel\\proj'])).toBe(false)
  })

  it('игнорирует пустые корни в списке', () => {
    expect(isWithinKnownRoots(join(ROOT, 'a.ts'), ['', ROOT])).toBe(true)
  })

  // Ревью F5: realpath-aware. Symlink ВНУТРИ корня, ведущий НАРУЖУ, должен
  // отвергаться (раньше textual resolve() пропускал его как «внутри»). Нужны
  // реальные пути (realpath работает только на существующих). На Windows
  // создание symlink требует привилегий — мягкий пропуск при EPERM.
  it('false для symlink внутри корня, ведущего наружу (realpath)', () => {
    const realRoot = mkdtempSync(join(tmpdir(), 'gg-root-'))
    const outside = mkdtempSync(join(tmpdir(), 'gg-outside-'))
    writeFileSync(join(outside, 'secret.txt'), 'TOP SECRET')
    const link = join(realRoot, 'escape')
    let linked = false
    try { symlinkSync(outside, link, 'dir'); linked = true } catch { /* нет привилегий */ }
    if (!linked) return
    // Путь через symlink указывает на файл вне корня → должен быть отвергнут.
    expect(isWithinKnownRoots(join(link, 'secret.txt'), [realRoot])).toBe(false)
    // Контроль: реальный файл внутри корня — внутри.
    mkdirSync(join(realRoot, 'sub'))
    writeFileSync(join(realRoot, 'sub', 'ok.txt'), 'ok')
    expect(isWithinKnownRoots(join(realRoot, 'sub', 'ok.txt'), [realRoot])).toBe(true)
  })
})

describe('path-policy resolveReadOnlyPath', () => {
  it('keeps relative paths inside the project root', async () => {
    const realRoot = mkdtempSync(join(tmpdir(), 'gg-root-'))
    writeFileSync(join(realRoot, 'ok.txt'), 'ok')
    const resolved = await resolveReadOnlyPath(realRoot, 'ok.txt')
    expect(resolved).toBe(join(realRoot, 'ok.txt'))
  })

  it('allows explicit absolute paths for read-only external context', async () => {
    const realRoot = mkdtempSync(join(tmpdir(), 'gg-root-'))
    const outside = mkdtempSync(join(tmpdir(), 'gg-outside-'))
    const file = join(outside, 'note.md')
    writeFileSync(file, 'outside')
    const resolved = await resolveReadOnlyPath(realRoot, file)
    expect(resolved).toBe(file)
  })
})

describe('path-policy resolveWritablePath', () => {
  it('keeps relative writes inside the project root', async () => {
    const realRoot = mkdtempSync(join(tmpdir(), 'gg-root-'))
    const resolved = await resolveWritablePath(realRoot, 'out/report.md')
    expect(resolved).toBe(join(realRoot, 'out', 'report.md'))
  })

  it('allows explicit absolute writes inside Downloads', async () => {
    const realRoot = mkdtempSync(join(tmpdir(), 'gg-root-'))
    const downloads = mkdtempSync(join(tmpdir(), 'gg-downloads-'))
    const target = join(downloads, 'verstak-report.md')
    const resolved = await resolveWritablePath(realRoot, target, { downloadsDir: downloads })
    expect(resolved).toBe(target)
  })

  it('blocks explicit absolute writes outside Downloads', async () => {
    const realRoot = mkdtempSync(join(tmpdir(), 'gg-root-'))
    const downloads = mkdtempSync(join(tmpdir(), 'gg-downloads-'))
    const outside = mkdtempSync(join(tmpdir(), 'gg-outside-'))
    await expect(resolveWritablePath(realRoot, join(outside, 'x.md'), { downloadsDir: downloads }))
      .rejects.toThrow('Downloads')
  })

  it('blocks symlink escape from Downloads', async () => {
    const realRoot = mkdtempSync(join(tmpdir(), 'gg-root-'))
    const downloads = mkdtempSync(join(tmpdir(), 'gg-downloads-'))
    const outside = mkdtempSync(join(tmpdir(), 'gg-outside-'))
    const link = join(downloads, 'escape')
    let linked = false
    try { symlinkSync(outside, link, 'dir'); linked = true } catch { /* нет привилегий */ }
    if (!linked) return
    await expect(resolveWritablePath(realRoot, join(link, 'x.md'), { downloadsDir: downloads }))
      .rejects.toThrow('symlink')
  })
})
