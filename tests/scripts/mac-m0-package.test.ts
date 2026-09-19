import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../..')
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>
  build: {
    extraResources?: Array<{ from: string }>
    win?: { extraResources?: Array<{ from: string }> }
    mac?: { target?: Array<string | { target: string; arch?: string[] }>; identity?: string | null }
  }
}

describe('Mac M0 package contract', () => {
  it('builds only ARM64 and verifies the package after native rebuild', () => {
    expect(pkg.scripts['dist:mac']).toContain('electron-rebuild')
    expect(pkg.scripts['dist:mac']).toContain('--arm64')
    expect(pkg.scripts['dist:mac']).not.toContain('--x64')
    expect(pkg.scripts['dist:mac']).toContain('check:mac-package')
    expect(pkg.scripts['smoke:mac:m0']).toContain('smoke-mac-m0.mjs')
  })

  it('keeps Windows helper payloads out of the Mac bundle', () => {
    expect(pkg.build.extraResources ?? []).toEqual([])
    const winResources = pkg.build.win?.extraResources?.map(item => item.from) ?? []
    expect(winResources).toEqual(expect.arrayContaining([
      'resources/app-update.yml',
      'node_modules/7zip-bin/win/x64/7za.exe',
      'resources/browser-bridge/host.cmd',
      'resources/computer-use/helper.ps1',
    ]))
  })

  it('pins unsigned DMG and ZIP artifacts to arm64', () => {
    expect(pkg.build.mac?.identity).toBeNull()
    expect(pkg.build.mac?.target).toEqual([
      { target: 'dmg', arch: ['arm64'] },
      { target: 'zip', arch: ['arm64'] },
    ])
  })

  it('uses a real Apple Silicon runner and runs packaged smoke', () => {
    const workflow = readFileSync(resolve(root, '.github/workflows/release.yml'), 'utf8')
    const smoke = readFileSync(resolve(root, 'scripts/smoke-mac-m0.mjs'), 'utf8')
    expect(workflow).toContain('macos-15')
    expect(workflow).toContain('test "$(uname -m)" = "arm64"')
    expect(workflow).toContain('npm run dist:mac')
    expect(workflow).toContain('npm run smoke:mac:m0')
    expect(workflow).not.toContain('macos-13')
    expect(smoke).toContain("'runtime.jsonl'")
    expect(smoke).toContain('/startup\\.ok/g')
    expect(smoke).toContain('safeStorage/Keychain encryption was not available')
  })
})
