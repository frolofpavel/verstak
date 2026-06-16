import { describe, expect, it } from 'vitest'
import { formalizeReleaseBody, polishReleaseNote } from '../electron/release-notes-official'
import { mergeReleaseNotes } from '../electron/rayner-changelog'
import type { ReleaseNote } from '../electron/update-remote'

describe('release-notes-official', () => {
  it('formalizeReleaseBody убирает разговорные вставки', () => {
    const raw = '- Клик по коннектору скроллит к настройкам (раньше панель за экраном — «жму, ничего не происходит»).'
    const out = formalizeReleaseBody(raw)
    expect(out).not.toMatch(/жму/i)
    expect(out).not.toMatch(/«/)
    expect(out).toMatch(/^- /)
  })

  it('mergeReleaseNotes: GitHub основной, bundled — дополнение', () => {
    const github: ReleaseNote[] = [{
      version: '1.5.4',
      name: 'Verstak 1.5.4',
      body: '- Upstream change',
      htmlUrl: 'https://example.com/gh',
      publishedAt: '2026-06-16T10:00:00Z',
    }]
    const bundled: ReleaseNote[] = [{
      version: '1.5.4',
      name: 'Verstak 1.5.4',
      body: '- Rayner patch',
      htmlUrl: 'https://example.com/rayner',
      publishedAt: '2026-06-16T14:00:00Z',
    }]
    const merged = mergeReleaseNotes(github, bundled)
    expect(merged[0].body).toContain('Upstream change')
    expect(merged[0].body).toContain('Rayner patch')
    expect(merged[0].body).toContain('---')
  })

  it('polishReleaseNote формализует merge без подмены каталогом', () => {
    const merged = mergeReleaseNotes(
      [{
        version: '1.5.4',
        name: 'Verstak 1.5.4',
        body: '- Жму на коннектор — ничего не вижу',
        htmlUrl: 'https://example.com/gh',
      }],
      [{
        version: '1.5.4',
        name: 'Verstak 1.5.4',
        body: '- Добавлена прокрутка к карточке коннектора при выборе из списка.',
        htmlUrl: 'https://example.com/rayner',
      }],
    )
    const polished = polishReleaseNote(merged[0])
    expect(polished.body).toContain('прокрутка к целевому блоку')
    expect(polished.body).toContain('---')
    expect(polished.body).toContain('прокрутка к карточке')
    expect(polished.body).not.toMatch(/Жму/i)
  })

  it('polishReleaseNote формализует версию без каталога', () => {
    const note: ReleaseNote = {
      version: '9.9.9',
      name: 'Test',
      body: '- fix: something broke — «тупит»',
      htmlUrl: 'https://example.com',
    }
    const polished = polishReleaseNote(note)
    expect(polished.body).not.toMatch(/тупит/i)
    expect(polished.body).toMatch(/^- Something broke/)
  })
})