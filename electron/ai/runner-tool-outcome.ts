import type { TurnChange } from './cross-verify'
import { isTypeScriptFile } from './diagnostic-loop'
import { isLspDiagnosableFile } from './lang-servers'
import { isReviewGatePassResult } from './review-gate'
import type { ToolCall, ToolResult } from './types'

export interface ToolTurnOutcome {
  acceptedWrites: number
  tsWrites: number
  lspWrites: Map<string, string>
  attested: boolean
  outcomeContractSubmitted: boolean
  stepOutcomeReported: boolean
  /**
   * §2.4 A3: человек отказал хотя бы одному вызову в этом ходе.
   *
   * Нужен, чтобы отличить ОТКАЗ от УСПЕХА на стороне интерфейса. Отказ
   * завершает прогон штатно — инструмент возвращает результат, модель его
   * читает и заканчивает ход, — поэтому renderer видит обычный `done` и до сих
   * пор помечал шаг плана ВЫПОЛНЕННЫМ. Шаг, который человек запретил,
   * записывался сделанным; молчание было бы честнее такой записи.
   */
  userRejected: boolean
}

/**
 * Текст, которым все спрашивающие инструменты сообщают об отказе человека:
 * command, connectors, file-ops, files, mcp, process, browser — ровно эта
 * строка. Сверено по коду; если появится восьмой инструмент со своей
 * формулировкой, отказ по нему потеряется молча — поэтому строка одна и здесь.
 */
const USER_REJECTED = 'User rejected'

interface CollectToolTurnOutcomeInput {
  toolCalls: ToolCall[]
  toolResults: ToolResult[]
  filesTouched: Set<string>
  commandsRun: string[]
  sessionChanges: TurnChange[]
  executedChecks: Map<string, number>
}

interface MutableOutcome extends ToolTurnOutcome {
  lspWrites: Map<string, string>
}

function collectWrittenFiles(
  result: ToolResult,
  filesTouched: Set<string>,
): Pick<ToolTurnOutcome, 'acceptedWrites' | 'tsWrites'> {
  let acceptedWrites = 0
  let tsWrites = 0
  for (const path of result.filesWritten ?? []) {
    filesTouched.add(path)
    acceptedWrites++
    if (isTypeScriptFile(path)) tsWrites++
  }
  return { acceptedWrites, tsWrites }
}

function collectDirectWrite(call: ToolCall, input: CollectToolTurnOutcomeInput, outcome: MutableOutcome): void {
  const path = String(call.args.path ?? '')
  if (path) {
    input.filesTouched.add(path)
    if (isTypeScriptFile(path)) outcome.tsWrites++
    const content = String(call.args.content ?? call.args.patch ?? '')
    if (content && input.sessionChanges.length < 5) {
      input.sessionChanges.push({
        file: path,
        type: call.name === 'write_file' ? 'write' : 'patch',
        content,
      })
    }
    if (call.name === 'write_file' && content && isLspDiagnosableFile(path)) {
      outcome.lspWrites.set(path, content)
    }
  }
  outcome.acceptedWrites++
}

function collectSuccessfulCall(call: ToolCall, input: CollectToolTurnOutcomeInput, outcome: MutableOutcome): void {
  if (call.name === 'write_file' || call.name === 'apply_patch') {
    collectDirectWrite(call, input, outcome)
    return
  }
  if (call.name === 'run_command') {
    const command = String(call.args.command ?? '')
    if (command) input.commandsRun.push(command)
    return
  }
  if (call.name === 'attest_verification') outcome.attested = true
  if (call.name === 'submit_task_contract') outcome.outcomeContractSubmitted = true
  if (call.name === 'report_step_outcome') outcome.stepOutcomeReported = true
}

function recordExecutedCheck(call: ToolCall, result: ToolResult, executedChecks: Map<string, number>): void {
  if (call.name !== 'run_command' && call.name !== 'run_until_green') return
  const exitCode = (result.result as { exitCode?: unknown } | null)?.exitCode
  const command = typeof call.args.command === 'string' ? call.args.command.trim() : ''
  if (command && typeof exitCode === 'number') executedChecks.set(command, exitCode)
}

/**
 * Pure accounting phase after dispatch: derives durable run facts from one
 * tool turn. External observations/memory hooks remain outside this function.
 */
export function collectToolTurnOutcome(input: CollectToolTurnOutcomeInput): ToolTurnOutcome {
  const outcome: MutableOutcome = {
    acceptedWrites: 0,
    tsWrites: 0,
    lspWrites: new Map<string, string>(),
    attested: false,
    outcomeContractSubmitted: false,
    stepOutcomeReported: false,
    userRejected: false,
  }

  for (let i = 0; i < input.toolCalls.length; i++) {
    const call = input.toolCalls[i]
    const result = input.toolResults[i]
    if (!result) continue

    const written = collectWrittenFiles(result, input.filesTouched)
    outcome.acceptedWrites += written.acceptedWrites
    outcome.tsWrites += written.tsWrites
    // Отказ человека — не сбой инструмента: сравнение точное, иначе любая
    // ошибка маскировалась бы под решение человека (и наоборот).
    if (result.error === USER_REJECTED) outcome.userRejected = true
    if (result.error) continue
    collectSuccessfulCall(call, input, outcome)
    recordExecutedCheck(call, result, input.executedChecks)
  }

  return outcome
}

export function reviewGatePassedInTurn(toolCalls: ToolCall[], toolResults: ToolResult[]): boolean {
  return toolCalls.some(
    (call, index) =>
      call.name === 'review_before_commit' &&
      isReviewGatePassResult(toolResults[index]?.result, !!toolResults[index]?.error),
  )
}
