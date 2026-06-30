import { ipcMain } from 'electron'
import { loadCommands, expandCommandBody } from '../ai/commands'
import { createToolsForProject } from '../ai/tools'
import { isWithinKnownRoots } from '../ai/path-policy'

export function registerCommandsIpc(getKnownRoots: () => string[]): void {
  ipcMain.handle('commands:list', (_e, projectPath: string | null) => {
    return loadCommands(projectPath)
  })

  /**
   * Раскрыть тело команды: позиционные $1/$ARGUMENTS + инъекция !`bash` вывода.
   * $VARIABLE (заглавные) НЕ трогаем — их промптит UI. Возвращает раскрытое тело.
   * Безопасность: projectPath валидируется против known-roots; !`cmd` гейтится
   * денилистом (tools.classifyCommand) и исполняется проектным раннером.
   */
  ipcMain.handle('commands:expand', async (_e, name: string, argString: string, projectPath: string | null): Promise<string> => {
    const cmd = loadCommands(projectPath).find(c => c.name === name)
    if (!cmd) return ''
    let runCommand: ((cmd: string) => Promise<string>) | undefined
    if (projectPath && isWithinKnownRoots(projectPath, getKnownRoots())) {
      const controller = new AbortController()
      const tools = createToolsForProject(projectPath, controller.signal)
      runCommand = async (shellCmd: string): Promise<string> => {
        const verdict = tools.classifyCommand(shellCmd)
        if (!verdict.allowed) throw new Error(`денилист: ${verdict.reason ?? 'запрещено'}`)
        const r = await tools.runCommand(shellCmd)
        return r.stdout || r.stderr || ''
      }
    }
    // Без валидного projectPath !`cmd` не выполняем (runCommand undefined → остаётся маркером).
    return expandCommandBody(cmd.body, argString ?? '', { runCommand })
  })
}
