// Уборка за ОБОРВАННОЙ сборкой релиза (C7, 13.08).
//
// `process.on('exit')` не спасает от Ctrl+C: при SIGINT/SIGTERM без собственного
// обработчика Node выполняет штатную реакцию на сигнал и обработчики `exit` не
// вызываются. Обрыв сборки оставлял каталог `%TEMP%\verstak-release-<sha>` на
// гигабайты И запись в `git worktree list` — призрак ловили дважды, один раз он
// уронил следующую сборку («missing but already registered worktree»).
//
// Модуль сознательно не знает НИЧЕГО про git и про пути: он владеет только
// проводкой сигналов — регистрацией, защитой от повторного входа и кодом
// выхода. Что именно убирать, решает вызывающий (release-build.mjs). Так логика
// проверяема на поддельном процессе, а не грепом по тексту скрипта.

/** Номера сигналов для кода выхода 128+N — соглашение оболочки. */
const SIGNAL_NUMBERS = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1, SIGBREAK: 21 }

/** По умолчанию ловим и Windows-специфичный SIGBREAK (Ctrl+Break в cmd/PowerShell). */
const DEFAULT_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']

/**
 * Повесить уборку на сигналы обрыва.
 *
 * @param {{ process: NodeJS.Process | { on: Function }, onAbort: () => void,
 *           onExit: (code: number) => void, signals?: string[] }} opts
 * @returns {string[]} сигналы, на которые встали обработчики
 */
function installAbortCleanup(opts) {
  const proc = opts.process
  const signals = opts.signals || DEFAULT_SIGNALS
  // Повторный вход реален: нетерпеливый человек жмёт Ctrl+C дважды, а первая
  // уборка ещё удаляет гигабайтное дерево. Вторая пошла бы поверх неё.
  let firing = false
  const installed = []
  for (const sig of signals) {
    proc.on(sig, () => {
      if (firing) return
      firing = true
      // Уборка — best-effort: она сама печатает след, если каталог остался.
      // Упасть здесь означало бы повиснуть на обрыве, а это хуже мусора.
      try { opts.onAbort() } catch { /* след печатает сама уборка */ }
      opts.onExit(128 + (SIGNAL_NUMBERS[sig] || 0))
    })
    installed.push(sig)
  }
  return installed
}

module.exports = { installAbortCleanup, SIGNAL_NUMBERS, DEFAULT_SIGNALS }
