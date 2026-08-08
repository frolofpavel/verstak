import { describe, it, expect } from 'vitest'
import { TOOL_DEFS, RUN_COMMAND_SHELL_HINT } from '../../electron/ai/tools'

// Задача B (08.08): run_command исполняется в cmd.exe на Windows (spawn ComSpec), но
// описание инструмента оболочку НЕ называло — модель гадала и трижды подряд пробовала
// PowerShell Move-Item на cmd.exe (все упали). Описание обязано называть оболочку.
describe('run_command описание называет оболочку', () => {
  const def = TOOL_DEFS.find(d => d.name === 'run_command')

  it('описание run_command содержит подсказку об оболочке (не молчит)', () => {
    expect(def).toBeTruthy()
    expect(def!.description).toContain(RUN_COMMAND_SHELL_HINT)
  })

  it('подсказка называет РЕАЛЬНУЮ оболочку платформы (cmd.exe+PowerShell-предупреждение на Windows, /bin/sh на POSIX)', () => {
    if (process.platform === 'win32') {
      expect(RUN_COMMAND_SHELL_HINT).toContain('cmd.exe')
      expect(RUN_COMMAND_SHELL_HINT).toMatch(/PowerShell/i)  // предупреждение про командлеты
    } else {
      expect(RUN_COMMAND_SHELL_HINT).toContain('/bin/sh')
    }
  })
})
