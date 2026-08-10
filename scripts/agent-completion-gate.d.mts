// Типы для scripts/agent-completion-gate.mjs — ЕДИНСТВЕННОГО источника правила
// completion gate. Модуль написан на .mjs, потому что его исполняет CLI
// (scripts/verstak-cli.mjs) напрямую, без сборки и без Electron. Десктопный путь
// импортирует тот же файл через electron/ai/completion-gate.ts, а этот .d.ts даёт
// TypeScript типы (allowJs в проекте выключен, и включать его ради одного модуля
// нельзя — это изменило бы правила проверки для всего дерева).

export declare const COMPLETION_GATE_MAX_NUDGES: number

export type CompletionGateDecision = 'allow' | 'retry' | 'finish-unverified'

export declare function isVerificationToolCall(call: {
  name?: string
  args?: Record<string, unknown> | null
}): boolean

export declare function decideCompletionGate(input: {
  acceptedWrites: number
  verifications: number
  nudges: number
}): CompletionGateDecision

export declare function buildCompletionGateNudge(verifyCommands: string[]): string

export declare function unverifiedWorkNote(fileCount: number): string

/** V3: одна строка об ИТОГЕ проверок. null — проверок не было, строки нет. */
export declare function verifiedWorkNote(
  checks: Array<{ label: string; ok: boolean }>,
  fileCount?: number,
): string | null
