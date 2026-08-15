// P3 кусок 3: запуск ЖИВОЙ приёмки изолированной браузерной сессии.
//
// Обёртка нужна ровно за тем, чтобы флаг ставился одинаково на всех оболочках:
// в cmd.exe `VAR=1 cmd` не работает вовсе, в PowerShell работает иначе, чем в sh, —
// а инструкция, которая в одной оболочке молча ничего не включает, хуже отсутствующей
// (тест «прошёл», потому что был пропущен).
import { spawn } from 'child_process'

const child = spawn(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['vitest', 'run', 'tests/live/browser-isolated-live.test.ts'],
  { stdio: 'inherit', env: { ...process.env, VERSTAK_LIVE_BROWSER: '1' } }
)
child.on('exit', code => process.exit(code ?? 1))
