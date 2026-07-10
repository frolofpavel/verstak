// Честная матрица защиты секретов по CLI-провайдерам (1.9.6 #2).
//
// Нельзя рисовать всем CLI одинаковую защиту. Аудит показал: guard чтения
// секретов реализован ТОЛЬКО для claude-cli (--disallowedTools Read/Edit/Write
// по секрет-глобам). codex опирается на sandbox ЗАПИСИ (чтение .env внутри
// проекта разрешено во всех режимах), grok/gemini не получают вообще никаких
// deny-флагов. Эта матрица — единый источник правды о том, что каждый CLI
// РЕАЛЬНО защищает, чтобы UI не обещал больше, чем есть.
//
// Уровень считается по ЧТЕНИЮ секретов (эксфильтрация — главная угроза): sandbox
// записи codex не мешает `cat .env`, поэтому для секретов у него уровень none,
// а write-sandbox честно вынесен в fallbackControl отдельной осью.

export type SecretProtectionLevel = 'full' | 'partial' | 'none'

export interface CliSecurityCapability {
  /** Флагами CLI запрещено ЧТЕНИЕ секрет-путей (.env/.ssh/creds). */
  pathDenyRead: boolean
  /** Флагами CLI ограничена ЗАПИСЬ (sandbox/deny) — отдельная ось от чтения. */
  pathDenyWrite: boolean
  /** Режется ли чтение секрета через shell (`cat .env`) — inherent-дыра CLI. */
  bashSecretReadDeny: boolean
  /** Режется ли сетевая эксфильтрация секрета. */
  networkExfiltrationDeny: boolean
  /** Подтверждено ли ЖИВЫМ smoke-прогоном (не только приёмом флагов парсером). */
  confirmedByLiveSmoke: boolean
  /** Чем прикрыто остаточное (для честной ноты UI). */
  fallbackControl: string
}

// Источник правды. Держать синхронно с фактическим поведением *-cli.ts:
// claude-cli.ts claudeGuardArgs (--disallowedTools) / codex-cli.ts sandboxArgsForMode.
// Renderer-зеркало уровня — src/lib/runtime-capability.ts secretProtectionLevel.
const MATRIX: Record<string, CliSecurityCapability> = {
  'claude-cli': {
    pathDenyRead: true,
    pathDenyWrite: true,
    bashSecretReadDeny: false,        // Bash не в deny-списке → cat .env обходит (задача #3)
    networkExfiltrationDeny: false,
    confirmedByLiveSmoke: false,      // до задачи #6 (живой OAuth-smoke)
    fallbackControl: 'Control Envelope (git-якорь) откатывает записи; чтение через shell не режется',
  },
  'codex-cli': {
    pathDenyRead: false,              // sandbox управляет ЗАПИСЬЮ; чтение .env разрешено
    pathDenyWrite: true,
    bashSecretReadDeny: false,
    networkExfiltrationDeny: false,
    confirmedByLiveSmoke: false,
    fallbackControl: 'sandbox записи (read-only/workspace-write) + Control Envelope; чтение секретов не режется',
  },
  'grok-cli': {
    pathDenyRead: false,
    pathDenyWrite: false,
    bashSecretReadDeny: false,
    networkExfiltrationDeny: false,
    confirmedByLiveSmoke: false,
    fallbackControl: 'только Control Envelope (git-якорь); permission/deny-флаги grok не подтверждены',
  },
  'gemini-cli': {
    pathDenyRead: false,
    pathDenyWrite: false,
    bashSecretReadDeny: false,
    networkExfiltrationDeny: false,
    confirmedByLiveSmoke: false,
    fallbackControl: 'только Control Envelope (git-якорь); config-dir/deny у gemini не поддержаны апстримом',
  },
}

export function cliSecurityCapability(providerId: string): CliSecurityCapability | null {
  return MATRIX[providerId] ?? null
}

/**
 * Уровень защиты СЕКРЕТОВ (по чтению): full только когда путь-чтение закрыто И
 * shell-чтение закрыто И подтверждено живым smoke; partial — закрыт хотя бы
 * путь-чтение (claude); none — чтение секретов CLI не режет (codex/grok/gemini).
 */
export function secretProtectionLevel(providerId: string): SecretProtectionLevel {
  const c = MATRIX[providerId]
  if (!c) return 'none'
  if (c.pathDenyRead && c.bashSecretReadDeny && c.confirmedByLiveSmoke) return 'full'
  if (c.pathDenyRead) return 'partial'
  return 'none'
}
