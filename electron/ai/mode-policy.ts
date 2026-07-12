/**
 * Agent mode — глобальная политика как обрабатывать write/command действия AI.
 * По аналогии с Claude Code (Ask / Accept / Plan / Auto / Bypass).
 *
 * Применяется ВО ВСЕХ местах где AI пытается изменить файлы или запустить
 * команды. Проверяется в tool-handlers перед dispatching.
 */

export type AgentMode = 'ask' | 'accept-edits' | 'plan' | 'auto' | 'bypass'

export const AGENT_MODES: Array<{ id: AgentMode; label: string; description: string; icon: string }> = [
  { id: 'ask',          label: 'Запрос разрешений',   description: 'Подтверждение на каждое изменение файла и команду. По умолчанию.', icon: '🛡' },
  { id: 'accept-edits', label: 'Принимать правки',    description: 'File edits авто-принимаются. Команды всё ещё через подтверждение.', icon: '✏' },
  { id: 'plan',         label: 'Режим планирования',  description: 'Только чтение и планирование. Никаких изменений файлов и команд.', icon: '📋' },
  { id: 'auto',         label: 'Авто-режим',          description: 'Всё авто-принимается. Команды и правки без подтверждения. Осторожно.', icon: '⚡' },
  { id: 'bypass',       label: 'Без подтверждения',   description: 'Никаких диалогов. Для опытных пользователей или CI.', icon: '🚀' }
]

/** Decision for a single tool call given the active mode. */
export type ToolDecision =
  | 'confirm'      // show diff/command modal and wait for user
  | 'auto-accept'  // execute immediately, no UI prompt
  | 'block'        // refuse with a message back to the model

/**
 * Per-tool auto-approve (ось 3 I) — пользовательские категорийные тумблеры поверх mode.
 * Повышают confirm→auto-accept для ДОВЕРЕННОЙ категории (без перехода в полный auto/
 * bypass). НЕ перекрывают block — plan-режим остаётся строгим. Гранулярный контроль:
 * «доверяю правкам, но команды подтверждаю» и наоборот.
 */
export interface AutoApprove {
  edits?: boolean     // write_file / apply_patch / propose_edits / edit_spreadsheet
  commands?: boolean  // run_command / connector_query / execute_code
}

/**
 * Returns what to do with a tool call under the given mode. Used by
 * tool-handlers to short-circuit the diff/command modals.
 *
 * Logic:
 * - write_file/apply_patch/propose_edits = "edits"
 * - run_command/connector_query = "commands"
 * - read_file/list_directory/search_project/get_project_map/etc = always allowed
 *
 * connector_query гейтится как команда: коннекторы (SSH, HTTP POST/PUT/DELETE,
 * Telegram, Битрикс24, публикация) дают side-effects на внешних системах, поэтому
 * в plan-режиме («только чтение») они должны блокироваться, а в ask — подтверждаться.
 */
export function decide(toolName: string, mode: AgentMode, autoApprove?: AutoApprove): ToolDecision {
  const isEdit = toolName === 'write_file' || toolName === 'apply_patch' || toolName === 'propose_edits' || toolName === 'edit_spreadsheet'
  // execute_code (PTC) исполняет произвольный JS — vm НЕ граница безопасности, поэтому
  // trust = run_command: confirm в ask, block в plan. Без эскалации привилегий.
  const isCommand = toolName === 'run_command' || toolName === 'connector_query' || toolName === 'execute_code'

  // reads + операции с СОБСТВЕННОЙ памятью агента (memory_save/memory_invalidate/
  // core_memory_*) всегда проходят: plan-режим гейтит изменения ПРОЕКТА (файлы/команды),
  // а не курирование агентом своей памяти (дёшево, обратимо, не трогает рабочее дерево).
  if (!isEdit && !isCommand) return 'auto-accept'

  let decision: ToolDecision
  switch (mode) {
    case 'ask':          decision = 'confirm'; break
    case 'accept-edits': decision = isEdit ? 'auto-accept' : 'confirm'; break
    case 'plan':         decision = 'block'; break
    case 'auto':         decision = 'auto-accept'; break
    case 'bypass':       decision = 'auto-accept'; break
  }
  // Per-tool auto-approve: только повышаем confirm→auto-accept для доверенной категории.
  // block (plan) и без того auto-accept НЕ трогаем.
  if (decision === 'confirm' && autoApprove) {
    if (isEdit && autoApprove.edits) return 'auto-accept'
    if (isCommand && autoApprove.commands) return 'auto-accept'
  }
  return decision
}

/** Human-readable rejection message for the model when a tool is blocked by mode. */
export function blockReason(toolName: string, mode: AgentMode): string {
  if (mode === 'plan') {
    if (toolName === 'connector_query') {
      return `Активен режим "Режим планирования" — запросы к коннекторам (внешние системы: SSH, HTTP, Telegram, Битрикс24 и т.п.) запрещены, ` +
             `так как они могут менять состояние внешних систем. ` +
             `Сосредоточься на чтении кода (read_file, get_project_map, search_project) и составлении плана через create_plan. ` +
             `Пользователь сам переключит режим когда захочет выполнить запрос к коннектору.`
    }
    return `Активен режим "Режим планирования" — изменение файлов и выполнение команд запрещены. ` +
           `Сосредоточься на чтении кода (read_file, get_project_map, search_project) и составлении плана через create_plan. ` +
           `Пользователь сам переключит режим когда захочет применить изменения.`
  }
  return `Tool "${toolName}" заблокирован активным режимом "${mode}".`
}
