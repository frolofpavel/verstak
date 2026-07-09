import { describe, expect, it } from 'vitest'
import { slugFromName } from '../../src/components/CreateClientModal'

describe('project folder slug', () => {
  it('transliterates cyrillic project names into editable latin slugs', () => {
    expect(slugFromName('Черри Дом')).toBe('cherri-dom')
    expect(slugFromName('ГК Остов — Иркутск')).toBe('gk-ostov-irkutsk')
    expect(slugFromName('Ёлка и Юла')).toBe('elka-i-yula')
  })

  it('keeps latin names clean and removes unsupported characters', () => {
    expect(slugFromName('  Acme Corp 2026!  ')).toBe('acme-corp-2026')
    expect(slugFromName('123 Остов')).toBe('ostov')
  })
})
