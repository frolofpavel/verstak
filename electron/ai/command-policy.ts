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

export interface CommandClassification {
  /** Pass to user-confirmation UI. */
  allowed: boolean
  /** Reason shown to user / model if blocked. */
  reason?: string
}

interface DenyRule {
  pattern: RegExp
  reason: string
}

const DENY_RULES: DenyRule[] = [
  // rm catch-all: any rm invocation with -r AND -f flags (combined or split) targeting root/home/parent
  { pattern: /\brm\b(?=[^\n]*\b-[a-z]*r[a-z]*\b|[^\n]*-r\b)(?=[^\n]*-[a-z]*f|[^\n]*-f\b)[^\n]*\s+(\/|~|\$HOME|\.\.)/i, reason: 'Запрещено: rm -r -f за пределами проекта или на корень' },
  // Also block plain rm -rf on root regardless of flag order (legacy/simpler)
  { pattern: /\brm\s+(-[a-z]*r[a-z]*f?|-rf|-fr|-r\s+-f|-f\s+-r)\s+(\/|~|\$HOME|\.\.)/i, reason: 'Запрещено: rm -rf за пределами проекта или на корень' },
  { pattern: /\b(format|mkfs|fdisk|diskpart)\b/i,                       reason: 'Запрещено: операции над дисками / файловой системой' },
  { pattern: /\bdd\s+if=.*of=\/dev\b/i,                                  reason: 'Запрещено: запись на сырой блочный девайс через dd' },
  { pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,           reason: 'Запрещено: fork-bomb' },
  { pattern: /\bshutdown\b|\breboot\b|\bhalt\b|\bpoweroff\b/i,           reason: 'Запрещено: выключение / перезагрузка системы' },
  { pattern: /\bcurl\b[^|]*\|\s*(sh|bash|zsh|powershell|pwsh|cmd)\b/i,   reason: 'Запрещено: pipe curl-вывода в shell (классический RCE-вектор)' },
  { pattern: /\b(wget|iwr|invoke-webrequest)\b[^|]*\|\s*(sh|bash|iex|powershell|pwsh|cmd)\b/i, reason: 'Запрещено: pipe сетевого ответа в shell' },
  { pattern: /\bbase64\b[\s\S]*?(?:-d|--decode)[\s\S]*?\|\s*(?:sh|bash|zsh|powershell|pwsh|cmd|iex)\b/i, reason: 'Запрещено: декодирование base64 в shell (обфускация RCE)' },
  { pattern: /\bsudo\s+rm\b/i,                                           reason: 'Запрещено: sudo rm' },
  { pattern: /\bgit\s+push\s+.*--force\b/i,                              reason: 'Запрещено: git push --force (фиксить вручную при необходимости)' },
  { pattern: /\bgit\s+(reset\s+--hard\s+HEAD~|clean\s+-fdx|filter-(repo|branch))/i, reason: 'Запрещено: разрушающие git операции' },
  // find -exec/-execdir rm -rf {} — массовое удаление: цель внутри find ({}), поэтому
  // правила rm-rf выше (требуют путь /|~|..) её НЕ ловят (ревью: обход денилиста).
  { pattern: /\bfind\b[\s\S]*-exec(?:dir)?\b[\s\S]*\brm\b[\s\S]*-[a-z]*r[a-z]*f|\bfind\b[\s\S]*-exec(?:dir)?\b[\s\S]*\brm\b[\s\S]*-rf/i, reason: 'Запрещено: массовое удаление через find -exec rm -rf' },
  { pattern: /\.ssh|\.ss\*|\bid_(?:rsa|ed25519|ecdsa|dsa)\b|\bid_[a-z0-9]*\*|\.aws[\/\\]|\.kube[\/\\]|\.docker[\/\\]|\.azure[\/\\]|\.config[\/\\]gcloud|kubeconfig|\.npmrc|\.netrc|\.gnupg|authorized_keys|known_hosts/i, reason: 'Запрещено: чтение/копирование ключей и токенов' },
  // PowerShell EncodedCommand bypass: payload is base64, denylist can't inspect contents.
  // Аудит M13: штатный бинарь PowerShell 7 на Win11 называется pwsh — без него обход.
  { pattern: /\b(?:powershell|pwsh)(\.exe)?\b[^\n]*\s-[eE](?:nc(?:oded(?:command)?)?)?\b/i, reason: 'Запрещено: powershell/pwsh -EncodedCommand (запутанная команда)' },
  // cmd /c with variable expansion is a common obfuscation pattern
  { pattern: /\bcmd(\.exe)?\s+\/[cC]\b[^\n]*(%[^%\s]+%|![\w]+!)/i,        reason: 'Запрещено: cmd /c с переменными расширения — попытка обфускации' },
  // Invoke-Expression (PowerShell eval) is RCE-by-design
  { pattern: /\b(iex|invoke-expression)\b/i,                              reason: 'Запрещено: PowerShell Invoke-Expression / iex' }
]

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
function deobfuscate(s: string): string {
  return s.replace(/[`'"^]/g, '')
}

/**
 * Человекочитаемый список того, что денилист команд блокирует НАВСЕГДА
 * (даже с подтверждением пользователя). Используется Policy Center для показа
 * правил «опасных команд» — единый источник истины, без дублирования паттернов.
 */
export function dangerousCommandLabels(): string[] {
  // Уникализируем reason'ы (некоторые правила делят формулировку), сохраняя порядок.
  const seen = new Set<string>()
  const out: string[] = []
  for (const rule of DENY_RULES) {
    if (!seen.has(rule.reason)) {
      seen.add(rule.reason)
      out.push(rule.reason)
    }
  }
  return out
}

export function classifyCommand(command: string): CommandClassification {
  const trimmed = normalize(command)
  if (!trimmed) return { allowed: false, reason: 'Пустая команда' }
  const candidates = [trimmed, normalize(deobfuscate(command))]
  for (const rule of DENY_RULES) {
    if (candidates.some(c => rule.pattern.test(c))) {
      return { allowed: false, reason: rule.reason }
    }
  }
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
  if (!classifyCommand(trimmed).allowed) return false
  return INJECTION_ALLOW_PATTERNS.some(p => p.test(trimmed))
}
