// Verification-хендлеры: attest_verification / create_plan / preflight. Вынесено при распиле.
import type { ToolHandler } from './shared'
import { emitActivity } from './shared'
import { planSpecFeedback } from '../../ai/task-spec-check'
import { resolvePlanGate, type PlanDecision } from '../../ai/plan-gate'
import { scanText } from '../../ai/secret-scanner'
import type { VerificationArtifact, VerificationCheck, VerificationChangedFile } from '../../ai/verification'

// Потолок проверок-с-командой на один attest — чтобы агент не превратил его в
// способ прогнать 50 команд разом. Ручные проверки сверх лимита не режем.
const MAX_VERIFICATION_CHECKS = 10
// Сколько символов вывода (stdout+stderr) сохраняем в артефакт.
const VERIFICATION_TAIL_CHARS = 800

export const attestVerificationHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    try {
      const { writeVerificationArtifact } = await import('../../ai/artifacts')
      const { computeOverall } = await import('../../ai/verification')

      const taskSummary = String(call.args.task_summary ?? '').trim()
      if (!taskSummary) return { id: call.id, name: call.name, result: '', error: 'attest_verification: task_summary обязателен' }

      const claimedFiles = Array.isArray(call.args.changed_files)
        ? call.args.changed_files.map(String).map(s => s.trim()).filter(Boolean)
        : []
      const risks = Array.isArray(call.args.risks)
        ? call.args.risks.map(String).map(s => s.trim()).filter(Boolean)
        : []
      const rawChecks = Array.isArray(call.args.checks) ? call.args.checks : []

      // --- Проверки: перепрогон команд через тот же runCommand (denylist+scanner внутри).
      const checks: VerificationCheck[] = []
      let commandRuns = 0
      for (const raw of rawChecks) {
        if (typeof raw !== 'object' || raw === null) continue
        const c = raw as Record<string, unknown>
        const command = c.command != null ? String(c.command).trim() : ''
        const summary = c.summary != null ? String(c.summary).trim() : undefined

        if (!command) {
          // Ручная проверка — статус not_run, берём summary от модели.
          checks.push({ command: null, status: 'not_run', manual: true, summary })
          continue
        }

        // Денилист: классифицируем ДО запуска. Заблокированная команда → not_run+manual,
        // причина в summary (агент сам решит, что с ней делать).
        const verdict = ctx.tools.classifyCommand(command)
        if (!verdict.allowed) {
          checks.push({
            command, status: 'not_run', manual: true,
            summary: summary ? `${summary} · заблокирована: ${verdict.reason ?? 'denylist'}` : `Заблокирована политикой: ${verdict.reason ?? 'denylist'}`
          })
          continue
        }

        // Cap: сверх лимита команды не прогоняем — фиксируем как not_run.
        if (commandRuns >= MAX_VERIFICATION_CHECKS) {
          checks.push({ command, status: 'not_run', manual: true, summary: summary ? `${summary} · не запущена (лимит проверок)` : 'Не запущена — превышен лимит проверок' })
          continue
        }
        commandRuns++

        try {
          const r = await ctx.tools.runCommand(command)
          // Доктрина: статус по exitCode, не по слову модели.
          const status: VerificationCheck['status'] = r.exitCode === 0 ? 'passed' : 'failed'
          // runCommand редактирует через secret-scanner на своём пути, но прогоняем
          // ещё раз на всякий случай — tail попадает в артефакт/контекст.
          const combined = scanText(`${r.stdout}\n${r.stderr}`).redacted.trim()
          const tail = combined.length > VERIFICATION_TAIL_CHARS
            ? combined.slice(-VERIFICATION_TAIL_CHARS)
            : (combined || undefined)
          checks.push({ command, status, manual: false, summary, exitCode: r.exitCode, tail })
          // Эфемерный фидбек в Timeline чата — видно что проверка прогнана.
          ctx.sender.send('ai:event', {
            id: ctx.sendId,
            event: { type: 'tool-activity', callId: call.id, name: 'attest_verification', label: `проверка: ${status === 'passed' ? 'OK' : 'FAIL'}`, detail: `${command} · exit ${r.exitCode}`, status: status === 'passed' ? 'ok' : 'error' }
          })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          checks.push({ command, status: 'failed', manual: false, summary, tail: scanText(msg).redacted.slice(0, VERIFICATION_TAIL_CHARS) })
        }
      }

      // --- changed_files: сверка claimed (из args) vs actual (реально записано прогоном).
      // actualSet — снимок filesTouched из ai.ts; нормализуем пути к forward-slash для сравнения.
      const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '')
      const actualList = ctx.runFilesTouched ? ctx.runFilesTouched().map(norm) : null
      const actualSet = actualList ? new Set(actualList) : null
      const changedFiles: VerificationChangedFile[] = claimedFiles.map(p => ({
        path: p,
        claimed: true,
        // Если источник actual недоступен — считаем actual=claimed (не блокируем фазу).
        actual: actualSet ? actualSet.has(norm(p)) : true
      }))
      // Файлы, реально тронутые, но НЕ заявленные агентом — тоже в артефакт (claimed=false).
      if (actualList) {
        const claimedNorm = new Set(claimedFiles.map(norm))
        for (const a of actualList) {
          if (!claimedNorm.has(a)) changedFiles.push({ path: a, claimed: false, actual: true })
        }
      }

      // --- UI screenshot: последний browser_screenshot из pendingAttachments (image/png).
      let screenshotPath: string | undefined
      if (call.args.ui_screenshot === true) {
        const shot = [...ctx.pendingAttachments].reverse().find(a => a.mimeType === 'image/png' && a.data)
        if (shot) {
          try {
            const { artifactsDir } = await import('../../ai/artifacts')
            const { mkdir, writeFile } = await import('fs/promises')
            const { join } = await import('path')
            const dir = artifactsDir(ctx.projectPath)
            await mkdir(dir, { recursive: true })
            const shotName = `verification-shot-${Date.now()}.png`
            await writeFile(join(dir, shotName), Buffer.from(shot.data, 'base64'))
            // Относительный путь — html артефакт лежит в той же папке.
            screenshotPath = shotName
          } catch { /* скриншот не критичен — пропускаем */ }
        }
      }

      const overall = computeOverall(checks)
      const art: VerificationArtifact = {
        version: 1,
        taskSummary,
        overall,
        changedFiles,
        checks,
        screenshotPath,
        risks,
        createdAt: Date.now(),
        runId: ctx.runId,
        chatId: ctx.parentChatId ?? undefined
      }

      const res = await writeVerificationArtifact(ctx.projectPath, art)
      const checksPassed = checks.filter(c => c.status === 'passed').length

      // Персист (Фаза 3): лёгкая строка истории поверх файла-артефакта. Нужна для
      // verifications.latest(chatId) в Review DoD и панели истории. Best-effort —
      // источник истины это файл, провал записи в БД не ломает attest.
      try {
        ctx.verifications?.insert({
          projectPath: ctx.projectPath,
          chatId: ctx.parentChatId ?? null,
          runId: ctx.runId ?? null,
          overall,
          checksTotal: checks.length,
          checksPassed,
          changedFilesCount: changedFiles.length,
          artifactPath: res.jsonPath,
          htmlPath: res.htmlPath,
          taskSummary,
          createdAt: art.createdAt
        })
      } catch { /* история не критична — файл-артефакт уже записан */ }

      try { ctx.recordJournal(ctx.projectPath, 'session', `${overall === 'passed' ? '✅' : overall === 'failed' ? '✗' : '⚠'} Верификация: ${overall}`, taskSummary) } catch { /* journal not critical */ }

      // artifact-created — как файл-артефакт (pill + preview), kind='verification'.
      ctx.sender.send('ai:event', {
        id: ctx.sendId,
        event: { type: 'artifact-created', callId: call.id, kind: 'verification', filename: res.filename, path: res.htmlPath, sizeBytes: res.sizeBytes }
      })
      // verification-attested — эфемерный бейдж DoD для UI.
      ctx.sender.send('ai:event', {
        id: ctx.sendId,
        event: { type: 'verification-attested', callId: call.id, overall, checksTotal: checks.length, checksPassed, changedFilesCount: changedFiles.length }
      })
      // Timeline задачи (Manager): событие verify со статусом overall.
      try { ctx.recordRunEvent?.('verify', { label: `DoD ${checksPassed}/${checks.length}`, detail: taskSummary, ref: res.htmlPath, status: overall }) } catch { /* best-effort */ }

      return {
        id: call.id, name: call.name,
        result: `Verification attested: overall=${overall}, DoD ${checksPassed}/${checks.length} проверок зелёные.\nАртефакт: ${res.htmlPath}\nСтатусы проверок поставлены по реальному exitCode перепрогона.`
      }
    } catch (err) {
      return { id: call.id, name: call.name, result: '', error: err instanceof Error ? err.message : String(err) }
    }
  }
}

export const createPlanHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    try {
      const title = String(call.args.title ?? 'План без названия')
      const rawSteps = Array.isArray(call.args.steps) ? call.args.steps : []
      const steps = rawSteps
        .filter((s: unknown): s is Record<string, unknown> => typeof s === 'object' && s !== null)
        .map((s) => ({
          title: String((s as Record<string, unknown>).title ?? ''),
          detail: (s as Record<string, unknown>).detail != null
            ? String((s as Record<string, unknown>).detail)
            : null
        }))
        .filter(s => s.title.length > 0)
      if (steps.length === 0) {
        return { id: call.id, name: call.name, result: '', error: 'create_plan: пустой список шагов' }
      }
      const plan = ctx.recordPlan(ctx.projectPath, title, steps)
      try { ctx.recordJournal(ctx.projectPath, 'note', `План: ${title}`, `${steps.length} шагов`) } catch { /* journal not critical */ }
      ctx.sender.send('ai:event', { id: ctx.sendId, event: { type: 'plan-created', planId: plan.id, title, stepCount: steps.length } })
      // #3 plan-gate: в режиме планирования БЛОКИРУЕМ-И-ЖДЁМ явного решения юзера
      // (Approve/Revise/Reject), а не просто пишем план и полагаемся на ручное
      // переключение. approve → выполнение в этом же прогоне (мутируем ctx.agentMode —
      // decide() читает его живо на каждом tool-call).
      if (ctx.agentMode === 'plan' && ctx.pendingPlans && ctx.getSecretForDelegate?.('plan_approval_gate') === 'true') {
        ctx.sender.send('ai:event', { id: ctx.sendId, event: { type: 'plan-approval', callId: call.id, planId: plan.id, title, stepCount: steps.length } })
        const pending = ctx.pendingPlans
        const key = ctx.scopedKey(ctx.sendId, call.id)
        const decision = await new Promise<{ decision: PlanDecision; feedback?: string }>(resolve => {
          let settled = false
          const finish = (d: { decision: PlanDecision; feedback?: string }) => { if (!settled) { settled = true; resolve(d) } }
          pending.set(key, { sendId: ctx.sendId, resolve: finish })
        })
        pending.delete(key)
        const outcome = resolvePlanGate(decision.decision, decision.feedback, title)
        if (outcome.newMode) ctx.agentMode = outcome.newMode
        return { id: call.id, name: call.name, result: outcome.result }
      }
      // v3 Шаг B (enforcement): фидбэк по тонким ТЗ-шагам — модель уточнит, чтобы
      // дешёвая модель-исполнитель получила точную инструкцию, а не «улучшить X».
      const specFeedback = planSpecFeedback(steps)
      return { id: call.id, name: call.name, result: `Plan #${plan.id} created with ${steps.length} steps. User will execute/confirm in the Plan view.${specFeedback}` }
    } catch (err) {
      return { id: call.id, name: call.name, result: '', error: err instanceof Error ? err.message : String(err) }
    }
  }
}

// ============================================================================
// preflight — объявление плана перед сложной/деструктивной задачей
// ============================================================================

function toStringList(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String).map(s => s.trim()).filter(Boolean) : []
}

export const preflightHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    try {
      const summary = String(call.args.summary ?? '').trim()
      if (!summary) {
        return { id: call.id, name: call.name, result: '', error: 'preflight: summary обязателен' }
      }
      const rawRisk = String(call.args.risk ?? '').trim()
      const risk: 'low' | 'medium' | 'high' = rawRisk === 'high' || rawRisk === 'medium' ? rawRisk : 'low'
      const affectedZones = toStringList(call.args.affectedZones)
      const verifyAfter = toStringList(call.args.verifyAfter)
      const outOfScope = toStringList(call.args.outOfScope)
      const riskReason = String(call.args.riskReason ?? '').trim()

      ctx.sender.send('ai:event', {
        id: ctx.sendId,
        event: { type: 'preflight', callId: call.id, summary, affectedZones, risk, riskReason, verifyAfter, outOfScope }
      })
      try { ctx.recordJournal(ctx.projectPath, 'note', `🛫 Preflight (${risk}): ${summary.slice(0, 120)}`, affectedZones.join(', ') || null) } catch { /* journal not critical */ }
      emitActivity(ctx, call, 'ok', 'preflight', `${risk} · ${summary.slice(0, 60)}`)
      return { id: call.id, name: call.name, result: 'preflight shown — продолжай выполнение задачи по объявленному плану.' }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      emitActivity(ctx, call, 'error', call.name, msg)
      return { id: call.id, name: call.name, result: '', error: msg }
    }
  }
}
