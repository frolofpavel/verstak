// Command-хендлер: run_command. Вынесено при распиле.
import type { ToolHandler } from './shared'
import { emitActivity, awaitCommandConfirm } from './shared'
import { scanText } from '../../ai/secret-scanner'
import { blockReason } from '../../ai/mode-policy'
import { resolveDecision } from '../../ai/permission-rules'
import { parseAllowlist, matchesAllowlist } from '../../ai/bash-allowlist'
import { hashCommandForAudit, type SmartApproveResult } from '../../ai/smart-approve'

function isSmartApproveEnabled(ctx: Parameters<ToolHandler['handle']>[1]): boolean {
  return ctx.smartApproveEnabled ?? process.env.USE_SMART_APPROVE === 'true'
}

const smartApproveEscalationsBySend = new Map<string, number>()
const MAX_SMART_APPROVE_ESCALATIONS_PER_SEND = 2

export function clearSmartApproveForSend(sendId: number | string): void {
  smartApproveEscalationsBySend.delete(String(sendId))
}

function smartApproveEscalationCount(sendId: number | string): number {
  return smartApproveEscalationsBySend.get(String(sendId)) ?? 0
}

function recordSmartApproveEscalation(sendId: number | string): void {
  const key = String(sendId)
  smartApproveEscalationsBySend.set(key, (smartApproveEscalationsBySend.get(key) ?? 0) + 1)
}

async function evaluateSmartApprove(
  command: string,
  ctx: Parameters<ToolHandler['handle']>[1]
): Promise<SmartApproveResult> {
  if (smartApproveEscalationCount(ctx.sendId) >= MAX_SMART_APPROVE_ESCALATIONS_PER_SEND) {
    return {
      verdict: 'escalate',
      reason: 'smart approval escalation limit reached for this run',
      model: 'not-called',
      durationMs: 0
    }
  }
  if (!ctx.smartApprove) {
    return {
      verdict: 'escalate',
      reason: 'smart approval is enabled but no guard provider is configured',
      model: 'unconfigured',
      durationMs: 0
    }
  }
  return ctx.smartApprove({
    command,
    cwd: ctx.projectPath,
    agentMode: ctx.agentMode,
    projectPath: ctx.projectPath
  })
}

function recordSmartApproveAudit(
  command: string,
  callId: string,
  result: SmartApproveResult,
  ctx: Parameters<ToolHandler['handle']>[1]
): void {
  if (!ctx.appendAudit) return
  try {
    const reason = scanText(result.reason).redacted.slice(0, 240)
    ctx.appendAudit('smart_approve', JSON.stringify({
      callId,
      cmd_hash: hashCommandForAudit(command),
      verdict: result.verdict,
      model: result.model,
      durationMs: result.durationMs,
      reason
    }))
  } catch { /* best-effort */ }
}

export const runCommandHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    const command = String(call.args.command ?? '')
    const verdict = ctx.tools.classifyCommand(command)
    if (!verdict.allowed) {
      ctx.sender.send('ai:event', {
        id: ctx.sendId,
        event: { type: 'tool-blocked', callId: call.id, name: 'run_command', command, reason: verdict.reason ?? 'denylist' }
      })
      return {
        id: call.id, name: call.name,
        result: `Command: ${command}`,
        error: `Blocked by safety policy: ${verdict.reason ?? 'denylist'}`
      }
    }
    // Mode policy: plan blocks, ask confirms, auto/bypass auto-accept,
    // accept-edits still confirms commands (only edits auto-pass).
    const { decision, reason: denyReason } = resolveDecision('run_command', call.args, ctx.agentMode, ctx.autoApprove, ctx.permissionRules)
    if (decision === 'block') {
      const reason = denyReason ?? blockReason('run_command', ctx.agentMode)
      ctx.sender.send('ai:event', {
        id: ctx.sendId,
        event: { type: 'tool-blocked', callId: call.id, name: 'run_command', command, reason }
      })
      return { id: call.id, name: call.name, result: '', error: reason }
    }
    // Tier-2 #4: доверенная команда (настройка bash_allowlist) авто-аппрувится в
    // confirm-режимах — без модалки. plan (block) НЕ перекрывается (вышли выше);
    // denylist (classifyCommand) уже отработал; цепочки/подстановки matchesAllowlist
    // отсекает сам.
    const allowlisted = decision !== 'auto-accept'
      && matchesAllowlist(command, parseAllowlist(ctx.getSecretForDelegate?.('bash_allowlist') ?? null))
    let forceConfirm = false
    if (isSmartApproveEnabled(ctx)) {
      const smart = await evaluateSmartApprove(command, ctx)
      recordSmartApproveAudit(command, call.id, smart, ctx)
      if (smart.verdict === 'deny') {
        const reason = `smart-approve denied: ${scanText(smart.reason).redacted}`
        ctx.sender.send('ai:event', {
          id: ctx.sendId,
          event: { type: 'tool-blocked', callId: call.id, name: 'run_command', command, reason }
        })
        return { id: call.id, name: call.name, result: `Command: ${command}`, error: reason }
      }
      if (smart.verdict === 'escalate') {
        recordSmartApproveEscalation(ctx.sendId)
        forceConfirm = true
      }
    }
    let accepted: boolean
    if (!forceConfirm && (decision === 'auto-accept' || allowlisted)) {
      ctx.sender.send('ai:event', {
        id: ctx.sendId,
        event: { type: 'tool-activity', callId: call.id, name: 'run_command', label: allowlisted ? 'run_command (авто · allowlist)' : 'run_command (авто)', detail: command, status: 'ok' }
      })
      accepted = true
    } else {
      // sendId в payload события: фоновый чат сохранит его в снапшот pendingCommand,
      // и резолв из Inbox пойдёт по строгому ключу ${sendId}::${callId}, а не по
      // collision-prone endsWith-фолбэку (ревью 24.06).
      ctx.sender.send('ai:event', { id: ctx.sendId, event: { type: 'pending-command', callId: call.id, command, sendId: ctx.sendId } })
      accepted = await awaitCommandConfirm(ctx, call.id)
    }
    if (!accepted) {
      ctx.sender.send('ai:event', { id: ctx.sendId, event: { type: 'command-result', callId: call.id, command, status: 'rejected' } })
      return { id: call.id, name: call.name, result: `Command: ${command}`, error: 'User rejected' }
    }
    try {
      const result = await ctx.tools.runCommand(command)
      // Редактируем оба потока через secret-scanner ДО отправки в UI и
      // возврата модели — иначе ключи/токены из stdout/stderr утекают в
      // контекст и в Timeline.
      const stdout = scanText(result.stdout).redacted
      const stderr = scanText(result.stderr).redacted
      ctx.sender.send('ai:event', {
        id: ctx.sendId,
        event: { type: 'command-result', callId: call.id, command, status: 'ok', exitCode: result.exitCode, stdout, stderr }
      })
      // Timeline задачи (Фаза 4): run_command не идёт через emitActivity, поэтому
      // пишем событие здесь, рядом с command-result. exitCode≠0 → status='error'.
      try { ctx.recordRunEvent?.('tool_call', { label: 'run_command', detail: command, status: result.exitCode === 0 ? 'ok' : 'error' }) } catch { /* best-effort */ }
      return { id: call.id, name: call.name, result: { stdout, stderr, exitCode: result.exitCode } }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      ctx.sender.send('ai:event', {
        id: ctx.sendId,
        event: { type: 'command-result', callId: call.id, command, status: 'error', error: msg }
      })
      try { ctx.recordRunEvent?.('tool_call', { label: 'run_command', detail: msg, status: 'error' }) } catch { /* best-effort */ }
      return { id: call.id, name: call.name, result: '', error: msg }
    }
  }
}

/**
 * Auto-debug (ось 3 E): рамка результата проверочной команды для цикла fix-until-green.
 * Чистая: exitCode + номер попытки → директива + флаги. На лимите ЧЕСТНО стопит петлю
 * (агент не должен говорить «готово», пока команда реально не зелёная — на любом стеке).
 */
export function formatAutoDebugResult(exitCode: number, attempt: number, maxAttempts: number): { passed: boolean; exhausted: boolean; directive: string } {
  if (exitCode === 0) return { passed: true, exhausted: false, directive: `✓ Команда зелёная (exit 0, попытка ${attempt}/${maxAttempts}). Проверка пройдена.` }
  if (attempt >= maxAttempts) return { passed: false, exhausted: true, directive: `✗ Команда всё ещё падает (exit ${exitCode}) после ${attempt} попыток — лимит исчерпан. ЧЕСТНО сообщи пользователю, какая команда не проходит и почему; НЕ говори «готово».` }
  return { passed: false, exhausted: false, directive: `✗ Команда упала (exit ${exitCode}), попытка ${attempt}/${maxAttempts}. Разбери ошибку выше, ПОЧИНИ причину в коде и вызови run_until_green с той же командой снова.` }
}

// Серверный счётчик попыток run_until_green per (sendId + command). Лимит НЕ доверяем
// агенту (он мог бы вечно слать attempt:1 в обход честного стопа — ревью). Ключ чистится
// на passed/exhausted/блокировке.
const runUntilGreenAttempts = new Map<string, number>()

/** Очистить счётчики попыток прогона (на завершении/abort) — иначе Map течёт per sendId. */
export function clearRunUntilGreenForSend(sendId: number): void {
  const prefix = `${sendId}::`
  for (const key of runUntilGreenAttempts.keys()) {
    if (key.startsWith(prefix)) runUntilGreenAttempts.delete(key)
  }
}

// run_until_green (ось 3 E): прогон ПРОИЗВОЛЬНОЙ команды в цикле fix-until-green. Тонкая
// обёртка над run_command — реюз денилиста/mode-policy-гейта/executor/secret-scan. Агент
// чинит между попытками (его ходы), хендлер несёт рамку с ЧЕСТНЫМ серверным лимитом.
export const runUntilGreenHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    const command = String(call.args.command ?? '').trim()
    if (!command) return { id: call.id, name: call.name, result: '', error: 'run_until_green: command обязателен' }
    const maxAttempts = Math.min(8, Math.max(1, Math.floor(Number(call.args.max_attempts) || 5)))
    const key = `${ctx.sendId}::${command}`
    const attempt = (runUntilGreenAttempts.get(key) ?? 0) + 1  // серверный счётчик, не args
    runUntilGreenAttempts.set(key, attempt)
    const res = await runCommandHandler.handle({ ...call, args: { command } }, ctx)
    if (res.error) { runUntilGreenAttempts.delete(key); return { ...res, name: call.name } } // заблокировано/отклонено
    const exitCode = (res.result as { exitCode?: number })?.exitCode ?? 0
    const framed = formatAutoDebugResult(exitCode, attempt, maxAttempts)
    if (framed.passed || framed.exhausted) runUntilGreenAttempts.delete(key) // сброс на финале петли
    return { id: call.id, name: call.name, result: { ...(res.result as object), ...framed } }
  }
}
