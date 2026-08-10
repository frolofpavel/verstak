// Типы для scripts/agent-progress.mjs — ЕДИНСТВЕННОГО источника признака
// прогресса и детекта застоя (V2-4). Модуль на .mjs, потому что его исполняет
// CLI (scripts/verstak-cli.mjs) напрямую, без сборки и без Electron; десктопный
// путь берёт тот же файл через electron/ai/progress.ts. allowJs в проекте
// выключен и включать его ради одного модуля нельзя — отсюда .d.mts.

export declare const STAGNATION_TURNS: number
export declare const MAX_STRATEGY_NUDGES: number

export interface ProgressCall {
  name?: string
  args?: unknown
  result?: unknown
  error?: unknown
}

export interface ProgressState {
  facts: Set<string>
  staleTurns: number
  window: Array<{ calls: string[]; readOnly: boolean }>
  strategyNudges: number
}

export type StagnationReason = 'repeat-call' | 'reread-loop' | 'no-new-facts'

export declare function factKey(call: ProgressCall): string
export declare function callKey(call: ProgressCall): string
export declare function createProgressState(): ProgressState
export declare function recordTurn(
  state: ProgressState,
  calls: ProgressCall[],
): { progressed: boolean; newFacts: number }
export declare function detectStagnation(state: ProgressState): {
  stagnant: boolean
  reason: StagnationReason | null
  staleTurns: number
}
export declare function buildStrategyChangeHint(reason: StagnationReason | null, staleTurns: number): string
export declare function stagnationStopNote(reason: StagnationReason | null, staleTurns: number): string
