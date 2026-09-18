import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import type { AutomaticComputerApp } from './automatic-target'

type SpawnApplication = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => Pick<ChildProcess, 'once' | 'unref'>

const APPLICATION_EXECUTABLE: Record<AutomaticComputerApp, string> = {
  notepad: 'notepad.exe',
  calculator: 'calc.exe',
}

/** Launches only product-owned app identifiers. User text is never a command. */
export async function launchComputerApplication(
  app: AutomaticComputerApp,
  spawnApplication: SpawnApplication = spawn,
): Promise<void> {
  const executable = APPLICATION_EXECUTABLE[app]
  const child = spawnApplication(executable, [], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  })
  child.unref()
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', () => resolve())
    child.once('error', error => reject(error))
  })
}
