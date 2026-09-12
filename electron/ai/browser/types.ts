// types.ts — фиксированный контракт Browser Employee (EXT-B0).
//
// Источник истины по терминам: docs/BROWSER_EMPLOYEE_PLAN.md §4, §5.
// В этом файле — только декларации, без логики. Логика классификации — в policy.ts,
// approval — в approval.ts, наблюдение/маскировка — в untrusted.ts.
//
// ВАЖНО: НИКАКИХ raw cookie/token/session в этих типах. Observation.text уже
// должен быть пропущен через scanText (см. untrusted.ts). BrowserProofRef хранит
// только redacted_summary + путь к артефакту на диске (bounded retention), а не
// сам скриншот в base64.

// ── Режимы Browser Employee (BR-?; план §5.2) ────────────────────────────────

export type BrowserMode = 'watch' | 'prepare' | 'execute'

// ── Risk levels (план §5.1) ──────────────────────────────────────────────────

export type RiskLevel = 'R0' | 'R1' | 'R2' | 'R3' | 'R4'

/**
 * R0 Observe — читать, inspect, поиск, screenshot, scroll. Автоматически в
 *   прикреплённых вкладках и разрешённых доменах.
 * R1 Proven reversible UI — открыть раздел/вкладку, изменить локальный фильтр по
 *   site policy. Автоматически в утверждённом плане; обязательный readback.
 * R2 Prepare — заполнить доказуемый черновик без autosave/submit. Только в режиме
 *   «Подготовить» и выше.
 * R3 External/unknown mutation — submit/save/send/publish, generic click/type с
 *   неясным эффектом, изменение кампании/ставки/бюджета, upload. Одноразовое
 *   локальное подтверждение + before/after Proof.
 * R4 Forbidden — пароль/2FA/CAPTCHA, платёж, создание аккаунта, выдача auth,
 *   необратимое удаление, обход антибота. Verstak НЕ выполняет; задача блокируется.
 */
export const RISK_LEVELS: readonly RiskLevel[] = ['R0', 'R1', 'R2', 'R3', 'R4'] as const

// ── Идентификаторы ───────────────────────────────────────────────────────────

/** Stable durable id одного браузерного поручения. Переживает Pause/Resume,
 *  restart, смену модели (BR-015). Не привязан к конкретному run_id модели. */
export type BrowserTaskId = string

/** Id одного запуска модели (из agent_runs.run_id). Один ai:send = один run. */
export type RunId = string

/** Id одного предложенного browser action (BR-013). Стабилен на всё время жизни
 *  действия; одноразовый — повторное действие получает новый action_id. */
export type ActionId = string

/** Snapshot-local reference на элемент страницы (план §4.3). После navigation
 *  или DOM change старые refs недействительны; controller сверяет observationVersion. */
export type ElementRef = string

/** Stable id одного наблюдения страницы. Действителен для одного observationVersion. */
export type ObservationId = string

// ── Scope — то, что идентифицирует «где» выполняется действие (план §4.4) ────

export interface BrowserActionScope {
  browserTaskId: BrowserTaskId
  runId: RunId
  clientId?: string | null
  /** tab + document refs из наблюдения (план §4.3). */
  tabRef?: string | null
  documentId?: string | null
  url?: string | null
  origin?: string | null
  /** Кabinet fingerprint (когда определяется надёжно). */
  tenant?: string | null
  account?: string | null
  /** Версия наблюдения, из которого взят elementRef. После navigation невалиден. */
  observationId?: string | null
  /** number | null — null = «нет observation context» (например, navigate без
   *  предварительного observe). JSON-serializable; canonicalJson даёт идентичный
   *  digest до/после storage round-trip (undefined → key пропускается, рассинхрон). */
  observationVersion?: number | null
  elementRef?: ElementRef | null
}

// ── Observation (план §4.3) — снимок страницы под одним scope ────────────────

export interface Observation {
  observationId: ObservationId
  observationVersion: number
  browserTaskId: BrowserTaskId
  runId: RunId
  capturedAt: number
  source: {
    kind: 'electron-webview' | 'chrome-extension'
    tabRef?: string | null
    documentId?: string | null
    url: string
    title: string
    origin: string
  }
  tenant?: string | null
  account?: string | null
  /** Видимый текст страницы — УЖЕ отсканирован (scanText). */
  text: string
  /** Видимые таблицы — УЖЕ отсканированы. */
  tables: Array<{ caption: string; rows: string[][] }>
  /** Interactive map: кнопки/ссылки/инпуты/select/checkbox с role+label+state,
   *  БЕЗ password/secret values. */
  controls?: Array<{
    elementRef: ElementRef
    role: string
    label: string
    state?: string
    observationVersion: number
  }>
  /** viewport screenshot data URL — только когда нужен; может содержать sensitive
   *  pixels, маскируется ДО отправки модели. null если не снят или заблокирован. */
  screenshotDataUrl?: string | null
  omissions: string[]
  truncated: { text: boolean; selection: boolean; tables: boolean }
}

// ── Browser Action (план §4.4) ───────────────────────────────────────────────

export type BrowserActionType =
  // навигация
  | 'attach_tab' | 'detach_tab' | 'list_task_tabs' | 'switch_tab'
  | 'observe'
  | 'navigate' | 'back' | 'forward' | 'reload'
  // взаимодействие
  | 'scroll' | 'click' | 'focus'
  | 'type_text' | 'clear_field' | 'select_option' | 'toggle' | 'press_key'
  | 'wait_for'
  | 'screenshot'
  // будущие (B1+): download_file, upload_file, open_tab, close_tab — НЕ в B0.

export interface BrowserAction {
  actionId: ActionId
  browserTaskId: BrowserTaskId
  runId: RunId
  attempt: number
  actionType: BrowserActionType
  scope: BrowserActionScope
  /** Точные параметры действия (url для navigate, text для type_text и т.д.). */
  payload: Record<string, unknown>
  /** Что должно быть true ПЕРЕД действием (origin, observationVersion, tenant...). */
  preconditions: BrowserActionPreconditions
  /** Ожидаемый postcondition — controller сверяет его в verify step. */
  expectedPostcondition?: BrowserPostcondition | null
  /** Риск определяется эффектом (BR-012), не названием tool. см. policy.ts. */
  risk: RiskLevel
  /** Короткий TTL действия (ms). После TTL action считается uncertain. */
  ttlMs: number
}

export interface BrowserActionPreconditions {
  expectedOrigin?: string | null
  expectedObservationId?: ObservationId | null
  expectedObservationVersion?: number | null
  expectedTenant?: string | null
  expectedAccount?: string | null
  expectedUrlPattern?: string | null
}

export interface BrowserPostcondition {
  /** Простойmatch: подстрока в URL после действия. */
  urlContains?: string | null
  /** Текст, который должен появиться/исчезнуть. */
  textAppears?: string | null
  textDisappears?: string | null
  /** Произвольный predicate (применяется в verify; не сереализуется в digest
   *  дословно — только его JSON-представление, чтобы быть детерминированным). */
  customCheckId?: string | null
}

// ── ActionResult (план §4.4) ─────────────────────────────────────────────────

export type ActionResultStatus =
  | 'verified'   // readback подтвердил postcondition
  | 'uncertain'  // неизвестно (crash, timeout, ambiguous UI response)
  | 'failed'     // выполнено, но postcondition не достигнут или явная ошибка
  | 'blocked'    // STOP policy/circuit-breaker (403/429/CAPTCHA/logout/origin drift)

export interface ActionResult {
  actionId: ActionId
  status: ActionResultStatus
  /** Final URL и observation после readback. observation=null если не удалось
   *  перечитать страницу. */
  finalUrl?: string | null
  postObservation?: Observation | null
  /** Short human-readable detail для UI и лога. */
  detail: string
  /** Момент завершения (ms epoch). */
  finalizedAt: number
  /** Optional: причина блокировки/uncertain (circuit-breaker code и т.п.). */
  reason?: string | null
}

// ── Approval (BR-017) — строгий scoped transport ─────────────────────────────

/** Стабильный sha256-digest ВСЕХ неизменяемых полей действия. Любое несовпадение
 *  в scope/payload/preconditions/postconditions даёт другой digest → approval
 *  становится недействительным. */
export interface BrowserApprovalDigest {
  actionId: ActionId
  digest: string
  /** snapshot всех полей, вошедших в digest — для UI и аудита. */
  snapshot: {
    browserTaskId: BrowserTaskId
    runId: RunId
    clientId?: string | null
    scope: BrowserActionScope
    actionType: BrowserActionType
    payload: Record<string, unknown>
    preconditions: BrowserActionPreconditions
    expectedPostcondition?: BrowserPostcondition | null
    risk: RiskLevel
  }
}

// ── Capability Envelope (план §5.3 инвариант 13) ────────────────────────────

/** Task-level allowlist инструментов/доменов. Источник — исходная команда Павла
 *  или скилла, НЕ контент страницы. Страница не может расширить capability. */
export interface CapabilityEnvelope {
  /** Какими tool-type'ами разрешено действовать в этой задаче. */
  allowedActionTypes: BrowserActionType[]
  /** Домены, на которых можно действовать. */
  allowedDomains: string[]
  /** Дополнительно запрещённые tool-type'ы (R4 всегда запрещены автоматически). */
  forbiddenActionTypes: BrowserActionType[]
  /** Внешние mutation-tools, которые browser run НЕ может вызвать из своего
   *  контекста: run_command, connector_query/send, file write, etc. Контент
   *  страницы не может их добавить. */
  forbiddenCrossTools: string[]
}

// ── Client Data Policy (план §6, инвариант 14) ───────────────────────────────

/** Per-client правила: какие провайдеры могут видеть browser context данного
 *  клиента. При provider handoff — если новый провайдер forbidden для клиента,
 *  DOM/screenshot ему НЕ передаются; run блокируется или выбирается другой route. */
export interface ClientDataPolicy {
  clientId?: string | null
  /** 'allow' / 'deny' / 'ask'. По умолчанию 'ask'. */
  providerAllow?: 'allow' | 'deny' | 'ask'
  /** Явный allowlist провайдеров (если providerAllow='allow'). */
  allowedProviders?: string[]
  /** Явный denylist. */
  deniedProviders?: string[]
  /** Классификация данных клиента: sensitive (PII/финансы) → по умолчанию deny. */
  dataClassification?: 'public' | 'internal' | 'sensitive'
  /** Что запрещено передавать любому провайдеру без явного решения. */
  redactScreenshotsByDefault?: boolean
}

// ── BrowserTaskState — durable state одного поручения ────────────────────────

export interface BrowserTaskState {
  browserTaskId: BrowserTaskId
  projectPath: string
  chatId: number | null
  clientId: string | null
  currentRunId: RunId | null
  browserMode: BrowserMode
  observationVersion: number
  observationId: ObservationId | null
  taskTabRef: string | null
  allowedDomains: string[]
  caps: CapabilityEnvelope
  dataPolicy: ClientDataPolicy
  lastResult: ActionResult | null
  runLineage: Array<{
    runId: RunId
    providerId: string | null
    model: string | null
    ord: number
    handoffReason: 'new_send' | 'pause_resume' | 'provider_switch' | 'forced'
    startedAt: number
    endedAt: number | null
  }>
}

// ── Adapter contract (план §4.1.1) ───────────────────────────────────────────

export interface BrowserAdapter {
  readonly id: 'electron-webview' | 'chrome-extension'
  /** Поддерживается ли в текущей среде (например, chrome-extension требует bridge). */
  available(): boolean
  /** Причина недоступности, для честного сообщения модели/пользователю. */
  unavailableReason(): string | null
  /** Снять observation. Не делает risk-classification — только сбор данных. */
  observe(scope: Pick<BrowserActionScope, 'browserTaskId' | 'runId' | 'tabRef'>): Promise<Observation>
  /** Перейти по URL. Возвращает final URL после редиректов. */
  navigate(url: string): Promise<{ finalUrl: string; title: string }>
  /** Browser back/forward/reload. */
  back(): Promise<void>
  forward(): Promise<void>
  reload(): Promise<void>
  /** Кликнуть/фокуснуть элемент по elementRef из свежего observation. */
  click(elementRef: ElementRef): Promise<{ finalUrl: string }>
  focus(elementRef: ElementRef): Promise<void>
  scroll(elementRef: ElementRef | null, delta: { x?: number; y?: number }): Promise<void>
  selectOption?(elementRef: ElementRef, value: string): Promise<void>
  typeText?(elementRef: ElementRef, text: string, opts?: { clearFirst?: boolean; submitEnter?: boolean }): Promise<void>
  clearField?(elementRef: ElementRef): Promise<void>
  toggle?(elementRef: ElementRef): Promise<void>
  pressKey?(elementRef: ElementRef, key: string): Promise<void>
  waitFor?(condition: { elementRef?: ElementRef; text?: string; url?: string; timeoutMs?: number }): Promise<{ ok: boolean; reason?: string }>
  /** Скриншот viewport. Возвращает data URL или null если заблокирован. */
  screenshot(): Promise<string | null>
  /** Универсальный «не знаю этот action» для типов, не реализованных в B0. */
  unsupported(actionType: BrowserActionType): { ok: false; reason: string }
}

// ── Policy Decision (план §5.2) ──────────────────────────────────────────────

export type PolicyDecision =
  | { kind: 'auto'; reason: string }              // выполнить без approval
  | { kind: 'require-approval'; reason: string }  // показать approval, ждать consume
  | { kind: 'block'; reason: string }             // отказать модели, R4/circuit-breaker

// ── Circuit Breaker (план §5.3 инвариант 11) ──────────────────────────────────

export interface CircuitBreakerState {
  /** HTTP status или код ('403' | '429' | 'CAPTCHA' | 'LOGOUT' | 'SECURITY_WARNING'
   *  | 'ORIGIN_DRIFT' | 'TENANT_CHANGE' | 'UNKNOWN'). */
  code: string
  at: number
  url?: string | null
  /** После срабатывания — без retry, без смены модели ради обхода. */
  detail?: string
}
