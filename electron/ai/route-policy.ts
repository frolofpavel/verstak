// Route Policy — детерминированный движок решений о маршруте прогона (срез 2.0.8-D-core).
//
// DoD: один и тот же input state ВСЕГДА даёт одно route decision (чистая функция, без
// сети/времени/рандома/общего мутируемого стейта → два параллельных чата не влияют друг
// на друга). Оркестрирует уже существующие детекторы (classifyFallbackReason,
// detectSubscriptionLimit) в единое решение по 8 инвариантам карточки 2.0.8-D.
//
// Транзиентные сетевые/429 ретраи с backoff делает with-retry ДО error-ветки runner'а,
// поэтому здесь НЕТ retry-same: движок выбирает среди stop / refresh-auth / rotate-account /
// model-fallback. Enforcement pinned-аккаунта (инвариант 1, часть) — срез D2 (нужен main.ts);
// движок принимает `pinned` как вход и уже сейчас его чтит, но проводка подаёт false до D2.

import type { CooldownScope, CooldownReason } from '../../shared/contracts/subscription'

export type { CooldownScope, CooldownReason }

/** Политика маршрута прогона. strict/allow — из PromptRouteOverride (2.0.7-F); chat-default — обычный прогон. */
export type RoutePolicy = 'strict' | 'allow' | 'chat-default'

/** Классифицированная причина сбоя хода. Разные коды → разные cooldown-политики (инвариант 5). */
export type RouteReason =
  | 'auth'                 // 401/403 — ключ/токен отклонён → refresh/login, НЕ cooldown
  | 'quota'                // usage/plan limit исчерпан → cooldown(account) + ротация
  | 'rate-limit'           // 429 too-many-requests (транзиент) → cooldown(account, короткий) + ротация
  | 'provider-unavailable' // 5xx/overloaded → cooldown(provider) + model-fallback
  | 'network'             // сеть/таймаут (после with-retry) → model-fallback БЕЗ бана аккаунта
  | 'model-not-found'      // модель не существует → cooldown(model) + model-fallback
  | 'context-overflow'     // маршрутизация не спасёт (компакция выше) → stop
  | 'none'                 // не ошибка / не классифицировано → stop

/** Один маршрут = провайдер + модель + конкретный аккаунт. accountId=null — дефолтный аккаунт. */
export interface RouteAttempt {
  providerId: string
  model: string
  accountId: number | null
}

/** Ключ попытки (инвариант 7): повтор запрещён. */
export function attemptKey(a: RouteAttempt): string {
  return `${a.providerId}:${a.model}:${a.accountId ?? '-'}`
}

/**
 * 2.0.8-D2: разрешение аккаунта для чата по per-chat binding (2.0.8-B). Инвариант карточки B:
 * pinned-аккаунт удалён → binding становится UNAVAILABLE и требует решения пользователя, БЕЗ
 * тихой ротации на глобально-активный. Чистая функция (тестируется отдельно от storage).
 *   auto        — режим auto / нет binding / accountId пуст → брать глобально-активный.
 *   pinned      — pinned на СУЩЕСТВУЮЩИЙ аккаунт → использовать его.
 *   unavailable — pinned на удалённый/несуществующий аккаунт → НЕ ротировать молча, спросить юзера.
 */
export type ChatAccountResolution =
  | { status: 'auto' }
  | { status: 'pinned'; accountId: number }
  | { status: 'unavailable'; accountId: number }

export function resolveChatAccount(
  binding: { mode: 'auto' | 'pinned'; accountId: number | null } | null,
  accountExists: (id: number) => boolean,
): ChatAccountResolution {
  if (!binding || binding.mode !== 'pinned' || binding.accountId == null) return { status: 'auto' }
  // pinned: аккаунт жив → используем; удалён → unavailable (НЕ падаем молча на глобально-активный).
  return accountExists(binding.accountId)
    ? { status: 'pinned', accountId: binding.accountId }
    : { status: 'unavailable', accountId: binding.accountId }
}

/**
 * D2: итоговое решение, КАКОЙ аккаунт брать для прогона чата (чистая функция поверх
 * resolveChatAccount + сверка провайдера). `lookupProvider(id)` → providerId аккаунта либо null
 * (удалён). Развязывает main.ts от DB — тестируется отдельно.
 *   unavailable — pin на удалённый аккаунт → стоп-с-вопросом (карточка B);
 *   pinned      — pin на живой аккаунт ЭТОГО провайдера → его id;
 *   auto        — нет pin / pin на аккаунт ДРУГОГО провайдера (нерелевантен) → глобально-активный.
 */
export function pickChatAccountId(
  providerId: string,
  binding: { mode: 'auto' | 'pinned'; accountId: number | null } | null,
  lookupProvider: (id: number) => string | null,
): { kind: 'unavailable' } | { kind: 'pinned'; accountId: number } | { kind: 'auto' } {
  const res = resolveChatAccount(binding, id => lookupProvider(id) != null)
  if (res.status === 'unavailable') return { kind: 'unavailable' }
  if (res.status === 'pinned') {
    return lookupProvider(res.accountId) === providerId
      ? { kind: 'pinned', accountId: res.accountId }
      : { kind: 'auto' } // pin для другого провайдера — нерелевантен этому прогону
  }
  return { kind: 'auto' }
}

/** Человекочитаемый текст смены маршрута для UI-пилюли (единый для обоих runner'ов). */
export function routeChangedText(
  action: 'rotate-account' | 'model-fallback' | 'refresh-auth',
  requested: { providerId: string },
  actual: { providerId: string; model: string },
): string {
  switch (action) {
    case 'rotate-account': return `⚡ Лимит аккаунта — переключился на другой аккаунт (${requested.providerId})`
    case 'model-fallback': return `⚡ ${requested.providerId} недоступен, переключаюсь на ${actual.providerId}`
    case 'refresh-auth': return `↻ Обновляю авторизацию (${requested.providerId})`
  }
}

/** Что делать с текущим маршрутом. */
export type RouteAction =
  | 'stop'           // прекратить: маршрут исчерпан / политика запрещает смену / loop guard
  | 'refresh-auth'   // обновить токен/логин на ТОМ ЖЕ аккаунте (не смена маршрута)
  | 'rotate-account' // сменить аккаунт того же провайдера/модели (пул подписок)
  | 'model-fallback' // сменить провайдера/модель (настроенная цепочка)

export interface RouteCooldown {
  scope: CooldownScope    // account | model | provider — глушим ТОЛЬКО нужную область (инвариант 6)
  reason: CooldownReason
}

export interface RouteDecisionInput {
  policy: RoutePolicy
  /** Аккаунт закреплён за чатом (инвариант 1). Проводка подаёт false до среза D2. */
  pinned: boolean
  current: RouteAttempt
  reason: RouteReason
  /** Уже попробованные ключи providerId:model:accountId (инвариант 7, без повторов). */
  triedKeys: readonly string[]
  /** Готовые (не cooling) аккаунты того же провайдера/модели — кандидаты ротации, по порядку. */
  readyAccounts: readonly RouteAttempt[]
  /** Настроенные fallback провайдер/модель кандидаты, по порядку приоритета. */
  modelFallbacks: readonly RouteAttempt[]
  /** Общий потолок попыток (loop guard). Единый источник — согласован с runner-shared. */
  maxAttempts: number
}

export interface RouteDecision {
  action: RouteAction
  /** Следующий маршрут (для rotate/model-fallback/refresh-auth) либо null (stop). */
  next: RouteAttempt | null
  reason: RouteReason
  /** Номер попытки = triedKeys.length + 1 (инвариант 8: пишется в route-changed). */
  attemptNumber: number
  /** Какую область охладить (null — не охлаждать: auth/network/none). */
  cooldown: RouteCooldown | null
  /** allow-политика меняет маршрут только с видимым предупреждением (инвариант 2). */
  visibleWarning: boolean
}

/** Классифицирует ошибку/статус в RouteReason (чистая логика). Расширяет classifyFallbackReason
 *  разделением quota vs rate-limit vs provider-unavailable vs model-not-found (инвариант 5).
 *  Порядок проверок важен: auth → context → model-not-found → quota → rate-limit → network →
 *  provider-unavailable. quota выигрывает у 429 (usage-limit — не транзиент, ротация не поможет). */
export function classifyRouteReason(error: unknown): RouteReason {
  // Ошибка приходит как Error, строка ИЛИ объект-событие провайдера ({type:'error', message}).
  // Читаем .message и из plain-объекта, иначе status победил бы текст (429 vs usage-limit).
  const rawMsg = error instanceof Error ? error.message
    : (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string')
      ? (error as { message: string }).message
      : String(error ?? '')
  const msg = rawMsg.toLowerCase()
  const rawStatus = (error && typeof error === 'object') ? (error as { status?: unknown }).status : null
  // Эффективный HTTP-статус: структурное поле ЛИБО распарсенный из текста в статус-контексте.
  // НЕ любое 3-значное число (ревью #2: «retry after 401 seconds» — длительность, не статус).
  const status = typeof rawStatus === 'number' ? rawStatus : parseHttpStatus(msg)

  if (/context[_ ]?length|maximum context|context_length_exceeded|too many tokens|prompt is too long/.test(msg)) {
    return 'context-overflow'
  }
  // model-not-found ТОЧНО (ревью): требуем контекст «model», иначе «does not exist» ловит
  // ошибки файлов, «invalid model» — не про отсутствие.
  if (/model[_ ]?not[_ ]?found|model_not_found|no such model|unknown model|model[^.]{0,24}(?:not found|does not exist)/.test(msg)) {
    return 'model-not-found'
  }
  // quota ДО auth/rate-limit (ревью): usage/plan limit — исчерпание; некоторые провайдеры
  // отдают его как 403/429, поэтому текст важнее статуса именно здесь.
  if (/usage limit|plan limit|limit reached for your plan|5.?hour limit|hour limit reached|\bquota\b/.test(msg)) {
    return 'quota'
  }
  // auth: только структурный статус ИЛИ словесные признаки (без голых чисел — ревью #2).
  if (status === 401 || status === 403 ||
      /unauthorized|authentication|invalid[_ ]?api[_ ]?key|permission denied|forbidden/.test(msg)) {
    return 'auth'
  }
  if (status === 429 || /rate[_ ]?limit|too[_ ]?many[_ ]?requests/.test(msg)) {
    return 'rate-limit'
  }
  if (/econnreset|etimedout|econnrefused|time[\s_-]?out|timed[\s_-]?out|timeout|\bnetwork\b|fetch failed|socket hang up/.test(msg)) {
    return 'network'
  }
  // 5xx ЦЕЛИКОМ (ревью #1: 504/505/508/529 терялись) + текстовые признаки перегрузки/шлюза.
  if ((typeof status === 'number' && status >= 500 && status < 600) ||
      /overloaded|capacity|service unavailable|temporarily unavailable|bad gateway|gateway time.?out|\bunavailable\b/.test(msg)) {
    return 'provider-unavailable'
  }
  return 'none'
}

/** Извлекает HTTP-статус из текста ТОЛЬКО в статус-контексте (http/status/code/error/начало),
 *  а не любое 3-значное число — иначе длительности вроде «401 seconds» ловились бы как статус. */
function parseHttpStatus(msg: string): number | null {
  const m = msg.match(/(?:^|\bhttp\b[\s/]*|\bstatus\b(?:\s*code)?[\s:=]*|\bcode\b[\s:=]*|\berror\b[\s:]*)(\d{3})\b/)
  return m ? parseInt(m[1], 10) : null
}

/** Детерминированное решение о маршруте по 8 инвариантам карточки. Чистая функция. */
export function decideRoute(input: RouteDecisionInput): RouteDecision {
  const { policy, pinned, current, reason, triedKeys, readyAccounts, modelFallbacks, maxAttempts } = input
  const attemptNumber = triedKeys.length + 1
  const locked = policy === 'strict' || pinned // инвариант 1: без авто-смены провайдера/аккаунта
  const warn = policy === 'allow'               // инвариант 2

  const stop = (): RouteDecision =>
    ({ action: 'stop', next: null, reason, attemptNumber, cooldown: null, visibleWarning: false })

  // Loop guard (инвариант 7): общий потолок попыток — единственный источник ограничения.
  if (triedKeys.length >= maxAttempts) return stop()

  // Ничего решать не нужно / маршрутизация не спасёт.
  if (reason === 'none' || reason === 'context-overflow') return stop()

  // auth (инвариант 4): обновить токен на ТОМ ЖЕ аккаунте — это НЕ смена маршрута, поэтому
  // разрешено и при locked. Без cooldown (аккаунт не виноват), без предупреждения.
  if (reason === 'auth') {
    return { action: 'refresh-auth', next: current, reason, attemptNumber, cooldown: null, visibleWarning: false }
  }

  // Дальше — смены маршрута. При locked (strict/pinned) запрещены → stop (инвариант 1).
  if (locked) return stop()

  const notTried = (a: RouteAttempt): boolean => !triedKeys.includes(attemptKey(a))
  const nextAccount = readyAccounts.find(notTried) ?? null
  const nextModel = modelFallbacks.find(notTried) ?? null

  const cooldownReasonFor = (r: RouteReason): CooldownReason => {
    switch (r) {
      case 'quota': return 'quota'
      case 'rate-limit': return 'rate-limit'
      case 'provider-unavailable': return 'provider-unavailable'
      case 'auth':
      case 'network':
      case 'model-not-found':
      case 'context-overflow':
      case 'none':
        return 'unknown'
    }
  }

  // quota / rate-limit: сначала ротация готового аккаунта того же провайдера/модели
  // (инвариант 3), пул исчерпан → model-fallback. cooldown на аккаунт (инвариант 6).
  if (reason === 'quota' || reason === 'rate-limit') {
    const cooldown: RouteCooldown = { scope: 'account', reason: cooldownReasonFor(reason) }
    if (nextAccount) {
      return { action: 'rotate-account', next: nextAccount, reason, attemptNumber, cooldown, visibleWarning: warn }
    }
    if (nextModel) {
      return { action: 'model-fallback', next: nextModel, reason, attemptNumber, cooldown, visibleWarning: warn }
    }
    return stop()
  }

  // provider-unavailable: провайдер лёг → сразу другой провайдер, cooldown на провайдера (инвариант 6).
  if (reason === 'provider-unavailable') {
    if (nextModel) {
      return { action: 'model-fallback', next: nextModel, reason, attemptNumber, cooldown: { scope: 'provider', reason: 'provider-unavailable' }, visibleWarning: warn }
    }
    return stop()
  }

  // model-not-found: модель не существует → другой провайдер/модель, cooldown на модель (инвариант 6).
  if (reason === 'model-not-found') {
    if (nextModel) {
      return { action: 'model-fallback', next: nextModel, reason, attemptNumber, cooldown: { scope: 'model', reason: 'unknown' }, visibleWarning: warn }
    }
    return stop()
  }

  // network (после with-retry): текущий провайдер недоступен → другой провайдер БЕЗ бана
  // аккаунта (инвариант 5 — cooldown null). Пул провайдеров исчерпан → stop.
  if (reason === 'network') {
    if (nextModel) {
      return { action: 'model-fallback', next: nextModel, reason, attemptNumber, cooldown: null, visibleWarning: warn }
    }
    return stop()
  }

  return stop()
}
