import { ipcMain } from 'electron'
import { loadCommands, expandCommandBody } from '../ai/commands'
import { createToolsForProject } from '../ai/tools'
import { isWithinKnownRoots } from '../ai/path-policy'
import { isInjectionCommandAllowed } from '../ai/command-policy'

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
        // Этот путь минует mode-policy/confirm-модалку — поэтому инъекция !`cmd`
        // ограничена read-only allowlist'ом (ревью HIGH: денилист пропускал
        // exfiltration/reverse-shell из недоверенного {project}/.verstak/commands).
        if (!isInjectionCommandAllowed(shellCmd)) {
          throw new Error('разрешены только read-only команды (git diff/status, ls, cat и т.п.)')
        }
        const r = await tools.runCommand(shellCmd)
        return r.stdout || r.stderr || ''
      }
    }
    // Без валидного projectPath !`cmd` не выполняем (runCommand undefined → остаётся маркером).
    return expandCommandBody(cmd.body, argString ?? '', { runCommand })
  })
}
