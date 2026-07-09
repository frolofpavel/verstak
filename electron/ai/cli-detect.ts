import { existsSync } from 'fs'
import { join } from 'path'
import { platform } from 'os'
import { execFileSync } from 'child_process'

export interface DetectedCli {
  id: string           // 'claude-cli' | 'codex-cli' | 'gemini-cli' | 'grok-cli' | 'hermes' | 'aider'
  name: string         // 'Claude Code' | 'Codex' | 'Gemini CLI' | 'Grok Build' | 'Hermes' | 'Aider'
  binary: string       // full path to binary
  version: string      // version string or 'unknown'
  status: 'ready' | 'found' | 'error'  // ready = works, found = binary exists but version check failed
}

const CLI_TOOLS = [
  {
    id: 'claude-cli',
    name: 'Claude Code',
    commands: ['claude'],
    versionArg: '--version',
    windowsPaths: (env: NodeJS.ProcessEnv) => [
      env.APPDATA ? join(env.APPDATA, 'npm', 'claude.cmd') : '',
      env.USERPROFILE ? join(env.USERPROFILE, '.local', 'bin', 'claude') : '',
      env.USERPROFILE ? join(env.USERPROFILE, '.local', 'bin', 'claude.exe') : '',
    ].filter(Boolean),
  },
  {
    id: 'codex-cli',
    name: 'Codex',
    commands: ['codex'],
    versionArg: '--version',
    windowsPaths: (env: NodeJS.ProcessEnv) => [
      env.APPDATA ? join(env.APPDATA, 'npm', 'codex.cmd') : '',
      env.APPDATA ? join(env.APPDATA, 'npm', 'codex.ps1') : '',
    ].filter(Boolean),
  },
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    commands: ['gemini'],
    versionArg: '--version',
    windowsPaths: (env: NodeJS.ProcessEnv) => [
      env.APPDATA ? join(env.APPDATA, 'npm', 'gemini.cmd') : '',
      env.USERPROFILE ? join(env.USERPROFILE, '.local', 'bin', 'gemini') : '',
    ].filter(Boolean),
  },
  {
    id: 'grok-cli',
    name: 'Grok Build',
    commands: ['grok'],
    versionArg: '--version',
    windowsPaths: (env: NodeJS.ProcessEnv) => [
      env.APPDATA ? join(env.APPDATA, 'npm', 'grok.cmd') : '',
      env.USERPROFILE ? join(env.USERPROFILE, '.grok', 'bin', 'grok.exe') : '',
      env.USERPROFILE ? join(env.USERPROFILE, '.grok', 'bin', 'grok') : '',
    ].filter(Boolean),
  },
  {
    id: 'hermes',
    name: 'Hermes Agent',
    commands: ['hermes'],
    versionArg: '--version',
    windowsPaths: (env: NodeJS.ProcessEnv) => [
      env.APPDATA ? join(env.APPDATA, 'npm', 'hermes.cmd') : '',
      env.USERPROFILE ? join(env.USERPROFILE, '.local', 'bin', 'hermes') : '',
    ].filter(Boolean),
  },
  {
    id: 'aider',
    name: 'Aider',
    commands: ['aider'],
    versionArg: '--version',
    windowsPaths: (env: NodeJS.ProcessEnv) => [
      env.USERPROFILE ? join(env.USERPROFILE, 'AppData', 'Local', 'Programs', 'Python', 'Python314', 'Scripts', 'aider.exe') : '',
      env.USERPROFILE ? join(env.USERPROFILE, 'AppData', 'Local', 'Programs', 'Python', 'Python313', 'Scripts', 'aider.exe') : '',
      env.USERPROFILE ? join(env.USERPROFILE, '.local', 'bin', 'aider') : '',
    ].filter(Boolean),
  },
]

export function detectInstalledClis(): DetectedCli[] {
  const results: DetectedCli[] = []

  for (const tool of CLI_TOOLS) {
    // 1. Check known Windows paths first
    let foundPath: string | null = null
    if (platform() === 'win32') {
      for (const p of tool.windowsPaths(process.env)) {
        if (p && existsSync(p)) { foundPath = p; break }
      }
    }

    // 2. If not found, try `where` (Windows) or `which` (Unix) to find on PATH
    if (!foundPath) {
      try {
        const cmd = platform() === 'win32' ? 'where' : 'which'
        const result = execFileSync(cmd, [tool.commands[0]], {
          timeout: 3000,
          encoding: 'utf-8',
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe']
        }).trim().split('\n')[0].trim()
        if (result && existsSync(result)) foundPath = result
      } catch { /* not on PATH */ }
    }

    if (!foundPath) continue

    // 3. Try to get version
    let version = 'unknown'
    let status: 'ready' | 'found' | 'error' = 'found'
    try {
      const isScript = foundPath.endsWith('.cmd') || foundPath.endsWith('.ps1')
      version = execFileSync(foundPath, [tool.versionArg], {
        timeout: 5000,
        encoding: 'utf-8',
        windowsHide: true,
        shell: isScript,
        stdio: ['pipe', 'pipe', 'pipe']
      }).trim().split('\n')[0].trim().slice(0, 50)
      status = 'ready'
    } catch {
      status = 'found' // binary exists but version check failed
    }

    results.push({ id: tool.id, name: tool.name, binary: foundPath, version, status })
  }

  return results
}
