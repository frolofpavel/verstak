import { describe, it, expect } from 'vitest'
import {
  normalizeClientFolderSlug,
  validateClientFolderSlug
} from '../../electron/storage/clients-root'

describe('clients-root', () => {
  it('normalizes slug to lowercase', () => {
    expect(normalizeClientFolderSlug('  My-Client_2 ')).toBe('my-client_2')
  })

  it('accepts valid latin slugs', () => {
    expect(validateClientFolderSlug('avtor')).toBeNull()
    expect(validateClientFolderSlug('gk-ostov')).toBeNull()
    expect(validateClientFolderSlug('client_v2')).toBeNull()
  })

  it('rejects invalid slugs', () => {
    expect(validateClientFolderSlug('')).not.toBeNull()
    expect(validateClientFolderSlug('2bad')).not.toBeNull()
    expect(validateClientFolderSlug('кириллица')).not.toBeNull()
    expect(validateClientFolderSlug('_template')).not.toBeNull()
  })
})