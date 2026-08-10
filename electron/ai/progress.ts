/**
 * V2-4 (agent-runtime-v2.md §4) — признак прогресса и детект застоя.
 *
 * Аудит назвал это B4: восстановление в прогоне построено для ПРОВАЙДЕРА
 * (смена аккаунта, fallback, компакция, retry), а для ЗАДАЧИ рантайм-механизма
 * нет вовсе. Агент, который встал, тихо доедал бюджет: повторял тот же вызов,
 * перечитывал те же файлы, и снаружи это было неотличимо от работы.
 *
 * ЕДИНСТВЕННЫЙ ИСТОЧНИК ПРАВИЛА — `scripts/agent-progress.mjs`, этот файл его
 * ре-экспортирует. Причина та же, что у V2-3 completion gate: тот же детект
 * обязан работать на CLI-пути (`scripts/verstak-cli.mjs`), который исполняется
 * без сборки и без Electron и потому не может импортировать из `electron/`.
 * Обратное направление возможно: TypeScript берёт .mjs через соседний .d.mts.
 * Дубля логики нет — один файл и две точки входа.
 *
 * Здесь же лежит признак прогресса для V2-2: автопродолжение бюджета включается
 * ровно тогда, когда прогон продолжает узнавать новое, и не включается, когда
 * он встал. Один сигнал на обе правки — иначе они разъехались бы.
 */
export {
  STAGNATION_TURNS,
  MAX_STRATEGY_NUDGES,
  observationDigest,
  factKey,
  callKey,
  createProgressState,
  recordTurn,
  detectStagnation,
  buildStrategyChangeHint,
  stagnationStopNote,
} from '../../scripts/agent-progress.mjs'
export type { ProgressCall, ProgressState, StagnationReason } from '../../scripts/agent-progress.mjs'
