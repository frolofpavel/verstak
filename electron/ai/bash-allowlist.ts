/**
 * Tier-2 #4 — per-command bash-allowlist. Пользователь задаёт список доверенных
 * команд (настройка `bash_allowlist`); такие команды в режиме ask авто-аппрувятся
 * без модалки (меньше кликов на рутине: git status, npm test, ls). «Контроль» как
 * настройка — углубляет mode-policy, не ослабляя её: denylist (classifyCommand)
 * всё равно срабатывает первым, а цепочки/подстановки за разрешённым префиксом
 * (`git status && rm -rf /`) НЕ авто-аппрувятся.
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

/** Команда покрыта allowlist'ом (точное совпадение ИЛИ префикс с границей токена)?
 *  Команды с цепочками/перенаправлением/подстановкой — НИКОГДА (только confirm). */
export function matchesAllowlist(command: string, patterns: string[]): boolean {
  const cmd = command.trim()
  if (!cmd || patterns.length === 0) return false
  if (SHELL_META.test(cmd)) return false
  for (const raw of patterns) {
    const p = raw.trim()
    if (!p) continue
    if (cmd === p || cmd.startsWith(p + ' ')) return true
  }
  return false
}
