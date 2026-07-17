// ЕДИНЫЙ КОНТРАКТ ПРОВАЙДЕРОВ — срез 2.0.7-C программы релизов 2.0.7–2.0.10.
//
// Проблема, которую он закрывает: правда о провайдере была размазана по слоям и
// синхронизировалась вручную —
//   · union `ProviderId` в `electron/ai/registry.ts` (main),
//   · ЕЩЁ ОДИН union `ProviderId` в `src/hooks/useProvider.ts` (renderer),
//   · ЕЩЁ ОДИН runtime-allowlist `KNOWN_IDS` там же,
//   · `ProviderDescriptorDTO` в `src/types/api.d.ts`.
// Реальные последствия дрейфа уже случались: `openai-codex-oauth` добавили в union и
// в реестр, но забыли в `KNOWN_IDS` → выбор пользователя МОЛЧА схлопывался в `gemini-api`.
//
// Здесь — единственный источник истины для ID, transport, execution mode, auth и
// capabilities. Модели остаются runtime-данными main-реестра: renderer получает их
// ТОЛЬКО через IPC (`providers:list`), никогда не хардкодит.
//
// Файл намеренно БЕЗ рантайм-зависимостей (ни electron, ни node, ни react): его
// импортируют обе стороны. Provider factories сюда НЕ переносятся.

/**
 * Исчерпывающий список ID. Добавление провайдера в одном слое теперь невозможно:
 * реестр main обязан быть `satisfies Record<ProviderId, …>`, а renderer резолвит
 * сохранённый ID только через `isKnownProviderId`.
 */
export const PROVIDER_IDS = [
  'gemini-api', 'gemini-cli',
  'claude', 'claude-cli',
  'grok', 'grok-cli',
  'openai', 'codex-cli', 'openai-codex-oauth',
  'yandex-gpt', 'gigachat',
  'openrouter', 'deepseek', 'moonshot', 'kimi-coding',
  'qwen', 'mistral', 'groq', 'ollama', 'custom-openai',
  'verstak-gateway', 'zai-coding',
] as const

export type ProviderId = typeof PROVIDER_IDS[number]

/**
 * Режим доставки:
 *  · `API`    — наш собственный agent-loop (ключ или OAuth-подписка);
 *  · `CLI`    — наша обёртка над внешним бинарём (subprocess);
 *  · `Tunnel` — внешний официальный агент ВЛАДЕЕТ циклом, мы супервайзим (Claude Code).
 * Tunnel ≈ CLI по рантайму (оба subprocess), но врать про «прямую интеграцию» нельзя.
 */
export type ProviderTransport = 'API' | 'CLI' | 'Tunnel'

/** Кто фактически крутит agent-loop. UI обязан показывать это честно. */
export type ProviderExecutionMode =
  | 'native-agent-loop'   // цикл наш (API)
  | 'cli-subprocess'      // цикл наш, но исполняет внешний бинарь (CLI)
  | 'external-agent-loop' // цикл НЕ наш (Tunnel)

/**
 * Чем провайдер авторизуется. Секреты и пути к ним в DTO НЕ попадают — только вид.
 * ВАЖНО (ревью 2.0.7-C): 'cli-session' НЕ значит «Verstak не хранит секретов» — для
 * claude-cli мы храним `claude_code_oauth_token` в safeStorage и пробрасываем его в env
 * дочернего процесса. Значит только одно: аутентификацию выполняет сам CLI, а не наш HTTP-слой.
 */
export type ProviderAuthKind =
  | 'api-key'            // ключ в настройках, наш HTTP-слой шлёт его сам
  | 'oauth-subscription' // подписка через OAuth (Codex): токен обновляем мы
  | 'cli-session'        // авторизуется сам CLI (токен ему можем пробрасывать мы)
  | 'none'               // локальный/безключевой (ollama)

/** Откуда взят список моделей. Молчаливая подмена запрещена — источник виден. */
export type ProviderCatalogSource =
  | 'static'          // зашитый список реестра
  | 'live-discovery'  // опрошен у провайдера (Model Doctor, 2.0.7-E)
  | 'user-override'   // задан пользователем (custom endpoint)

/** Что провайдер реально умеет ПОД КОНТРОЛЕМ Verstak (не «вообще умеет»). */
export interface ProviderCapabilities {
  /** Function calling / файловые тулзы исполняет и гейтит наш loop. */
  tools: boolean
  /** Вложения (изображения/файлы) доходят до модели через наш путь. */
  attachments: boolean
  /** Проверка выполнения (DoD / run-until-green) под нашим контролем. */
  verification: boolean
  /**
   * Tick-таймлайн НАШЕГО agent-loop'а (шаги, tool-решения, прогресс хода).
   * НЕ путать с проекцией tool-событий CLI: у claude-cli/codex-cli она есть с 1.9.5
   * (см. src/lib/runtime-capability.ts → CLI_WITH_TIMELINE) — но это информационное
   * зеркало чужого цикла, а не наш таймлайн. Здесь именно наш.
   */
  liveTimeline: boolean
  /** Прогон переживает краш и возобновляется. */
  resumeSafe: boolean
  /** MCP-инструменты доступны через наш loop. */
  mcp: boolean
  /** Мультиагент (delegate/parallel/swarm). */
  delegation: boolean
  /**
   * Пофайловый undo правок, сделанных НАШИМИ file-тулзами ВНУТРИ проекта
   * (write_file/apply_patch по относительному пути → recordWrite → undo-стек).
   * Осознанно узкое обещание — мимо стека идут: правки через `run_command` (форматтер,
   * кодоген), делегированные в CLI-суб-агента, и запись по АБСОЛЮТНОМУ пути вне проекта
   * (file-ops.ts пропускает recordWrite при isExternalWrite). Для всего этого сеть
   * безопасности — git-якорь Control Envelope, а не per-file undo.
   */
  perFileUndo: boolean
  /**
   * Изоляция чата в отдельном worktree реальна: правки агента идут в КОПИЮ проекта, а не
   * в рабочий репозиторий.
   *
   * Держится на том же, что и perFileUndo — на наших file-тулзах: изоляция сделана
   * подменой корня (runRoot) у них. CLI-провайдер ходит своим бинарём с cwd реального
   * проекта и правит настоящий репозиторий — обещать ему изоляцию значит врать в самом
   * дорогом месте: человек уверен, что работает на копии (ре-ревью 2.0.11-B #3).
   *
   * Полноценная изоляция CLI (передать бинарю cwd worktree) — отдельная карточка, не здесь.
   */
  worktreeIsolation: boolean
}

/**
 * То, что main отдаёт renderer через `providers:list`.
 * АДДИТИВЕН: поля существующих потребителей не переименованы и не удалены.
 * Секреты, пути к credential и auth-claim сюда не попадают НИКОГДА (только `secretKey` —
 * это ИМЯ ключа настройки, не его значение).
 */
export interface ProviderDescriptorDTO {
  id: ProviderId
  name: string
  shortLabel: string
  transport: ProviderTransport
  /** Кто крутит loop. Выводится из transport — UI не должен это угадывать. */
  executionMode: ProviderExecutionMode
  /** Вид авторизации (не секрет). */
  authKind: ProviderAuthKind
  /**
   * ИМЯ настройки, по которому лежит секрет (НЕ значение — секреты в DTO не уходят).
   * Гоча: у `openai-codex-oauth` это `codex_oauth_risk_accepted` — флаг согласия с риском,
   * а не креденшл (сам токен живёт в OAuth-файле). Потребители, читающие «ключ задан =
   * провайдер настроен», для него читают согласие. Не выпрямляем это здесь — `authKind`
   * даёт честный ответ на вопрос «чем авторизуется».
   */
  secretKey: string | null
  models: string[]
  defaultModel: string
  supportsTools: boolean
  /** Помечен как экспериментальный — UI обязан предупредить. */
  experimental: boolean
  /** Откуда список моделей. */
  catalogSource: ProviderCatalogSource
  capabilities: ProviderCapabilities
}

// ─── Чистые выводимые функции (одна правда для обеих сторон) ────────────────

/** CLI и Tunnel — оба subprocess: движок вне нашего loop'а. */
export function isSubprocessTransport(t: ProviderTransport): boolean {
  return t === 'CLI' || t === 'Tunnel'
}

/** Execution mode ОДНОЗНАЧНО выводится из transport — второй источник правды не заводим. */
export function executionModeFor(transport: ProviderTransport): ProviderExecutionMode {
  if (transport === 'API') return 'native-agent-loop'
  if (transport === 'CLI') return 'cli-subprocess'
  return 'external-agent-loop'
}

/** Провайдеры, помеченные экспериментальными (UI обязан показать предупреждение). */
export const EXPERIMENTAL_PROVIDER_IDS: readonly ProviderId[] = ['openai-codex-oauth']

/** Вид авторизации выводится из id/transport/secretKey — не хранится третьим списком. */
export function authKindFor(id: ProviderId, transport: ProviderTransport, secretKey: string | null): ProviderAuthKind {
  if (id === 'openai-codex-oauth') return 'oauth-subscription'
  if (isSubprocessTransport(transport)) return 'cli-session'
  return secretKey ? 'api-key' : 'none'
}

/**
 * Матрица возможностей. Единственное место, где она считается — раньше UI и main
 * выводили её порознь и расходились.
 * perFileUndo: наш undo-стек ведёт ТОЛЬКО наш loop; CLI/Tunnel пишут файлы мимо него
 * (поэтому для них — git-якорь Control Envelope, а не per-file undo).
 */
export function capabilitiesFor(transport: ProviderTransport, supportsTools: boolean): ProviderCapabilities {
  const nativeLoop = transport === 'API'
  const full = nativeLoop && supportsTools
  return {
    tools: full,
    attachments: nativeLoop,
    verification: full,
    liveTimeline: full,
    resumeSafe: nativeLoop,
    mcp: full,
    delegation: full,
    // Не `nativeLoop`: undo-стек наполняют file-тулзы, а без supportsTools агент их не
    // вызывает вовсе — обещать откат там, где писать нечем, значит врать (ревью 2.0.7-C).
    perFileUndo: full,
    // По той же причине `full`: изоляция сделана подменой корня у наших file-тулзов.
    // CLI правит реальный репозиторий своим бинарём (ре-ревью 2.0.11-B #3).
    worktreeIsolation: full,
  }
}

// ─── Срез 2.0.7-F: маршрут модели на один prompt ─────────────────────────────

/** Откуда взялся маршрут отправки. Для честного UI/agent-run (requested vs actual). */
export type SelectionSource = 'chat-default' | 'prompt-explicit' | 'automatic'

/**
 * Override маршрута на ОДНУ отправку (не меняет default чата). fallbackPolicy:
 *  · 'strict' — при сбое выбранного провайдера НЕ переезжать молча на другого (дефолт
 *    для explicit-выбора: пользователь выбрал модель осознанно);
 *  · 'allow'  — fallback разрешён, но обязан породить видимое structured route-событие.
 */
export interface PromptRouteOverride {
  providerId: ProviderId
  model: string
  fallbackPolicy: 'strict' | 'allow'
}

export interface ResolvedRoute {
  providerId: ProviderId
  model: string
  source: SelectionSource
  /** Разрешён ли smart-fallback на другого провайдера для этой отправки. */
  fallbackAllowed: boolean
}

/**
 * Резолв requested-маршрута ДО отправки. Override (если есть) побеждает default чата,
 * но НЕ мутирует его (one-shot). Renderer-facing контракт: тестируемое определение
 * семантики маршрута (source + fallbackAllowed) для показа requested route в UI.
 * Main (ipc/ai.ts) гейтит fallback ЭКВИВАЛЕНТНОЙ инлайн-логикой (`!route || policy==='allow'`) —
 * там резолв провайдера/модели богаче (getProviderId/getProviderModel + resume-route), поэтому
 * не через этот хелпер; при правках держать fallbackAllowed-семантику синхронной.
 */
export function resolvePromptRoute(
  chatDefault: { providerId: ProviderId; model: string },
  override: PromptRouteOverride | null | undefined,
): ResolvedRoute {
  if (override) {
    return {
      providerId: override.providerId,
      model: override.model,
      source: 'prompt-explicit',
      fallbackAllowed: override.fallbackPolicy === 'allow',
    }
  }
  return {
    providerId: chatDefault.providerId,
    model: chatDefault.model,
    source: 'chat-default',
    fallbackAllowed: true,
  }
}

/** Известен ли сохранённый ID. Неизвестный НЕ схлопывается молча — см. resolveStoredProviderId. */
export function isKnownProviderId(v: unknown): v is ProviderId {
  return typeof v === 'string' && (PROVIDER_IDS as readonly string[]).includes(v)
}

/** Безопасный дефолт, когда сохранённого выбора нет вообще. */
export const DEFAULT_PROVIDER_ID: ProviderId = 'gemini-api'

/**
 * Резолв сохранённого provider-id БЕЗ молчаливой подмены.
 * Раньше неизвестный id тихо становился `gemini-api`, и пользователь не понимал, почему
 * его выбор «не сохраняется» (так был потерян openai-codex-oauth). Теперь факт подмены
 * ВОЗВРАЩАЕТСЯ наружу, и UI обязан показать «сохранённый провайдер X больше не доступен».
 */
export function resolveStoredProviderId(stored: unknown): {
  id: ProviderId
  /** Сохранённый id не опознан → показан дефолт. Что именно было сохранено — в `requested`. */
  unavailable: boolean
  requested: string | null
} {
  if (isKnownProviderId(stored)) return { id: stored, unavailable: false, requested: stored }
  const requested = typeof stored === 'string' && stored.length > 0 ? stored : null
  return { id: DEFAULT_PROVIDER_ID, unavailable: requested !== null, requested }
}
