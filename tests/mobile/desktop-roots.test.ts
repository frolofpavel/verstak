import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createRootCapabilities } from '../../electron/mobile-bridge/roots'

describe('desktop mobile roots', () => {
  it('exposes opaque stable ids and resolves safe relative paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verstak-mobile-'))
    await writeFile(join(root, 'a.txt'), 'ok')
    const first = createRootCapabilities([{ path: root, name: 'Demo', hidden: false }])
    const second = createRootCapabilities([{ path: root, name: 'Demo', hidden: false }])
    expect(first.list()).toEqual(second.list())
    expect(first.list()[0]).not.toHaveProperty('path')
    await expect(first.resolve(first.list()[0].rootId, 'a.txt')).resolves.toBe(join(root, 'a.txt'))
  })

  it('blocks traversal, forbidden files and unknown roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verstak-mobile-'))
    const caps = createRootCapabilities([{ path: root, name: 'Demo', hidden: false }])
    const id = caps.list()[0].rootId
    await expect(caps.resolve(id, '../outside')).rejects.toThrow()
    await expect(caps.resolve(id, '.env')).rejects.toThrow('forbidden')
    await expect(caps.resolve('missing', 'a.txt')).rejects.toThrow('unknown root')
  })
})
