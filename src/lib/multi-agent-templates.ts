/**
 * Шаблоны для мультиагентных инструментов (orchestrate / swarm / delegate_parallel).
 *
 * Единый источник истины для трёх точек входа в UI:
 *  1. Системные slash-команды (/orchestrate /swarm /parallel) — Chat.tsx.
 *  2. Кнопка «Мультиагент» в композере — MultiAgentPicker.tsx.
 *  3. Quick-action кнопки в пустом чате — Chat.tsx.
 *
 * Тексты ИМПЕРАТИВНЫЕ, но мягкие: агент надёжно вызовет нужный tool, при этом
 * сам декомпозирует цель и выберет модели — мы НЕ форсируем жёсткий tool-call.
 * Курсор остаётся в textarea (инъекция через setInput) — пользователь дописывает цель.
 */

export interface MultiAgentTemplate {
  /** trigger для slash-команды (без слэша). */
  trigger: string
  /** Иконка для пунктов меню / quick-action. */
  icon: string
  /** Короткий label для кнопок и попапа. */
  label: string
  /** Понятное описание (для slash-попапа и тултипа). */
  description: string
  /** Текст, который вставляется в композер. Цель/задачи пользователь дописывает. */
  template: string
}

export const MULTI_AGENT_TEMPLATES: Record<'orchestrate' | 'swarm' | 'parallel', MultiAgentTemplate> = {
  orchestrate: {
    trigger: 'orchestrate',
    icon: '📊',
    label: 'Оркестратор',
    description: 'Разбить цель на подзадачи по ролям и выполнить параллельно',
    template:
      'Оркестрируй эту цель через инструмент orchestrate: разбей на подзадачи по ролям и выполни их параллельно, в конце сведи результат.\n\nЦель: '
  },
  swarm: {
    trigger: 'swarm',
    icon: '🐝',
    label: 'Рой',
    description: 'N агентов разными стратегиями + арбитр сведёт консенсус',
    template:
      'Запусти рой через инструмент swarm для одной цели: несколько агентов разными стратегиями + арбитр сведёт консенсус.\n\nЦель (size=4): '
  },
  parallel: {
    trigger: 'parallel',
    icon: '🧩',
    label: 'Параллельно',
    description: 'Пакет независимых задач — каждую отдельным суб-агентом',
    template:
      'Выполни эти независимые задачи параллельно через delegate_parallel, каждую отдельным суб-агентом с подходящей ролью.\n\nЗадачи:\n1. '
  }
}

/** Упорядоченный список для рендера меню/quick-actions. */
export const MULTI_AGENT_LIST: MultiAgentTemplate[] = [
  MULTI_AGENT_TEMPLATES.orchestrate,
  MULTI_AGENT_TEMPLATES.swarm,
  MULTI_AGENT_TEMPLATES.parallel
]
