import { describe, expect, it } from 'vitest'
import { getBundledReleaseNotesInRange, mergeReleaseNotes } from '../electron/rayner-changelog'
import type { ReleaseNote } from '../electron/update-remote'

describe('rayner-changelog', () => {
  it('returns bundled 1.5.1 in range from 1.5.0 to 1.5.1', () => {
    const notes = getBundledReleaseNotesInRange('1.5.0', '1.5.1')
    expect(notes.some(n => n.version === '1.5.1')).toBe(true)
    expect(notes[0]?.publishedAt).toBeTruthy()
  })

  it('mergeReleaseNotes combines github and bundled by version', () => {
    const github: ReleaseNote[] = [{
      version: '1.5.0',
      name: 'Verstak 1.5.0',
      body: '- Upstream feature',
      htmlUrl: 'https://example.com/1.5.0',
      publishedAt: '2026-06-15T10:00:00Z',
    }]
    const bundled: ReleaseNote[] = [{
      version: '1.5.1',
      name: 'Rayner build',
      body: '- Fork patch',
      htmlUrl: 'https://example.com/rayner',
      publishedAt: '2026-06-16T12:00:00Z',
    }]
    const merged = mergeReleaseNotes(github, bundled)
    expect(merged.map(n => n.version)).toEqual(['1.5.0', '1.5.1'])
  })

})