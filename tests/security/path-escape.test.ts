import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { resolveReadOnlyPath, resolveWritablePath } from '../../electron/ai/path-policy'

function makeFixture() {
  const base = mkdtempSync(join(tmpdir(), 'verstak-security-path-'))
  const project = join(base, 'project')
  const outside = join(base, 'outside')
  const downloads = join(base, 'downloads')
  const allowed = join(base, 'allowed')

  mkdirSync(project)
  mkdirSync(outside)
  mkdirSync(downloads)
  mkdirSync(allowed)

  return { base, project, outside, downloads, allowed }
}

describe('SEC-PATH path escape regression pack', () => {
  it('SEC-PATH-01 allows explicit absolute read outside project as read-only context', async () => {
    const fixture = makeFixture()
    const externalFile = join(fixture.outside, 'context.md')
    writeFileSync(externalFile, 'external context')

    await expect(resolveReadOnlyPath(fixture.project, externalFile))
      .resolves.toBe(realpathSync(externalFile))
  })

  it('SEC-PATH-02 allows absolute writes inside configured external roots', async () => {
    const fixture = makeFixture()
    const target = join(fixture.allowed, 'report.md')

    await expect(resolveWritablePath(fixture.project, target, {
      downloadsDir: fixture.downloads,
      allowedRoots: [fixture.allowed]
    })).resolves.toBe(target)
  })

  it('SEC-PATH-03 blocks absolute writes outside project, downloads, and allowed roots', async () => {
    const fixture = makeFixture()
    const target = join(fixture.outside, 'blocked.md')

    await expect(resolveWritablePath(fixture.project, target, {
      downloadsDir: fixture.downloads,
      allowedRoots: [fixture.allowed]
    })).rejects.toThrow()
  })

  it('SEC-PATH-04 blocks symlink escape from configured external roots', async () => {
    const fixture = makeFixture()
    const link = join(fixture.allowed, 'link-out')

    try {
      symlinkSync(fixture.outside, link, 'dir')
    } catch {
      return
    }

    await expect(resolveWritablePath(fixture.project, join(link, 'leak.md'), {
      downloadsDir: fixture.downloads,
      allowedRoots: [fixture.allowed]
    })).rejects.toThrow('symlink')
  })
})
