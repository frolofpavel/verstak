/**
 * Workflow Scientist — исследовательский слой самоулучшения.
 *
 * Цикл: дорогой или проваленный прогон → замечен → гипотеза → контролируемый
 * эксперимент → сравнение → РЕКОМЕНДАЦИЯ → решение человека.
 *
 * ГРАНИЦА, КОТОРАЯ ЗДЕСЬ ГЛАВНЕЕ ЛЮБОГО РАСЧЁТА. Этот слой не меняет production,
 * не включает скиллы, не расширяет права и не ставит себе зачёт. Он производит
 * АРТЕФАКТ с рекомендацией — и всё. Продвижение идёт тем же путём, что уже
 * построен для Model Gym: `eval:policy` формирует кандидата с `autoApplied: false`
 * и требует явного одобрения владельца (docs/model-gym-policy.md). Второго
 * прогонщика экспериментов здесь нет: контролируемые прогоны делает
 * существующий харнесс `scripts/eval/`.
 *
 * МЕНЯЕТСЯ РОВНО ОДИН ФАКТОР ЗА ЭКСПЕРИМЕНТ — иначе причинность неизвестна и
 * сравнение не значит ничего.
 */

/** Одно наблюдение: чем и как закончился прогон. Всё берётся из фактов, не из оценок. */
export interface WorkflowSample {
  runId: string
  providerId: string
  model: string
  /** Класс задачи: сравнивать «починить баг» с «написать отчёт» бессмысленно. */
  taskType: string
  succeeded: boolean
  costCents: number
  durationMs: number
  /** null — проверок не было; это НЕ провал. */
  verificationPassed: boolean | null
}

/** Меньше этого числа наблюдений вывод не делается: единичный прогон — не факт. */
export const MIN_SAMPLES = 5

/** Ниже этой доли успеха workflow считается проблемным. */
const POOR_SUCCESS_RATE = 0.7

/** Дороже этого среднего расхода за прогон workflow считается дорогим. */
const EXPENSIVE_CENTS = 200

/** Сколько повторов требует контролируемое сравнение. Один прогон вердиктом не бывает. */
const REQUIRED_REPEATS = 3

export interface WorkflowProblem {
  taskType: string
  currentModel: string
  currentProviderId: string
  sampleSize: number
  successRate: number
  avgCostCents: number
  avgDurationMs: number
  why: string
}

const mean = (values: number[]): number =>
  values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length

/** Доля успеха с учётом проверок: провал проверки — не успех, отсутствие — нейтрально. */
function successRate(samples: WorkflowSample[]): number {
  if (samples.length === 0) return 0
  const good = samples.filter(s => s.succeeded && s.verificationPassed !== false).length
  return good / samples.length
}

/**
 * Найти проблемный workflow.
 *
 * Наблюдения группируются по паре «класс задачи + модель»: сравнивать разные
 * классы между собой бессмысленно, а смешивать модели — значит потерять причину.
 * Возвращается ХУДШАЯ группа или null. Молчание — законный ответ: система,
 * которая всегда находит проблему, перестаёт что-либо значить.
 */
export function detectProblem(samples: readonly WorkflowSample[]): WorkflowProblem | null {
  const groups = new Map<string, WorkflowSample[]>()
  for (const s of samples) {
    // Ключ группы — JSON пары, а не склейка через разделитель: и класс задачи,
    // и имя модели приходят извне и могут содержать любой символ, включая тот,
    // что выбран разделителем. Склейка тогда объединила бы разные группы молча.
    const key = JSON.stringify([s.taskType, s.model])
    const bucket = groups.get(key)
    if (bucket) bucket.push(s)
    else groups.set(key, [s])
  }

  let worst: WorkflowProblem | null = null
  for (const group of groups.values()) {
    if (group.length < MIN_SAMPLES) continue
    const rate = successRate(group)
    const cost = mean(group.map(s => s.costCents))
    const poor = rate < POOR_SUCCESS_RATE
    const expensive = cost > EXPENSIVE_CENTS
    if (!poor && !expensive) continue

    const why = poor && expensive
      ? `Доля успеха ${(rate * 100).toFixed(0)}% при среднем расходе ${cost.toFixed(0)} центов за прогон: и провалы, и дорого.`
      : poor
        ? `Доля успеха ${(rate * 100).toFixed(0)}% — больше провалов, чем должно быть.`
        : `Средний расход ${cost.toFixed(0)} центов за прогон — дорого для этого класса задач.`

    const candidate: WorkflowProblem = {
      taskType: group[0].taskType,
      currentModel: group[0].model,
      currentProviderId: group[0].providerId,
      sampleSize: group.length,
      successRate: rate,
      avgCostCents: cost,
      avgDurationMs: mean(group.map(s => s.durationMs)),
      why,
    }
    // Хуже = ниже доля успеха; при равной — дороже.
    if (
      !worst ||
      candidate.successRate < worst.successRate ||
      (candidate.successRate === worst.successRate && candidate.avgCostCents > worst.avgCostCents)
    ) {
      worst = candidate
    }
  }
  return worst
}

/** Что именно меняется в эксперименте. Список открыт, но за раз меняется ОДНО. */
export type ExperimentFactor =
  | 'model'
  | 'planner-model'
  | 'reviewer-model'
  | 'skill'
  | 'system-prompt-fragment'
  | 'context-strategy'
  | 'allowed-tools'
  | 'retry-strategy'

export interface ExperimentPlan {
  hypothesis: string
  changedFactor: ExperimentFactor
  baseline: string
  candidate: string
  taskSet: string
  repeats: number
}

/**
 * Построить гипотезу. Кандидат берётся из СПИСКА ИЗВЕСТНЫХ моделей — выдумывать
 * модель нельзя: эксперимент на несуществующем кандидате не проваливается, он
 * просто не значит ничего.
 */
export function buildHypothesis(
  problem: WorkflowProblem,
  candidateModels: readonly string[]
): ExperimentPlan | null {
  const candidate = candidateModels.find(m => m && m !== problem.currentModel)
  if (!candidate) return null
  return {
    hypothesis:
      `На задачах класса «${problem.taskType}» текущая модель ${problem.currentModel} ` +
      `даёт ${(problem.successRate * 100).toFixed(0)}% успеха при ${problem.avgCostCents.toFixed(0)} центах за прогон. ` +
      `Проверяем, будет ли ${candidate} лучше при прочих равных.`,
    changedFactor: 'model',
    baseline: problem.currentModel,
    candidate,
    taskSet: problem.taskType,
    repeats: REQUIRED_REPEATS,
  }
}

export type Recommendation = 'promote' | 'reject' | 'insufficient'

export interface ExperimentResultV1 {
  hypothesis: string
  changedFactor: ExperimentFactor
  baseline: string
  candidate: string
  taskSet: string
  repeats: number
  successRateBefore: number
  successRateAfter: number
  costBefore: number
  costAfter: number
  latencyBefore: number
  latencyAfter: number
  verificationBefore: number
  verificationAfter: number
  recommendation: Recommendation
  /** Насколько выводу можно верить: растёт с числом наблюдений, не с желанием. */
  confidence: number
  /**
   * ВСЕГДА false. Поле существует, чтобы читатель артефакта видел границу прямо:
   * учёный не меняет production. Продвижение — отдельное решение человека через
   * тот же путь одобрения, что у Model Gym.
   */
  autoApplied: false
  appliedAt: null
  createdAt: number
}

/** Доля пройденных проверок среди тех, что вообще проводились. */
function verificationRate(samples: readonly WorkflowSample[]): number {
  const measured = samples.filter(s => s.verificationPassed !== null)
  if (measured.length === 0) return 0
  return measured.filter(s => s.verificationPassed === true).length / measured.length
}

/** Уверенность по объёму наблюдений: 0 при пустоте, насыщение к 1. */
function confidenceFor(before: number, after: number): number {
  const n = Math.min(before, after)
  if (n < MIN_SAMPLES) return 0
  return Math.min(1, n / (MIN_SAMPLES * 4))
}

/**
 * Сравнить базу и кандидата.
 *
 * Цена НЕ перевешивает качество: кандидат, который стал чаще ошибаться, не
 * продвигается, даже если дешевле втрое. Экономия, оплаченная чужим разбором
 * последствий, экономией не является.
 */
export function compareRuns(
  hypothesis: string,
  changedFactor: ExperimentFactor,
  baseline: string,
  candidate: string,
  taskSet: string,
  repeats: number,
  before: readonly WorkflowSample[],
  after: readonly WorkflowSample[],
  now = Date.now()
): ExperimentResultV1 {
  const successBefore = successRate([...before])
  const successAfter = successRate([...after])
  const costBefore = mean(before.map(s => s.costCents))
  const costAfter = mean(after.map(s => s.costCents))
  const latencyBefore = mean(before.map(s => s.durationMs))
  const latencyAfter = mean(after.map(s => s.durationMs))
  const verificationBefore = verificationRate(before)
  const verificationAfter = verificationRate(after)
  const confidence = confidenceFor(before.length, after.length)

  let recommendation: Recommendation
  if (confidence === 0) {
    // Слабый вердикт хуже отсутствия вердикта: его прочитают как вывод.
    recommendation = 'insufficient'
  } else {
    const qualityHeld = successAfter >= successBefore && verificationAfter >= verificationBefore
    const cheaperOrEqual = costAfter <= costBefore
    const betterQuality = successAfter > successBefore
    recommendation = qualityHeld && (cheaperOrEqual || betterQuality) ? 'promote' : 'reject'
  }

  return {
    hypothesis,
    changedFactor,
    baseline,
    candidate,
    taskSet,
    repeats,
    successRateBefore: successBefore,
    successRateAfter: successAfter,
    costBefore,
    costAfter,
    latencyBefore,
    latencyAfter,
    verificationBefore,
    verificationAfter,
    recommendation,
    confidence,
    autoApplied: false,
    appliedAt: null,
    createdAt: now,
  }
}
