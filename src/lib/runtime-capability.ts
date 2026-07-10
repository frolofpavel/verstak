// Runtime-capability — честный уровень контроля Verstak над прогоном.
//
// Раньше UI считал «контроль» ТОЛЬКО из transport (API vs CLI) — все CLI под
// одну гребёнку «урезанный». После проекции родного tool-таймлайна (срезы 1-2)
// это перестало быть правдой: claude-cli / codex-cli теперь ПОКАЗЫВАЮТ, что
// делает агент (tool_use / command_execution / file_change проецируются в
// Timeline), тогда как grok-cli / gemini-cli — нет. Но даже у наблюдаемых CLI
// само ИСПОЛНЕНИЕ инструментов, проверка (DoD), откат и crash-resume идут
// ВНУТРИ бинаря и не под контролем Verstak. Считаем capability из
// provider+transport, а не из одного transport, и не приукрашиваем.

export type RuntimeTransport = 'API' | 'CLI'

export type RuntimeTier = 'full' | 'observed' | 'limited'

export interface RuntimeCapability {
  /** Verstak ВИДИТ, что делает агент (tool-таймлайн в Timeline). */
  toolVisibility: boolean
  /** Verstak сам ВЫПОЛНЯЕТ и гейтит инструменты (mode-policy, подтверждения, path-policy). */
  toolExecution: boolean
  /** Проверка выполнения (DoD / run-until-green) под контролем Verstak. */
  verify: boolean
  /** Откат правок сессии (per-file undo / checkpoint). */
  undo: boolean
  /** Возобновление после краха посреди сессии. */
  crashResume: boolean
  /** Короткий уровень контроля для ярлыка. */
  tier: RuntimeTier
}

// CLI-провайдеры, где проекция tool-таймлайна РЕАЛЬНО реализована и проверена
// тестами (срез 1 — claude-cli, срез 2 — codex-cli). Набор намеренно узкий:
// не добавлять сюда провайдер, пока проекция не подтверждена на потоке.
export const CLI_WITH_TIMELINE: ReadonlySet<string> = new Set(['claude-cli', 'codex-cli'])

export function runtimeCapability(providerId: string, transport: RuntimeTransport): RuntimeCapability {
  if (transport === 'API') {
    // API-путь: инструменты выполняет и гейтит сам Verstak → полный контроль.
    return {
      toolVisibility: true,
      toolExecution: true,
      verify: true,
      undo: true,
      crashResume: true,
      tier: 'full',
    }
  }

  // CLI-путь: бинарь выполняет инструменты сам. Единственная ось, которая
  // может быть true — видимость (если проекция реализована для этого провайдера).
  const observed = CLI_WITH_TIMELINE.has(providerId)
  return {
    toolVisibility: observed,
    toolExecution: false,
    verify: false,
    undo: false,
    crashResume: false,
    tier: observed ? 'observed' : 'limited',
  }
}

// ─── Защита секретов (1.9.6 #2): честный ярлык по CLI ────────────────────────
// Зеркало electron/ai/cli-security-capabilities.ts secretProtectionLevel
// (renderer и main не делят модуль). Держать синхронно — тест
// cli-security-capabilities.test.ts сверяет уровни по каждому провайдеру.
export type SecretProtectionLevel = 'full' | 'partial' | 'none'

const CLI_SECRET_LEVEL: Record<string, SecretProtectionLevel> = {
  'claude-cli': 'partial', // путь-чтение закрыто, Bash-обход открыт, не подтверждён живьём
  'codex-cli': 'none',     // sandbox только записи, чтение .env разрешено
  'grok-cli': 'none',
  'gemini-cli': 'none',
}

export function secretProtectionLevel(providerId: string): SecretProtectionLevel {
  return CLI_SECRET_LEVEL[providerId] ?? 'none'
}

// Тон бейджа по уровню (подписи — в i18n secretProtection.*).
export const SECRET_PROTECTION_UI: Record<SecretProtectionLevel, { tone: 'ok' | 'warn' | 'danger' }> = {
  full: { tone: 'ok' },
  partial: { tone: 'warn' },
  none: { tone: 'danger' },
}
