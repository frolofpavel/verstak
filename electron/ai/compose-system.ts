/**
 * Single source of truth for assembling the agent's system context.
 *
 * Before this module, ipc/ai.ts (for API providers) and cli-prompt.ts (for
 * CLI providers) BOTH did the same dance independently:
 *   1. loadUserLayer(projectPath)
 *   2. buildContextPack({ projectPath, recentWrites, latestUserMessage,
 *                         isFirstTurn })
 *   3. composeSystemPrompt(userLayer, contextPack)
 *
 * Result: drift waiting to happen. When Context Pack got new fields, only one
 * caller usually got updated; CLI lagged. Per Grok audit (harsh edition):
 * "два параллельных мира построения промпта".
 *
 * Now: both callers go through prepareSystemContext(). Adding a new context
 * detector or changing assembly rules — one place to edit.
 */

import { relative, isAbsolute } from 'path'
import { loadUserLayer, type UserLayer } from './user-layer'
import { loadFileScopedRules, selectActiveRules } from './file-rules'
import { buildContextPack } from './context-pack'
import { composeSystemPrompt, type ComposedPrompt } from './compose-prompt'
import type { ChatMessage } from './types'
import type { CoreMemoryBlocks } from './core-memory'
import { buildModePreset } from './model-presets'
import type { AgentMode } from './mode-policy'

export interface PrepareSystemInput {
  projectPath: string | null
  messages: ChatMessage[]
  /** Recent file writes from undoStack (provided by main; the renderer/IPC
   *  shouldn't reach into storage directly). Pass [] if not available. */
  recentWrites: Array<{ filePath: string; createdAt: number }>
  /** Project-specific system prompt set in Project Settings (UI shows it in
   *  "Системный промпт проекта" section). When non-empty, appended to the
   *  user_layer content so the agent treats it as additional project rules. */
  projectSystemPrompt?: string | null
  /** Топ-5 воспоминаний проекта — передаются в context-pack для инжекции
   *  в system prompt. Опционально: если не передано, секция не появляется. */
  memories?: Array<{ type: string; content: string; tags: string[] }>
  /** Core memory (Hermes-style) — MEMORY.md + USER.md, всегда в system prompt.
   *  Загружается при каждом turn'е в отличие от архивной памяти. */
  coreMemory?: CoreMemoryBlocks
  /** Промпт активного скилла. Когда задан — НАСЛАИВАЕТСЯ поверх базового
   *  промпта (system-layer + user-layer + context-pack) как секция
   *  специализации, а НЕ заменяет его. Скилл уточняет роль агента, но базовый
   *  протокол выполнения (7-шаговый цикл, работа с тулзами) остаётся в силе. */
  skillPrompt?: string | null
  /** v3 Шаг D: режим агента — для beast-пресета автономности (auto/bypass). */
  agentMode?: AgentMode
  /** Project Brain (Итер.4): прогретый ContextPack проекта (грузит вызывающий). */
  brainContext?: string | null
}

export interface PreparedParts {
  userLayer: UserLayer
  contextPack: string
}

/**
 * Assemble the final system prompt for an agent send. Returns the fully
 * composed prompt plus the project path so callers can stitch it into the
 * provider-specific format.
 *
 * On any failure inside context-pack the function logs a warning (NOT silent
 * — that was previously hidden) and proceeds with whatever pieces succeeded.
 */
export async function prepareSystemContext(input: PrepareSystemInput): Promise<ComposedPrompt> {
  const parts = await prepareParts(input)
  return composeSystemPrompt(parts.userLayer, parts.contextPack, input.skillPrompt ?? undefined)
}

/**
 * Returns the raw user_layer + context_pack pieces without the SYSTEM_LAYER_PROMPT
 * envelope. Used by claude-cli where Claude Code already injects its own
 * developed system prompt — we don't want to layer ours on top.
 */
export async function prepareParts(input: PrepareSystemInput): Promise<PreparedParts> {
  const { projectPath, messages, recentWrites, projectSystemPrompt, memories, coreMemory } = input
  let userLayer = projectPath ? await loadUserLayer(projectPath) : { path: null, content: '' }

  // Project Settings — пользователь может задать промпт через UI шестерёнки
  // в Project Rail. Он сохраняется в settings ключом `system_prompt_${path}`.
  // Дописываем его к userLayer.content с явным маркером источника, чтобы в
  // отладке было видно откуда правило пришло (файл / UI).
  const trimmedProjectPrompt = projectSystemPrompt?.trim()
  if (trimmedProjectPrompt) {
    const sep = userLayer.content ? '\n\n' : ''
    userLayer = {
      path: userLayer.path,
      content: `${userLayer.content}${sep}<!-- project_settings_prompt -->\n${trimmedProjectPrompt}`
    }
  }

  // Подсказка по core memory tools — добавляется один раз к userLayer,
  // чтобы агент знал как обновлять MEMORY.md / USER.md.
  if (userLayer.content !== undefined) {
    const hint = '\n\n<!-- core_memory_hint -->\nИспользуй core_memory_append/replace/remove чтобы обновлять свою память о проекте (MEMORY.md) и пользователе (USER.md). Core memory всегда видна — не нужно искать, она автоматически в контексте.'
    userLayer = { path: userLayer.path, content: userLayer.content + hint }
  }

  // Принципы Карпати — краткие правила AI-кодинга, добавляются к userLayer.
  // Намеренно коротко: идут в каждый промпт, каждый токен на счету.
  if (userLayer.content !== undefined) {
    const karpathyHint = '\n\n<!-- agent_principles -->\n## Принципы работы\n1. Думай перед кодом — озвучивай предположения, при неопределённости спроси\n2. Минимализм — только запрошенный код, без спекулятивных абстракций\n3. Точечные правки — меняй только что просили, сохраняй существующий стиль\n4. Цели через тесты — сначала критерий «как поймём что готово», потом код'
    userLayer = { path: userLayer.path, content: userLayer.content + karpathyHint }
  }

  // Fan-out: агент САМ решает разбить многогранную задачу на параллельные
  // подзадачи (не пользователь кнопкой). Правило решения + капабилити.
  if (userLayer.content !== undefined) {
    const delegateHint = '\n\n<!-- fan_out_decision -->\n## Когда разбивать на параллельные подзадачи (сам, без спроса)\nЕсли задача состоит из НЕСКОЛЬКИХ независимых частей («сделай X и проверь Y и собери Z», несколько файлов/модулей/каналов) — НЕ делай всё одним потоком. Разбей и выполни параллельно через delegate_parallel (несколько исполнителей разом). Для расходящихся стратегий одной цели — swarm (несколько подходов + арбитр). Для сложной декомпозиции — orchestrate. Роли: planner (разбей), executor (сделай), verifier (проверь), critic (найди проблемы), researcher (исследуй). Это твоё решение по характеру задачи — пользователь описывает результат, стратегию выбираешь ты.'
    userLayer = { path: userLayer.path, content: userLayer.content + delegateHint }
  }

  // Tier-2 #6: file-scoped правила (.verstak/rules/*.mdc) — инжектим те, что подходят
  // под активные файлы (recentWrites) по glob, + alwaysApply всегда. Условные правила
  // под конкретные зоны проекта, не раздувая базовый user-layer. Graceful: ошибка → skip.
  if (projectPath && userLayer.content !== undefined) {
    try {
      const rules = await loadFileScopedRules(projectPath)
      if (rules.length) {
        const activeFiles = recentWrites.map(w =>
          (isAbsolute(w.filePath) ? relative(projectPath, w.filePath) : w.filePath).replace(/\\/g, '/'))
        const active = selectActiveRules(rules, activeFiles)
        if (active.length) {
          // Cap как у user-layer (MAX_BYTES): не раздуваем промпт большими .mdc на каждом ходу.
          const MAX_RULES_CHARS = 8000
          let block = active.map(r => r.body).join('\n\n')
          if (block.length > MAX_RULES_CHARS) block = block.slice(0, MAX_RULES_CHARS) + '\n…[file-scoped правила обрезаны по лимиту]'
          userLayer = { path: userLayer.path, content: `${userLayer.content}\n\n<!-- file_scoped_rules -->\n${block}` }
        }
      }
    } catch (err) {
      console.warn('[prepareSystemContext] file-rules failed:', err instanceof Error ? err.message : err)
    }
  }

  // v3 Шаг D: beast-пресет автономности для режимов auto/bypass — «не сдавайся,
  // проверяй жёстко». Пусто для подтверждающих режимов.
  const modePreset = input.agentMode ? buildModePreset(input.agentMode) : ''
  if (modePreset && userLayer.content !== undefined) {
    userLayer = { path: userLayer.path, content: `${userLayer.content}\n\n${modePreset}` }
  }

  let contextPack = ''
  if (projectPath) {
    const lastUser = messages.filter(m => m.role === 'user').at(-1)
    const isFirstTurn = !messages.some(m => m.role === 'assistant')
    try {
      contextPack = await buildContextPack({
        projectPath,
        recentWrites,
        latestUserMessage: lastUser?.content ?? '',
        isFirstTurn,
        memories,
        coreMemory,
        brainContext: input.brainContext
      })
    } catch (err) {
      // Visible failure — previously this was silent and made debugging hard.
      console.warn('[prepareSystemContext] buildContextPack failed:', err instanceof Error ? err.message : err)
    }
  }

  return { userLayer, contextPack }
}
