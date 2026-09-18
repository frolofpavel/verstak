import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ComputerHelperClient } from '../../../electron/ai/computer/helper-client'

describe('computer helper Windows read-only smoke', () => {
  it.runIf(process.platform === 'win32')('rejects clearFirst and empty type at the direct helper prepare boundary', async () => {
    const client = new ComputerHelperClient({
      helperPath: join(process.cwd(), 'resources', 'computer-use', 'helper.ps1'),
      appVersion: '2.9.1',
      requestTimeoutMs: 15_000,
    })
    const base = {
      identity: { pid: 1, processStartTime100ns: '1', hwnd: '1' },
      resolvedElement: { backendRef: 'direct-ipc-must-not-resolve' },
      expected: {
        title: 'must-not-probe',
        titleFingerprint: 'b'.repeat(64),
        geometry: { left: 0, top: 0, width: 1, height: 1 },
        dpi: 96,
        foreground: true,
        screenLocked: false,
        userInputEpoch: 0,
      },
    } as const

    try {
      await expect(client.prepareAction({
        ...base,
        attemptId: 'direct-clear-first',
        action: { kind: 'type', clearFirst: true } as never,
        textChunks: ['replacement'],
      })).rejects.toMatchObject({ code: 'clear_first_blocked' })

      await expect(client.prepareAction({
        ...base,
        attemptId: 'direct-clear-first-false',
        action: { kind: 'type', clearFirst: false } as never,
        textChunks: ['append'],
      })).rejects.toMatchObject({ code: 'clear_first_blocked' })

      await expect(client.prepareAction({
        ...base,
        attemptId: 'direct-top-level-clear-first',
        action: { kind: 'type' },
        clearFirst: true,
        textChunks: ['replacement'],
      } as never)).rejects.toMatchObject({ code: 'clear_first_blocked' })

      await expect(client.prepareAction({
        ...base,
        attemptId: 'direct-empty-type',
        action: { kind: 'type' },
        textChunks: [],
      })).rejects.toMatchObject({ code: 'empty_text' })
    } finally {
      await client.shutdown()
    }
  }, 30_000)

  it.runIf(process.platform === 'win32')('handshakes, enumerates candidates and shuts down without desktop action', async () => {
    const client = new ComputerHelperClient({
      helperPath: join(process.cwd(), 'resources', 'computer-use', 'helper.ps1'),
      appVersion: '2.9.1',
      requestTimeoutMs: 15_000,
    })
    const hello = await client.hello()
    expect(hello).toMatchObject({
      protocolVersion: 1,
      helperVersion: '2.9.1',
      appVersion: '2.9.1',
      inputMonitorReady: true,
    })
    await expect(client.ping()).resolves.toMatchObject({ ok: true })
    const candidates = await client.listCandidates()
    expect(Array.isArray(candidates)).toBe(true)
    for (const candidate of candidates) {
      expect(candidate).toMatchObject({
        candidateToken: expect.stringMatching(/^candidate-lease:[a-f0-9]{24}$/),
        identity: {
          pid: expect.any(Number),
          processStartTime100ns: expect.any(String),
          hwnd: expect.any(String),
        },
        titleFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      })
      expect(candidate.identity.pid).not.toBe(process.pid)
      expect([
        'cmd', 'conhost', 'openconsole', 'powershell', 'pwsh', 'windowsterminal',
        'wt', 'mintty', 'putty', 'puttytel', 'kitty', 'wezterm', 'wezterm-gui',
        'alacritty', 'conemu', 'conemu64', 'hyper', 'tabby', 'fluentterminal',
        'wsl', 'wslhost', 'bash', 'ubuntu', 'debian', 'kali', 'code',
        'code-insiders', 'cursor', 'windsurf', 'antigravity', 'devenv',
        'idea64', 'pycharm64', 'webstorm64', 'rider64', 'clion64', 'goland64',
        'phpstorm64', 'rubymine64', 'datagrip64', 'studio64', 'fleet', 'explorer',
        'shellexperiencehost', 'startmenuexperiencehost', 'searchhost', 'searchapp',
        'chrome', 'chrome_proxy', 'google-chrome', 'msedge', 'msedgewebview2',
        'firefox', 'firefox-esr', 'brave', 'brave-browser', 'opera', 'opera_gx',
        'chromium', 'chromium-browser', 'vivaldi', 'waterfox', 'librewolf',
        'browser', 'yandex', 'yandexbrowser', 'yabrowser', 'arc', 'arc-browser',
        'duckduckgo', 'duckduckgobrowser', 'zen', 'zen-browser', 'floorp',
      ]).not.toContain(candidate.processName.toLowerCase())
      expect(candidate.topLevelClassName).toEqual(expect.any(String))
      expect(candidate.topLevelClassName).not.toMatch(/^(?:Chrome_WidgetWin_|MozillaWindowClass|OperaWindowClass)/iu)
      expect(candidate.productName ?? '').not.toMatch(/browser|браузер/iu)
    }
    await expect(client.cancel('read-only-smoke-no-action')).resolves.toEqual({ cancelled: false })
    const stopStarted = performance.now()
    await expect(client.stop()).resolves.toEqual({ stopped: true })
    expect(performance.now() - stopStarted).toBeLessThanOrEqual(500)
    await client.shutdown()
  }, 30_000)

  it.runIf(process.platform === 'win32')('self-exits when its exact temporary owner process ends', async () => {
    const owner = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 30',
    ], { windowsHide: true, stdio: 'ignore' })
    if (!owner.pid) throw new Error('temporary owner process did not start')
    const client = new ComputerHelperClient({
      helperPath: join(process.cwd(), 'resources', 'computer-use', 'helper.ps1'),
      appVersion: '2.9.1',
      ownerPid: owner.pid,
      requestTimeoutMs: 15_000,
    })
    let crashTimeout: ReturnType<typeof setTimeout> | undefined
    try {
      await client.hello()
      const helperExited = new Promise<void>((resolve, reject) => {
        client.onEvent(event => {
          if (event.type === 'helper-crashed') resolve()
        })
        // Add-Type/helper startup is load-sensitive and is not part of the
        // owner-exit SLA. Measure only after the exact helper is ready.
        crashTimeout = setTimeout(() => reject(new Error('helper outlived its exact owner')), 5_000)
      })
      expect(owner.kill('SIGTERM')).toBe(true)
      await helperExited
      await expect(client.stop()).resolves.toEqual({ stopped: true })
    } finally {
      if (crashTimeout) clearTimeout(crashTimeout)
      if (owner.exitCode == null && owner.signalCode == null) owner.kill('SIGTERM')
      await client.shutdown()
    }
  }, 30_000)

  it.runIf(process.platform === 'win32')('rejects the correct owner PID with the wrong exact creation FILETIME', async () => {
    const client = new ComputerHelperClient({
      helperPath: join(process.cwd(), 'resources', 'computer-use', 'helper.ps1'),
      appVersion: '2.9.1',
      ownerPid: process.pid,
      resolveOwnerStartTime100ns: () => '1',
      requestTimeoutMs: 15_000,
    })
    try {
      await expect(client.hello()).rejects.toThrow()
    } finally {
      await client.shutdown()
    }
  }, 30_000)
})
