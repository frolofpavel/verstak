import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Browser Employee placement', () => {
  it('не монтирует карточку браузера поверх чата', () => {
    const app = readFileSync(join(process.cwd(), 'src/App.tsx'), 'utf8')

    expect(app).not.toContain('BrowserBridgeCard')
  })
})
