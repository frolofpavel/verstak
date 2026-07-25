import { describe, it, expect, vi, beforeAll } from 'vitest'
import { mkdtempSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// project-icons.ts тянет electron.app.getPath('userData'). В vitest electron
// нет — мокаем app, чтобы projectIconsDir() указывал во временную папку.
const USER_DATA = mkdtempSync(join(tmpdir(), 'gg-userdata-'))
vi.mock('electron', () => ({
  app: { getPath: () => USER_DATA },
  nativeImage: {}
}))

let isInsideProjectIcons: (p: string) => boolean
let projectIconsDir: () => string
let importProjectIcon: (projectPath: string, sourcePath: string) => string

beforeAll(async () => {
  const mod = await import('../../electron/storage/project-icons')
  isInsideProjectIcons = mod.isInsideProjectIcons
  projectIconsDir = mod.projectIconsDir
  importProjectIcon = mod.importProjectIcon
})

describe('isInsideProjectIcons', () => {
  it('true для файла внутри project-icons', () => {
    const inside = join(projectIconsDir(), 'abc123.png')
    expect(isInsideProjectIcons(inside)).toBe(true)
  })

  it('false для произвольного системного файла вне папки', () => {
    const outside = process.platform === 'win32' ? 'C:\\Windows\\System32\\drivers\\etc\\hosts' : '/etc/passwd'
    expect(isInsideProjectIcons(outside)).toBe(false)
  })

  it('false для traversal-выхода из папки', () => {
    const escape = join(projectIconsDir(), '..', '..', 'secret.png')
    expect(isInsideProjectIcons(escape)).toBe(false)
  })

  it('false для самой папки (не файл внутри неё) и для пустой строки', () => {
    expect(isInsideProjectIcons(projectIconsDir())).toBe(false)
    expect(isInsideProjectIcons('')).toBe(false)
  })

  // Ревью F6: symlink внутри project-icons, ведущий наружу, не должен считаться
  // «внутри» (realpath разворачивает ссылку). На Windows создание symlink требует
  // привилегий — тест мягко пропускается, если symlinkSync кинул EPERM.
  it('false для symlink наружу (realpath-проверка)', () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'gg-outside-'))
    const secret = join(outsideDir, 'secret.png')
    writeFileSync(secret, 'PNGDATA')
    const link = join(projectIconsDir(), 'evil.png')
    let linked = false
    try { symlinkSync(secret, link); linked = true } catch { /* нет привилегий — пропуск */ }
    if (!linked) return
    expect(isInsideProjectIcons(link)).toBe(false)
  })
})

describe('importProjectIcon — валидация источника (F7)', () => {
  it('отвергает не-изображение (произвольное чтение через .png невозможно)', () => {
    expect(() => importProjectIcon('/proj', '/etc/passwd')).toThrow(/изображения/)
    expect(() => importProjectIcon('/proj', 'C:/secret/data.txt')).toThrow(/изображения/)
    expect(() => importProjectIcon('/proj', '')).toThrow()
  })

  it('отвергает image внутри запрещённой папки (.ssh/icon.png) — isForbiddenPath', () => {
    expect(() => importProjectIcon('/proj', '.ssh/icon.png')).toThrow(/заблокирован|секрет/)
  })
})
