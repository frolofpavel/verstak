import { join } from 'node:path'
import { assertRunnerAdapter } from './process.mjs'
import { runVerstakCli } from './verstak.mjs'

export const verstakArenaRunner = assertRunnerAdapter({
  id: 'verstak',
  label: 'Verstak',
  command: process.execPath,
  versionArgs: ['--version'],
  automation: 'non-interactive',
  permissionProfile: 'isolated-workspace-write',
  buildInvocation({ repoRoot, workspace, model, fixture, maxTurns }) {
    return {
      root: workspace,
      repoRoot,
      cliPath: join(repoRoot, 'scripts', 'verstak-cli.mjs'),
      fixture,
      model,
      maxTurns,
    }
  },
})

export function runVerstakArena({ repoRoot, workspace, model, fixture, maxTurns }) {
  return runVerstakCli(
    verstakArenaRunner.buildInvocation({ repoRoot, workspace, model, fixture, maxTurns }),
  )
}
