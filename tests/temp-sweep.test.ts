import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, chmodSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { sweepTestTempDirs } from './temp-sweep'

// Карточка #1 (надёжный гейт): свип test-temp в globalSetup разрывает петлю накопления
// (10 051 каталог за сессию 18.07 → антивирус → EPERM-эскалация). ВАЖНО: тесты бьют по
// ИЗОЛИРОВАННОЙ base, а не по реальному %TEMP% — иначе снесли бы каталоги параллельных тестов.
describe('sweepTestTempDirs — глобальная чистка test-temp (карточка #1)', () => {
  let base: string
  afterEach(() => { try { rmSync(base, { recursive: true, force: true }) } catch { /* */ } })

  const makeChild = (name: string, readonlyPack = false) => {
    const dir = join(base, name)
    const packDir = join(dir, '.git', 'objects', 'pack')
    mkdirSync(packDir, { recursive: true })
    const f = join(packDir, 'pack-x.pack')
    writeFileSync(f, 'x')
    if (readonlyPack) chmodSync(f, 0o444) // как git метит pack — воспроизводим EPERM-класс
    return dir
  }

  it('удаляет test-prefixed каталоги (verstak-*/gg-*), даже с readonly pack-файлом', () => {
    base = mkdtempSync(join(tmpdir(), 'gg-sweepbase-'))
    const wt = makeChild('verstak-wt-state-abc', true)
    const proc = makeChild('verstak-proc-test-xyz')
    const gg = makeChild('gg-nudge-42')
    expect(existsSync(wt) && existsSync(proc) && existsSync(gg)).toBe(true)
    const { removed } = sweepTestTempDirs({ base })
    expect(removed).toBeGreaterThanOrEqual(3)
    expect(existsSync(wt)).toBe(false)
    expect(existsSync(proc)).toBe(false)
    expect(existsSync(gg)).toBe(false)
  })

  it('НЕ трогает каталоги без test-префикса (чужое в %TEMP% цело)', () => {
    base = mkdtempSync(join(tmpdir(), 'gg-sweepbase-'))
    const foreign = makeChild('some-other-tool-cache')
    sweepTestTempDirs({ base })
    expect(existsSync(foreign)).toBe(true)
  })

  it('olderThanMs щадит свежие каталоги (параллельный прогон не пострадает)', () => {
    base = mkdtempSync(join(tmpdir(), 'gg-sweepbase-'))
    const fresh = makeChild('verstak-wt-fresh')
    sweepTestTempDirs({ base, olderThanMs: 60 * 60 * 1000 }) // только >1ч
    expect(existsSync(fresh)).toBe(true) // свежий — не тронут
    sweepTestTempDirs({ base }) // без фильтра — убираем
    expect(existsSync(fresh)).toBe(false)
  })
})
