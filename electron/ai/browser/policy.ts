// policy.ts — детерминированный R0-R4 chokepoint для browser actions (BR-012).
//
// ВАЖНО (план §5.1): «Риск определяется эффектом, а не названием tool. `click`
// не считается безопасным сам по себе: кнопка может сохранить, отправить, сменить
// tenant или запустить кампанию. Неизвестный эффект классифицируется fail-closed
// как R3. R1/R2 разрешаются только общим детерминированным правилом или
// проверенным site policy; решение модели не понижает risk level.»
//
// Поэтому classifyRisk() смотрит на actionType + payload + scope, а НЕ доверяет
// модели. В B0 есть только базовая классификация по actionType + явным маркерам
// в payload (submit=true, budget=…, secretField=true). Site policy для
// конкретных кабинетов (Calltouch/Telegram Ads) — фаза C/D, здесь её НЕТ.

import type {
  BrowserAction,
  BrowserActionType,
  BrowserMode,
  PolicyDecision,
  RiskLevel,
} from './types'

// ── Базовая классификация по actionType ──────────────────────────────────────
// Источник решения — что тип действия «делает физически», а не его название.
// unknown click/type = R3 (план §5.1, §12 «Не считаем generic click/type
// обратимым: неизвестный эффект = R3»).

const OBSERVE_ACTIONS: ReadonlySet<BrowserActionType> = new Set([
  'observe', 'list_task_tabs', 'screenshot',
])

const NAVIGATION_ACTIONS: ReadonlySet<BrowserActionType> = new Set([
  'attach_tab', 'detach_tab', 'switch_tab',
  'navigate', 'back', 'forward', 'reload', 'scroll',
])

const UI_INTERACT_ACTIONS: ReadonlySet<BrowserActionType> = new Set([
  'click', 'focus',
])

const INPUT_ACTIONS: ReadonlySet<BrowserActionType> = new Set([
  'type_text', 'clear_field', 'select_option', 'toggle', 'press_key',
])

const WAIT_ACTIONS: ReadonlySet<BrowserActionType> = new Set(['wait_for'])

// ── Forbidden markers in payload (BR-012, R4) ────────────────────────────────
// Поля, которые делают действие R4 независимо от actionType.

const R4_FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  'password', 'secret', 'token', 'otp', 'totp', 'captcha', 'cvv', 'cardnumber',
  'payment', 'credentials', 'apikey', // все lowercase; проверка через .toLowerCase() ключа
])

const R3_MUTATION_HINTS: ReadonlySet<string> = new Set([
  // submit / save / send / publish — внешние мутации (план §5.1 R3)
  'submit', 'save', 'send', 'publish', 'delete', 'remove',
  // ad-platform мутации
  'budget', 'bid', 'campaign', 'launch', 'pause', 'activate',
])

export interface ClassifyContext {
  /** Опционально: known R1 policy по site (например, локальный фильтр на
   *  calltouch.com). В B0 — пустой, всегда undefined → все navigation трактуются
   *  как R1 безопасно (не R0), generic click/type остаются R3. */
  provenReversibleOrigins?: ReadonlySet<string>
}

/**
 * Классифицирует риск действия. Возвращает R0-R4.
 *
 * Правила (детерминированные, не от модели):
 *   1. Если payload содержит R4-маркер (password/payment/secret/...) в ключе
 *      ИЛИ в строковом значении (рекурсивно по вложенным объектам/массивам) → R4.
 *   2. Если actionType в OBSERVE_ACTIONS → R0.
 *   3. Если actionType в NAVIGATION_ACTIONS → R1 (внутренние tab/load/scroll
 *      в разрешённом домене; переход на новый origin гейтится отдельной
 *      проверкой в controller — но само действие R1, не R3, потому что не
 *      меняет состояние сайта).
 *   4. Если actionType в UI_INTERACT (click, focus):
 *      - если payload.provenReversible=true И origin в provenReversibleOrigins
 *        → R1;
 *      - иначе R3 (generic click с неизвестным эффектом = R3 по контракту).
 *   5. Если actionType в INPUT_ACTIONS (type_text/select/toggle/press_key):
 *      - если R3-маркер (submit/save/Enter/autosaving form) → R3;
 *      - если provenReversible=true И trusted site policy (origin в provenReversibleOrigins
 *        И payload.trustedNoAutosubmit=true) → R2 (доказано, что autosave/submit нет);
 *      - иначе R3 (FAIL-CLOSED: R2 возможен только при доказанном trusted site policy).
 *   6. wait_for → R0 (просто ожидание, не меняет состояние).
 *   7. Любой неизвестный actionType → R3 (fail-closed, BR-012).
 *
 * Это детерминированный chokepoint. Site policies (Calltouch и т.п.) расширяют
 * provenReversibleOrigins — в B0/R1 список пустой, поэтому type/select/toggle
 * ВСЕГДА R3 без явного site policy (что и требует R1).
 */
export function classifyRisk(action: {
  actionType: BrowserActionType
  payload?: Record<string, unknown>
  scope?: { origin?: string | null }
}, ctx?: ClassifyContext): RiskLevel {
  const payload = action.payload ?? {}

  // 1. R4 markers — проверяем ключи И строковые значения рекурсивно.
  if (hasForbiddenMarker(payload)) return 'R4'

  // 2. observe / list_tabs / screenshot → R0
  if (OBSERVE_ACTIONS.has(action.actionType)) return 'R0'

  // 6. wait_for → R0
  if (WAIT_ACTIONS.has(action.actionType)) return 'R0'

  // 3. navigation → R1 (если переход на новый origin, controller его отдельно
  //    гейтит; само действие R1).
  if (NAVIGATION_ACTIONS.has(action.actionType)) return 'R1'

  // 4. UI interact (click, focus)
  if (UI_INTERACT_ACTIONS.has(action.actionType)) {
    // R3 markers в payload → R3 (submit/save/etc кнопки)
    if (hasMutationHint(payload)) return 'R3'
    // proven reversible по site policy → R1
    if (payload.provenReversible === true) {
      const origin = action.scope?.origin ?? null
      if (origin && (ctx?.provenReversibleOrigins?.has(origin) ?? false)) {
        return 'R1'
      }
    }
    // generic click с неизвестным эффектом = R3 (BR-012, план §12)
    return 'R3'
  }

  // 5. input actions (type/select/toggle/press_key)
  if (INPUT_ACTIONS.has(action.actionType)) {
    // R3 marker → R3 (включая Enter-key в форме = потенциальный submit)
    if (hasMutationHint(payload)) return 'R3'
    if (payload.intoAutosavingForm === true) return 'R3'
    // press_key с Enter без явного контекста — потенциальный submit → R3.
    if (action.actionType === 'press_key' && isEnterLikeKey(payload)) return 'R3'
    // R2 возможен ТОЛЬКО при доказанном trusted site policy (origin в allowlist
    // И явный флаг trustedNoAutosubmit от site policy). Без site policy — R3.
    if (payload.provenReversible === true && payload.trustedNoAutosubmit === true) {
      const origin = action.scope?.origin ?? null
      if (origin && (ctx?.provenReversibleOrigins?.has(origin) ?? false)) {
        return 'R2'
      }
    }
    // FAIL-CLOSED: без доказанного site policy → R3 (R1 контракт).
    return 'R3'
  }

  // 7. На всякий случай: неизвестный actionType — fail-closed R3.
  return 'R3'
}

/** press_key с Enter/Return — потенциальный submit формы, R3 по умолчанию. */
function isEnterLikeKey(payload: Record<string, unknown>): boolean {
  const k = payload.key ?? payload.code ?? payload.keyCode
  if (typeof k !== 'string') return false
  const lower = k.toLowerCase()
  return lower === 'enter' || lower === 'return' || lower === 'numpadenter'
}

/**
 * Рекурсивная проверка payload на R4-маркеры. Возвращает true если:
 *   • ЛЮБОЙ ключ (на любом уровне вложенности) содержит forbidden-маркер
 *     (password, secret, token, otp, captcha, cvv, payment, apiKey, ...).
 *   • ЛЮБОЕ строковое значение (на любом уровне) содержит высоко-энтропийный
 *     секретный паттерн (PEM-блок, AKIA..., sk-..., ghp_..., Bearer <token>).
 *
 * Case-insensitive по всей цепочке. Не использует модель — только детерминированные
 * regex'ы, заимствованные из secret-scanner.ts.
 */
function hasForbiddenMarker(payload: Record<string, unknown>): boolean {
  return scanForR4(payload, /* depth */ 0)
}

const R4_MAX_DEPTH = 8 // защита от зловредной бесконечной вложенности

function scanForR4(value: unknown, depth: number): boolean {
  if (depth > R4_MAX_DEPTH) return true // fail-closed: слишком глубоко — R4
  if (value == null) return false
  if (typeof value === 'string') {
    return scanStringValueForR4(value)
  }
  if (Array.isArray(value)) {
    for (const v of value) {
      if (scanForR4(v, depth + 1)) return true
    }
    return false
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    for (const key of Object.keys(obj)) {
      const lowerKey = key.toLowerCase()
      // Точное совпадение ключа с forbidden-маркером.
      if (R4_FORBIDDEN_KEYS.has(lowerKey)) return true
      // Суффиксное/включающее совпадение ключа (userPassword, apiKey, otpCode).
      for (const f of R4_FORBIDDEN_KEYS) {
        if (lowerKey !== f && lowerKey.length > f.length && lowerKey.includes(f)) return true
      }
      // Рекурсивно в значение.
      if (scanForR4(obj[key], depth + 1)) return true
    }
    return false
  }
  // number/boolean/symbol/etc — не строка, пропускаем.
  return false
}

/**
 * Проверяет строковое значение на presence секретных паттернов. Не покрывает
 * 100% секретов (это работа secret-scanner.ts для observation text), но ловит
 * наиболее опасные формы в payload action'а.
 */
const R4_VALUE_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z]+ PRIVATE KEY-----/i, // PEM private key
  /\bAKIA[0-9A-Z]{16}\b/,                // AWS access key
  /\bghp_[A-Za-z0-9]{36,}\b/,            // GitHub PAT
  /\bsk-ant-[A-Za-z0-9-_]{20,}\b/,       // Anthropic
  /\bsk-[A-Za-z0-9]{20,}\b/,             // OpenAI
  /\bgho_[A-Za-z0-9]{36,}\b/,            // GitHub OAuth
  /\bglpat-[A-Za-z0-9_-]{20,}\b/,        // GitLab PAT
  /\bxox[baprs]-[A-Za-z0-9-]+\b/,        // Slack
  /\bAIza[0-9A-Za-z_-]{35}\b/,           // Google API
  /\bbearer\s+[A-Za-z0-9._-]{16,}\b/i,   // Bearer token
  /\bcaptcha\b/i,                        // CAPTCHA reference
  /\bCVV\b|\bcvc\b/i,                    // Card Verification Code
  /\b\d{13,19}\b/,                       // PAN (card number range)
]

function scanStringValueForR4(s: string): boolean {
  if (!s) return false
  for (const re of R4_VALUE_PATTERNS) {
    if (re.test(s)) return true
  }
  return false
}

function hasMutationHint(payload: Record<string, unknown>): boolean {
  for (const key of Object.keys(payload)) {
    const lower = key.toLowerCase()
    if (R3_MUTATION_HINTS.has(lower)) return true
    // значение — строка, совпадающая с одним из маркеров (например, action='submit')
    const v = payload[key]
    if (typeof v === 'string' && R3_MUTATION_HINTS.has(v.toLowerCase())) return true
  }
  // Явный флаг payload.isMutation (если site policy его ставит)
  if (payload.isMutation === true) return true
  // Enter-like key без явного контекста — потенциальный submit.
  if (isEnterLikeKey(payload)) return true
  return false
}

// ── Mode gating (план §5.2) ──────────────────────────────────────────────────
//
// «Режим `plan` основного агента блокирует R2/R3. До реализации классификатора
// нельзя переиспользовать нынешний `browser_click` как безопасный write path.»
//
// «`auto` и `bypass` не отменяют R3/R4. Для внешнего мира важнее blast radius,
// чем режим файлового агента.» (§5.1)

/**
 * Решает, допускает ли режим уровень риска. Это НЕ решает «выполнять ли без
 * подтверждения» — это отдельная функция decideApproval. Здесь только запрет.
 */
export function modeAllows(mode: BrowserMode, risk: RiskLevel): boolean {
  switch (mode) {
    case 'watch':
      // Смотреть: только R0–R1. Никаких изменений.
      return risk === 'R0' || risk === 'R1'
    case 'prepare':
      // Подготовить: R0–R2. Заполнить и показать, но не отправлять.
      return risk === 'R0' || risk === 'R1' || risk === 'R2'
    case 'execute':
      // Выполнить: R0–R3 (R3 через one-shot approval). R4 всегда запрещён.
      return risk !== 'R4'
  }
}

/**
 * Решает, нужно ли одобрение для действия в режиме. R4 нельзя выполнить ни при
 * каком режиме — это block. R3 в execute требует approval.
 */
export function decideApproval(mode: BrowserMode, risk: RiskLevel): PolicyDecision {
  // R4 — абсолютно запрещён, всегда.
  if (risk === 'R4') {
    return {
      kind: 'block',
      reason: 'R4 forbidden: пароль/2FA/CAPTCHA/платёж/создание аккаунта/выдача auth/необратимое удаление/обход антибота.verstak не выполняет это автоматически ни в каком режиме.',
    }
  }
  // Сначала modeAllows — если режим не пускает риск, блокируем.
  if (!modeAllows(mode, risk)) {
    return {
      kind: 'block',
      reason: `Действие риска ${risk} не разрешено в режиме Browser Employee "${mode}". Переключите режим (Смотреть/Подготовить/Выполнить) или откажитесь от действия.`,
    }
  }
  // R0 — авто (observe не требует подтверждения).
  if (risk === 'R0') {
    return { kind: 'auto', reason: 'R0 observe — безопасное чтение страницы.' }
  }
  // R1 — авто, если режим позволяет (доказуемо обратимое действие).
  if (risk === 'R1') {
    return { kind: 'auto', reason: 'R1 proven reversible UI — выполняется автоматически с обязательным readback.' }
  }
  // R2 — авто в режиме «Подготовить» и выше (заполнить черновик без submit).
  if (risk === 'R2') {
    return { kind: 'auto', reason: 'R2 prepare — заполнение черновика без autosave/submit. Подготовленное состояние будет показано.' }
  }
  // R3 — одноразовое approval (даже в auto/bypass).
  if (risk === 'R3') {
    return { kind: 'require-approval', reason: 'R3 external/unknown mutation — требуется одноразовое локальное подтверждение с before/after Proof.' }
  }
  // На всякий случай — fail-closed.
  return { kind: 'block', reason: `Неизвестный риск ${risk}; действие заблокировано fail-closed.` }
}

/**
 * Готовое решение по действию: классифицирует риск и применяет mode-gate +
 * approval-decision в одном вызове. Это единый chokepoint для controller'а.
 */
export function decideAction(
  action: {
    actionType: BrowserActionType
    payload?: Record<string, unknown>
    scope?: { origin?: string | null }
  },
  mode: BrowserMode,
  ctx?: ClassifyContext
): { risk: RiskLevel; decision: PolicyDecision } {
  const risk = classifyRisk(action, ctx)
  const decision = decideApproval(mode, risk)
  return { risk, decision }
}

// ── Mutation classifier (для crash-resume guard — план §9 B0 п.6) ────────────
//
// Расширяет isMutatingTool из agent-runs.ts: browser action с risk≥R1 — мутация
// в смысле crash-resume (auto-resume запрещён). R0 observe мутацией НЕ является.
//
// Это используется в electron/storage/agent-runs.ts (после правки) чтобы
// pickResumeGuardTool / isAutoResumable правильно гейтнули browser mutations.

/**
 * Возвращает true, если действие считается мутацией в смысле crash-resume guard.
 * Используется для «browser_*» tool names которые пойдут через BrowserController.
 */
export function isBrowserMutationByRisk(risk: RiskLevel): boolean {
  return risk !== 'R0'
}

/**
 * Для интеграции с pickResumeGuardTool: по имени tool'а определяем, является ли
 * он browser-action мутацией. В B0 browser tool names: browser_navigate (R1),
 * browser_click (R3), browser_type_text (R2/R3), browser_screenshot (R0), etc.
 *
 * Это грубая эвристика по имени — точная классификация идёт в classifyRisk.
 * Здесь мы консервативны: считаем мутацией всё, что НЕ screenshot/read/observe.
 */
const BROWSER_OBSERVE_TOOLS: ReadonlySet<string> = new Set([
  'browser_screenshot', 'browser_read_page', 'browser_observe',
])

export function isBrowserMutationToolName(name: string | null | undefined): boolean {
  if (!name) return false
  if (!name.startsWith('browser_')) return false
  return !BROWSER_OBSERVE_TOOLS.has(name)
}

/**
 * Полный список «мутационных» browser tool names для добавления в
 * agent-runs.MUTATING_TOOLS (см. tests/ai/browser/crash-resume.test.ts).
 */
export const BROWSER_MUTATION_TOOL_NAMES: readonly string[] = [
  'browser_navigate',     // R1 (navigation)
  'browser_click',        // R3 по умолчанию (unknown click)
  'browser_type_text',    // R2/R3
  'browser_clear_field',  // R2
  'browser_select_option',// R2
  'browser_toggle',       // R2
  'browser_press_key',    // R2/R3 (Enter в форме может submit)
  'browser_back',
  'browser_forward',
  'browser_reload',
  'browser_scroll',
  'browser_focus',
  'browser_wait_for',     // R0, но оставляем в списке для простоты crash-resume
                          // (wait_for не меняет состояние; но controller его
                          //  пускает по тому же dispatch path, поэтому «safe»
                          //  классификатору проще держать его вне mutate-сета —
                          //  см. BROWSER_OBSERVE_TOOLS выше, который НЕ включает
                          //  wait_for. Здесь — для полноты реестра.)
] as const

// Удобный реестр «не мутаций» (для классификатора agent-runs).
export const BROWSER_NON_MUTATION_TOOL_NAMES: readonly string[] = [
  'browser_screenshot', 'browser_read_page', 'browser_observe',
] as const

// ── Helpers для интеграции с mode-policy.ts ──────────────────────────────────
//
// В electron/ai/mode-policy.ts решается «edits vs commands». browser_* не входит
// ни в одну из категорий (это не edits, не commands). Но из-за того что
// browser_* гейтится ОТДЕЛЬНЫМ browserRiskAllows (этот файл), мы не трогаем
// decide() в mode-policy.ts — controller вызывает decideAction() сверху.

/** Зеркалит mode-policy.ts interface для удобства интеграции. */
export type AgentMode = 'ask' | 'accept-edits' | 'plan' | 'auto' | 'bypass'

/**
 * Гейт plan-режима основного агента: в `plan` блокируются ВСЕ browser mutations
 * (R1+), наблюдать (R0) можно. Это отдельная проверка ПОВЕРХ browserMode —
 * agent_mode='plan' строгий даже если browserMode='execute'.
 */
export function agentModeBlocksBrowserMutation(agentMode: AgentMode, risk: RiskLevel): boolean {
  if (risk === 'R0') return false
  if (agentMode === 'plan') return true
  return false
}

/**
 * auto/bypass НЕ повышают R3/R4: даже в auto/bypass R3 требует approval, R4
 * блокируется. См. decideApproval — там это уже учтено; эта функция для внешней
 * интеграции с mode-policy (на случай, если кто-то попытается «авто-aprove»).
 */
export function autoBypassDoesNotSkipR3R4(_agentMode: AgentMode, risk: RiskLevel): boolean {
  // R3 в auto/bypass всё равно требует approval; R4 блокируется.
  return risk === 'R3' || risk === 'R4'
}
