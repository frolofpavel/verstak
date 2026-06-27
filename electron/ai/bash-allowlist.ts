/**
 * Tier-2 #4 — per-command bash-allowlist. Пользователь задаёт список доверенных
 * команд (настройка `bash_allowlist`); такие команды в режиме ask авто-аппрувятся
 * без модалки (меньше кликов на рутине: git status, npm test, ls). «Контроль» как
 * настройка — углубляет mode-policy, не ослабляя её. ВАЖНО: префиксный allowlist для
 * команд-обёрток (git/npm/find/docker) принципиально арг-инъектируем — флаги самой
 * команды исполняют код БЕЗ shell-метасимволов (`git status --pager="sh -c id"`,
 * `git -c core.sshCommand=…`, `npm run <скрипт>`). Поэтому авто-аппрув блокируется ДВУМЯ
 * фильтрами: SHELL_META (цепочки/подстановки) И ESCALATOR (флаги/субкоманды-эскалаторы).
 * denylist (classifyCommand) тоже срабатывает первым. Планку поднимает, но НЕ гарантия —
 * в allowlist класть только доверенные команды.
 */

/** Разбить настройку (строки/запятые) в список паттернов-префиксов. */
export function parseAllowlist(raw: string | null | undefined): string[] {
  if (!raw) return []
  return raw
    .split(/[\n,]/)
    .map(s => s.trim())
    .filter(Boolean)
}

// Метасимволы шелла, способные спрятать опасную команду за разрешённым префиксом.
const SHELL_META = /[;&|`<>\n]|\$\(/

// Флаги/субкоманды-эскалаторы: исполняют произвольный код БЕЗ shell-метасимволов
// (arg-injection через сам бинарь). Даже на разрешённом префиксе — только confirm.
const ESCALATOR = /(?:^|\s)(?:-c|-e|--config|--pager|--exec|--eval|--upload-pack|--receive-pack|--use-askpass|--open-files-in-pager|exec|run)(?:[\s=]|$)|ext::|sshCommand/i

/** Команда покрыта allowlist'ом (точное совпадение ИЛИ префикс с границей токена)?
 *  Цепочки/подстановки (SHELL_META) и флаги-эскалаторы (ESCALATOR) — НИКОГДА. */
export function matchesAllowlist(command: string, patterns: string[]): boolean {
  const cmd = command.trim()
  if (!cmd || patterns.length === 0) return false
  if (SHELL_META.test(cmd) || ESCALATOR.test(cmd)) return false
  for (const raw of patterns) {
    const p = raw.trim()
    if (!p) continue
    if (cmd === p || cmd.startsWith(p + ' ')) return true
  }
  return false
}
