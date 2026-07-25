import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '../..')

describe('repository root hygiene', () => {
  it('не допускает одноразовые handoff/task-файлы в корне', () => {
    const forbidden = readdirSync(ROOT)
      .filter(name => /^TASK-.*\.md$/i.test(name) || name === 'SECURITY-NOTES.md')
      .sort()

    expect(forbidden).toEqual([])
  })

  it('production package использует allowlist и не включает dev-документы', () => {
    const pkg = JSON.parse(
      readFileSync(resolve(ROOT, 'package.json'), 'utf8')
    ) as { build?: { files?: string[] } }
    const files = pkg.build?.files ?? []

    expect(files).toContain('out/**/*')
    expect(files).toContain('package.json')
    expect(files).toContain('node_modules/**/*')
    expect(files).not.toContain('**/*')
    expect(files.some(pattern => /\.(?:md|txt)$/i.test(pattern))).toBe(false)
  })
})
