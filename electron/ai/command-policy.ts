/**
 * Static safety rules for AI-issued shell commands.
 *
 * Two layers:
 *   1. DENYLIST — patterns that are NEVER allowed to run, even with user
 *      confirmation. These are clearly destructive operations a coding agent
 *      should never need (drive wipes, OS reinstall, mass deletions outside
 *      the project, network shenanigans on hosts, etc.).
 *
 *   2. CONFIRMATION (everything else) — all other commands require an explicit
 *      user click in the UI before they execute. The confirmation flow lives in
 *      `ipc/ai.ts`; this module only classifies.
 *
 * The denylist is intentionally tight — false positives that block legit work
 * are worse than false negatives that prompt for confirmation, because the
 * confirmation gate is the real safety net.
 */

import { isForbiddenPath } from './secret-scanner'
import { dangerousCommandReasons, detectDangerousCommand } from './dangerous-commands'

export interface CommandClassification {
  /** Pass to user-confirmation UI. */
  allowed: boolean
  /** Reason shown to user / model if blocked. */
  reason?: string
}

/**
 * Normalize a command before checking — collapses whitespace runs so patterns
 * that match `\s+` don't trip on multi-space obfuscation.
 */
function normalize(s: string): string {
  return s.replace(/[\t ]+/g, ' ').trim()
}

/** Деобфусцированная копия для матчинга денилиста: убирает кавычки, backticks
 *  и caret (cmd ^), которыми прячут опасные токены: c'a't, c"a"t, c`a`t, ca^t.
 *  Для ДЕТЕКЦИИ (не для исполнения) — на исполнение команды это не влияет. */
/**
 * Человекочитаемый список того, что денилист команд блокирует НАВСЕГДА
 * (даже с подтверждением пользователя). Используется Policy Center для показа
 * правил «опасных команд» — единый источник истины, без дублирования паттернов.
 */
export function dangerousCommandLabels(): string[] {
  return dangerousCommandReasons()
}

export function classifyCommand(command: string): CommandClassification {
  const trimmed = normalize(command)
  if (!trimmed) return { allowed: false, reason: 'Пустая команда' }
  const hit = detectDangerousCommand(command)
  if (hit.hit && hit.severity === 'block') return { allowed: false, reason: hit.reason ?? `Запрещено: ${hit.pattern ?? 'опасная команда'}` }
  return { allowed: true }
}

/**
 * Whitelist проверочных команд для роли verifier (Фаза 1 мультиагентности).
 *
 * verifier-субагент может запускать ТОЛЬКО неразрушающие проверки: тесты,
 * type-check, линт. Любая другая команда (установка пакетов, git-операции,
 * запуск произвольных скриптов) для него запрещена — он верифицирует, а не
 * меняет состояние. executor таким лимитом не ограничен (у него полный
 * denylist-гейт classifyCommand).
 *
 * Совпадение по «команда содержит проверочный токен» — намеренно мягкое:
 * `npm run type`, `npx tsc --noEmit`, `npm test -- --run`, `pnpm vitest` и т.п.
 * все проходят. Префиксы окружения (`cross-env X=1 vitest`) тоже.
 */
const VERIFIER_ALLOW_PATTERNS: RegExp[] = [
  /\b(vitest|jest|mocha|pytest|ava)\b/i,
  /\bnpm\s+(run\s+)?test\b/i,
  /\b(yarn|pnpm)\s+(run\s+)?test\b/i,
  /\bnpm\s+run\s+(type|typecheck|lint)\b/i,
  /\b(yarn|pnpm)\s+(run\s+)?(type|typecheck|lint)\b/i,
  /\btsc\b/i,
  /\beslint\b/i,
  /\bruff\b/i,
  /\bmypy\b/i
]

export function isVerifierCommand(command: string): boolean {
  const trimmed = normalize(command)
  if (!trimmed) return false
  // Сначала общий denylist — разрушающее запрещено даже если совпало с allow.
  if (!classifyCommand(trimmed).allowed) return false
  return VERIFIER_ALLOW_PATTERNS.some(p => p.test(trimmed))
}

/**
 * Allowlist read-only команд для инъекции !`cmd` в slash-командах (F4/F5 ревью HIGH).
 * Этот путь (commands:expand) НЕ проходит mode-policy/confirm-модалку — только денилист,
 * который default-allow и пропускает exfiltration/reverse-shell. Поэтому для инъекции
 * в ПРОМПТ разрешаем лишь заведомо безопасные диагностические команды (git read-ops,
 * листинг, чтение в пределах проекта). Всё прочее !`cmd` остаётся текстовым маркером.
 * Защита от вредоносного {project}/.verstak/commands/*.md недоверенного репо.
 */
const INJECTION_ALLOW_PATTERNS: RegExp[] = [
  /^git\s+(diff|status|log|show|branch|rev-parse|describe|remote|tag|shortlog|blame|ls-files|config\s+--get)\b/i,
  /^(ls|dir|pwd|cd)\b/i,
  /^(cat|type|head|tail|wc|nl)\b/i,
  /^(echo|printf)\b/i,
  /^(grep|rg|findstr|find)\b/i,
  /^(date|whoami|hostname|node\s+--version|npm\s+--version|python\s+--version)\b/i,
]

// find разрешён для листинга, но GNU find деструктивен: -delete/-exec/-fprintf пишут/
// удаляют/исполняют. Блокируем эти примитивы (ре-ревью HIGH: find . -delete обходил).
const DESTRUCTIVE_FIND_RE = /(?:^|\s)-(?:delete|exec|execdir|ok|okdir|fprintf?|fls|fprint0)\b/i
// Абсолютный / восходящий / drive-letter путь в аргументах — read-диагностика в
// пределах проекта в них не нуждается, а cat /etc/passwd / cat ../../.env = эксфильтрация
// секретов вне проекта (ре-ревью HIGH). Срабатывает на токене после пробела/начала.
const OUT_OF_PROJECT_PATH_RE = /(?:^|\s)(?:[/~]|\.\.[/\\]|[A-Za-z]:[/\\])/

/** Безопасна ли команда для инъекции !`cmd` (read-only allowlist + общий денилист)? */
export function isInjectionCommandAllowed(command: string): boolean {
  const trimmed = normalize(command)
  if (!trimmed) return false
  // Цепочки/подстановки/обёртки — НЕ для инъекции (могут спрятать опасное за read-команду).
  if (/[;&|`<>\n]|\$\(|\bsudo\b|\bbash\s+-c\b|\bsh\s+-c\b/i.test(trimmed)) return false
  // Деструктивный find и пути вне проекта — закрыты до allowlist-матча.
  if (/^find\b/i.test(trimmed) && DESTRUCTIVE_FIND_RE.test(trimmed)) return false
  if (OUT_OF_PROJECT_PATH_RE.test(trimmed)) return false
  // Аргумент-путь к секрету в пределах проекта (ре-ревью HIGH: `cat .env` / `cat creds.json`
  // обходили OUT_OF_PROJECT_PATH_RE как относительный путь без /~/..). Гейт isForbiddenPath
  // как у write_file — .env/.ssh/*.key/id_ed25519 нельзя читать даже read-командой в инъекции.
  for (const tok of trimmed.split(/\s+/).slice(1)) {
    if (tok.startsWith('-')) continue
    if (isForbiddenPath(tok.replace(/^["']|["']$/g, ''))) return false
  }
  if (!classifyCommand(trimmed).allowed) return false
  return INJECTION_ALLOW_PATTERNS.some(p => p.test(trimmed))
}
