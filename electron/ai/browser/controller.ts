// controller.ts — единый BrowserController (BR-011).
//
// Единая точка dispatch'а для всех browser actions. Любой tool handler
// (browser_navigate, browser_click, browser_type_text, ...) проходит через
// controller.dispatch(). Это ЕДИНСТВЕННЫЙ chokepoint: вне его — никаких
// adapter-вызовов, никаких mutation.
//
// Контракт (план §9 Phase B0 гейт + R1 усиление):
//   observe → classifyRisk → modeAllows → agentModeBlocks → capability →
//   data-policy → (R3) require approval → consumeApproval (atomic, до executor,
//   из ledger а не из caller input) → fresh observe + checkPreconditions →
//   execute → fresh observe → verify postcondition → finalize.
//
// Crash recovery: если процесс упал во время execute, при старте
// reconcileStaleActions помечает все 'executing' actions как 'uncertain'.
// Автоповтор запрещён — только fresh observe решает, что дальше.
//
// R1 усиления:
//   • approveAndExecute берёт action из ledger, НЕ из caller input. Подмена
//     actionType/payload/scope/preconditions/postconditions → blocked.
//   • Digest пересчитывается перед consume (не доверяем caller'у).
//   • Approval TTL: просроченное approval нельзя потребить.
//   • Inactive run (после handoff) не может dispatch/approve.
//   • Navigate: проверяется origin целевого URL; после redirect final origin
//     перечитывается, drift останавливает дальнейшие действия.
//   • Пустой allowedDomains не разрешает mutation (fail-closed).
//   • R0 observe допустим только для task tab.
//   • payload redacted перед proposeAction (secret values не в SQLite).

import { randomUUID } from 'node:crypto'
import { redactForDisplay, redactUrlSecrets } from '../secret-scanner'
import type { BrowserTasks, BrowserActionRow } from '../../storage/browser-tasks'
import type {
  BrowserAdapter,
  BrowserActionScope,
  BrowserActionType,
  BrowserMode,
  BrowserTaskId,
  ActionResult,
  ActionId,
  Observation,
  PolicyDecision,
  RiskLevel,
  RunId,
  ClientDataPolicy,
  CapabilityEnvelope,
} from './types'
import {
  classifyRisk,
  decideApproval,
  agentModeBlocksBrowserMutation,
} from './policy'
import type { ClassifyContext } from './policy'
import {
  buildApprovalSnapshot,
  buildDigest,
  checkPreconditions,
  computeDigest,
  verifyDigest,
} from './approval'
import {
  decideProviderBrowserContext,
  DEFAULT_DATA_POLICY,
} from './data-policy'
import {
  isActionAllowedByCaps,
  isDomainAllowedByCaps,
} from './capability'
import {
  ensureTask,
  attachRun,
  isActiveRun,
  getCurrentRun,
} from './lineage'
import {
  isScreenshotSafeForModel,
  projectObservationForProof,
  probeForPromptInjection,
  wrapObservationForModel,
} from './untrusted'
import { isUnknownBrowserEffectError } from './errors'

// ── Public types ─────────────────────────────────────────────────────────────

export type AgentMode = 'ask' | 'accept-edits' | 'plan' | 'auto' | 'bypass'

export interface DispatchInput {
  browserTaskId: BrowserTaskId
  runId: RunId
  actionType: BrowserActionType
  /** Actual provider of this runner frame. Trusted tool routing sets it explicitly. */
  providerId?: string | null
  /** Explicit environment choice from trusted handler routing. Omitted = resolver default. */
  preferredAdapter?: BrowserAdapter['id']
  payload?: Record<string, unknown>
  scope?: Partial<BrowserActionScope>
  preconditions?: Record<string, unknown>
  expectedPostcondition?: Record<string, unknown> | null
}

export interface DispatchResult {
  ok: boolean
  actionId: ActionId
  risk: RiskLevel
  decision: PolicyDecision
  result?: ActionResult
  observation?: Observation
  /** Untrusted envelope для модели — handler должен передать ЭТО, не raw text. */
  observationForModel?: { text: string; redactionHits: string[]; truncated: boolean }
  error?: string
  pendingApproval?: {
    approvalDigest: string
    snapshot: ReturnType<typeof buildApprovalSnapshot>
    expiresAt: number | null
  }
}

export interface ControllerDeps {
  storage: BrowserTasks
  resolveAdapter: (preferred?: 'electron-webview' | 'chrome-extension') => BrowserAdapter | null
  getBrowserMode: (browserTaskId: BrowserTaskId) => BrowserMode
  getAgentMode: () => AgentMode
  getCapability: (browserTaskId: BrowserTaskId) => CapabilityEnvelope
  getDataPolicy: (browserTaskId: BrowserTaskId) => ClientDataPolicy
  getProviderId: (browserTaskId: BrowserTaskId) => string | null
  /** Сколько ms живёт approval после propose. По умолчанию 5 минут. */
  approvalTtlMs?: number
  awaitApproval?: (actionId: ActionId, digest: string, snapshot: ReturnType<typeof buildApprovalSnapshot>, expiresAt: number | null) => Promise<boolean>
  classifyCtx?: ClassifyContext
  emitTimeline?: (kind: string, payload: { label?: string | null; detail?: string | null; ref?: string | null; status?: string | null }) => void
}

// ── Controller ───────────────────────────────────────────────────────────────

export interface BrowserController {
  ensureTask(input: {
    browserTaskId: BrowserTaskId
    projectPath: string
    chatId?: number | null
    clientId?: string | null
    runId?: RunId | null
    providerId?: string | null
    model?: string | null
    allowedDomains?: string[]
    browserMode?: BrowserMode
    caps?: CapabilityEnvelope
    dataPolicy?: ClientDataPolicy
  }): void
  attachRun(input: {
    browserTaskId: BrowserTaskId
    runId: RunId
    providerId?: string | null
    model?: string | null
    handoffReason?: 'new_send' | 'pause_resume' | 'provider_switch' | 'forced'
  }): void
  dispatch(input: DispatchInput): Promise<DispatchResult>
  rejectAction(actionId: ActionId, reason: string): void
  approveAndExecute(actionId: ActionId, approvalDigestFromUi: string): Promise<DispatchResult>
  observe(browserTaskId: BrowserTaskId, runId: RunId): Promise<Observation>
  reconcile(): number
}

const DEFAULT_APPROVAL_TTL_MS = 5 * 60 * 1000 // 5 минут

export function createBrowserController(deps: ControllerDeps): BrowserController {
  const { storage } = deps
  const approvalTtlMs = deps.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS

  return {
    ensureTask(input) {
      ensureTask(storage, {
        browserTaskId: input.browserTaskId,
        projectPath: input.projectPath,
        chatId: input.chatId ?? null,
        clientId: input.clientId ?? null,
        runId: input.runId ?? null,
        providerId: input.providerId ?? null,
        model: input.model ?? null,
        allowedDomains: input.allowedDomains ?? [],
        browserMode: input.browserMode,
        caps: input.caps ? capsToJsonable(input.caps) : undefined,
        dataPolicy: input.dataPolicy ? dataPolicyToJsonable(input.dataPolicy) : undefined,
      })
      // Persist/overwrite seed policy when caller передаёт (R2: durable policy).
      if (input.browserMode) storage.updateBrowserMode(input.browserTaskId, input.browserMode)
      if (input.caps) storage.setCaps(input.browserTaskId, capsToJsonable(input.caps))
      if (input.dataPolicy) storage.setDataPolicy(input.browserTaskId, dataPolicyToJsonable(input.dataPolicy))
      if (input.allowedDomains && input.allowedDomains.length > 0) {
        storage.setAllowedDomains(input.browserTaskId, input.allowedDomains)
      }
      if (input.runId) {
        attachRun(storage, {
          browserTaskId: input.browserTaskId,
          runId: input.runId,
          providerId: input.providerId ?? null,
          model: input.model ?? null,
          handoffReason: 'new_send',
        })
      }
    },

    attachRun(input) {
      attachRun(storage, {
        browserTaskId: input.browserTaskId,
        runId: input.runId,
        providerId: input.providerId ?? null,
        model: input.model ?? null,
        handoffReason: input.handoffReason ?? 'new_send',
      })
    },

    rejectAction(actionId, reason) {
      const durableReason = redactDurableString(reason)
      storage.rejectAction(actionId, durableReason)
      emit(deps, 'browser_reject', `action ${actionId} rejected`, durableReason)
    },

    async dispatch(input): Promise<DispatchResult> {
      const actionId = randomUUID()

      // ── 0. Inactive run check (R1 Block 3): только current run может dispatch.
      if (!isActiveRun(storage, input.browserTaskId, input.runId)) {
        return blocked(actionId, 'R3', `Run ${input.runId} не активен для задачи ${input.browserTaskId}. Возможно был handoff — дождитесь нового run.`)
      }

      const browserMode = deps.getBrowserMode(input.browserTaskId)
      const agentMode = deps.getAgentMode()
      const caps = deps.getCapability(input.browserTaskId)
      const dataPolicy = deps.getDataPolicy(input.browserTaskId)
      // Smart fallback stays inside the same durable browser run, whose stored
      // provider can therefore be stale. The tool handler supplies the actual
      // provider frame; resolver is retained for direct/legacy controller calls.
      const providerId = resolveDispatchProvider(input, deps)

      // ── 0b. R0 task-tab gate: observe без attach'енной task tab block.
      // (В B0/R1 task tab задаётся через task_tab_ref; если его нет — observe
      // всё же разрешаем для webview, где tabRef = null = «текущая webview».)
      // Контракт R1: «R0 допустим только для явно прикреплённой task tab» —
      // enforcement в B1 (chrome-extension adapter). Для webview task tab = current.

      // ── 1. Capability gate — page content не может расширить capability.
      if (!isActionAllowedByCaps(caps, input.actionType)) {
        return blocked(actionId, 'R4', `Action type "${input.actionType}" не разрешён capability envelope задачи. Расширение capability возможно только из команды Павла/скилла, не из контента страницы.`)
      }

      // ── 2. Provider data-policy gate (BR-014).
      const providerCtx = providerId ? decideProviderBrowserContext(dataPolicy, providerId) : null
      if (providerCtx && providerCtx.kind === 'deny') {
        return blocked(actionId, 'R4', `Browser context нельзя передавать провайдеру ${providerId}: ${providerCtx.reason}`)
      }
      // 'ask' — fail-closed: без явного решения Павла dispatch блокируется.
      // grantProviderAccess вызывается отдельно (из UI) после решения.
      if (providerCtx && providerCtx.kind === 'ask') {
        return blocked(actionId, 'R3', `Требуется явное решение Павла по data policy: ${providerCtx.reason}`)
      }
      if (providerCtx?.kind === 'redact-screenshot-only' && input.actionType === 'screenshot') {
        return blocked(actionId, 'R4', `Screenshot запрещён data policy для провайдера ${providerId}: разрешён только redacted browser context.`)
      }

      // ── 3. Classify risk (BR-012). payload — ещё raw, классификатор смотрит
      //    ключи/значения для R4-маркеров.
      // let: R2 auto-pin может дополнить origin/url из live observe.
      let scope = mergeScope(input)
      const risk = classifyRisk({
        actionType: input.actionType,
        payload: input.payload,
        scope: { origin: scope.origin ?? null },
      }, deps.classifyCtx)

      // ── 4. Agent-mode gate (план §5.2): plan блокирует все R1+.
      if (agentModeBlocksBrowserMutation(agentMode, risk)) {
        return blocked(actionId, risk, `Активен agent_mode="${agentMode}" — browser mutations (${risk}) запрещены в plan-режиме. Переключите режим основного агента.`)
      }

      // ── 5. Policy decision (modeAllows + approval).
      const decision = decideApproval(browserMode, risk)
      if (decision.kind === 'block') {
        return blocked(actionId, risk, decision.reason)
      }

      // Любая mutation привязывается к ФАКТИЧЕСКОЙ открытой странице, а не к
      // scope от модели. Это одновременно даёт origin для persisted allowlist
      // и формирует expectedOrigin для fresh-observe перед execute.
      let preflightAdapter: BrowserAdapter | null = null
      if (risk !== 'R0') {
        preflightAdapter = deps.resolveAdapter(input.preferredAdapter)
        if (!preflightAdapter || !preflightAdapter.available()) {
          return blocked(actionId, risk, preflightAdapter?.unavailableReason() ?? 'Browser adapter недоступен для live-origin проверки.')
        }
        try {
          const live = await preflightAdapter.observe({
            browserTaskId: input.browserTaskId,
            runId: input.runId,
            tabRef: scope.tabRef ?? null,
          })
          const liveOrigin = live.source.origin || extractOrigin(live.source.url)
          if (!liveOrigin) {
            return blocked(actionId, risk, 'Не удалось определить текущий origin вкладки — browser mutation заблокирована.')
          }
          scope = {
            ...scope,
            tabRef: live.source.tabRef ?? scope.tabRef ?? null,
            documentId: live.source.documentId ?? null,
            url: live.source.url,
            origin: liveOrigin,
            tenant: live.tenant ?? null,
            account: live.account ?? null,
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return blocked(actionId, risk, `Live-origin проверка не выполнена: ${msg}`)
        }
      }

      // ── 5b. R1 Block 4 + R2 webview auto-pin:
      // Пустой allowedDomains НЕ разрешает mutation (fail-closed), КРОМЕ
      // electron-webview B0: текущий LIVE origin пинится в durable
      // task (persisted). Chrome-extension (B1) остаётся fail-closed.
      let effectiveCaps = caps
      if (risk !== 'R0' && effectiveCaps.allowedDomains.length === 0) {
        const adapter = preflightAdapter ?? deps.resolveAdapter(input.preferredAdapter)
        const isWebview = adapter?.id === 'electron-webview'
        if (!isWebview) {
          return blocked(actionId, risk, `Mutation риска ${risk} требует явного allowedDomains в capability envelope. Пустой список = «не разрешено нигде» (fail-closed).`)
        }
        const pinOrigin = scope.origin ?? ''
        if (!pinOrigin) {
          return blocked(actionId, risk, `Mutation риска ${risk} требует allowedDomains; origin неизвестен (откройте вкладку Browser / укажите URL).`)
        }
        effectiveCaps = pinDomainToTask(storage, input.browserTaskId, effectiveCaps, pinOrigin)
      }

      // ── 5c. R1 Block 4: target URL origin check для navigate (не только scope.origin).
      if (input.actionType === 'navigate') {
        const targetUrl = String(input.payload?.url ?? '')
        const targetOrigin = extractOrigin(targetUrl)
        if (targetOrigin && !isDomainAllowedByCaps(effectiveCaps, targetOrigin)) {
          return blocked(actionId, risk, `Целевой origin "${targetOrigin}" не разрешён в allowedDomains задачи.`)
        }
      }

      // ── 5d. R1 Block 4: текущий scope origin должен быть в allowedDomains
      // (для mutation; R0 observe exempt — может читать любую страницу вкладки).
      if (risk !== 'R0' && scope.origin && !isDomainAllowedByCaps(effectiveCaps, scope.origin)) {
        return blocked(actionId, risk, `Origin "${scope.origin}" не разрешён в allowedDomains задачи.`)
      }

      // ── 6. Redact payload (R1 Block 8): scan recursively before persist.
      const redactedPayload = redactPayload(input.payload ?? {})

      // C1: elementRef/version for click come from payload or last live observe in scope.
      const payloadElementRef =
        typeof redactedPayload.elementRef === 'string'
          ? redactedPayload.elementRef
          : typeof redactedPayload.selector === 'string'
            ? redactedPayload.selector
            : null
      if (payloadElementRef && /[{};<>]|document\.|querySelector|eval\(/i.test(payloadElementRef)) {
        return blocked(actionId, risk, 'raw CSS/JS selector запрещён — только elementRef из observation map')
      }

      // ── 7. Propose action (persisted в action ledger).
      const fullScope: BrowserActionScope = {
        browserTaskId: input.browserTaskId,
        runId: input.runId,
        ...(providerId ? { providerId } : {}),
        ...(input.preferredAdapter ? { adapterId: input.preferredAdapter } : {}),
        clientId: dataPolicy.clientId ?? null,
        tabRef: scope.tabRef ?? null,
        documentId: scope.documentId ?? null,
        url: scope.url ?? null,
        origin: scope.origin ?? null,
        tenant: scope.tenant ?? null,
        account: scope.account ?? null,
        observationId: scope.observationId ?? null,
        observationVersion: scope.observationVersion ?? null,
        elementRef: scope.elementRef ?? payloadElementRef ?? null,
      }
      const preconditions = input.preconditions ?? buildPreconditionsFromScope(fullScope)
      // Runtime checks keep the live values above. The approval/UI/SQLite copy is
      // a separate projection: durable state must never become a cookie/token/
      // OAuth cache merely because the page echoed credentials in its URL or
      // cabinet metadata.
      const durableScope = scopeToJsonable(fullScope) as unknown as BrowserActionScope
      const durablePreconditions = redactDurableRecord(preconditions)
      const durableExpectedPostcondition = input.expectedPostcondition
        ? redactDurableRecord(input.expectedPostcondition)
        : null
      // Digest считается от REDACTED payload (то, что в ledger) — controller при
      // consume пересчитает от того же ledger-row и сравнит.
      const approvalDigestObj = buildDigest({
        actionId,
        browserTaskId: input.browserTaskId,
        runId: input.runId,
        scope: durableScope,
        actionType: input.actionType,
        payload: redactedPayload,
        preconditions: durablePreconditions,
        expectedPostcondition: durableExpectedPostcondition,
        risk,
        clientId: durableScope.clientId ?? null,
      })
      const approvalExpiresAt = (risk === 'R3') ? Date.now() + approvalTtlMs : null
      storage.proposeAction({
        actionId,
        browserTaskId: input.browserTaskId,
        runId: input.runId,
        actionType: input.actionType,
        riskLevel: risk,
        scope: durableScope as unknown as Record<string, unknown>,
        payload: redactedPayload,
        preconditions: durablePreconditions,
        expectedPostcondition: durableExpectedPostcondition,
        approvalDigest: risk === 'R3' ? approvalDigestObj.digest : null,
        approvalExpiresAt,
      })

      emit(deps, 'browser_propose', `${input.actionType} (${risk})`, `actionId=${actionId}`)

      // ── 8. R3 — требуется approval.
      if (decision.kind === 'require-approval') {
        if (deps.awaitApproval) {
          const approved = await deps.awaitApproval(actionId, approvalDigestObj.digest, approvalDigestObj.snapshot, approvalExpiresAt)
          if (!approved) {
            this.rejectAction(actionId, 'user_rejected')
            return { ok: false, actionId, risk, decision, error: 'Пользователь отклонил действие.' }
          }
          // approveAndExecute из ledger (digest из UI передаётся для сверки).
          return await this.approveAndExecute(actionId, approvalDigestObj.digest)
        }
        return {
          ok: false,
          actionId,
          risk,
          decision,
          pendingApproval: {
            approvalDigest: approvalDigestObj.digest,
            snapshot: approvalDigestObj.snapshot,
            expiresAt: approvalExpiresAt,
          },
          error: decision.reason,
        }
      }

      // ── 9. R0/R1/R2 auto path — checkPreconditions → execute.
      return await runExecute(deps, this, input, actionId, fullScope, preconditions, risk, redactedPayload, approvalDigestObj.digest)
    },

    async approveAndExecute(actionId, approvalDigestFromUi): Promise<DispatchResult> {
      // ── R1 Block 3: action берётся ИЗ LEDGER, не из caller input.
      // Caller больше не передаёт actionType/payload/scope — только actionId +
      // digest от UI. Подмена actionType/payload через caller input больше
      // невозможна: controller пересчитает digest от ledger-row'а и сравнит.
      const action = storage.getAction(actionId)
      if (!action) {
        return { ok: false, actionId, risk: 'R3', decision: { kind: 'block', reason: 'action not found' }, error: 'Action не найден в ledger.' }
      }

      // ── Inactive run check (R1 Block 3): после handoff старый run не dispatch.
      if (!isActiveRun(storage, action.browserTaskId, action.runId)) {
        return { ok: false, actionId, risk: action.riskLevel, decision: { kind: 'block', reason: 'inactive run' }, error: `Run ${action.runId} больше не активен — был handoff. Approval недействителен.` }
      }

      // ── Status check: только proposed/approved можно исполнить.
      if (action.status !== 'proposed' && action.status !== 'approved') {
        return { ok: false, actionId, risk: action.riskLevel, decision: { kind: 'block', reason: `status=${action.status}` }, error: `Action в статусе "${action.status}" — повторное approval невозможно.` }
      }

      // ── R1 Block 3: digest ПЕРЕСЧИТЫВАЕТСЯ от ledger-row (канонический action).
      //    Если UI прислал digest от другого action — не совпадёт.
      const canonicalSnapshot = buildApprovalSnapshot({
        browserTaskId: action.browserTaskId,
        runId: action.runId,
        scope: action.scope as unknown as BrowserActionScope,
        actionType: action.actionType as BrowserActionType,
        payload: action.payload,
        preconditions: action.preconditions as Record<string, unknown>,
        expectedPostcondition: action.expectedPostcondition as Record<string, unknown> | null,
        risk: action.riskLevel,
        clientId: null, // clientId хранится в task, не в action snapshot v1
      })
      const canonicalDigest = computeDigest(canonicalSnapshot)

      // UI передал digest от SNAPSHOT (propose-time). Controller ожидает что
      // canonicalDigest (от ledger) совпадёт с тем, что UI показал пользователю.
      // digest-UI = digest, вычисленный на этапе propose (он же в storage).
      // canonicalDigest должен совпасть с action.approvalDigest.
      if (action.approvalDigest && canonicalDigest !== action.approvalDigest) {
        // Ledger-row был изменён после propose — это инвариант.
        return { ok: false, actionId, risk: action.riskLevel, decision: { kind: 'block', reason: 'ledger row tampered' }, error: 'Ledger action изменён после propose — digest канонический не совпадает.' }
      }

      // UI digest должен совпадать с canonicalDigest (или хотя бы с stored).
      const expected = action.approvalDigest ?? canonicalDigest
      if (approvalDigestFromUi !== expected) {
        return { ok: false, actionId, risk: action.riskLevel, decision: { kind: 'block', reason: 'digest mismatch' }, error: 'Approval digest от UI не совпадает с action. Возможно UI показал approval от другого action или action был пересоздан.' }
      }

      // ── Status: proposed → approved (если ещё не).
      if (action.status === 'proposed') {
        const ok = storage.approveAction(actionId, canonicalDigest)
        if (!ok) {
          return { ok: false, actionId, risk: action.riskLevel, decision: { kind: 'block', reason: 'approve failed' }, error: 'approveAction отклонён — action не proposed или TTL истёк.' }
        }
      }

      // ── Atomic consume (storage-layer проверит digest + TTL).
      const consumed = storage.consumeApproval(actionId, canonicalDigest)
      if (!consumed) {
        return { ok: false, actionId, risk: action.riskLevel, decision: { kind: 'block', reason: 'consume failed' }, error: 'consumeApproval отклонён — approval уже использован, digest не совпадает, или TTL истёк.' }
      }

      // ── R1 Block 7: fresh observation перед execute.
      const actionScope = action.scope as unknown as BrowserActionScope
      const preferredAdapter = adapterIdFromScope(actionScope)
      const adapter = deps.resolveAdapter(preferredAdapter)
      if (!adapter || !adapter.available()) {
        storage.finalizeAction(actionId, 'blocked', {
          resultStatus: 'no_adapter',
          resultDetail: redactDurableString(adapter?.unavailableReason() ?? 'no adapter'),
        })
        return { ok: false, actionId, risk: action.riskLevel, decision: { kind: 'block', reason: 'no adapter' }, error: 'Adapter недоступен.' }
      }
      let freshObs: Observation
      try {
        freshObs = await adapter.observe({ browserTaskId: action.browserTaskId, runId: action.runId, tabRef: actionScope.tabRef ?? null })
      } catch (err) {
        const msg = redactDurableString(err instanceof Error ? err.message : String(err))
        storage.finalizeAction(actionId, 'blocked', { resultStatus: 'observe_failed', resultDetail: msg })
        return { ok: false, actionId, risk: action.riskLevel, decision: { kind: 'block', reason: 'observe failed' }, error: `Fresh observe упал: ${msg}` }
      }

      // ── R1 Block 7: check preconditions на СВЕЖЕМ observation.
      const preconditions = action.preconditions as Record<string, unknown>
      const preCheck = checkPreconditions(preconditions, redactDurableRecord({
        origin: freshObs.source.origin,
        observationVersion: freshObs.observationVersion,
        observationId: freshObs.observationId,
        tenant: freshObs.tenant ?? null,
        account: freshObs.account ?? null,
        url: freshObs.source.url,
      }))
      if (!preCheck.ok) {
        const reason = redactDurableString(preCheck.reason ?? 'precondition failed on fresh observe')
        storage.finalizeAction(actionId, 'blocked', { resultStatus: 'preconditions_failed_on_fresh_observe', resultDetail: reason })
        emit(deps, 'browser_block', 'preconditions failed (fresh observe)', reason)
        return { ok: false, actionId, risk: action.riskLevel, decision: { kind: 'block', reason }, error: `Preconditions нарушены на свежем observation: ${reason}` }
      }

      // C1: click elementRef must still exist on fresh observation map.
      if (action.actionType === 'click') {
        const ref = String(
          (action.payload as Record<string, unknown>)?.elementRef
          ?? (action.payload as Record<string, unknown>)?.selector
          ?? (action.scope as unknown as BrowserActionScope)?.elementRef
          ?? '',
        )
        if (ref && freshObs.controls && freshObs.controls.length > 0) {
          const hit = freshObs.controls.some((c) => c.elementRef === ref)
          if (!hit) {
            const reason = redactDurableString(`elementRef "${ref}" отсутствует в fresh observation — STOP без клика (stale ref / reload)`)
            storage.finalizeAction(actionId, 'blocked', { resultStatus: 'stale_element_ref', resultDetail: reason })
            return { ok: false, actionId, risk: action.riskLevel, decision: { kind: 'block', reason }, error: reason }
          }
        }
        if (freshObs.source.tabRef && (action.scope as unknown as BrowserActionScope)?.tabRef
          && freshObs.source.tabRef !== (action.scope as unknown as BrowserActionScope).tabRef) {
          const reason = 'wrong tab на fresh observe — STOP без клика'
          storage.finalizeAction(actionId, 'blocked', { resultStatus: 'wrong_tab', resultDetail: reason })
          return { ok: false, actionId, risk: action.riskLevel, decision: { kind: 'block', reason }, error: reason }
        }
      }

      // ── Execute.
      const attemptId = `${actionId}-0`
      emit(deps, 'browser_execute', `${action.actionType} (approved)`, `actionId=${actionId}`)
      // Reconstruct DispatchInput from ledger-row (канонический action).
      const reconstructedInput: DispatchInput = {
        browserTaskId: action.browserTaskId,
        runId: action.runId,
        actionType: action.actionType as BrowserActionType,
        providerId: providerIdFromScope(actionScope) ?? deps.getProviderId(action.browserTaskId),
        preferredAdapter,
        payload: action.payload,
        scope: action.scope as Partial<BrowserActionScope>,
        preconditions,
        expectedPostcondition: action.expectedPostcondition as Record<string, unknown> | null,
      }
      const result = await executeAdapted(deps, reconstructedInput, action.scope as unknown as BrowserActionScope, actionId, attemptId, action.riskLevel, freshObs)

      // ── R1 Block 7: verify postcondition на fresh observation.
      const verifiedResult = redactActionResult(
        verifyPostcondition(result, reconstructedInput.expectedPostcondition ?? null, action.riskLevel),
      )

      storage.finalizeAction(actionId, verifiedResult.status, {
        resultStatus: verifiedResult.status,
        resultDetail: verifiedResult.detail,
        attemptId,
      })
      storage.updateLastResult(action.browserTaskId, verifiedResult.status, verifiedResult.detail)
      emit(deps, 'browser_finalize', `${action.actionType} → ${verifiedResult.status}`, verifiedResult.detail)

      // ── R1 Block 7: before/after Proof для R3.
      if (action.riskLevel === 'R3') {
        // before ref — последний observation до action (из scope, нет отдельного before screenshot в B0).
        // after ref — свежий postObservation.
        if (verifiedResult.postObservation) {
          const proj = projectObservationForProof(verifiedResult.postObservation)
          storage.appendProofRef({
            actionId,
            browserTaskId: action.browserTaskId,
            runId: action.runId,
            kind: 'after',
            artifactPath: null,
            artifactDigest: null,
            origin: proj.origin,
            url: proj.url,
            redactedSummary: proj.redactedSummary,
            omissions: proj.omissions,
            retentionUntil: Date.now() + 1000 * 60 * 60 * 24 * 30,
          })
        }
      }
      return { ok: verifiedResult.status === 'verified' || verifiedResult.status === 'uncertain', actionId, risk: action.riskLevel, decision: { kind: 'auto', reason: 'consumed' }, result: verifiedResult }
    },

    async observe(browserTaskId, runId): Promise<Observation> {
      const r = await this.dispatch({
        browserTaskId, runId, actionType: 'observe',
        payload: {}, scope: {},
      })
      if (r.observation) return r.observation
      if (r.result?.postObservation) return r.result.postObservation
      throw new Error(r.error ?? 'observe failed')
    },

    reconcile() {
      const n = storage.reconcileStaleActions()
      if (n > 0) emit(deps, 'browser_reconcile', `reconciled ${n} stale action(s)`, null)
      return n
    },
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function blocked(actionId: ActionId, risk: RiskLevel, reason: string): DispatchResult {
  return { ok: false, actionId, risk, decision: { kind: 'block', reason }, error: reason }
}

function emit(deps: ControllerDeps, kind: string, label: string | null, detail: string | null): void {
  try {
    deps.emitTimeline?.(kind, {
      label: label == null ? null : redactDurableString(label),
      detail: detail == null ? null : redactDurableString(detail),
      ref: null,
      status: null,
    })
  } catch { /* best-effort */ }
}

function mergeScope(input: DispatchInput): Partial<BrowserActionScope> {
  return { ...input.scope }
}

function adapterIdFromScope(scope: BrowserActionScope): BrowserAdapter['id'] | undefined {
  return scope.adapterId === 'electron-webview' || scope.adapterId === 'chrome-extension'
    ? scope.adapterId
    : undefined
}

function providerIdFromScope(scope: BrowserActionScope): string | null {
  return typeof scope.providerId === 'string' && scope.providerId.trim()
    ? scope.providerId.trim()
    : null
}

function resolveDispatchProvider(input: DispatchInput, deps: ControllerDeps): string | null {
  const explicit = typeof input.providerId === 'string' ? input.providerId.trim() : ''
  return explicit || deps.getProviderId(input.browserTaskId)
}

function buildPreconditionsFromScope(scope: BrowserActionScope): Record<string, unknown> {
  const p: Record<string, unknown> = {}
  if (scope.origin) p.expectedOrigin = scope.origin
  if (scope.observationVersion != null) p.expectedObservationVersion = scope.observationVersion
  if (scope.observationId) p.expectedObservationId = scope.observationId
  if (scope.tenant) p.expectedTenant = scope.tenant
  if (scope.account) p.expectedAccount = scope.account
  return p
}

function scopeToJsonable(scope: BrowserActionScope): Record<string, unknown> {
  return {
    ...scope,
    clientId: redactDurableNullable(scope.clientId),
    documentId: redactDurableNullable(scope.documentId),
    url: redactDurableNullable(scope.url),
    origin: redactDurableNullable(scope.origin),
    tenant: redactDurableNullable(scope.tenant),
    account: redactDurableNullable(scope.account),
  }
}

function capsToJsonable(caps: CapabilityEnvelope): Record<string, unknown> {
  return caps as unknown as Record<string, unknown>
}

function dataPolicyToJsonable(p: ClientDataPolicy): Record<string, unknown> {
  return p as unknown as Record<string, unknown>
}

/** Рекурсивно очищает все строковые значения payload до записи в durable ledger. */
function redactPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return redactDurableRecord(payload)
}

const REDACT_MAX_DEPTH = 8

function redactDeep(value: unknown, depth: number): unknown {
  if (depth > REDACT_MAX_DEPTH) return null
  if (value == null) return value
  if (typeof value === 'string') {
    return redactDurableString(value)
  }
  if (Array.isArray(value)) {
    return value.map(v => redactDeep(v, depth + 1))
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(obj)) {
      out[k] = redactDeep(obj[k], depth + 1)
    }
    return out
  }
  return value
}

function redactDurableRecord(value: Record<string, unknown>): Record<string, unknown> {
  return redactDeep(value, 0) as Record<string, unknown>
}

function redactDurableString(value: string): string {
  // redactUrlSecrets handles a standalone URL before generic scanning can make
  // its userinfo unparsable; redactForDisplay also catches URLs embedded in
  // error/result prose and format-specific credentials.
  return redactForDisplay(redactUrlSecrets(value))
}

function redactDurableNullable(value: string | null | undefined): string | null {
  return value == null ? null : redactDurableString(value)
}

function redactActionResult(result: ActionResult): ActionResult {
  return {
    ...result,
    finalUrl: redactDurableNullable(result.finalUrl),
    reason: result.reason == null ? result.reason : redactDurableString(result.reason),
    detail: result.detail == null ? result.detail : redactDurableString(result.detail),
  }
}

function extractOrigin(url: string): string {
  try { return new URL(url).host } catch { return '' }
}

/** R2: pin first origin в durable task + caps (webview local seed). */
function pinDomainToTask(
  storage: BrowserTasks,
  browserTaskId: BrowserTaskId,
  caps: CapabilityEnvelope,
  origin: string,
): CapabilityEnvelope {
  const domains = caps.allowedDomains.includes(origin)
    ? [...caps.allowedDomains]
    : [...caps.allowedDomains, origin]
  const next: CapabilityEnvelope = { ...caps, allowedDomains: domains }
  storage.setAllowedDomains(browserTaskId, domains)
  storage.setCaps(browserTaskId, capsToJsonable(next))
  return next
}

// ── runExecute — общий path для R0/R1/R2 (auto-accept) ──────────────────────

async function runExecute(
  deps: ControllerDeps,
  controller: BrowserController,
  input: DispatchInput,
  actionId: ActionId,
  scope: BrowserActionScope,
  preconditions: Record<string, unknown>,
  risk: RiskLevel,
  redactedPayload: Record<string, unknown>,
  approvalDigest: string,
): Promise<DispatchResult> {
  // R0/R1/R2 — execute. preconditions check на текущем scope (свежий observe
  // для R1/R2 делаем внутри executeAdapted через postObservation).
  const preCheck = checkPreconditions(preconditions, {
    origin: scope.origin ?? null,
    observationVersion: scope.observationVersion ?? null,
    observationId: scope.observationId ?? null,
    tenant: scope.tenant ?? null,
    account: scope.account ?? null,
    url: scope.url ?? null,
  })
  if (!preCheck.ok) {
    const reason = redactDurableString(preCheck.reason ?? 'precondition failed')
    deps.storage.finalizeAction(actionId, 'blocked', { resultStatus: 'preconditions_failed', resultDetail: reason })
    emit(deps, 'browser_block', `preconditions failed`, reason)
    return blocked(actionId, risk, `Preconditions нарушены до execute: ${reason}`)
  }
  const attemptId = `${actionId}-0`
  deps.storage.startExecute(actionId, attemptId)
  emit(deps, 'browser_execute', `${input.actionType}`, `actionId=${actionId}`)
  // Для R0/R1/R2 — initial observe для fresh-контекст (для R0 это сам observe-action).
  let preObs: Observation | null = null
  if (risk === 'R0') {
    // observe сам собирает — executeAdapted вернёт observation.
  }
  const result = await executeAdapted(deps, input, scope, actionId, attemptId, risk, preObs)
  // Verify postcondition (для R0 verified автоматически, для R1/R2 — по expectedPostcondition).
  const verified = redactActionResult(
    verifyPostcondition(result, input.expectedPostcondition ?? null, risk),
  )
  deps.storage.finalizeAction(actionId, verified.status, {
    resultStatus: verified.status,
    resultDetail: verified.detail,
    attemptId,
  })
  deps.storage.updateLastResult(input.browserTaskId, verified.status, verified.detail)
  emit(deps, 'browser_finalize', `${input.actionType} → ${verified.status}`, verified.detail)
  // Proof ref для R0/R1 — after.
  if (verified.postObservation) {
    const proj = projectObservationForProof(verified.postObservation)
    deps.storage.appendProofRef({
      actionId,
      browserTaskId: input.browserTaskId,
      runId: input.runId,
      kind: 'after',
      artifactPath: null, artifactDigest: null,
      origin: proj.origin, url: proj.url,
      redactedSummary: proj.redactedSummary,
      omissions: proj.omissions,
      retentionUntil: Date.now() + 1000 * 60 * 60 * 24 * 7,
    })
  }
  // observationForModel — untrusted envelope для handler.
  let observationForModel: DispatchResult['observationForModel'] = undefined
  if (verified.postObservation) {
    observationForModel = wrapObservationForModel(verified.postObservation)
  }
  return { ok: verified.status === 'verified' || verified.status === 'uncertain', actionId, risk, decision: { kind: 'auto', reason: 'executed' }, result: verified, observationForModel }
}

// ── Postcondition verification (R1 Block 7) ─────────────────────────────────

function verifyPostcondition(
  result: ActionResult,
  expectedPostcondition: Record<string, unknown> | null,
  risk: RiskLevel,
): ActionResult {
  if (result.status === 'blocked' || result.status === 'failed') {
    return result // уже финал
  }
  // R0 (observe) — всегда verified (просто чтение).
  if (risk === 'R0') {
    return { ...result, status: 'verified' }
  }
  // R1 navigate — verified если finalUrl доступен (postObservation есть).
  // R2/R3 — проверяем postcondition если задан.
  if (!expectedPostcondition) {
    // Нет явного expectedPostcondition — для R1/R2 verified если postObs есть.
    // Для R3 (mutation без postcondition) — uncertain (недоказанный mutation).
    if (risk === 'R3') {
      return { ...result, status: 'uncertain', detail: (result.detail || '') + ' [postcondition не задан → uncertain]' }
    }
    return { ...result, status: result.postObservation ? 'verified' : 'uncertain' }
  }
  // Есть postcondition — проверяем.
  const obs = result.postObservation
  if (!obs) {
    return { ...result, status: 'uncertain', detail: (result.detail || '') + ' [нет postObservation для verify → uncertain]' }
  }
  const urlContains = typeof expectedPostcondition.urlContains === 'string'
    ? redactDurableString(expectedPostcondition.urlContains)
    : undefined
  const textAppears = typeof expectedPostcondition.textAppears === 'string'
    ? redactDurableString(expectedPostcondition.textAppears)
    : undefined
  const textDisappears = typeof expectedPostcondition.textDisappears === 'string'
    ? redactDurableString(expectedPostcondition.textDisappears)
    : undefined
  const obsUrl = redactDurableString(obs.source.url)
  const obsText = redactDurableString(obs.text ?? '')
  if (urlContains && !obsUrl.includes(urlContains)) {
    return { ...result, status: 'uncertain', detail: `postcondition urlContains "${urlContains}" не подтверждён (url=${obsUrl})` }
  }
  if (textAppears && !obsText.includes(textAppears)) {
    return { ...result, status: 'uncertain', detail: `postcondition textAppears "${textAppears}" не подтверждён` }
  }
  if (textDisappears && obsText.includes(textDisappears)) {
    return { ...result, status: 'uncertain', detail: `postcondition textDisappears "${textDisappears}" не подтверждён (текст всё ещё виден)` }
  }
  return { ...result, status: 'verified' }
}

// ── executeAdapted ──────────────────────────────────────────────────────────

async function executeAdapted(
  deps: ControllerDeps,
  input: DispatchInput,
  scope: BrowserActionScope,
  actionId: ActionId,
  attemptId: string,
  risk: RiskLevel,
  _preObs: Observation | null,
): Promise<ActionResult> {
  const adapter = deps.resolveAdapter(input.preferredAdapter)
  if (!adapter) {
    return mkFailed(actionId, attemptId, 'no adapter available', 'В текущей среде нет доступного browser adapter.')
  }
  if (!adapter.available()) {
    return mkFailed(actionId, attemptId, 'adapter unavailable', adapter.unavailableReason() ?? 'adapter not available')
  }
  const providerId = resolveDispatchProvider(input, deps)
  const providerCtx = providerId
    ? decideProviderBrowserContext(deps.getDataPolicy(input.browserTaskId), providerId)
    : null
  const redactScreenshot = providerCtx?.kind === 'redact-screenshot-only'
  try {
    // cast к string — иначе @typescript-eslint/switch-exhaustiveness-check
    // требует явной обработки всех BrowserActionType, включая не реализованные
    // в B0/R1 (download_file, upload_file — B1+). default ловит их как unsupported.
    const actionType: string = input.actionType
    switch (actionType) {
      case 'observe': {
        const obs = await adapter.observe({ browserTaskId: scope.browserTaskId, runId: scope.runId, tabRef: scope.tabRef })
        return finalizeObservation(actionId, attemptId, obs, deps, redactScreenshot)
      }
      case 'screenshot': {
        if (redactScreenshot) {
          return mkBlocked(actionId, attemptId, 'screenshot_redacted_by_data_policy', `Screenshot запрещён data policy для провайдера ${providerId ?? 'unknown'}`)
        }
        const dataUrl = await adapter.screenshot(scope)
        if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
          return mkFailed(
            actionId,
            attemptId,
            'screenshot_unavailable',
            'screenshot недоступен: adapter не вернул изображение',
          )
        }
        const url = scope.url ?? ''
        if (!isScreenshotSafeForModel(url)) {
          return mkBlocked(actionId, attemptId, 'screenshot_blocked_sensitive_url', `Скриншот заблокирован на чувствительной странице: ${url}`)
        }
        const obs = await adapter.observe({ browserTaskId: scope.browserTaskId, runId: scope.runId, tabRef: scope.tabRef })
        obs.screenshotDataUrl = dataUrl
        return finalizeObservation(actionId, attemptId, obs, deps, false)
      }
      case 'navigate': {
        const url = String(input.payload?.url ?? '')
        if (!url) return mkFailed(actionId, attemptId, 'no url', 'navigate: payload.url пуст')
        const r = await adapter.navigate(url, scope)
        // R1 Block 4: после redirect перечитываем origin — drift останавливает.
        const finalOrigin = extractOrigin(r.finalUrl)
        let obs: Observation
        try {
          obs = await adapter.observe({ browserTaskId: scope.browserTaskId, runId: scope.runId, tabRef: scope.tabRef })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return mkUncertain(
            actionId,
            attemptId,
            'unknown_effect',
            `Navigate выполнен, но post-navigate readback не удался: ${msg}. Автоповтор запрещён; нужен свежий observe.`,
          )
        }
        if (scope.origin && finalOrigin && finalOrigin !== scope.origin) {
          // redirect уводит на другой origin — следующий action должен STOP.
          // Сам navigate завершаем verified (он уже произошёл), но пост-condition
          // observation отмечает новый origin для будущих проверок.
          obs.omissions = [...(obs.omissions ?? []), `redirect drift: navigate ушёл с ${scope.origin} на ${finalOrigin} — следующие actions на старом scope будут заблокированы`]
          return mkVerified(actionId, attemptId, r.finalUrl, applyProviderScreenshotPolicy(obs, redactScreenshot), `navigated to ${r.finalUrl} (redirect drift detected)`)
        }
        return mkVerified(actionId, attemptId, r.finalUrl, applyProviderScreenshotPolicy(obs, redactScreenshot), `navigated to ${r.finalUrl}`)
      }
      case 'click': {
        const elementRef = String(input.payload?.elementRef ?? input.payload?.selector ?? scope.elementRef ?? '')
        if (!elementRef) return mkFailed(actionId, attemptId, 'no elementRef', 'click: payload.elementRef пуст')
        if (/[{};<>]|document\.|querySelector|eval\(/i.test(elementRef)) {
          return mkBlocked(actionId, attemptId, 'raw_selector', 'raw CSS/JS selector запрещён')
        }
        // Prefer control label for human-readable detail / approval already used payload.
        const r = await adapter.click(elementRef, scope)
        // Fresh observe after successful click (readback).
        let obs: Observation
        try {
          obs = await adapter.observe({ browserTaskId: scope.browserTaskId, runId: scope.runId, tabRef: scope.tabRef })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return mkUncertain(
            actionId,
            attemptId,
            'unknown_effect',
            `Click выполнен, но post-click readback не удался: ${msg}. Автоповтор запрещён; нужен свежий observe.`,
          )
        }
        // R3 without explicit postcondition → uncertain is handled in verifyPostcondition.
        // If page text clearly changed and postcondition set, verify will mark verified.
        return mkVerified(actionId, attemptId, r.finalUrl, applyProviderScreenshotPolicy(obs, redactScreenshot), `clicked ${elementRef}`)
      }
      case 'list_task_tabs': {
        const obs = await adapter.observe({ browserTaskId: scope.browserTaskId, runId: scope.runId, tabRef: scope.tabRef })
        return mkVerified(actionId, attemptId, scope.url ?? '', applyProviderScreenshotPolicy(obs, redactScreenshot), 'list_task_tabs (B0: только текущая webview tab)')
      }
      default: {
        const u = adapter.unsupported(input.actionType)
        return mkFailed(actionId, attemptId, 'unsupported', u.reason)
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (isUnknownBrowserEffectError(err)) {
      return mkUncertain(
        actionId,
        attemptId,
        'unknown_effect',
        `Эффект browser action неизвестен после dispatch: ${msg}. Автоповтор запрещён; нужен свежий readback.`,
      )
    }
    const cb = detectCircuitBreaker(msg)
    if (cb) {
      return mkBlocked(actionId, attemptId, cb, `Circuit breaker (${cb}): ${msg}`)
    }
    return mkFailed(actionId, attemptId, 'execute_error', msg)
  }
}

function finalizeObservation(
  actionId: ActionId,
  attemptId: string,
  rawObservation: Observation,
  deps: ControllerDeps,
  redactScreenshot = false,
): ActionResult {
  const obs = applyProviderScreenshotPolicy(rawObservation, redactScreenshot)
  // probe injection (best-effort): предупреждаем в лог.
  const probe = probeForPromptInjection(obs.text)
  if (probe.detected) {
    emit(deps, 'browser_injection_probe', `injection markers: ${probe.markers.join(', ')}`, obs.source.url)
  }
  // mask screenshot if unsafe.
  if (obs.screenshotDataUrl && !isScreenshotSafeForModel(obs.source.url)) {
    obs.screenshotDataUrl = null
    obs.omissions = [...(obs.omissions ?? []), 'screenshot blocked on sensitive URL (fail-closed)']
  }
  return mkVerified(actionId, attemptId, obs.source.url, obs, 'observe ok')
}

function applyProviderScreenshotPolicy(obs: Observation, redactScreenshot: boolean): Observation {
  if (!redactScreenshot || !obs.screenshotDataUrl) return obs
  return {
    ...obs,
    screenshotDataUrl: null,
    omissions: [...(obs.omissions ?? []), 'screenshot redacted by provider data policy'],
  }
}

function detectCircuitBreaker(msg: string): string | null {
  const lower = msg.toLowerCase()
  if (/\b403\b|forbidden/.test(lower)) return '403'
  if (/\b429\b|rate.?limit|too many requests/.test(lower)) return '429'
  if (/captcha|challenge|verification required/.test(lower)) return 'CAPTCHA'
  if (/logout|signed out|unauthorized|auth required/.test(lower)) return 'LOGOUT'
  if (/security warning|deceptive site|malware/.test(lower)) return 'SECURITY_WARNING'
  return null
}

function mkVerified(actionId: ActionId, attemptId: string, finalUrl: string | null, postObs: Observation, detail: string): ActionResult {
  return { actionId, status: 'verified', finalUrl, postObservation: postObs, detail, finalizedAt: Date.now() }
}
function mkFailed(actionId: ActionId, attemptId: string, reason: string, detail: string): ActionResult {
  return { actionId, status: 'failed', finalUrl: null, postObservation: null, detail, reason, finalizedAt: Date.now() }
}
function mkUncertain(actionId: ActionId, attemptId: string, reason: string, detail: string): ActionResult {
  return { actionId, status: 'uncertain', finalUrl: null, postObservation: null, detail, reason, finalizedAt: Date.now() }
}
function mkBlocked(actionId: ActionId, attemptId: string, reason: string, detail: string): ActionResult {
  return { actionId, status: 'blocked', finalUrl: null, postObservation: null, detail, reason, finalizedAt: Date.now() }
}
