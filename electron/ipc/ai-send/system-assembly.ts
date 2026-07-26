// Распил ai.ts (2.1.10-G): сборка system-промпта и итоговых messages для ai:send.
//
// Вынесено из registerAiIpc БЕЗ изменения логики. Здесь собран последний крупный
// узел хендлера — решение «какой системный слой уедет модели»:
//  · resume по чекпойнту — история подаётся как есть, пере-сборки нет;
//  · Explicit Review — ПОЛНАЯ замена системного промпта reviewer-промптом;
//  · API-транспорт — полная сборка (user-layer, память, Мозг проекта, скилл,
//    output style) + наслоение интенсивности;
//  · не-API со скилл-override — безвредный system-фолбэк (CLI его отфильтрует).
//
// Порядок веток и приоритет между ними сохранены дословно: это не оптимизация, а
// перенос. Побочные эффекты (progress-события, info о Мозге) остались в хендлере,
// поэтому лента событий не сдвигается.

import type { ChatMessage } from '../../ai/types'
import type { AgentMode } from '../../ai/mode-policy'
import type { ProviderId, ProviderDescriptor } from '../../ai/registry'
import { prepareSystemContext } from '../../ai/compose-system'
import { systemForProvider } from '../../ai/compose-prompt'
import { REVIEWER_SYSTEM_PROMPT } from '../../ai/review-prompt'
import { canReplayCheckpoint } from '../../ai/resume-checkpoint'

/** Прогретый ContextPack Мозга проекта — то немногое, что нужно и хендлеру (бейдж). */
export interface BrainContext {
  content: string
  packType: string
  tokenEstimate?: number | null
}

export interface AssembledSystem {
  /** История, уже дополненная системным слоем — ровно то, что уйдёт в runner. */
  messagesWithSystem: ChatMessage[]
  /** Точная system-строка API-пути (Debug Packet). null для CLI, reviewer и resume. */
  composedSystem: string | null
  /** Использованный ContextPack Мозга — для бейджа и метрики экономии. */
  brain: BrainContext | null
}

export interface SystemAssemblyDeps {
  getSecret: (key: string) => string | null
  recentWrites: (projectPath: string, limit: number) => Array<{ filePath: string; createdAt: number }>
  getBrainContext?: (projectPath: string, lastUserMessage: string) => BrainContext | null
}

/**
 * Load project's user-layer (AGENTS.md / CLAUDE.md / GEMINI.md / our RULES.md) and
 * prepend the immutable system layer + user layer as a single system message.
 * CLI providers run their own agent inside, so we don't inject for them — the
 * user's AGENTS.md is already picked up by Claude Code / Codex / Grok Build natively.
 */
export async function assembleSendSystem(input: {
  messages: ChatMessage[]
  projectPath: string | null
  providerId: ProviderId
  descriptor: ProviderDescriptor
  agentMode: AgentMode
  /** Полная история из чекпойнта (crash-resume). null — обычный старт. */
  resumedMessages: ChatMessage[] | null
  /** Прогон чекпойнта — гард совместимости провайдера при возобновлении. */
  checkpointRun: { providerId: string | null } | null | undefined
  /** Skill-промпт с уже наслоённым recipe-протоколом (один раз собран в хендлере). */
  skillLayerPrompt: string | null | undefined
  /** Сырой overrides.systemPrompt. Именно он, а НЕ результат наслоения recipe, решает
   *  судьбу не-API ветки: recipe без скилла даёт непустой skillLayerPrompt, и условие
   *  на нём подсунуло бы CLI system-сообщение, которого в исходном коде не было. */
  skillOverridePrompt: string | null | undefined
  useReviewerPrompt: boolean
  memories: { type: string; content: string; tags: string[] }[]
  consolidationHint: string | null
  /** Core memory frozen at run start: MEMORY.md + USER.md stay stable for prompt-cache diagnostics. */
  coreMemory: { memory: string; user: string }
  /** Наслоение оси интенсивности (Простой/Турбо) поверх собранного промпта. */
  intensitySystemHint: string
  deps: SystemAssemblyDeps
}): Promise<AssembledSystem> {
  const { messages } = input
  // Reviewer override (Explicit Review) — ПОЛНАЯ ЗАМЕНА системного промпта.
  // Ревьюер не является агентом проекта: он читает работу другого AI и даёт
  // независимый разбор. Давать ему system-layer + user-layer = заставить
  // вести себя как сам агент, а не как критик → теряется смысл кросс-ревью.
  // Поэтому reviewer-промпт остаётся единственной системной инструкцией.
  if (input.resumedMessages && canReplayCheckpoint(input.checkpointRun, input.providerId)) {
    // Crash-resume Фаза 2: чекпойнт уже содержит system + полную историю прогона
    // — подаём как есть, минуя пере-сборку контекста. composedSystem остаётся
    // null (Debug-снапшот системы для возобновления не делаем — это продолжение).
    // 1.9.8 #4: только если провайдер совпал — иначе tool_use-история одного
    // провайдера не ляжет в формат другого (свежий старт по messages безопаснее).
    return { messagesWithSystem: input.resumedMessages, composedSystem: null, brain: null }
  }
  if (input.useReviewerPrompt) {
    return {
      messagesWithSystem: [{ role: 'system', content: REVIEWER_SYSTEM_PROMPT }, ...messages],
      composedSystem: null,
      brain: null,
    }
  }
  if (input.descriptor.transport === 'API') {
    // Same assembly path as CLI providers — see ai/compose-system.ts.
    // projectSystemPrompt — пользовательский промпт из Project Settings
    // (UI шестерёнки в Project Rail). Хранится в settings ключом
    // `system_prompt_${path}`. Если пусто — игнорируется.
    const projectSystemPrompt = input.projectPath ? input.deps.getSecret(`system_prompt_${input.projectPath}`) : null
    // Project Brain (Итер.4): если проект прогрет и не выключено — инжектим
    // готовый ContextPack под задачу (вместо сборки всего контекста заново).
    const brainOn = input.deps.getSecret('use_project_brain') !== 'false'
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')?.content ?? ''
    const brain = (brainOn && input.projectPath && input.deps.getBrainContext)
      ? input.deps.getBrainContext(input.projectPath, lastUserMsg) : null
    // Skill override — НАСЛОЕНИЕ, а не замена. Промпт скилла (overrides.systemPrompt)
    // дописывается ПОВЕРХ базового промпта секцией <skill_layer> внутри
    // composeSystemPrompt. Так скилл уточняет роль агента, но базовый протокол
    // выполнения (system-layer 7-шаговый цикл + работа с тулзами) сохраняется —
    // раньше промпт скилла полностью заменял базу и агент терял протокол.
    const composed = await prepareSystemContext({
      projectPath: input.projectPath,
      messages,
      recentWrites: input.projectPath ? input.deps.recentWrites(input.projectPath, 8) : [],
      projectSystemPrompt,
      memories: input.memories,
      consolidationHint: input.consolidationHint ?? undefined,
      coreMemory: input.coreMemory,
      agentMode: input.agentMode,
      brainContext: brain?.content ?? null,
      skillPrompt: input.skillLayerPrompt ?? undefined,
      // Output style (формат/персона ответа) — глобальная настройка, инжектится
      // в user_layer секцией. 'default'/пусто → ничего не добавляется. ЛИМИТ: только
      // API-путь; CLI-провайдеры (claude-cli/codex-cli/grok-cli/gemini-cli) строят свой
      // промпт в buildCliPrompt без outputStyle — стиль на них не применяется (известный
      // CLI-parity лимит, как бинарные вложения; см. CLAUDE.md §5.2).
      outputStyle: input.deps.getSecret('output_style')
    })
    // Наслоение интенсивности (<intensity>) поверх собранного промпта — стерёт
    // поведение под Простой/Турбо. Простой-подсказка нейтральна к сегодняшнему
    // поведению (один прямой путь), Турбо — поощряет всю машинерию.
    const composedSystem = composed.system + '\n\n' + input.intensitySystemHint
    // Prompt caching: 'claude' получает маркер (сам режет и кэширует стабильный
    // префикс), остальные провайдеры — снятый маркер (авто-кэш по стабильному
    // префиксу OpenAI/DeepSeek/Gemini implicit). Порядок stable→volatile уже задан
    // в composeSystemPrompt — этого достаточно для implicit-кэша прочих.
    return {
      messagesWithSystem: [{ role: 'system', content: systemForProvider(composedSystem, input.providerId) }, ...messages],
      composedSystem,
      brain,
    }
  }
  if (input.skillOverridePrompt) {
    // Не-API (CLI) транспорт со скилл-override. CLI-провайдеры строят свой
    // системный промпт внутри buildCliPrompt и игнорируют system-сообщение в
    // messages (cli-prompt.ts фильтрует role==='system'). Сам скилл наслаивается
    // для CLI через skillPromptForProvider → createProvider → buildCliPrompt
    // секцией <skill_layer> (см. ниже). Это system-сообщение — безвредный
    // fallback для гипотетических не-CLI не-API провайдеров (CLI его отфильтрует).
    return {
      messagesWithSystem: [{ role: 'system', content: input.skillLayerPrompt ?? input.skillOverridePrompt }, ...messages],
      composedSystem: null,
      brain: null,
    }
  }
  return { messagesWithSystem: messages, composedSystem: null, brain: null }
}
