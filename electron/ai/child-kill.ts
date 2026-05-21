import { spawn, type ChildProcess } from 'child_process'
import { platform } from 'os'

/**
 * Kill a spawned CLI child process AND its descendants.
 *
 * Why this exists: on Windows we spawn `.cmd`/`.ps1` wrappers (claude, codex,
 * grok, gemini) with `shell: true`. The `shell` option means Node spawns
 * `cmd.exe /c <wrapper>` and the wrapper itself spawns the actual node.exe
 * binary. `child.kill()` only terminates cmd.exe — the grandchild node.exe is
 * orphaned and keeps eating the user's CPU/memory after Stop is pressed. Per
 * Grok CLI parity audit (2026-05-21, finding 2.4): "корректное убийство
 * child-процессов во всех CLI" — addressed here.
 *
 * On Unix `child.kill('SIGTERM')` already propagates to the process group when
 * we spawn with detached:false, so the default works. We only need the special
 * treatment on Windows.
 *
 * Best-effort: silent on errors. Caller should also keep calling child.kill()
 * for the immediate handle so the SIGTERM path still works if treeKill fails.
 */
export function treeKill(child: ChildProcess): void {
  if (!child.pid) return
  if (platform() === 'win32') {
    // /F = force, /T = include process tree. taskkill is shipped with Windows.
    try {
      const k = spawn('taskkill', ['/pid', String(child.pid), '/F', '/T'], {
        windowsHide: true,
        stdio: 'ignore'
      })
      k.on('error', () => { /* taskkill missing — fall through */ })
    } catch { /* noop */ }
  }
  try { child.kill() } catch { /* already exited */ }
}
