// manifest.test.ts — гейт контракта VSK-EXT-A1 + EXT-B1 Connected Eyes.
//
// MV3, минимум Chrome 114, permissions B1 (activeTab/scripting/sidePanel/
// nativeMessaging/storage), optional_host_permissions без <all_urls>,
// русское action.default_title, отсутствие опасных API.

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const EXT_DIR = resolve(HERE, '..', '..', 'browser-extension')

function readExt(relative: string): string {
  return readFileSync(join(EXT_DIR, relative), 'utf8')
}

function parseManifest() {
  const raw = readExt('manifest.json')
  return JSON.parse(raw) as Record<string, unknown>
}

describe('manifest.json — контракт VSK-EXT-A1 + EXT-B1', () => {
  it('валидный JSON, MV3, минимум Chrome 114', () => {
    const m = parseManifest()
    expect(m.manifest_version).toBe(3)
    expect(m.minimum_chrome_version).toBe('114')
    expect(typeof m.name).toBe('string')
    expect((m.name as string).length).toBeGreaterThan(0)
    expect(typeof m.version).toBe('string')
  })

  it('B1 permissions: activeTab, scripting, sidePanel, nativeMessaging, storage', () => {
    const m = parseManifest()
    const perms = m.permissions as string[] | undefined
    expect(Array.isArray(perms)).toBe(true)
    expect(perms!.slice().sort()).toEqual(
      ['activeTab', 'nativeMessaging', 'scripting', 'sidePanel', 'storage'].sort(),
    )
  })

  it('optional_host_permissions допустимы без <all_urls>; host_permissions отсутствуют', () => {
    const m = parseManifest()
    // B1: runtime request exact attached origin — optional patterns allowed, not broad host_permissions.
    expect(m).not.toHaveProperty('host_permissions')
    const optional = m.optional_host_permissions as string[] | undefined
    expect(Array.isArray(optional)).toBe(true)
    expect(optional!.length).toBeGreaterThan(0)
    for (const p of optional!) {
      expect(p, `optional_host_permissions не должен быть <all_urls>`).not.toBe('<all_urls>')
      expect(p).not.toMatch(/^\*:\/\//)
    }
    // Только http(s) patterns
    for (const p of optional!) {
      expect(p).toMatch(/^https?:\/\//)
    }
  })

  it('отсутствуют опасные разрешения и content_scripts', () => {
    const m = parseManifest()
    const forbiddenTop = [
      'host_permissions',
      'content_scripts',
      'optional_permissions',
      'declarativeNetRequest',
      'webRequest',
      'webRequestBlocking',
    ]
    for (const key of forbiddenTop) {
      expect(m, `manifest содержит запрещённое поле "${key}"`).not.toHaveProperty(key)
    }
    const perms = (m.permissions as string[]) || []
    const forbiddenPerms = new Set([
      'tabs',
      'cookies',
      'clipboardRead',
      'clipboardWrite',
      'history',
      'downloads',
      'declarativeNetRequest',
      'debugger',
      'proxy',
      'webRequest',
    ])
    for (const p of perms) {
      expect(forbiddenPerms.has(p), `запрещённое permission "${p}"`).toBe(false)
      expect(p).not.toContain('<all_urls>')
    }
  })

  it('background — service worker module, без удалённых скриптов', () => {
    const m = parseManifest()
    const bg = m.background as Record<string, unknown> | undefined
    expect(bg).toBeDefined()
    expect(bg?.service_worker).toBe('background.mjs')
    expect(bg?.type).toBe('module')
    expect(bg).not.toHaveProperty('scripts')
  })

  it('side_panel.default_path указывает на существующий файл', () => {
    const m = parseManifest()
    const sp = m.side_panel as Record<string, unknown> | undefined
    expect(sp).toBeDefined()
    expect(sp?.default_path).toBe('sidepanel.html')
    expect(existsSync(join(EXT_DIR, 'sidepanel.html'))).toBe(true)
  })

  it('action с осмысленным русским названием', () => {
    const m = parseManifest()
    const action = m.action as Record<string, unknown> | undefined
    expect(action).toBeDefined()
    const title = action?.default_title
    expect(typeof title).toBe('string')
    expect((title as string).trim().length).toBeGreaterThan(2)
    // Кириллица — индикатор «русского названия».
    expect((title as string)).toMatch(/[А-Яа-яЁё]/)
  })

  it('stable extension key присутствует (для fixed extension id)', () => {
    const m = parseManifest()
    expect(typeof m.key).toBe('string')
    expect((m.key as string).length).toBeGreaterThan(100)
  })

  it('указанные в manifest файлы существуют', () => {
    expect(existsSync(join(EXT_DIR, 'background.mjs'))).toBe(true)
    expect(existsSync(join(EXT_DIR, 'sidepanel.html'))).toBe(true)
    expect(existsSync(join(EXT_DIR, 'sidepanel.mjs'))).toBe(true)
    expect(existsSync(join(EXT_DIR, 'sidepanel.css'))).toBe(true)
    expect(existsSync(join(EXT_DIR, 'extractor.mjs'))).toBe(true)
    expect(existsSync(join(EXT_DIR, 'format-prompt.mjs'))).toBe(true)
    expect(existsSync(join(EXT_DIR, 'bridge-client.mjs'))).toBe(true)
  })

  it('background запрашивает exact origin, не <all_urls>', () => {
    const bg = readExt('background.mjs')
    expect(bg).toMatch(/ensureOriginPermission/)
    expect(bg).toMatch(/permissions\.request/)
    // originPattern = protocol//host/*  — точный host, не all_urls
    expect(bg).toMatch(/originPattern\s*=\s*`\$\{u\.protocol\}\/\/\$\{u\.host\}\/\*`/)
    expect(bg).not.toMatch(/<all_urls>/)
    expect(bg).not.toMatch(/permissions\.request\(\s*\{\s*origins:\s*\[\s*['"]<all_urls>/)
  })

  it('исходники не используют eval/new Function/удалённые URL/innerHTML', () => {
    const files = [
      'background.mjs',
      'sidepanel.mjs',
      'extractor.mjs',
      'format-prompt.mjs',
      'bridge-client.mjs',
    ]
    const banPatterns: Array<{ re: RegExp; label: string }> = [
      { re: /\beval\s*\(/, label: 'eval(' },
      { re: /new\s+Function\s*\(/, label: 'new Function(' },
      { re: /\.innerHTML\b/, label: '.innerHTML' },
      { re: /\.outerHTML\b/, label: '.outerHTML' },
      { re: /insertAdjacentHTML\b/, label: 'insertAdjacentHTML' },
      { re: /document\.write\b/, label: 'document.write' },
      { re: /https?:\/\/[^/\s)'"]+\.(ru|com|net|org|io)\b/, label: 'remote URL' },
    ]
    for (const f of files) {
      const src = readExt(f)
      for (const { re, label } of banPatterns) {
        expect(
          src,
          `${f}: найдено запрещённое выражение "${label}"`
        ).not.toMatch(re)
      }
    }
  })

  it('extractor.mjs экспортирует self-contained capturePageSnapshot', async () => {
    const url = pathToFileURL(join(EXT_DIR, 'extractor.mjs')).href
    const mod = await import(url) as { capturePageSnapshot?: unknown }
    expect(typeof mod.capturePageSnapshot).toBe('function')
  })

  it('format-prompt.mjs экспортирует formatSnapshotForVerstak', async () => {
    const url = pathToFileURL(join(EXT_DIR, 'format-prompt.mjs')).href
    const mod = await import(url) as { formatSnapshotForVerstak?: unknown }
    expect(typeof mod.formatSnapshotForVerstak).toBe('function')
  })
})
