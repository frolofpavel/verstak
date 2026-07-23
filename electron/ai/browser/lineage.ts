// lineage.ts — фасад над browser-tasks.ts для run-lineage операций (BR-015).
//
// Storage (electron/storage/browser-tasks.ts) — источник истины для таблиц.
// Этот файл — чистая логика/controller-layer: создаёт task, добавляет run в
// lineage, делает handoff при provider switch. НЕ дублирует SQL.
//
// «Каждый run_id по-прежнему честно фиксирует requested/actual provider и свой
// lifecycle, а browserTaskId связывает попытки в одно поручение и хранит
// provider-neutral checkpoint.» (план §4.1)

import type { BrowserTasks, BrowserTaskRunRow, HandoffReason } from '../../storage/browser-tasks'
import type { BrowserTaskId, RunId } from './types'

export interface CreateTaskOptions {
  browserTaskId: BrowserTaskId
  projectPath: string
  chatId?: number | null
  clientId?: string | null
  runId?: RunId | null
  providerId?: string | null
  model?: string | null
  allowedDomains?: string[]
  /** B0/R2: seed mode (webview local → execute, чтобы R3 шёл в approval UI). */
  browserMode?: 'watch' | 'prepare' | 'execute'
  caps?: Record<string, unknown>
  dataPolicy?: Record<string, unknown>
}

/**
 * Создаёт новый task с опциональным первым run'ом. Если task с таким id уже
 * существует — no-op (возвращает существующий). Это для идемпотентности на
 * случай replay/duplicate send.
 */
export function ensureTask(bt: BrowserTasks, opts: CreateTaskOptions) {
  const existing = bt.get(opts.browserTaskId)
  if (existing) return existing
  return bt.create({
    browserTaskId: opts.browserTaskId,
    projectPath: opts.projectPath,
    chatId: opts.chatId ?? null,
    clientId: opts.clientId ?? null,
    runId: opts.runId ?? null,
    providerId: opts.providerId ?? null,
    model: opts.model ?? null,
    allowedDomains: opts.allowedDomains ?? [],
    browserMode: opts.browserMode,
    caps: opts.caps,
    dataPolicy: opts.dataPolicy,
  })
}

/**
 * Привязывает новый run к существующему task. Если run уже в lineage — no-op
 * (идемпотентность UNIQUE(browser_task_id, run_id)). Иначе — appendRun.
 *
 * Сценарии:
 *   • new ai:send → тот же browserTaskId, новый runId → appendRun('new_send')
 *   • provider fallback → appendRun('provider_switch')
 *   • Pause/Resume → appendRun('pause_resume')
 */
export function attachRun(bt: BrowserTasks, input: {
  browserTaskId: BrowserTaskId
  runId: RunId
  providerId?: string | null
  model?: string | null
  handoffReason?: HandoffReason
}): BrowserTaskRunRow {
  // Проверим, что этот run уже не в lineage — тогда no-op append (UNIQUE guard).
  const lin = bt.lineage(input.browserTaskId)
  if (lin.some(r => r.runId === input.runId)) {
    return lin.find(r => r.runId === input.runId)!
  }
  return bt.appendRun({
    browserTaskId: input.browserTaskId,
    runId: input.runId,
    providerId: input.providerId ?? null,
    model: input.model ?? null,
    handoffReason: input.handoffReason ?? 'new_send',
  })
}

/**
 * Handoff: сменить провайдера для продолжения той же задачи. Возвращает новый
 * «головной» run. Старый run закрывается (ended_at), новый становится current.
 *
 * Используется в controller'е при 429/forced fallback (план §6).
 */
export function handoffToProvider(bt: BrowserTasks, input: {
  browserTaskId: BrowserTaskId
  newRunId: RunId
  newProviderId?: string | null
  newModel?: string | null
  reason?: HandoffReason
}): BrowserTaskRunRow {
  return bt.handoffTo({
    browserTaskId: input.browserTaskId,
    runId: input.newRunId,
    providerId: input.newProviderId ?? null,
    model: input.newModel ?? null,
    handoffReason: input.reason ?? 'provider_switch',
  })
}

/**
 * Возвращает упорядоченный lineage задачи для аудита/UI. Wrap над bt.lineage.
 */
export function getLineage(bt: BrowserTasks, browserTaskId: BrowserTaskId): BrowserTaskRunRow[] {
  return bt.lineage(browserTaskId)
}

/**
 * Возвращает текущий (головной) run задачи — где сейчас «работает» модель.
 */
export function getCurrentRun(bt: BrowserTasks, browserTaskId: BrowserTaskId): BrowserTaskRunRow | null {
  return bt.currentRun(browserTaskId)
}

/**
 * Проверяет, валиден ли run для продолжения: он должен быть головным (последним
 * в lineage) и не завершённым. Используется в controller'е перед dispatch:
 * если runId не current — мы, возможно, обрабатываем event от старого провайдера
 * после handoff'а, и его actions не должны исполняться.
 */
export function isActiveRun(bt: BrowserTasks, browserTaskId: BrowserTaskId, runId: RunId): boolean {
  const current = bt.currentRun(browserTaskId)
  if (!current) return false
  if (current.runId !== runId) return false
  return current.endedAt == null
}
