import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRequire } from 'module'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const require = createRequire(import.meta.url)
const { comparePayloadTrees, describeCompareResult } = require('../../scripts/payload-compare.cjs')

// Сверка «что реально ставится» с эталоном win-unpacked. Правило репозитория: рядом
// с проверкой «потери НЕ произошло» обязан стоять контрольный кейс, где потеря
// ПРОИСХОДИТ и сверка краснеет, — иначе зелёная сверка ничего не измеряет.

function write(root: string, rel: string, content = 'x') {
  const abs = join(root, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content)
}

describe('comparePayloadTrees — пейлоад установщика против win-unpacked', () => {
  let unpacked = ''
  let payload = ''

  beforeEach(() => {
    unpacked = mkdtempSync(join(tmpdir(), 'verstak-cmp-unpacked-'))
    payload = mkdtempSync(join(tmpdir(), 'verstak-cmp-payload-'))
    for (const root of [unpacked, payload]) {
      write(root, 'Verstak.exe', 'exe-bytes')
      write(root, join('locales', 'ru.pak'), 'ru')
      write(root, join('locales', 'en-US.pak'), 'en')
      write(root, join('resources', 'app.asar'), 'asar')
    }
    // Эталон может содержать вложенный app-payload прошлой сборки — он не обязан
    // попадать в пейлоад; пейлоад несёт свой служебный манифест.
    write(unpacked, join('app-payload', 'stale.7z'), 'zzz')
    write(payload, 'payload-manifest.json', '{"fileCount":4}')
  })

  afterEach(() => {
    rmSync(unpacked, { recursive: true, force: true })
    rmSync(payload, { recursive: true, force: true })
  })

  it('полный пейлоад — зелёный (app-payload эталона и манифест пейлоада не мешают)', () => {
    const r = comparePayloadTrees(unpacked, payload)
    expect(r.ok).toBe(true)
    expect(r.missing).toEqual([])
    expect(r.comparedCount).toBe(4)
  })

  it('КОНТРОЛЬ: пейлоад без locales обязан ронять сверку поимённо', () => {
    rmSync(join(payload, 'locales'), { recursive: true, force: true })
    const r = comparePayloadTrees(unpacked, payload)
    expect(r.ok).toBe(false)
    expect(r.missing).toEqual(['locales/en-US.pak', 'locales/ru.pak'])
    expect(describeCompareResult(r)).toContain('locales/en-US.pak')
  })

  it('обрезанный файл (размер разошёлся) роняет сверку', () => {
    writeFileSync(join(payload, 'resources', 'app.asar'), 'a')
    const r = comparePayloadTrees(unpacked, payload)
    expect(r.ok).toBe(false)
    expect(r.sizeMismatch).toEqual([
      { rel: 'resources/app.asar', expected: 4, actual: 1 },
    ])
  })

  it('неизвестный лишний файл в пейлоаде роняет сверку (allowlist только осознанный)', () => {
    write(payload, 'mystery.dll', 'huh')
    const r = comparePayloadTrees(unpacked, payload)
    expect(r.ok).toBe(false)
    expect(r.extra).toEqual(['mystery.dll'])
  })
})
