import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRequire } from 'module'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { join, relative, sep } from 'path'
import { tmpdir } from 'os'

const require = createRequire(import.meta.url)
const { PAYLOAD_SKIP, copyDirFiltered, computePayloadManifest } = require('../../scripts/build-setup.cjs')

// Класс дефекта: пейлоад собственного установщика строится копией win-unpacked с фильтром,
// и каталог, выпавший из фильтра, молча пропадает у КАЖДОГО пользователя Setup-артефакта.
// Реальный случай (2.4.5–2.4.7): 'locales' попал в PAYLOAD_SKIP «для скорости» (777a304),
// без locale-pak рендер Chromium падает access violation через ~0.5 с после загрузки —
// вечное серое окно. Манифест пейлоада при этом честно записывал урезанный fileCount,
// т.е. врал именно сборщик, а не копирование установщика.

function write(root: string, rel: string, content = 'x') {
  const abs = join(root, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content)
}

function listFilesRec(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) walk(abs)
      else if (entry.isFile()) out.push(relative(root, abs).split(sep).join('/'))
    }
  }
  walk(root)
  return out.sort()
}

describe('build-setup: пейлоад установщика не теряет файлы win-unpacked', () => {
  let src = ''
  let dest = ''

  beforeEach(() => {
    src = mkdtempSync(join(tmpdir(), 'verstak-payload-src-'))
    dest = mkdtempSync(join(tmpdir(), 'verstak-payload-dest-'))
    // Мини-слепок win-unpacked: exe, локали Chromium, ресурсы, вложенный app-payload
    // от прошлой сборки (единственное, что фильтр вправе отсечь).
    write(src, 'Verstak.exe')
    write(src, 'd3dcompiler_47.dll')
    write(src, join('locales', 'ru.pak'))
    write(src, join('locales', 'en-US.pak'))
    write(src, join('resources', 'app.asar'))
    write(src, join('resources', 'native-fix', 'better_sqlite3.node'))
    write(src, join('app-payload', 'stale.7z'))
  })

  afterEach(() => {
    rmSync(src, { recursive: true, force: true })
    rmSync(dest, { recursive: true, force: true })
  })

  it('locales уходит в пейлоад целиком (без него рендер падает access violation)', () => {
    copyDirFiltered(src, dest)
    expect(listFilesRec(dest)).toEqual(
      expect.arrayContaining(['locales/ru.pak', 'locales/en-US.pak']),
    )
  })

  it('из win-unpacked не теряется НИЧЕГО, кроме вложенного app-payload', () => {
    copyDirFiltered(src, dest)
    const expected = listFilesRec(src).filter(rel => !rel.startsWith('app-payload/'))
    expect(listFilesRec(dest)).toEqual(expected)
  })

  it('контроль: вложенный app-payload в пейлоад не попадает (иначе рекурсивное раздувание)', () => {
    copyDirFiltered(src, dest)
    expect(listFilesRec(dest)).not.toEqual(
      expect.arrayContaining(['app-payload/stale.7z']),
    )
    expect(PAYLOAD_SKIP.has('app-payload')).toBe(true)
  })

  it('манифест считает то, что реально лежит в staging (fileCount не врёт)', () => {
    copyDirFiltered(src, dest)
    const manifest = computePayloadManifest(dest)
    expect(manifest.fileCount).toBe(listFilesRec(dest).length)
  })
})
