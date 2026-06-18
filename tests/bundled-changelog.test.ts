import { describe, expect, it } from 'vitest'
import { getBundledReleaseNote } from '../electron/bundled-changelog'

describe('bundled-changelog', () => {
  it('1.5.15: встроенное описание без GitHub API', () => {
    const note = getBundledReleaseNote('1.5.15')
    expect(note?.version).toBe('1.5.15')
    expect(note?.body).toContain('Справка')
    expect(note?.body).toContain('черновики')
  })
})