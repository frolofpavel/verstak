import { describe, expect, it } from 'vitest'
import {
  cleanReleaseBody,
  isBenignUpdaterError,
  maxSemver,
  mergeRateLimit,
  normalizeVersion,
  parseGithubRateLimit,
  parseLatestYmlArtifact,
  parseReleaseTagFromUrl,
  pickInstallableUpdate,
  rateLimitWaitMinutes,
  releaseFeedBase,
  semverGt,
} from '../electron/update-remote'

describe('update-remote semver', () => {
  it('normalizeVersion strips v prefix', () => {
    expect(normalizeVersion('v1.3.1')).toBe('1.3.1')
  })

  it('semverGt compares patch versions', () => {
    expect(semverGt('1.3.1', '1.3.0')).toBe(true)
    expect(semverGt('1.3.0', '1.3.1')).toBe(false)
    expect(semverGt('1.3.0', '1.3.0')).toBe(false)
  })

  it('maxSemver picks highest', () => {
    expect(maxSemver(['v1.2.0', 'v1.3.1', 'v1.3.0'])).toBe('1.3.1')
  })

  it('releaseFeedBase builds tag download url', () => {
    expect(releaseFeedBase('1.3.1')).toBe(
      'https://github.com/frolofpavel/verstak/releases/download/v1.3.1',
    )
  })
})

describe('cleanReleaseBody', () => {
  it('strips install footer after horizontal rule', () => {
    const raw = '## Verstak 1.4.0\n\n- Feature A\n\n---\nУстановка: setup.exe'
    expect(cleanReleaseBody(raw)).toBe('## Verstak 1.4.0\n\n- Feature A')
  })
})

describe('pickInstallableUpdate', () => {
  it('prefers latest release when package.json on main is ahead', () => {
    const result = pickInstallableUpdate({
      installed: '1.5.5',
      repoMax: '1.5.12',
      latestRelease: '1.5.11',
      hasArtifacts: (v) => v === '1.5.11',
    })
    expect(result).toEqual({ installable: '1.5.11', pendingVersion: null })
  })

  it('returns pending when repo is newer but no artifacts exist', () => {
    const result = pickInstallableUpdate({
      installed: '1.5.5',
      repoMax: '1.5.12',
      latestRelease: null,
      hasArtifacts: () => false,
    })
    expect(result).toEqual({ installable: null, pendingVersion: '1.5.12' })
  })

  it('uses repo max when it has artifacts', () => {
    const result = pickInstallableUpdate({
      installed: '1.5.10',
      repoMax: '1.5.11',
      latestRelease: '1.5.11',
      hasArtifacts: (v) => v === '1.5.11',
    })
    expect(result).toEqual({ installable: '1.5.11', pendingVersion: null })
  })

  it('installs latest published when package.json on main is ahead without installer', () => {
    const result = pickInstallableUpdate({
      installed: '1.5.17',
      repoMax: '1.5.20',
      latestRelease: '1.5.19',
      hasArtifacts: (v) => v === '1.5.19',
    })
    expect(result).toEqual({ installable: '1.5.19', pendingVersion: null })
  })
})

describe('parseReleaseTagFromUrl', () => {
  it('extracts semver from releases/latest redirect url', () => {
    expect(parseReleaseTagFromUrl('https://github.com/frolofpavel/verstak/releases/tag/v1.5.19')).toBe('1.5.19')
  })
})

describe('parseLatestYmlArtifact', () => {
  it('parses path, sha512 and size', () => {
    const yml = `version: 1.5.7
files:
  - url: Verstak-Setup-1.5.7-x64.exe
    sha512: abc==
    size: 253272554
path: Verstak-Setup-1.5.7-x64.exe
sha512: abc==
`
    expect(parseLatestYmlArtifact(yml, '1.5.7')).toEqual({
      version: '1.5.7',
      fileName: 'Verstak-Setup-1.5.7-x64.exe',
      sha512: 'abc==',
      size: 253272554,
    })
  })
})

describe('parseGithubRateLimit', () => {
  it('detects 403 rate limit from body and reset header', async () => {
    const reset = Math.floor(Date.now() / 1000) + 3600
    const res = new Response(
      JSON.stringify({ message: 'API rate limit exceeded for 1.2.3.4' }),
      { status: 403, headers: { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': String(reset) } },
    )
    const info = await parseGithubRateLimit(res)
    expect(info).not.toBeNull()
    expect(info!.resetAt).toBe(reset * 1000)
    expect(rateLimitWaitMinutes(info!)).toBeGreaterThan(0)
  })

  it('returns null for unrelated 403', async () => {
    const res = new Response('Forbidden', { status: 403 })
    expect(await parseGithubRateLimit(res)).toBeNull()
  })

  it('mergeRateLimit keeps later reset', () => {
    const a = { resetAt: 1000, retryAfterSec: 60 }
    const b = { resetAt: 5000, retryAfterSec: 120 }
    expect(mergeRateLimit(a, b)?.resetAt).toBe(5000)
  })
})

describe('fetchVersionFromLatestYml parsing', () => {
  it('parses version line from latest.yml body', () => {
    const yml = `version: 1.5.11
files:
  - url: Verstak-Setup-1.5.11-x64.exe
path: Verstak-Setup-1.5.11-x64.exe
`
    const m = yml.match(/^version:\s*(\S+)/m)
    expect(m?.[1]).toBe('1.5.11')
  })
})

describe('isBenignUpdaterError', () => {
  it('treats missing latest.yml as benign', () => {
    expect(isBenignUpdaterError('Cannot find latest.yml in the latest release')).toBe(true)
  })

  it('keeps unexpected errors', () => {
    expect(isBenignUpdaterError('disk full')).toBe(false)
  })
})