/**
 * Smart Model Router — оценивает сложность задачи и рекомендует модель.
 *
 * При effortLevel='standard' и отсутствии явного выбора модели пользователем
 * маршрутизатор выбирает дешёвую модель для простых запросов и мощную для
 * сложных. Это снижает стоимость при сохранении качества.
 */

import type { ChatMessage } from './types'
import { PROVIDERS, type ProviderId } from './registry'
import { recommendAgentModel } from './agent-model-policy'

export type TaskComplexity = 'simple' | 'moderate' | 'complex'

/**
 * Оценивает сложность задачи по последнему сообщению пользователя
 * и истории вызовов инструментов.
 */
export function estimateComplexity(messages: ChatMessage[], toolHistory: string[]): TaskComplexity {
  const lastUser = messages.filter(m => m.role === 'user').pop()
  if (!lastUser) return 'simple'

  const text = lastUser.content.toLowerCase()
  const len = text.length
  // Реальная активность агента: в ai.ts toolHistory передаётся как [], поэтому
  // считаем число tool-вызовов прямо из истории сообщений (иначе сложность
  // оценивалась только по длине последнего промпта).
  const totalToolCalls = messages.reduce((acc, m) => acc + (m.toolCalls?.length ?? 0), 0)

  // Простые: короткие вопросы без сигналов сложной работы И без накопленной
  // активности (короткое «продолжи» при 6 уже сделанных tool-вызовах — не простая).
  if (
    len < 100 &&
    totalToolCalls <= 5 &&
    !text.includes('refactor') &&
    !text.includes('fix') &&
    !text.includes('implement') &&
    !text.includes('create') &&
    !text.includes('build')
  ) return 'simple'

  // Сложные: длинные промпты или несколько сигналов сложной работы
  const complexSignals = [
    'refactor', 'architect', 'redesign', 'migrate', 'rewrite',
    'implement', 'build', 'create', 'test', 'debug', 'optimize'
  ]
  const complexCount = complexSignals.filter(s => text.includes(s)).length

  if (complexCount >= 2 || len > 500 || toolHistory.length > 5 || totalToolCalls > 5) return 'complex'

  return 'moderate'
}

/**
 * Рекомендует модель для данного провайдера и уровня сложности.
 * Возвращает null если провайдер не покрыт маппингом.
 */
export function recommendModel(providerId: string, complexity: TaskComplexity): string | null {
  const MAP: Record<string, Record<TaskComplexity, string>> = {
    'gemini-api': {
      simple: 'gemini-3-flash',
      moderate: 'gemini-3.5-flash',
      complex: 'gemini-3-pro',
    },
    'claude': {
      simple: 'claude-haiku-4-5',
      moderate: 'claude-sonnet-4-6',
      complex: 'claude-opus-4-5',
    },
    'openai': {
      simple: 'gpt-4o-mini',
      moderate: 'gpt-4o',
      complex: 'o1',
    },
    'grok': {
      simple: 'grok-4.5',
      moderate: 'grok-4.5',
      complex: 'grok-4.5',
    },
    'verstak-gateway': {
      simple: recommendAgentModel('coding'),
      moderate: recommendAgentModel('coding'),
      complex: recommendAgentModel('coding'),
    },
  }

  const model = MAP[providerId]?.[complexity] ?? null
  if (!model) return null

  // Safety validation: verify model exists in provider registry
  const descriptor = PROVIDERS[providerId as ProviderId]
  if (descriptor && !descriptor.models.includes(model)) {
    return descriptor.defaultModel
  }

  return model
}

/**
 * Гибридный роутинг API↔CLI (Сценарий Б). Детектит, требует ли задача
 * «терминального цикла» — выполнить команду, прочитать вывод, итеративно
 * править, перезапустить (сборка/типы/тесты/локальный прогон). Такие задачи
 * автономнее делает CLI-агент (Claude Code/Codex), чем чистый API-чат.
 *
 * Возвращает {reason} если задача терминальная, иначе null. Чистая функция —
 * вызывающий решает, ЧТО делать с подсказкой (info-event / pill / delegate).
 */
export function detectCliWorthiness(messages: ChatMessage[]): { reason: string } | null {
  const lastUser = messages.filter(m => m.role === 'user').pop()
  if (!lastUser) return null
  const text = lastUser.content.toLowerCase()

  // Сигналы терминального цикла: запуск/наблюдение/итерация. RU + EN.
  // Сгруппированы по смыслу — для каждой группы своя человекочитаемая причина.
  const GROUPS: Array<{ reason: string; patterns: RegExp }> = [
    {
      reason: 'сборка/компиляция (нужно читать вывод и итеративно править)',
      patterns: /(падает|сломал|чинит?|почему).{0,30}(сборк|билд|компил)|tsc|type ?check|типизац|build (fail|error|break)|compile error|сборка не/,
    },
    {
      reason: 'прогон тестов (нужен цикл запуск→правка→перезапуск)',
      patterns: /(запусти|прогон|почини|fix).{0,30}(тест|test)|npm (run )?test|vitest|jest|pytest|тесты (не )?(проход|падают)|failing test|make tests? pass/,
    },
    {
      reason: 'итеративная отладка по выводу инструментов',
      patterns: /(почему|why).{0,40}(падае|fail|crash|краш|ошибк|error|не работает)|debug|трассир|stack ?trace|воспроизвед|reproduce/,
    },
    {
      reason: 'локальное окружение/команды (установка, запуск, линт)',
      patterns: /npm (install|run|ci)|yarn |pnpm |запусти локально|подними (окруж|сервер)|run the (app|server|dev)|lint|eslint --fix|migrate (db|database)|прогони миграц/,
    },
  ]

  for (const g of GROUPS) {
    if (g.patterns.test(text)) return { reason: g.reason }
  }
  return null
}

/** Человекочитаемая метка для info-события. */
export function complexityLabel(complexity: TaskComplexity): string {
  switch (complexity) {
    case 'simple': return 'Simple task'
    case 'moderate': return 'Moderate task'
    case 'complex': return 'Complex task'
  }
}
