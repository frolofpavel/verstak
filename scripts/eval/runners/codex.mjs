import { assertRunnerAdapter, resolveInstalledCommand, runProcess } from './process.mjs'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const npmCodexScript =
  process.platform === 'win32' && process.env.APPDATA
    ? join(process.env.APPDATA, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
    : ''
const commandPrefix = npmCodexScript && existsSync(npmCodexScript) ? [npmCodexScript] : []

export const codexRunner = assertRunnerAdapter({
  id: 'codex',
  label: 'Codex CLI',
  command: commandPrefix.length ? process.execPath : resolveInstalledCommand('codex', ['.cmd', '.exe', '']),
  versionArgs: [...commandPrefix, '--version'],
  automation: 'non-interactive',
  permissionProfile: 'isolated-workspace-write',
  buildInvocation({ workspace, model, task }) {
    return {
      args: [
        ...commandPrefix,
        'exec',
        '--ephemeral',
        '--sandbox',
        'workspace-write',
        '--cd',
        workspace,
        '--model',
        model,
        '--json',
        '-',
      ],
      input: task,
    }
  },
})

export function runCodex({ workspace, model, task, env }) {
  const invocation = codexRunner.buildInvocation({ workspace, model, task })
  return runProcess({
    command: codexRunner.command,
    args: invocation.args,
    input: invocation.input,
    cwd: workspace,
    env,
  })
}
