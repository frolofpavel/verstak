// Ось «Интенсивность» — Простой / Турбо. Ортогональна 5 режимам подтверждения
// (ask/accept-edits/plan/auto/bypass — ось безопасности). Интенсивность управляет
// ГЛУБИНОЙ машинерии: сколько контекста, какой effort, поощряет ли агента
// проактивно делегировать/роить/звать тяжёлые инструменты.
//
// Это ПРЕСЕТ (бандл настроек + подсказка в системный промпт), а не новый движок.
// Дефолт — Простой: предсказуемо и дёшево. Турбо — «весь харнес на задачу».

export type Intensity = 'simple' | 'turbo'

export interface IntensityConfig {
  /** Уровень усилий модели (max_tokens / extended thinking). */
  effortLevel: 'quick' | 'standard' | 'deep'
  /** Глубина ContextPack из Project Brain (short ~2k / medium ~8k / long ~20k токенов). */
  brainPack: 'short' | 'medium' | 'long'
  /** Поощрять ли проактивную оркестрацию (delegate/swarm/LSP). Простой — нет
   *  (один прямой путь), Турбо — да. Это ПОДСКАЗКА промпта, не жёсткий гейт:
   *  тулзы остаются доступны, меняется лишь поведение по умолчанию. */
  proactiveOrchestration: boolean
  /** Текст-наслоение в системный промпт (секция <intensity>). */
  systemHint: string
}

const SIMPLE_HINT =
  '<intensity mode="simple">Режим «Простой»: решай задачу прямо и предсказуемо — ' +
  'один путь к результату. Не разворачивай оркестрацию, делегирование или рой ' +
  'агентов без явной нужды; справляйся сам и отвечай по делу. Экономь шаги и токены.</intensity>'

const TURBO_HINT =
  '<intensity mode="turbo">Режим «Турбо»: качество результата важнее экономии. ' +
  'Проактивно применяй всю машинерию — декомпозируй сложное на под-задачи через ' +
  'delegate_task/swarm и веди их параллельно, бери глубокий контекст проекта, ' +
  'используй семантическую навигацию (LSP) для точности, и строго проверяй итог ' +
  '(attest_verification). Не упрощай ради скорости — доводи до конца.</intensity>'

/** Пресет настроек для уровня интенсивности. */
export function intensityConfig(mode: Intensity): IntensityConfig {
  if (mode === 'turbo') {
    return {
      effortLevel: 'deep',
      brainPack: 'long',
      proactiveOrchestration: true,
      systemHint: TURBO_HINT
    }
  }
  return {
    effortLevel: 'standard',
    brainPack: 'short',
    proactiveOrchestration: false,
    systemHint: SIMPLE_HINT
  }
}

/** Нормализовать произвольное значение настройки к Intensity (дефолт — simple). */
export function parseIntensity(value: string | null | undefined): Intensity {
  return value === 'turbo' ? 'turbo' : 'simple'
}
