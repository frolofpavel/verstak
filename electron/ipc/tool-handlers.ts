/**
 * Tool handlers — extracted from runApiConversation.
 *
 * Each handler takes a normalized ToolContext + the tool call, and returns a
 * ToolResult. Handlers also have side-effects (UI events, journal entries,
 * attachment collection) that they perform via ctx callbacks.
 *
 * The dispatch table (HANDLER_REGISTRY) maps tool name → handler entry.
 * `mode` controls how the agentic loop schedules execution:
 *
 *   'parallel-read' — pure-info tools (read_file/list_directory/search_project/
 *                     find_files/get_project_map/refresh_project_map).
 *                     Fired in parallel via Promise.all — no UI side effects
 *                     or shared mutable state.
 *
 *   'sequential'    — tools that need to run in order or have UI effects
 *                     (run_command, browser_*, list_connectors,
 *                     connector_query, create_plan).
 *
 *   'confirm-write' — tools that go through the multi-file diff confirm
 *                     modal (write_file, apply_patch, propose_edits). Collected
 *                     into writePromises and awaited together so the user gets
 *                     ONE modal for all writes in a turn.
 */

import { randomUUID } from 'crypto'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { join, resolve, relative, isAbsolute } from 'path'
import type { Attachment, ToolCall, ToolResult } from '../ai/types'
import { applySearchReplaceBlocks, type FileTools } from '../ai/tools'
import { decide, blockReason, type AgentMode } from '../ai/mode-policy'
import { planSpecFeedback } from '../ai/task-spec-check'
import { classifyMcpToolScope, mcpDecision, mcpBlockReason } from '../ai/mcp-policy'
import { getRolePrompt } from '../ai/agent-roles'
import { invalidateProjectMap, markFileDirty } from '../ai/project-map'
import { scanText, isForbiddenPath } from '../ai/secret-scanner'
import { safeRealJoin } from '../ai/path-policy'
import type { McpClient } from '../mcp/client'
import type { ProviderId, CreateOptions } from '../ai/registry'
import type { VerificationArtifact, VerificationCheck, VerificationChangedFile } from '../ai/verification'
import { createSshBackend, makeSshExec, parseSshProjectPath } from '../projects/ssh-backend'

const execFileAsync = promisify(execFile)


// Типы и общие хелперы вынесены в ./tool-handlers/shared (распил монолита tool-handlers.ts).
import { emitActivity, awaitCommandConfirm, summarizeToolCall } from './tool-handlers/shared'
import { delegateTaskHandler, delegateParallelHandler, orchestrateHandler, swarmHandler } from './tool-handlers/delegation'
export { dedupeTaskIds, parseDecomposition, decomposeGoal, buildSwarmRoster } from './tool-handlers/delegation'
import { runCommandHandler } from './tool-handlers/command'
import { browserHandler } from './tool-handlers/browser'
import { readHandler, writeFileHandler, applyPatchHandler, proposeEditsHandler } from './tool-handlers/file-ops'
import { listConnectorsHandler, connectorQueryHandler } from './tool-handlers/connectors'
import { readJournalHandler } from './tool-handlers/journal'
import { checkDiagnosticsHandler, conversationSearchHandler, impactAnalysisHandler } from './tool-handlers/diagnostics'
export { buildRemoteTscCommand } from './tool-handlers/diagnostics'
import { convertFileHandler, editSpreadsheetHandler } from './tool-handlers/files'
export { convertFileHandler } from './tool-handlers/files'
import { attestVerificationHandler, createPlanHandler, preflightHandler } from './tool-handlers/verification'
import { memorySaveHandler, memorySearchHandler, coreMemoryAppendHandler, coreMemoryReplaceHandler, coreMemoryRemoveHandler } from './tool-handlers/memory'
import { screenCaptureHandler, screenInfoHandler } from './tool-handlers/screen'
import { mcpToolHandler } from './tool-handlers/mcp'
import { todoCreateHandler, todoUpdateHandler, todoListHandler } from './tool-handlers/todos'
import type { SendId, TaggedSender, ConnectorRegistry, ToolContext, ToolMode, ToolHandler } from './tool-handlers/shared'
// Реэкспорт типов для внешних импортов (sub-agent-loop импортит ToolContext отсюда).
export type { SendId, TaggedSender, ConnectorRegistry, ToolContext, ToolMode, ToolHandler }
import { renderChartHandler, generateHtmlHandler, generateDocxHandler } from './tool-handlers/artifacts'






// ============================================================================
// Plans: create_plan

// ============================================================================
// Sub-provider create-options — добор секретов под 18 провайдеров (Фаза 1)

// ============================================================================





// ============================================================================
// MCP tool handler — роутит вызов к mcpClient

// ============================================================================
// Office: read_spreadsheet / read_document / edit_spreadsheet — «beyond code»
// ============================================================================

// Чтение xlsx/docx — pure-info, идёт через generic readHandler (ctx.tools.execute).
// Здесь только edit_spreadsheet: WRITE-операция, гейтится mode-policy как write_file.
// Diff текстом не показываем (xlsx бинарный) — подтверждаем через ту же модалку
// команды (pending-command), показывая список правок ячеек.


// ============================================================================
// Registry — single source of truth for tool dispatch
// ============================================================================

const HANDLER_REGISTRY: Record<string, ToolHandler> = {
  // Confirm-write — go through the diff modal
  'write_file': writeFileHandler,
  'apply_patch': applyPatchHandler,
  'propose_edits': proposeEditsHandler,
  // Sequential, side-effecting
  'run_command': runCommandHandler,
  'browser_navigate': browserHandler,
  'browser_read_page': browserHandler,
  'browser_screenshot': browserHandler,
  'list_connectors': listConnectorsHandler,
  'connector_query': connectorQueryHandler,
  'create_plan': createPlanHandler,
  // TodoGate (Фаза 3) — оркестрационный todo-лист сессии
  'todo_create': todoCreateHandler,
  'todo_update': todoUpdateHandler,
  'todo_list': todoListHandler,
  'preflight': preflightHandler,
  'read_journal': readJournalHandler,
  'generate_html': generateHtmlHandler,
  'generate_docx': generateDocxHandler,
  'render_chart': renderChartHandler,
  // Verification Artifact (DoD) — перепрогон проверок, статус по exitCode
  'attest_verification': attestVerificationHandler,
  'delegate_task': delegateTaskHandler,
  'delegate_parallel': delegateParallelHandler,
  'orchestrate': orchestrateHandler,
  // Agent Swarms (Фаза 4, Идея 10) — рой агентов с консенсусом-арбитром
  'swarm': swarmHandler,
  'memory_save': memorySaveHandler,
  'memory_search': memorySearchHandler,
  // Core Memory (Hermes-style) — sequential, file-backed, no user confirmation
  'core_memory_append': coreMemoryAppendHandler,
  'core_memory_replace': coreMemoryReplaceHandler,
  'core_memory_remove': coreMemoryRemoveHandler,
  // Diagnostics — parallel-read, no user confirmation needed
  'check_diagnostics': checkDiagnosticsHandler,
  // Code intelligence — parallel-read
  'impact_analysis': impactAnalysisHandler,
  // Conversation history search — parallel-read, FTS5
  'conversation_search': conversationSearchHandler,
  // File conversion — parallel-read, no user confirmation needed
  'convert_file': convertFileHandler,
  // Screen capture — parallel-read, Electron desktopCapturer
  'screen_capture': screenCaptureHandler,
  'screen_info': screenInfoHandler,
  // Office «beyond code» — чтение parallel-read (через readHandler), правка confirm-write
  'read_spreadsheet': readHandler,
  'read_document': readHandler,
  'edit_spreadsheet': editSpreadsheetHandler
}

/**
 * Look up the handler for a tool call. Falls back to the generic parallel-read
 * handler (which calls into ctx.tools.execute) for anything not explicitly
 * registered — that's the safe default for new pure-info tools.
 *
 * MCP tools: если имя не найдено в registry и передан ctx.mcpClient —
 * роутим к mcpToolHandler. Так как lookupHandler не имеет ctx, проверка
 * происходит в mcpToolHandler.handle через поиск в mcpClient.getAllTools().
 */
export function lookupHandler(name: string, ctx?: { mcpClient?: import('../mcp/client').McpClient }): ToolHandler {
  const registered = HANDLER_REGISTRY[name]
  if (registered) return registered
  // Если есть mcpClient и инструмент среди MCP tools — роутим к MCP handler
  if (ctx?.mcpClient) {
    const allMcpTools = ctx.mcpClient.getAllTools()
    if (allMcpTools.some(t => t.name === name)) {
      return mcpToolHandler
    }
  }
  return readHandler
}
