import { assertRunnerAdapter, resolveInstalledCommand, runProcess } from './process.mjs'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const bundledWindowsCommand =
  process.platform === 'win32' && process.env.APPDATA
    ? join(process.env.APPDATA, 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe')
    : ''

export const opencodeRunner = assertRunnerAdapter({
  id: 'opencode',
  label: 'OpenCode',
  command:
    bundledWindowsCommand && existsSync(bundledWindowsCommand)
      ? bundledWindowsCommand
      : resolveInstalledCommand('opencode', ['.exe', '.cmd', '']),
  versionArgs: ['--version'],
  automation: 'non-interactive',
  permissionProfile: 'isolated-workspace-write',
  buildInvocation({ workspace, model, task }) {
    return {
      args: ['run', '--pure', '--auto', '--format', 'json', '--dir', workspace, '--model', model, task],
      input: '',
    }
  },
})

export function runOpenCode({ workspace, model, task, env }) {
  const invocation = opencodeRunner.buildInvocation({ workspace, model, task })
  return runProcess({
    command: opencodeRunner.command,
    args: invocation.args,
    input: invocation.input,
    cwd: workspace,
    env,
  })
}
