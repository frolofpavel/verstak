import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { SECURITY_RULES } from './_catalog'

const HERE = dirname(fileURLToPath(import.meta.url))

describe('security regression catalog', () => {
  it('every active rule references an existing test file and pending rules explain the gap', () => {
    for (const rule of SECURITY_RULES) {
      expect(rule.id).toMatch(/^SEC-[A-Z]+-\d{2}$/)
      if (rule.status === 'active') {
        expect(rule.testFile).toBeTruthy()
        expect(existsSync(resolve(HERE, rule.testFile!))).toBe(true)
      } else {
        expect(rule.testFile).toBeUndefined()
        expect(rule.pendingReason).toBeTruthy()
      }
    }
  })

  it('keeps rule ids unique', () => {
    const ids = SECURITY_RULES.map((rule) => rule.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('keeps the markdown registry in sync with catalog ids', () => {
    const docPath = resolve(HERE, '../../docs/SECURITY_REGRESSION_PACK.md')
    expect(existsSync(docPath)).toBe(true)

    const doc = readFileSync(docPath, 'utf8')
    for (const rule of SECURITY_RULES) {
      expect(doc).toContain(rule.id)
    }
  })
})
