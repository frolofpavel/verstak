// Browser-хендлер: все browser_* вызовы проходят через единый BrowserController
// chokepoint (EXT-B0, BR-011). До B0 handler дёргал verstakBrowser напрямую
// без policy gate — теперь это запрещено.
//
// Контракт (план §9 Phase B0):
//   • Любой browser_* call → controller.dispatch({ actionType, payload, scope }).
//   • Risk classify + mode gating + approval — в controller.
//   • R3 (require-approval) → эмитим ai:event 'pending-browser-action' со scoped
//     payload (digest + snapshot), ждём resolver от UI (новый транспорт без
//     boolean-only/suffix-fallback, BR-017).
//   • R0/R1/R2 → controller execute синхронно.
//   • R4 (block) → возвращаем модели понятную ошибку.
//
// Существующий BrowserView (webview) продолжает работать — controller сам пикает
// webview adapter первым. Chrome extension adapter — stub до EXT-B1.

import type { ToolHandler, ToolContext } from './shared'
import type { ToolCall, ToolResult } from '../../ai/types'
import { emitActivity, summarizeToolCall } from './shared'
import { addProofFrame } from '../../ai/proof-frames'
import type { BrowserController } from '../../ai/browser/controller'
import type { BrowserActionType } from '../../ai/browser/types'

// ── Mapping tool name → BrowserActionType ────────────────────────────────────
// Старые tool names (browser_navigate/read_page/click/screenshot) маппим на
// новые action types. В B0 сохраняем все 4 рабочих + добавляем observe как alias
// для read_page.

const TOOL_TO_ACTION: Record<string, BrowserActionType> = {
  'browser_navigate': 'navigate',
  'browser_read_page': 'observe',   // R0 — чтение = observe
  'browser_click': 'click',
  'browser_screenshot': 'screenshot',
  // Будущие tools (browser_type_text/select_option/etc.) добавлять сюда.
}

export interface BrowserHandlerDeps {
  /** Контроллер — единый chokepoint. Если не передан (старый path), handler
   *  деградирует к прямому verstakBrowser-вызову БЕЗ policy — только для
   *  обратной совместимости на случай, если controller не инициализирован. */
  controller?: BrowserController
  /** Один browserTaskId на активный run (контекст stream'а). Пока нет реальной
   *  интеграции с chat session — используем deterministic id = `bt-${chatId}`. */
  resolveTaskId?: (ctx: ToolContext) => string
  /** Callback для эмитации pending-browser-action события в renderer. */
  emitPendingBrowserAction?: (
    ctx: ToolContext,
    payload: {
      callId: string
      actionId: string
      browserTaskId: string
      runId: string
      risk: string
      decision: string
      approvalDigest: string
      snapshot: unknown
      reason: string
    }
  ) => void
  /** Ждать resolver UI для pending-browser-action. Возвращает approved (true)
   *  или rejected/false. */
  awaitBrowserApproval?: (
    ctx: ToolContext,
    actionId: string,
    abortSignal: AbortSignal
  ) => Promise<{ approved: boolean; approvalDigest: string }>
  /** Максимальное ожидание реально доступного approval UI. */
  approvalTimeoutMs?: number
}

let depsRef: BrowserHandlerDeps = {}
export const BROWSER_APPROVAL_TIMEOUT_MS = 2 * 60 * 1000

/** Регистрируется один раз при старте main process (см. integration в ai.ts). */
export function configureBrowserHandler(deps: BrowserHandlerDeps): void {
  depsRef = { ...deps }
}

async function dispatchBrowser(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  const actionType = TOOL_TO_ACTION[call.name] ?? null
  const controller = depsRef.controller

  // R1 Block 1: FAIL-CLOSED. Если controller не сконфигурирован — никаких
  // прямых verstakBrowser-вызовов. Старый legacyDispatch удалён: он обходил
  // policy/approval/capability/ledger/crash protection, что прямо запрещено
  // контрактом R1. В production controller всегда есть (создаётся в main.ts).
  // В тестах без controller'а handler отказывает с понятным сообщением.
  if (!controller) {
    return {
      id: call.id, name: call.name, result: '',
      error: 'BrowserController не сконфигурирован — browser actions заблокированы (fail-closed). В production controller создаётся в main.ts.',
    }
  }

  if (!actionType) {
    return { id: call.id, name: call.name, result: '', error: `Unknown browser tool: ${call.name}` }
  }

  const taskId = depsRef.resolveTaskId ? depsRef.resolveTaskId(ctx) : `bt-${ctx.runId ?? ctx.sendId}`
  const runId = ctx.runId ?? `run-${ctx.sendId}`
  const args = call.args ?? {}

  // ── R3 path: показываем approval UI, ждём consume ─────────────────────
  // Сначала propose (без approval). Если decision=require-approval → emit.
  const proposeResult = await controller.dispatch({
    browserTaskId: taskId,
    runId,
    actionType,
    payload: args as Record<string, unknown>,
    scope: {},
  })

  if (proposeResult.decision.kind === 'block') {
    return { id: call.id, name: call.name, result: '', error: proposeResult.error ?? 'blocked by policy' }
  }

  if (proposeResult.pendingApproval && proposeResult.decision.kind === 'require-approval') {
    // Emit ai:event для renderer'а показать approval modal.
    if (depsRef.emitPendingBrowserAction) {
      depsRef.emitPendingBrowserAction(ctx, {
        callId: call.id,
        actionId: proposeResult.actionId,
        browserTaskId: taskId,
        runId,
        risk: proposeResult.risk,
        decision: proposeResult.decision.kind,
        approvalDigest: proposeResult.pendingApproval.approvalDigest,
        snapshot: proposeResult.pendingApproval.snapshot,
        reason: proposeResult.decision.reason,
      })
    }
    // Ждём решения UI.
    if (depsRef.awaitBrowserApproval) {
      const approval = await waitForBrowserApproval(
        depsRef.awaitBrowserApproval(ctx, proposeResult.actionId, ctx.signal),
        depsRef.approvalTimeoutMs ?? BROWSER_APPROVAL_TIMEOUT_MS,
      )
      const { approved, approvalDigest } = approval
      if (!approved) {
        const error = approval.timedOut
          ? 'Approval UI не ответил вовремя — browser action безопасно отменён.'
          : approval.failed
            ? `Approval UI недоступен — browser action отменён: ${approval.failed}`
            : 'Пользователь отклонил browser action.'
        return { id: call.id, name: call.name, result: '', error }
      }
      // R1 Block 3: approveAndExecute берёт action из ledger по actionId.
      // Digest из UI — для сверки контроллером (canonical digest должен совпасть).
      const execResult = await controller.approveAndExecute(proposeResult.actionId, approvalDigest)
      return finalizeBrowserResult(call, execResult, ctx)
    }
    // Нет awaitBrowserApproval — не можем ждать UI; возвращаем модель как error.
    return { id: call.id, name: call.name, result: '', error: 'Требуется approval browser action, но UI transport не сконфигурирован.' }
  }

  // ── R0/R1/R2 auto path — результат уже в proposeResult ─────────────────
  return finalizeBrowserResult(call, proposeResult, ctx)
}

async function waitForBrowserApproval(
  pending: Promise<{ approved: boolean; approvalDigest: string }>,
  timeoutMs: number,
): Promise<{ approved: boolean; approvalDigest: string; timedOut?: boolean; failed?: string }> {
  const boundedMs = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(timeoutMs, BROWSER_APPROVAL_TIMEOUT_MS)) : BROWSER_APPROVAL_TIMEOUT_MS
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      pending.catch(err => ({
        approved: false,
        approvalDigest: '',
        failed: err instanceof Error ? err.message : String(err),
      })),
      new Promise<{ approved: false; approvalDigest: ''; timedOut: true }>(resolve => {
        timer = setTimeout(() => resolve({ approved: false, approvalDigest: '', timedOut: true }), boundedMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function finalizeBrowserResult(call: ToolCall, r: import('../../ai/browser/controller').DispatchResult, ctx: ToolContext): ToolResult {
  if (!r.ok && !r.result) {
    return { id: call.id, name: call.name, result: '', error: r.error ?? 'browser action failed' }
  }
  const status = r.result?.status ?? 'verified'
  if (status === 'blocked') {
    return { id: call.id, name: call.name, result: '', error: `Blocked: ${r.result?.reason ?? 'неизвестно'} — ${r.result?.detail ?? ''}` }
  }
  if (status === 'failed') {
    return { id: call.id, name: call.name, result: '', error: `Failed: ${r.result?.detail ?? 'неизвестно'}` }
  }
  // verified / uncertain. R1 Block 5: модель получает UNTRUSTED ENVELOPE
  // (r.observationForModel.text — это warning + scanText-redacted text), а НЕ
  // raw obs.text. Контент страницы — данные, не инструкции.
  const result: Record<string, unknown> = {
    actionId: r.actionId,
    risk: r.risk,
    status,
    finalUrl: r.result?.finalUrl ?? null,
  }
  if (status === 'uncertain') {
    result.warning = 'Действие выполнено с неясным результатом. Перечитай страницу перед следующим шагом; НЕ повторяй это действие автоматически.'
  }
  if (r.observationForModel) {
    // Untrusted envelope — главная поверхность для модели. Включает warning
    // о недоверенном содержимом первой строкой + redacted text/tables/controls.
    result.observationText = r.observationForModel.text
    if (r.observationForModel.redactionHits.length > 0) {
      result.redacted = r.observationForModel.redactionHits
    }
    if (r.observationForModel.truncated) {
      result.truncated = true
    }
  } else if (r.result?.postObservation) {
    // Fallback: если controller не собрал envelope (R0 без runExecute path),
    // передаём минимальные метаданные без raw text.
    const obs = r.result.postObservation
    result.url = obs.source.url
    result.title = obs.source.title
    result.origin = obs.source.origin
    result.tenant = obs.tenant
    result.account = obs.account
  }
  if (r.result?.postObservation?.screenshotDataUrl) {
    // R1 Block 5: screenshot уже прошёл isScreenshotSafeForModel в controller
    // (fail-closed на sensitive URL). Если он дошёл сюда — можно передать.
    result.screenshotAttached = true
    try {
      const m = /^data:(image\/[\w+-]+);base64,(.+)$/.exec(r.result.postObservation.screenshotDataUrl)
      if (m) {
        ctx.pendingAttachments.push({
          name: `screenshot-${Date.now()}.png`,
          mimeType: m[1],
          data: m[2],
          size: Math.floor(m[2].length * 0.75),
        })
        try { addProofFrame(Number(ctx.sendId), Buffer.from(m[2], 'base64')) } catch { /* best-effort */ }
      }
    } catch { /* ignore */ }
  }
  return { id: call.id, name: call.name, result }
}

export const browserHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    const result = await dispatchBrowser(call, ctx)
    try {
      if (!result.error) {
        const url = String(call.args?.url ?? '')
        const label = call.name === 'browser_navigate' ? `Браузер → ${url}`
                    : call.name === 'browser_read_page' ? `Браузер: прочитан текст`
                    : `Браузер: скриншот`
        ctx.recordJournal(ctx.projectPath, 'tool', label, null)
      }
    } catch { /* journal not critical */ }
    const s = summarizeToolCall(call.name, call.args, undefined)
    if (s) emitActivity(ctx, call, result.error ? 'error' : 'ok', s.label, s.detail)
    return result
  }
}
