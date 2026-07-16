// CLI-путь агентного прогона (распил ai.ts, 1.9.8 #1, срез 4b).
//
// Вынесено из ipc/ai.ts БЕЗ изменения логики. runPlainConversation — весь CLI-путь
// (claude/codex/grok/gemini): projected tool-таймлайн, Control Envelope git-якорь,
// account-switch на лимите, fallback. Покрыт харнесом tests/ipc/plain-loop.test.ts —
// он и подтверждает идентичность поведения после переезда.

import type { TaggedSender } from '../ipc/tool-handlers/shared'
import type { ChatProvider, ChatMessage } from './types'
import { PROVIDERS, type ProviderId } from './registry'
import type { InputAccounting } from '../../shared/contracts/usage'
import type { AgentRuns } from '../storage/agent-runs'
import { usageHash } from '../storage/agent-run-usage'
import { type FallbackOpts, MAX_FALLBACK_ATTEMPTS, MAX_ACCOUNT_SWITCHES } from './runner-shared'
import { type ExitReason, writeSessionJournal } from './session-journal'
import { createCostGuard } from './cost-guard'
import { captureControlCheckpoint, buildRunProvenance, serializeEnvelope, anchorStash, pruneEnvelopeStashes } from './control-envelope'
import { secretProtectionLevel } from './cli-security-capabilities'
import { detectSubscriptionLimit } from './subscription-limits'
import { redactForDisplay } from './secret-scanner'
import { emitAgentProgress, compactProgressText, modelProgressLabel, createModelWaitHeartbeat } from './runner-progress'
import { registerConversationSupplements, unregisterConversationSupplements, formatConversationSupplement } from './runner-supplements'
import { logRuntime, logRuntimeError } from '../runtime-log'
import { isAgentRunTimeoutAbort, exitReasonToAgentRunStatus } from './run-lifecycle'
import { classifyProviderError } from './provider-error'
import { shouldFallback, getNextFallback } from './smart-fallback'
import { classifyRouteReason, routeChangedText } from './route-policy'

export async function runPlainConversation(
  sender: TaggedSender,
  sendId: number,
  provider: ChatProvider,
  projectPath: string | null,
  messages: ChatMessage[],
  signal: AbortSignal,
  recordJournal: (projectPath: string, kind: 'tool' | 'session' | 'note', title: string, detail?: string | null) => void,
  costGuard?: ReturnType<typeof createCostGuard>,
  providerId?: ProviderId,
  model?: string,
  fallbackOpts?: FallbackOpts,
  agentRuns?: AgentRuns,
  runId?: string
): Promise<void> {
  const startedAt = Date.now()
  logRuntime('ai.runner.loop_start', {
    sendId,
    runId: runId ?? null,
    path: 'plain',
    projectPath,
    providerId: providerId ?? null,
    model: model ?? null,
    messageCount: messages.length
  })
  // Пре-прерванный сигнал: закрываем стрим сразу (renderer ждёт терминальный
  // done), без envelope-работы и вызова провайдера. Харнес 1.9.6 #5 выявил, что
  // при уже-aborted сигнале while-цикл не выполнялся и done не эмитился → зависший
  // стрим. В проде сигнал свежий, но гарантия «done на любом выходе» важна.
  if (signal.aborted) {
    sender.send('ai:event', { id: sendId, event: { type: 'done' } })
    return
  }
  // Control Envelope (срез 4): перед CLI-прогоном ставим честный git-якорь отката.
  // CLI пишет файлы ВНУТРИ бинаря, мимо undo-стека Verstak — единственная реальная
  // точка отката его внешних правок это git (HEAD + недеструктивный stash-снапшот
  // грязных tracked-правок). Ставится ДАЖЕ на one-shot; событие видно в Timeline,
  // нота honestly говорит что именно вне контроля. Секретов не несёт.
  if (providerId && providerId.endsWith('-cli') && projectPath) {
    try {
      const checkpoint = captureControlCheckpoint(projectPath, startedAt)
      // 1.9.7 #2: закрепить stash-снапшот ref'ом (git gc иначе выгребет висячий
      // commit) + оппортунистическая TTL-чистка старых (7 дней). Best-effort.
      if (checkpoint.stashRef && runId) {
        try {
          anchorStash(projectPath, runId, checkpoint.stashRef)
          pruneEnvelopeStashes(projectPath, 7 * 24 * 3600 * 1000, startedAt)
        } catch { /* удержание snapshot не критично */ }
      }
      const provenance = buildRunProvenance({ providerId, model: model ?? null, transport: 'CLI', checkpoint })
      // Bash-exfiltration truth (1.9.6 #3): если чтение секретов у этого CLI не
      // закрыто полностью — честно предупреждаем ПРЯМО в ноте, не имитируя защиту.
      // Bash-чтение (cat/less/python/xxd/base64/$(<file)) принципиально обходимо,
      // поэтому Bash-deny НЕ добавляем (был бы театр). Envelope = recovery (откат
      // записей), НЕ prevention (не мешает чтению) — говорим это прямым текстом.
      const secLevel = secretProtectionLevel(providerId)
      const shellWarn = secLevel !== 'full'
        ? ' ⚠️ CLI может прочитать секреты через shell — Verstak это не гейтит; якорь откатывает записи, но не предотвращает чтение.'
        : ''
      const envelopeNote = provenance.note + shellWarn
      emitAgentProgress(sender, sendId, {
        id: `envelope-${startedAt}`,
        phase: 'context',
        title: '🛟 Контрольная точка перед CLI-прогоном',
        detail: envelopeNote,
        status: 'done'
      })
      recordJournal(projectPath, 'note', 'Control Envelope', envelopeNote)
      if (agentRuns && runId) {
        // ref = сериализованный якорь (полный gitHead+stashRef) для queryable-
        // отката из UI (1.9.6 #1). detail — человекочитаемая нота. Секретов нет.
        try { agentRuns.appendEvent(runId, 'checkpoint', { detail: envelopeNote, ref: serializeEnvelope(checkpoint) }) } catch { /* best-effort */ }
      }
    } catch { /* envelope-телеметрия не должна ронять прогон */ }
  }
  const currentMessages = [...messages]
  const pendingSupplements: string[] = []
  registerConversationSupplements(sendId, (text: string) => {
    pendingSupplements.push(text)
  })
  const drainSupplements = (): boolean => {
    let added = false
    while (pendingSupplements.length > 0) {
      const text = pendingSupplements.shift()!
      currentMessages.push({
        role: 'user',
        content: formatConversationSupplement(text)
      })
      emitAgentProgress(sender, sendId, {
        id: `supplement-${Date.now()}`,
        phase: 'context',
        title: 'Добавил новый контекст в текущую задачу',
        detail: compactProgressText(text, 180),
        status: 'done'
      })
      added = true
      if (agentRuns && runId) {
        try { agentRuns.appendEvent(runId, 'user_msg', { detail: text.slice(0, 500) }) } catch { /* best-effort */ }
      }
    }
    return added
  }
  let lastAssistantText = ''
  // 2.0.8-F: +cacheWriteTokens/inputAccounting — накапливаем для persistence прогона.
  const sessionUsage: { inputTokens: number; outputTokens: number; cachedInputTokens: number; cacheWriteTokens: number; inputAccounting: InputAccounting | undefined } = {
    inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, inputAccounting: undefined
  }
  let exitReason: ExitReason = 'completed'
  const signalExitReason = (): ExitReason => isAgentRunTimeoutAbort(signal) ? 'timeout' : 'aborted'
  let handedOff = false // #15: при fallback финализирует рекурсивный фрейм

  // 2.0.8-D: структурное событие смены маршрута (инвариант 8) + запись в agent_run_events.
  // Зеркалит runner-api emitRouteChanged (CLI-путь тоже объясним по Timeline).
  const emitRouteChanged = (
    action: 'rotate-account' | 'model-fallback' | 'refresh-auth',
    err: unknown,
    actual: { providerId: string; model: string },
    attempt: number,
  ): void => {
    const reason = classifyRouteReason(err)
    const requested = { providerId: providerId ?? '', model: model ?? '' }
    sender.send('ai:event', { id: sendId, event: { type: 'route-changed', action, reason, attempt, requested, actual } })
    sender.send('ai:event', { id: sendId, event: { type: 'info', text: routeChangedText(action, requested, actual) } })
    if (agentRuns && runId) {
      try {
        agentRuns.appendEvent(runId, 'route', {
          label: action,
          detail: `${requested.providerId}/${requested.model} → ${actual.providerId}/${actual.model} · reason=${reason} · attempt=${attempt}`,
          status: 'ok',
        })
      } catch { /* best-effort */ }
    }
  }
  try {
    while (!signal.aborted) {
      drainSupplements()
      let roundText = ''
      let roundHadError = false
      let roundErrorMessage: string | null = null // 1.9.7 #6: для account-switch по лимиту
      let roundSawText = false
      let roundSawThought = false
      const providerLabel = modelProgressLabel(providerId, model)
      const waitHeartbeat = createModelWaitHeartbeat(sender, sendId, {
        id: `plain-${Date.now()}`,
        label: providerLabel,
        detail: 'Внешний агент может молчать до первого фрагмента; Verstak держит запрос активным.'
      })

      try {
      for await (const event of provider.send(currentMessages, [], undefined, signal)) {
        if (signal.aborted) {
          exitReason = signalExitReason()
          waitHeartbeat.stop('done', 'Запрос остановлен.')
          sender.send('ai:event', { id: sendId, event: { type: 'done' } })
          return
        }
        // Accumulate stream into lastAssistantText so journal has a real summary.
        // CLI providers stream text in chunks via { type: 'text' } — same shape
        // as API providers.
        if (event.type === 'text' && typeof event.text === 'string') {
          if (!roundSawText) {
            roundSawText = true
            waitHeartbeat.stop('done', 'Появился первый видимый фрагмент ответа.')
            emitAgentProgress(sender, sendId, {
              id: `plain-first-text-${Date.now()}`,
              phase: 'final',
              title: 'Модель начала писать ответ',
              detail: compactProgressText(event.text, 140) ?? 'Получен первый видимый текст.',
              status: 'running'
            })
          }
          roundText += event.text
          lastAssistantText += event.text
        } else if (event.type === 'thought') {
          if (!roundSawThought) {
            roundSawThought = true
            waitHeartbeat.stop('done', 'Модель начала отдавать служебный ход работы.')
            emitAgentProgress(sender, sendId, {
              id: `plain-first-thought-${Date.now()}`,
              phase: 'reasoning',
              title: 'Модель разбирает задачу',
              detail: 'Получил служебный сигнал хода работы от провайдера; жду видимый ответ.',
              status: 'running'
            })
          }
        } else if (event.type === 'tool-call') {
          // Проекция родного tool-use CLI (claude/codex/grok): инструмент УЖЕ выполнен
          // внутри CLI-провайдера — показываем завершённой активностью в Timeline. Наш
          // executor его НЕ запускает (plain-путь без tool-loop) → без двойного исполнения.
          // redactForDisplay ОБЯЗАТЕЛЕН (1.9.6 #4): args могут нести inline-креды
          // (curl -H "Authorization: Bearer …", git remote https://user:pass@, ?token=).
          const detail = compactProgressText(redactForDisplay(JSON.stringify(event.call.args ?? {})), 120) ?? ''
          sender.send('ai:event', {
            id: sendId,
            event: { type: 'tool-activity', callId: event.call.id, name: event.call.name, label: `${event.call.name} · CLI`, detail, status: 'ok' }
          })
        } else if (event.type === 'usage' && event.usage) {
          sessionUsage.inputTokens += event.usage.inputTokens ?? 0
          sessionUsage.outputTokens += event.usage.outputTokens ?? 0
          sessionUsage.cachedInputTokens += event.usage.cachedInputTokens ?? 0
          // 2.0.8-F: cache-write + accounting фактического провайдера для persistence.
          sessionUsage.cacheWriteTokens += event.usage.cacheWriteTokens ?? event.usage.cacheCreationInputTokens ?? 0
          if (event.usage.inputAccounting) sessionUsage.inputAccounting = event.usage.inputAccounting
          // Cost guard check — abort если превышен лимит.
          if (costGuard && providerId) {
            const check = costGuard.recordAndCheck(
              providerId, model ?? '', event.usage.inputTokens ?? null,
              event.usage.outputTokens ?? null, event.usage.cacheReadTokens ?? event.usage.cachedInputTokens ?? null,
              event.usage.inputAccounting // 2.0.8-E: exclusive → billable без вычитания cached (фикс B)
            )
            if (check.exceeded) {
              exitReason = 'error'
              waitHeartbeat.stop('error', check.message ?? 'Превышен лимит стоимости.')
              logRuntime('ai.cost_cap.exceeded', {
                sendId,
                runId: runId ?? null,
                path: 'plain',
                providerId,
                model: model ?? null,
                message: check.message ?? 'cost cap exceeded',
                usage: sessionUsage
              }, 'warn')
              sender.send('ai:event', { id: sendId, event: { type: 'error', message: check.message ?? 'cost cap exceeded' } })
              sender.send('ai:event', { id: sendId, event: { type: 'done' } })
              return
            }
          }
        } else if (event.type === 'error') {
          exitReason = 'error'
          roundHadError = true
          roundErrorMessage = String((event as { message?: unknown }).message ?? '')
          waitHeartbeat.stop('error', 'Провайдер вернул ошибку.')
        }
        if (event.type !== 'done') {
          sender.send('ai:event', { id: sendId, event })
        }
        if (event.type === 'done' || event.type === 'error') break
      }
      } finally {
        waitHeartbeat.stop()
      }

      if (signal.aborted) {
        exitReason = signalExitReason()
        sender.send('ai:event', { id: sendId, event: { type: 'done' } })
        return
      }
      if (roundHadError) {
        // 1.9.7 #6: подписочный лимит активного аккаунта → переключаем АККАУНТ
        // того же провайдера (пул), не теряя запрос. Раньше CLI-путь тут просто
        // сдавался (done+return) — авто-свитч (1.9.4) был мёртв для CLI-подписок,
        // хотя аккаунты именно у CLI-провайдеров. Зеркалит attemptAccountSwitch API-пути.
        // 2.0.8-D2: pinned-чат — ротация аккаунта запрещена (инвариант 1). Зеркалит runner-api.
        if (fallbackOpts && !fallbackOpts.pinnedAccount && providerId && roundErrorMessage && (fallbackOpts.accountSwitchCount ?? 0) < MAX_ACCOUNT_SWITCHES) {
          const hit = detectSubscriptionLimit(roundErrorMessage)
          if (hit.limited) {
            const sw = fallbackOpts.switchAccountOnLimit?.(providerId, hit.resetEta)
            if (sw?.switched) {
              fallbackOpts.accountSwitchCount = (fallbackOpts.accountSwitchCount ?? 0) + 1
              const fresh = fallbackOpts.getNextProvider(providerId) // тот же id → новый активный аккаунт
              if (fresh) {
                emitRouteChanged('rotate-account', roundErrorMessage, { providerId, model: model ?? '' }, fallbackOpts.accountSwitchCount)
                handedOff = true
                return runPlainConversation(sender, sendId, fresh, projectPath, messages, signal, recordJournal, costGuard, providerId, model, fallbackOpts, agentRuns, runId)
              }
            }
          }
        }
        sender.send('ai:event', { id: sendId, event: { type: 'done' } })
        return
      }

      if (!roundText.trim()) {
        emitAgentProgress(sender, sendId, {
          id: `plain-empty-${Date.now()}`,
          phase: 'final',
          title: 'Модель завершила шаг без видимого ответа',
          detail: roundSawThought
            ? 'Провайдер отдал только служебный сигнал хода работы. Жду следующий шаг или финальный текст.'
            : 'Провайдер завершил поток без текста. Это будет видно в логах запуска.',
          status: 'blocked'
        })
      }

      if (roundText.trim()) {
        currentMessages.push({ role: 'assistant', content: roundText })
      }

      if (!drainSupplements()) {
        sender.send('ai:event', { id: sendId, event: { type: 'done' } })
        return
      }
    }
  } catch (err) {
    if (signal.aborted) {
      exitReason = signalExitReason()
      sender.send('ai:event', { id: sendId, event: { type: 'done' } })
      return
    }
    logRuntimeError('ai.runner.error', err, {
      sendId,
      runId: runId ?? null,
      path: 'plain',
      projectPath,
      providerId: providerId ?? null,
      model: model ?? null
    })
    // Smart fallback: если ошибка retriable и есть ещё кандидаты — пробуем.
    if (fallbackOpts && !fallbackOpts.pinnedAccount && providerId && (fallbackOpts.triedProviders.size - 1) < MAX_FALLBACK_ATTEMPTS) {
      fallbackOpts.triedProviders.add(providerId)
      if (shouldFallback(err)) {
        const nextId = getNextFallback(providerId, fallbackOpts.triedProviders, fallbackOpts.configuredProviders)
        const nextProvider = nextId ? fallbackOpts.getNextProvider(nextId) : null
        if (nextProvider && nextId) {
          console.log(`[fallback] ${providerId} failed: ${err instanceof Error ? err.message : String(err)}. Trying ${nextId}...`)
          fallbackOpts.triedProviders.add(nextId)
          // #7: модель fallback-провайдера, а не упавшего — для верного cost/журнала.
          const nextModel = fallbackOpts.getProviderModel(nextId) ?? model
          emitRouteChanged('model-fallback', err, { providerId: nextId, model: nextModel ?? '' }, fallbackOpts.triedProviders.size)
          // #15: fallback-фрейм владеет финализацией (agentRuns/runId переданы).
          handedOff = true
          logRuntime('ai.fallback.handoff', {
            sendId,
            runId: runId ?? null,
            path: 'plain',
            fromProviderId: providerId,
            toProviderId: nextId,
            fromModel: model ?? null,
            toModel: nextModel ?? null
          }, 'warn')
          return runPlainConversation(sender, sendId, nextProvider, projectPath, messages, signal, recordJournal, costGuard, nextId, nextModel, fallbackOpts, agentRuns, runId)
        }
      }
    }
    exitReason = 'crashed'
    sender.send('ai:event', {
      id: sendId,
      event: { type: 'error', message: classifyProviderError(err).userMessage }
    })
    sender.send('ai:event', { id: sendId, event: { type: 'done' } })
  } finally {
    unregisterConversationSupplements(sendId)
    logRuntime('ai.runner.finish', {
      sendId,
      runId: runId ?? null,
      path: 'plain',
      projectPath,
      providerId: providerId ?? null,
      model: model ?? null,
      exitReason,
      handedOff,
      durationMs: Date.now() - startedAt,
      assistantChars: lastAssistantText.length,
      usage: sessionUsage,
      costCents: costGuard?.current() ?? 0
    }, exitReason === 'completed' || exitReason === 'aborted' || handedOff ? 'info' : 'warn')
    // Same guarantee as runApiConversation: every exit path writes a journal
    // entry. Skipped when there's no projectPath (background sessions in the
    // future may not have one). #15: при fallback журнал/finish делает рекурсивный фрейм.
    if (!handedOff && projectPath) {
      try {
        writeSessionJournal(
          recordJournal,
          projectPath,
          lastAssistantText,
          new Set<string>(),   // CLI path: no tool-driven file writes tracked here
          [],                  // CLI path: no command-tool dispatch (CLI runs them inside)
          sessionUsage,
          exitReason
        )
      } catch (err) {
        console.error('[ai.ts] writeSessionJournal (plain) failed in finally:', err)
      }
    }
    // Multi-agent Manager (Фаза 2): завершаем прогон. Best-effort — ошибка
    // storage не должна ломать runner. Plain-путь: tool/files = 0 (CLI крутит
    // их внутри, наружу не видно), стоимость из costGuard. agentRuns/runId не
    // (внешний finally, либо рекурсивный fallback-фрейм при handedOff — #15).
    // Review-прогоны (owner='review') финишируются здесь же.
    if (!handedOff && agentRuns && runId) {
      try {
        // Timeline: финальный ответ агента — итог CLI-прогона (на CLI-пути нет
        // recordRunEvent, так что это единственное содержательное событие ленты).
        if (lastAssistantText.trim()) {
          agentRuns.appendEvent(runId, 'assistant_msg', { detail: lastAssistantText.slice(0, 500), status: exitReason })
        }
        agentRuns.finish(runId, exitReasonToAgentRunStatus(exitReason), {
          costCents: costGuard?.current() ?? 0,
          error: exitReason === 'error' || exitReason === 'crashed' ? lastAssistantText.slice(0, 500) || exitReason : null
        })
      } catch (err) {
        console.warn('[agent-runs] finish (plain) failed:', err instanceof Error ? err.message : err)
      }
      // 2.0.8-F: persistence usage прогона (одна строка, идемпотентно по run_id).
      // BEST-EFFORT в отдельном try — сбой персистенса НЕ роняет прогон и не путается
      // с ошибкой finish. Пишем только при реальном usage.
      if (providerId && (sessionUsage.inputTokens || sessionUsage.outputTokens || sessionUsage.cachedInputTokens)) {
        try {
          // Хешируем ЗДЕСЬ — текст промпта не покидает runner (каветат #3). toolsHash=null:
          // на CLI-пути набор инструментов держит сам CLI, наружу он не виден — не выдумываем.
          const systemText = messages.find(m => m.role === 'system')?.content
          agentRuns.persistUsage({
            runId, providerId, model: model ?? '', transport: PROVIDERS[providerId]?.transport ?? null,
            inputTokens: sessionUsage.inputTokens, outputTokens: sessionUsage.outputTokens,
            cacheReadTokens: sessionUsage.cachedInputTokens, cacheWriteTokens: sessionUsage.cacheWriteTokens,
            inputAccounting: sessionUsage.inputAccounting,
            systemPromptHash: systemText ? usageHash(systemText) : null,
            toolsHash: null
          })
        } catch { /* best-effort: персистенс не роняет финализацию */ }
      }
    }
  }
}
