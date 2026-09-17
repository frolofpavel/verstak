// Command-хендлер: run_command. Вынесено при распиле.
import type { ToolHandler } from './shared'
import { awaitCommandConfirm } from './shared'
import { scanText } from '../../ai/secret-scanner'
import { blockReason } from '../../ai/mode-policy'
import { parseAllowlist, matchesAllowlist } from '../../ai/bash-allowlist'
import { hashCommandForAudit, type SmartApproveResult } from '../../ai/smart-approve'
import { isVerifierCommand } from '../../ai/command-policy'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { artifactsDir } from '../../ai/artifacts'
import { splitLargeOutput, commandOutputFileName, COMMAND_OUTPUT_LIMIT } from '../../ai/large-output'
import { attributeFailure, formatAttribution } from '../../ai/failure-attribution'
import { createDecisionReadback, evaluatePolicyDecision, serializeDecisionTrace } from '../../ai/policy-decision'
import type { DecisionContextV1, DecisionReadbackV1, DecisionTraceV1 } from '../../../shared/contracts/policy-decision'

export function isSmartApproveEnabled(ctx: Parameters<ToolHandler['handle']>[1]): boolean {
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

export function recordSmartApproveEscalation(sendId: number | string): void {
  const key = String(sendId)
  smartApproveEscalationsBySend.set(key, (smartApproveEscalationsBySend.get(key) ?? 0) + 1)
}

export async function evaluateSmartApprove(
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

export function recordSmartApproveAudit(
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

function commandDecisionContext(ctx: Parameters<ToolHandler['handle']>[1]): DecisionContextV1 {
  const identity = ctx.policyIdentity
  const capability = identity?.capability
    ? { ...identity.capability, trust: ctx.capabilityTrust ?? identity.capability.trust }
    : null
  return {
    schemaVersion: 1,
    policyVersion: 's2-a1-v1',
    timestamp: Date.now(),
    agentId: identity?.agentId ?? null,
    ownerId: identity?.ownerId ?? null,
    taskId: identity?.taskId ?? null,
    // A nested durable job is more specific than the run-level identity and is
    // read from server context, never from tool args.
    jobId: ctx.parentJobId ?? null,
    runId: ctx.runId ?? null,
    capability,
    mode: ctx.agentMode,
    tool: 'run_command',
    operation: 'execute',
    normalizedTarget: { kind: 'command', digest: '', scope: 'project' },
    dataClass: 'project-local',
    envelope: { costCents: null, runtimeMs: null },
    effectful: true,
  }
}

function recordPolicyTrace(ctx: Parameters<ToolHandler['handle']>[1], trace: DecisionTraceV1): void {
  if (trace.rolloutMode === 'off') return
  const detail = serializeDecisionTrace(trace)
  try { ctx.recordRunEvent?.('policy_decision', { label: trace.context.tool, detail, status: trace.enforcedDecision }) } catch { /* best-effort */ }
  try { ctx.appendAudit?.('policy_decision', detail) } catch { /* best-effort */ }
}

function recordPolicyReadback(
  ctx: Parameters<ToolHandler['handle']>[1],
  trace: DecisionTraceV1,
  readback: DecisionReadbackV1,
): void {
  if (trace.rolloutMode === 'off') return
  const detail = JSON.stringify(readback)
  try { ctx.recordRunEvent?.('policy_result', { label: 'run_command', detail, status: readback.status }) } catch { /* best-effort */ }
  try { ctx.appendAudit?.('policy_result', detail) } catch { /* best-effort */ }
}

export const runCommandHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    const command = String(call.args.command ?? '')
    let hardDenyReason: string | undefined
    let hardDenyResponse: string | undefined
    if (ctx.parentJobId && ctx.agentJobs) {
      const job = ctx.agentJobs.get(ctx.parentJobId)
      if (!job) {
        hardDenyReason = 'agent-job-not-found'
        hardDenyResponse = 'Agent Job не найдена: команда безопасно остановлена.'
      } else {
        const unrestrictedWriter = job.writeScope.includes('**')
        if (!unrestrictedWriter && !isVerifierCommand(command)) {
          const reason = job.writeScope.length === 0
            ? 'Read-only Agent Job может запускать только проверочные команды.'
            : 'Команда может писать вне ограниченного write scope; используй write_file/apply_patch или расширь scope через решение пользователя.'
          hardDenyReason = 'agent-job-scope-deny'
          hardDenyResponse = reason
        }
      }
    }
    const verdict = ctx.tools.classifyCommand(command)
    if (!verdict.allowed && !hardDenyReason) {
      hardDenyReason = verdict.reason ?? 'denylist'
      hardDenyResponse = `Blocked by safety policy: ${verdict.reason ?? 'denylist'}`
    }
    const policy = evaluatePolicyDecision({
      context: commandDecisionContext(ctx),
      args: call.args,
      autoApprove: ctx.autoApprove,
      permissionRules: ctx.permissionRules,
      capabilityTrust: ctx.capabilityTrust,
      featureMode: ctx.policyDecisionMode,
      hardDenyReason,
    })
    recordPolicyTrace(ctx, policy.trace)
    const decision = policy.decision === 'deny'
      ? 'block'
      : policy.decision === 'require_confirmation' ? 'confirm' : 'auto-accept'
    const confirmCause = policy.confirmCause
    if (decision === 'block') {
      const reason = hardDenyResponse ?? policy.denyReason ?? blockReason('run_command', ctx.agentMode)
      ctx.sender.send('ai:event', {
        id: ctx.sendId,
        event: { type: 'tool-blocked', callId: call.id, name: 'run_command', command, reason }
      })
      recordPolicyReadback(ctx, policy.trace, createDecisionReadback(policy.trace, { status: 'blocked' }))
      return {
        id: call.id,
        name: call.name,
        result: hardDenyResponse?.startsWith('Blocked by safety policy:') ? `Command: ${command}` : '',
        error: reason,
      }
    }
    // Tier-2 #4: доверенная команда (настройка bash_allowlist) авто-аппрувится —
    // но ТОЛЬКО когда подтверждения требует РЕЖИМ (confirmCause === 'mode').
    // Ответственное действие и явное ask-правило пользователя allowlist не гасит:
    // совпадение префиксное, и `git` в списке ради `git status` иначе молча
    // пропускал бы `git push` (обход №4, 30.07). plan (block) НЕ перекрывается
    // (вышли выше); denylist (classifyCommand) уже отработал; цепочки/подстановки
    // matchesAllowlist отсекает сам.
    const allowlisted = decision !== 'auto-accept'
      && confirmCause === 'mode'
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
        recordPolicyReadback(ctx, policy.trace, createDecisionReadback(policy.trace, { status: 'blocked' }))
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
      ctx.sender.send('ai:event', { id: ctx.sendId, event: { type: 'pending-command', callId: call.id, command, toolName: call.name, sendId: ctx.sendId } })
      accepted = await awaitCommandConfirm(ctx, call.id, { toolName: call.name, subject: command })
    }
    if (!accepted) {
      ctx.sender.send('ai:event', { id: ctx.sendId, event: { type: 'command-result', callId: call.id, command, status: 'rejected' } })
      recordPolicyReadback(ctx, policy.trace, createDecisionReadback(policy.trace, { status: 'rejected' }))
      return { id: call.id, name: call.name, result: `Command: ${command}`, error: 'User rejected' }
    }
    try {
      const result = await ctx.tools.runCommand(command)
      // Редактируем оба потока через secret-scanner ДО отправки в UI и
      // возврата модели — иначе ключи/токены из stdout/stderr утекают в
      // контекст и в Timeline.
      const stdout = scanText(result.stdout).redacted
      const stderr = scanText(result.stderr).redacted
      recordPolicyReadback(ctx, policy.trace, createDecisionReadback(policy.trace, {
        status: result.exitCode === 0 ? 'ok' : 'error',
        exitCode: result.exitCode,
        stdout,
        stderr,
      }))
      ctx.sender.send('ai:event', {
        id: ctx.sendId,
        event: { type: 'command-result', callId: call.id, command, status: 'ok', exitCode: result.exitCode, stdout, stderr }
      })
      // Timeline задачи (Фаза 4): run_command не идёт через emitActivity, поэтому
      // пишем событие здесь, рядом с command-result. exitCode≠0 → status='error'.
      try { ctx.recordRunEvent?.('tool_call', { label: 'run_command', detail: command, status: result.exitCode === 0 ? 'ok' : 'error' }) } catch { /* best-effort */ }

      // Человеку в Timeline вывод ушёл ЦЕЛИКОМ (событие выше). Модели отдаём урезанную
      // копию: `npm test` на десятки тысяч символов иначе съедает окно и деньги.
      // Полный текст кладём файлом — модель дочитает нужное через read_file.
      const full = stdout + (stderr ? `\n[stderr]\n${stderr}` : '')
      let savedPath: string | null = null
      if (full.length > COMMAND_OUTPUT_LIMIT && ctx.projectPath) {
        try {
          const dir = artifactsDir(ctx.projectPath)
          mkdirSync(dir, { recursive: true })
          const file = join(dir, commandOutputFileName(Date.now()))
          writeFileSync(file, `$ ${command}\n\n${full}`, 'utf8')
          savedPath = file
        } catch { /* splitLargeOutput честно скажет, что пропущенного нет */ }
      }
      // Почему упало: условие прогона или код. При падении добавляем шапку с
      // причиной — иначе модель начинает менять логику там, где виновато окружение
      // (открытое приложение держит нативный модуль, занят файл, оборвался прогон).
      // Причина не опознана → шапки нет: молчание честнее догадки.
      const attribution = result.exitCode === 0 ? '' : formatAttribution(attributeFailure(full, result.exitCode))
      return {
        id: call.id,
        name: call.name,
        result: {
          stdout: splitLargeOutput(stdout, savedPath).forModel,
          stderr: attribution + splitLargeOutput(stderr, savedPath).forModel,
          exitCode: result.exitCode
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      recordPolicyReadback(ctx, policy.trace, createDecisionReadback(policy.trace, { status: 'error', stderr: scanText(msg).redacted }))
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
