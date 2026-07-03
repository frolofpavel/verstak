/**
 * Skill — переиспользуемый агентский пресет: system prompt + список разрешённых
 * tools + auto-loaders контекста + дефолтный provider/model.
 *
 * Источник: Verstak V3 Plan, раздел 6. См. Downloads/Verstak-V3-Plan.html.
 *
 * Скиллы загружаются из:
 *  1. Server API (your-skills-server.example.com/api/skills) — опциональный источник,
 *     URL настраивается в Settings. См. SkillSource.serverApi.
 *  2. Локально из ~/.verstak/skills/*.md — fallback / личные.
 *  3. Built-in 3 шт в коде (code-review, git-summary, explain-code) — гарантированный
 *     baseline на случай если сервер недоступен.
 */

import type { ProviderId } from '../registry'
import type { AgentMode } from '../mode-policy'

/**
 * Recipe (Этап 4) — жёсткий пошаговый протокол под тип coding-задачи поверх
 * обычного скилла. Цель — не «подсказать», а ОГРАНИЧИТЬ свободу дешёвой модели:
 * читать только read_set, делать маленький patch, проверять результат, не чинить
 * чужой red, не завершать без verify. Рецепт опционален: скилл без блока `recipe:`
 * работает как раньше. Невалидный recipe → fail-soft (parseRecipe вернёт undefined,
 * скилл остаётся обычным скиллом). См. `recipe.ts`.
 */
export type RecipeStep =
  | 'inspect_error'
  | 'locate_files'
  | 'read_context'
  | 'propose_patch'
  | 'apply_patch'
  | 'run_verify'
  | 'run_tests'
  | 'review'
  | 'summarize'

/** Forward-compat (Блок G Этапа 4): model-compensation. В Этапе 4 НЕ используется —
 *  только парсится и хранится, чтобы позже `ModelProfile` встал без ломки схемы. */
export interface RecipeCompensation {
  toolMode?: 'native' | 'json'
  editStrategy?: 'patch' | 'search-replace' | 'whole-file'
  promptStyle?: 'strict-json' | 'terse' | 'stepwise'
  knownIssues?: string[]
}

export interface RecipeSpec {
  id: string
  /** Категория рецепта (пока — coding). */
  kind: string
  /** Ключевые фразы для recipe-router (Блок D). */
  trigger: string[]
  /** Минимальный контекст: какие файлы/globs читать. */
  read_set: string[]
  /** Пошаговый протокол — ограничивает свободу модели. */
  steps: RecipeStep[]
  /** Команды верификации (напр. npm run type / npm test). */
  verify?: { commands: string[] }
  /** Нужен ли независимый reviewer (Блок E — review_before_commit). */
  reviewer?: { required: boolean }
  /** Критерии завершения задачи. */
  stop: string[]
  /** Forward-compat, не используется в Этапе 4. */
  compensation?: RecipeCompensation
}

/** Frontmatter полей скилла. Все поля кроме id опциональны. */
export interface SkillFrontmatter {
  id: string
  /** Человекочитаемое имя в picker и в Timeline pill. */
  name?: string
  /** Краткое описание для tooltip + auto-trigger подсказок. */
  description?: string
  /** Emoji icon — показывается в picker и slash-popup. */
  icon?: string
  /** Дефолтный provider при создании чата под этим скиллом. */
  default_provider?: ProviderId
  /** Дефолтная модель в рамках выбранного provider. */
  default_model?: string
  /** Дефолтный agent mode (ask/accept-edits/plan/auto/bypass). */
  default_mode?: AgentMode
  /**
   * Whitelist tools. Принимает glob-like (`gsheets.*`) или точное имя.
   * Если пусто — разрешены все стандартные tools. Если задано — ТОЛЬКО эти.
   */
  tools_allow?: string[]
  /** Подсказки в composer placeholder для быстрого ввода. */
  suggested_prompts?: string[]
  /** Slash-команда без `/` (по умолчанию = id). */
  slash?: string
  /**
   * Контекст-лоадеры — функции которые подгружают данные в первое user msg
   * перед стартом чата. Реализация в `electron/ai/skills/loaders/`.
   * Поле `impl` = ключ реестра загрузчиков.
   */
  context_loaders?: Array<{
    id: string
    impl: string
    /** Когда запустить: при открытии чата / при slash с аргументом. */
    runs_on: 'chat_open' | 'slash_arg'
    /** Произвольные параметры для конкретного loader'а. */
    args?: Record<string, unknown>
  }>
  /**
   * Recipe-блок (Этап 4). Опционален. Если задан и валиден — скилл работает как
   * рецепт (жёсткий протокол). Невалидный → parseRecipe вернёт undefined и скилл
   * остаётся обычным скиллом (fail-soft).
   */
  recipe?: RecipeSpec
}

/** Полная сборка: frontmatter + тело system prompt. */
export interface Skill extends SkillFrontmatter {
  /** Тело markdown после frontmatter — это и есть system prompt. */
  systemPrompt: string
  /** Откуда загружен — для отладки и UI badge. */
  source: SkillSource
  /** Путь к файлу (если local) или URL (если server). */
  sourceRef: string
}

export type SkillSource = 'server' | 'user' | 'built-in'

/** Реестр в runtime — собирает скиллы из всех источников. */
export interface SkillRegistry {
  /** Получить все доступные скиллы (built-in + user + server). */
  list(): Skill[]
  /** Поиск по id. */
  get(id: string): Skill | null
  /** Refresh из всех источников (по запросу пользователя или при старте). */
  refresh(): Promise<{ added: number; updated: number; failed: string[] }>
  /** Статус последнего refresh. */
  status(): { lastRefreshAt: number | null; serverReachable: boolean; total: number }
}
