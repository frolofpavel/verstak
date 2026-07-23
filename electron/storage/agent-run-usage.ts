/**
 * Persistence usage — срез 2.0.8-F. По одной строке на терминальный прогон в agent_run_usage
 * (миграция 50). run_id PRIMARY KEY → INSERT OR IGNORE ИДЕМПОТЕНТЕН: повторный finalize и
 * crash-resume-переигровка не создают 2-ю строку (каветат #1).
 *
 * Цена считается ЗДЕСЬ (main-side pricing layer) через ту же price-таблицу, что и cost-guard
 * (импорт read-only — единый источник, дубля цен нет). При НЕИЗВЕСТНОЙ цене → pricing_known=0,
 * cost_amount=null (НЕ $0, каветат #2). cache_diagnostic — ТОЛЬКО reason-код (без текста промпта,
 * каветат #3): диагностика уходит в БД навсегда.
 */

import { createHash } from 'crypto'
import type { Database } from 'better-sqlite3'
import type { ProviderId } from '../ai/registry'
import { PRICES, CLI_FREE, ZERO_COST_PROVIDERS, normalizeModelId } from '../ai/cost-guard'
import {
  billableInputTokens,
  type NormalizedUsage, type CacheDiagnosticCode, type RunUsageRow, type UsageSummaryGroup,
} from '../../shared/contracts/usage'

// Формы DTO живут в shared/contracts/usage.ts (единый источник main+renderer, 2.0.7-C).
// Re-export — чтобы существующие импортёры (agent-runs.ts) не меняли путь.
export type { CacheDiagnosticCode, RunUsageRow, UsageSummaryGroup }

export interface RunUsageInput {
  runId: string
  providerId: string
  model: string
  transport: string | null
  accountId: number | null
  usage: NormalizedUsage
  /** Только reason-код; БЕЗ текста промпта (каветат #3). Не задан → считаем из хешей. */
  cacheDiagnosticCode?: CacheDiagnosticCode | null
  /**
   * ХЕШИ (не текст!) system-prompt и набора инструментов прогона. Хеширует ВЫЗЫВАЮЩИЙ (runner) —
   * текст промпта не пересекает границу storage вообще (каветат #3: утечь нечему).
   * null/undefined = не сообщён → сравнение по этой оси невозможно.
   */
  systemPromptHash?: string | null
  toolsHash?: string | null
}

/**
 * Хеш для cache-диагностики. Короткий sha256 — нужен только для сравнения «то же / другое»,
 * восстановить текст из него нельзя. Зовётся В RUNNER'Е (текст остаётся там).
 */
export function usageHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

export interface RunCost {
  costAmount: number | null // null = цена неизвестна (pricingKnown=0), НЕ 0
  currency: string
  pricingKnown: 0 | 1
}

/**
 * Стоимость прогона по той же логике, что cost-guard (billableInputTokens — единое место
 * вычитания кэша, фикс дефекта B из E). CLI/локальные — ЗАВЕДОМО $0 (pricing_known=1). Модель
 * не в PRICES — цена НЕИЗВЕСТНА (pricing_known=0, cost=null), НЕ $0 (каветат #2).
 */
export function computeRunCost(providerId: string, model: string, usage: NormalizedUsage): RunCost {
  const pid = providerId as ProviderId
  if (CLI_FREE.has(pid) || ZERO_COST_PROVIDERS.has(pid)) {
    return { costAmount: 0, currency: 'USD', pricingKnown: 1 } // заведомо бесплатно (известно)
  }
  const price = PRICES[normalizeModelId(pid, model)]
  if (!price) return { costAmount: null, currency: 'USD', pricingKnown: 0 } // цена неизвестна
  const billable = billableInputTokens(usage) ?? 0
  const cacheRead = usage.cacheReadTokens ?? 0
  const output = usage.outputTokens ?? 0
  const inputCost = (billable / 1_000_000) * price.input
  const cachedCost = price.cached ? (cacheRead / 1_000_000) * price.cached : 0
  const outputCost = (output / 1_000_000) * price.output
  // ЗНАЕМЫЙ СИСТЕМНЫЙ ПРОБЕЛ (не F-регрессия): cacheWriteTokens ПЕРСИСТИТСЯ (колонка
  // cache_write_tokens), но в стоимость НЕ входит — как и в live cost-guard.recordAndCheck
  // (ModelPrice не имеет цены записи кэша). У Claude cache-creation тарифицируется ~1.25×input,
  // поэтому cost занижен на cache-heavy первом ходе. Сознательно держим ОДИНАКОВО с cost-guard
  // (иначе persisted-cost разойдётся с денежным CAP). Тарификация cacheWrite = отдельный срез
  // (ModelPrice.cacheWrite + оба места: cost-guard + здесь) — деферрал для аудита 2.0.10-G.
  return { costAmount: inputCost + cachedCost + outputCost, currency: 'USD', pricingKnown: 1 }
}

/**
 * Cache-диагностика (минимальная ЧЕСТНАЯ версия). Отвечает на строго проверяемый вопрос:
 * «что изменилось против ПРОШЛОГО прогона этого чата» — то, что делает кэш невалидным.
 *
 * ВАЖНО про честность: это НЕ утверждение «поэтому кэш промахнулся». Отличить «провайдер не
 * сообщил кэш» от «кэш дал ноль» на hook-пути нельзя (сумма усечена в 0), поэтому код НЕ
 * привязан к факту промаха — он констатирует факт изменения условий. Так он не врёт ни на
 * провайдерах без кэша, ни при частичном попадании.
 *
 * Прогон вне чата (chat_id NULL) или неизвестные хеши → 'unknown' (не выдумываем).
 */
export function diagnoseCacheReason(
  db: Database,
  input: Pick<RunUsageInput, 'runId' | 'systemPromptHash' | 'toolsHash'>,
  now: number,
): CacheDiagnosticCode {
  const run = db.prepare('SELECT chat_id as chatId FROM agent_runs WHERE run_id = ?').get(input.runId) as { chatId: number | null } | undefined
  if (!run || run.chatId == null) return 'unknown' // вне чата — сравнивать не с чем
  const prior = db.prepare(
    `SELECT u.system_prompt_hash as sysHash, u.tools_hash as toolsHash
       FROM agent_run_usage u
       JOIN agent_runs r ON r.run_id = u.run_id
      WHERE r.chat_id = ? AND u.run_id != ? AND u.created_at <= ?
      ORDER BY u.created_at DESC, u.rowid DESC
      LIMIT 1`
  ).get(run.chatId, input.runId, now) as { sysHash: string | null; toolsHash: string | null } | undefined
  if (!prior) {
    // Прошлой строки usage нет — но это ДВА разных случая, и путать их нельзя:
    //  · чат реально новый → 'first-request' (кэшу неоткуда взяться) — правда;
    //  · чат СТАРЫЙ, просто учёт расхода включился только сейчас (миграция 50 историю не
    //    бэкфиллит) → назвать прогон «первым в этом чате» = соврать. Честно: 'unknown'
    //    (прошлый прогон был, но его префикс мы не знаем — сравнивать не с чем).
    const priorRun = db.prepare(
      'SELECT 1 AS x FROM agent_runs WHERE chat_id = ? AND run_id != ? AND started_at <= ? LIMIT 1'
    ).get(run.chatId, input.runId, now) as { x: number } | undefined
    return priorRun ? 'unknown' : 'first-request'
  }
  if (input.systemPromptHash && prior.sysHash && input.systemPromptHash !== prior.sysHash) return 'system-prompt-changed'
  if (input.toolsHash && prior.toolsHash && input.toolsHash !== prior.toolsHash) return 'tools-drift'
  return 'unknown' // условия те же (или не сообщены) — причину промаха не знаем
}

/**
 * Пишет usage прогона ОДИН раз (INSERT OR IGNORE по run_id PRIMARY KEY). Повторный вызов
 * (double-finalize / crash-resume) — no-op, 2-й строки нет. Best-effort у ВЫЗЫВАЮЩЕГО:
 * исключение отсюда не должно ронять прогон (runner ловит).
 *
 * cacheDiagnosticCode: явно переданный побеждает; иначе считаем через diagnoseCacheReason.
 * В БД уходят ТОЛЬКО хеши и код — текста промпта здесь нет by design (каветат #3).
 */
export function persistRunUsage(db: Database, input: RunUsageInput, now: number): void {
  const cost = computeRunCost(input.providerId, input.model, input.usage)
  const u = input.usage
  const diagnostic = input.cacheDiagnosticCode ?? diagnoseCacheReason(db, input, now)
  db.prepare(
    `INSERT OR IGNORE INTO agent_run_usage
       (run_id, provider_id, model, transport, account_id,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, input_accounting,
        cost_amount, currency, pricing_known, cache_diagnostic_code,
        system_prompt_hash, tools_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.runId, input.providerId, input.model, input.transport, input.accountId,
    u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheWriteTokens, u.inputAccounting,
    cost.costAmount, cost.currency, cost.pricingKnown, diagnostic,
    input.systemPromptHash ?? null, input.toolsHash ?? null, now,
  )
}

const SELECT = `
  SELECT run_id as runId, provider_id as providerId, model, transport, account_id as accountId,
         input_tokens as inputTokens, output_tokens as outputTokens,
         cache_read_tokens as cacheReadTokens, cache_write_tokens as cacheWriteTokens,
         input_accounting as inputAccounting, cost_amount as costAmount, currency,
         pricing_known as pricingKnown, cache_diagnostic_code as cacheDiagnosticCode, created_at as createdAt
  FROM agent_run_usage
`

/** Строки usage за период (createdAt >= sinceMs), новейшие первыми. */
export function listRunUsage(db: Database, opts?: { sinceMs?: number; limit?: number }): RunUsageRow[] {
  const since = opts?.sinceMs ?? 0
  const limit = opts?.limit ?? 1000
  return db.prepare(`${SELECT} WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?`).all(since, limit) as RunUsageRow[]
}

/**
 * VSK-PROOF-A1: точная строка usage СТРОГО по run_id (PRIMARY KEY) — источник честности
 * стоимости для Proof Pack. Отсутствие строки → null (legacy/incomplete), НЕ «ноль».
 * Никакого list().find() по времени/chatId/provider — чужой прогон подхватить нельзя.
 */
export function getRunUsage(db: Database, runId: string): RunUsageRow | null {
  return (db.prepare(`${SELECT} WHERE run_id = ?`).get(runId) as RunUsageRow | undefined) ?? null
}

/**
 * Полный размер промпта строки — ЗНАМЕНАТЕЛЬ доли кэша. Зависит от семантики провайдера
 * (ревью P0: без этого доля врала). Это тот же дефект B, но в знаменателе:
 *  · exclusive (Claude) — reported input НЕ содержит кэш. У Claude промпт разложен на ТРИ
 *    непересекающиеся корзины: input_tokens (свежий) + cache_creation (запись) + cache_read
 *    (чтение) → весь промпт = сумма всех трёх. Забыть запись нельзя: прогон прогрева кэша
 *    иначе выпадает из знаменателя и доля завышается кратно (ре-ревью P0: показывало 98%
 *    там, где честно ~50%);
 *  · inclusive (OpenAI/Gemini) — cached ⊂ input → весь промпт = input;
 *  · unknown — семантика не подтверждена → доля неинтерпретируема, строку НЕ учитываем.
 * null = «в знаменатель не берём» (input не сообщён или семантика неизвестна).
 */
function promptSizeForShare(r: Pick<RunUsageRow, 'inputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'inputAccounting'>): number | null {
  if (r.inputTokens == null) return null
  if (r.inputAccounting === 'exclusive') return r.inputTokens + (r.cacheReadTokens ?? 0) + (r.cacheWriteTokens ?? 0)
  if (r.inputAccounting === 'inclusive') {
    // inclusive ОБЕЩАЕТ cached ⊂ input, значит cacheRead > input невозможно. Если провайдер
    // прислал такое — наша модель его семантики неверна; честный ответ «нет данных», а не
    // доля >100% (доля не может превышать единицу — это выглядело бы бредом и врало бы).
    if ((r.cacheReadTokens ?? 0) > r.inputTokens) return null
    return r.inputTokens
  }
  return null
}

/**
 * Агрегат по (provider, model, transport) за период. cacheHitShare считается ТОЛЬКО по строкам
 * с ИЗВЕСТНЫМ и ИНТЕРПРЕТИРУЕМЫМ знаменателем (см. promptSizeForShare) — иначе null
 * (не выдумываем «0%», каветат «долю только где знаменатель известен»).
 */
export function usageSummary(db: Database, sinceMs: number): UsageSummaryGroup[] {
  const rows = listRunUsage(db, { sinceMs, limit: 100_000 })
  const groups = new Map<string, UsageSummaryGroup & { _inputKnown: number; _cacheKnown: number }>()
  for (const r of rows) {
    const key = `${r.providerId}|${r.model}|${r.transport ?? ''}`
    let g = groups.get(key)
    if (!g) {
      g = { providerId: r.providerId, model: r.model, transport: r.transport, runs: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costAmount: 0, unknownCostRuns: 0, cacheHitShare: null, _inputKnown: 0, _cacheKnown: 0 }
      groups.set(key, g)
    }
    g.runs++
    g.inputTokens += r.inputTokens ?? 0
    g.outputTokens += r.outputTokens ?? 0
    g.cacheReadTokens += r.cacheReadTokens ?? 0
    g.cacheWriteTokens += r.cacheWriteTokens ?? 0
    if (r.pricingKnown === 1 && r.costAmount != null) g.costAmount += r.costAmount
    else g.unknownCostRuns++
    // Знаменатель cache-hit — ПОЛНЫЙ размер промпта по семантике провайдера, а не сырой
    // reported input (иначе у exclusive-провайдеров «доля» уходит за 100%).
    const promptSize = promptSizeForShare(r)
    if (promptSize != null) { g._inputKnown += promptSize; g._cacheKnown += r.cacheReadTokens ?? 0 }
  }
  return [...groups.values()].map(g => {
    const { _inputKnown, _cacheKnown, ...rest } = g
    // cacheHitShare только если знаменатель > 0 и известен; иначе null (нет данных).
    return { ...rest, cacheHitShare: _inputKnown > 0 ? _cacheKnown / _inputKnown : null }
  })
}

/** Read-поверхность usage для IPC (зеркалит идиому createFeedback/createPlans). */
export interface RunUsage {
  /** Точный lookup по runId (VSK-PROOF-A1): строка есть → RunUsageRow, нет → null. */
  get: (runId: string) => RunUsageRow | null
  list: (opts?: { sinceMs?: number; limit?: number }) => RunUsageRow[]
  summary: (sinceMs: number) => UsageSummaryGroup[]
}

export function createRunUsage(db: Database): RunUsage {
  return {
    get: (runId) => getRunUsage(db, runId),
    list: (opts) => listRunUsage(db, opts),
    summary: (sinceMs) => usageSummary(db, sinceMs),
  }
}
