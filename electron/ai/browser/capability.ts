// capability.ts — task-level Capability Envelope (план §5.3 инвариант 13).
//
// «До первого observe BrowserTask получает task-level capability allowlist из
// исходной команды Павла/скилла. Контент страницы не может добавить
// run_command, connector/send, file write, другой домен или канал
// эксфильтрации. В первых пилотах browser run физически не получает cross-tool
// mutations, которые не нужны сценарию.»
//
// Здесь:
//   • buildCapabilityFromCommand — строит envelope из исходной команды Павла
//     (или скилла). Берётся «явно разрешённый минимум», не «всё что возможно».
//   • isActionAllowedByCaps — проверяет, разрешает ли envelope действие.
//   • isCrossToolForbidden — protection от page-driven exfiltration: страница
//     не может вызвать run_command/connector_query/file write из browser run.
//
// В B0 capability по умолчанию очень узкая: observe + navigate + scroll +
// screenshot (R0/R1). R2+ (type/click/etc) — только если команда Павла явно их
// потребовала (например, «зайди в отчёт и примени фильтр»).

import type {
  BrowserActionType,
  CapabilityEnvelope,
} from './types'

/**
 * Кросс-тулы, которые browser run НЕ может получить из своего контекста, какие
 * бы инструкции ни были на странице (план §5.3 инвариант 13 + §10.5
 * «page-derived injection не вызывает run_command, file write, connector/send
 * или эксфильтрацию через другой tool»).
 */
export const FORBIDDEN_CROSS_TOOLS: readonly string[] = [
  'run_command',
  'execute_code',
  'write_file', 'apply_patch', 'edit_file', 'create_file', 'edit_spreadsheet',
  'delegate_task', 'delegate_parallel', 'delegate_orchestrate', 'delegate_swarm',
  'connector_query', 'connector_send',
  'spawn_process', 'stop_process',
  'memory_save',                  // страница не может заставить сохранить память
  'new_task',
] as const

/**
 * Безопасный envelope по умолчанию для B0: только observe + базовая навигация.
 * Никаких click/type/select — они добавляются явно через allowActionType когда
 * задача их требует.
 */
export function defaultCapability(): CapabilityEnvelope {
  return {
    allowedActionTypes: ['observe', 'list_task_tabs', 'switch_tab', 'attach_tab', 'detach_tab',
                         'navigate', 'back', 'forward', 'reload', 'scroll', 'screenshot', 'wait_for',
                         'focus'],
    allowedDomains: [],
    forbiddenActionTypes: [],
    forbiddenCrossTools: [...FORBIDDEN_CROSS_TOOLS],
  }
}

/**
 * B0 webview seed: 4 wired tools (observe/navigate/click/screenshot) + R0 extras.
 * click остаётся R3 → one-shot approval. allowedDomains пустой до auto-pin origin.
 */
export function webviewB0Capability(allowedDomains: string[] = []): CapabilityEnvelope {
  const caps = defaultCapability()
  if (!caps.allowedActionTypes.includes('click')) caps.allowedActionTypes.push('click')
  if (allowedDomains.length > 0) caps.allowedDomains = [...allowedDomains]
  return caps
}

/** Восстановить CapabilityEnvelope из persisted JSON (browser_tasks.caps_json). */
export function parseCapabilityEnvelope(raw: Record<string, unknown> | null | undefined): CapabilityEnvelope | null {
  if (!raw || typeof raw !== 'object') return null
  if (!Array.isArray(raw.allowedActionTypes)) return null
  return {
    allowedActionTypes: raw.allowedActionTypes.filter((t): t is BrowserActionType => typeof t === 'string') as BrowserActionType[],
    allowedDomains: Array.isArray(raw.allowedDomains) ? raw.allowedDomains.map(String) : [],
    forbiddenActionTypes: Array.isArray(raw.forbiddenActionTypes)
      ? raw.forbiddenActionTypes.filter((t): t is BrowserActionType => typeof t === 'string') as BrowserActionType[]
      : [],
    forbiddenCrossTools: Array.isArray(raw.forbiddenCrossTools)
      ? raw.forbiddenCrossTools.map(String)
      : [...FORBIDDEN_CROSS_TOOLS],
  }
}

/**
 * Строит envelope под задачу. В B0 — простая эвристика по «глаголам» в команде.
 * Полноценный NLP-парсер команды — отдельная задача (Phase D site policies),
 * здесь достаточно правила «явно разрешить click/type только если задача их
 * упоминает».
 *
 * Примеры:
 *   «прочитай отчёт Calltouch» → только observe/navigate (R0/R1).
 *   «зайди в отчёт и поставь фильтр» → + click/select_option (R1/R2).
 *   «отправь кампанию в Telegram Ads» → + click/type_text + R3 approval.
 */
export function buildCapabilityFromCommand(input: {
  command?: string | null
  allowedDomains?: string[]
  extraAllowedActionTypes?: BrowserActionType[]
  extraForbiddenActionTypes?: BrowserActionType[]
}): CapabilityEnvelope {
  const caps = defaultCapability()
  if (input.allowedDomains && input.allowedDomains.length > 0) {
    caps.allowedDomains = [...input.allowedDomains]
  }
  if (input.extraAllowedActionTypes) {
    for (const t of input.extraAllowedActionTypes) {
      if (!caps.allowedActionTypes.includes(t)) caps.allowedActionTypes.push(t)
    }
  }
  if (input.extraForbiddenActionTypes) {
    caps.forbiddenActionTypes = [...input.extraForbiddenActionTypes]
  }
  const cmd = (input.command ?? '').toLowerCase()
  // Эвристика: если команда явно говорит «кликни/нажми/выбери» — добавляем.
  // ВНИМАНИЕ: \b word boundary НЕ работает с кириллицей в JS regex — используем
  // явные подстроки / [^a-zа-яё] обрамления для латиницы.
  const hasWord = (words: string[]): boolean => {
    for (const w of words) {
      // Латиница: используем \b для корректной границы слова.
      if (/^[a-z]+$/i.test(w)) {
        if (new RegExp(`\\b${w}\\b`, 'i').test(cmd)) return true
      } else {
        // Кириллица / смешанные — простая подстрока (нижний регистр).
        if (cmd.includes(w)) return true
      }
    }
    return false
  }
  if (hasWord(['кликни', 'нажми', 'click', 'select', 'выбери', 'поставь фильтр'])) {
    if (!caps.allowedActionTypes.includes('click')) caps.allowedActionTypes.push('click')
    if (!caps.allowedActionTypes.includes('select_option')) caps.allowedActionTypes.push('select_option')
  }
  if (hasWord(['введи', 'заполни', 'type', 'fill', 'insert'])) {
    if (!caps.allowedActionTypes.includes('type_text')) caps.allowedActionTypes.push('type_text')
    if (!caps.allowedActionTypes.includes('clear_field')) caps.allowedActionTypes.push('clear_field')
  }
  if (hasWord(['отправь', 'submit', 'send', 'save', 'publish', 'запусти кампанию'])) {
    // submit-like — разрешаем click + type, но controller всё равно гейтит R3.
    if (!caps.allowedActionTypes.includes('click')) caps.allowedActionTypes.push('click')
    if (!caps.allowedActionTypes.includes('type_text')) caps.allowedActionTypes.push('type_text')
    if (!caps.allowedActionTypes.includes('press_key')) caps.allowedActionTypes.push('press_key')
  }
  return caps
}

/**
 * Проверяет, разрешает ли envelope данный actionType. Запрещённые имеют приоритет
 * над разрешённые (fail-closed).
 */
export function isActionAllowedByCaps(caps: CapabilityEnvelope, actionType: BrowserActionType): boolean {
  if (caps.forbiddenActionTypes.includes(actionType)) return false
  return caps.allowedActionTypes.includes(actionType)
}

/**
 * Проверяет, разрешён ли домен в envelope. В B0 envelope.allowedDomains может
 * быть пустым (= «все домены разрешены для observe» — controller отдельно гейтит
 * origin drift). Если список не пуст — fail-closed: только перечисленные.
 */
export function isDomainAllowedByCaps(caps: CapabilityEnvelope, origin: string | null | undefined): boolean {
  if (!origin) return false
  if (caps.allowedDomains.length === 0) return true // открытый allowlist
  const norm = normalizeDomain(origin)
  for (const d of caps.allowedDomains) {
    const nd = normalizeDomain(d)
    if (!nd) continue
    if (norm === nd || norm.endsWith('.' + nd) || nd.endsWith('.' + norm)) return true
  }
  return false
}

/** host or origin → comparable host (no scheme/path). */
function normalizeDomain(raw: string): string {
  const s = String(raw || '').trim().toLowerCase()
  if (!s) return ''
  try {
    if (/^https?:\/\//i.test(s)) return new URL(s).host
  } catch { /* fallthrough */ }
  return s.replace(/^https?:\/\//, '').replace(/\/$/, '')
}

/**
 * Проверяет, запрещён ли cross-tool (для защиты от page-derived injection,
 * пытающегося вызвать run_command/file write/connector_send из browser context).
 */
export function isCrossToolForbidden(caps: CapabilityEnvelope, toolName: string): boolean {
  return caps.forbiddenCrossTools.includes(toolName)
}

/**
 * Список всех action types, явно запрещённых в R4 (BR-012, план §5.1).
 * Controller использует это как absolute gate поверх risk-classifier: если
 * payload содержит R4-маркер, action не проходит даже если actionType разрешён
 * caps'ами.
 */
export const R4_ALWAYS_FORBIDDEN_PAYLOAD_KEYS: readonly string[] = [
  'password', 'secret', 'token', 'otp', 'totp', 'captcha', 'cvv', 'cardnumber',
  'payment', 'credentials', 'apikey', // lowercase — classifier .toLowerCase() ключ
] as const
