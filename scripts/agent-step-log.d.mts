// Типы для scripts/agent-step-log.mjs (V2-5). Модуль на .mjs, потому что тот же
// формат строки шага нужен CLI-циклу, который исполняется без сборки и Electron;
// десктоп берёт его через electron/ai/step-log.ts. allowJs выключен — отсюда .d.mts.

export interface StepLogCall {
  name?: string
  args?: unknown
  error?: unknown
}

export interface StepLogInput {
  /** Номер шага, 1-based. */
  step: number
  /** Бюджет ходов на момент шага; null — не показывать знаменатель. */
  budget?: number | null
  /** Цель работы: незакрытый пункт Focus Chain или формулировка задачи. */
  goal?: string | null
  calls?: StepLogCall[]
  /** Решение РАНТАЙМА после хода: продолжаю / требую проверку / останавливаю… */
  decision?: string | null
  progressed?: boolean
  newFacts?: number
  staleTurns?: number
}

export declare function formatStepLine(input: StepLogInput): string
