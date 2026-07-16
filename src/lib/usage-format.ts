import type { UsageSummaryGroup, RunUsageRow } from '../types/api'

/**
 * Ярлыки расхода — срез 2.0.8-F. Чистая логика ЧЕСТНОСТИ (каветат #2 карточки):
 * «неизвестно» нельзя показывать как ноль, а «известный ноль» — как неизвестность.
 *
 * Три различимых состояния:
 *  · «цена неизвестна» — pricing_known=0 (модель не в прайсе). НЕ $0.
 *  · «бесплатно»       — цена ИЗВЕСТНА и равна нулю (CLI/локальные).
 *  · «$X.XX»           — цена известна и положительна.
 * И по кэшу:
 *  · «нет данных» — знаменатель неизвестен (провайдер не сообщил input);
 *  · «нет кэша»   — знаменатель известен, доля ровно 0 (кэш реально не сработал).
 */

/** Деньги: мелкие суммы — 4 знака (иначе всё схлопнется в «$0.00» и будет врать). */
export function formatCost(amount: number): string {
  return `$${amount < 0.01 ? amount.toFixed(4) : amount.toFixed(2)}`
}

/** Стоимость группы: известный ноль ≠ неизвестная цена; частично-неизвестное честно помечено. */
export function costLabel(g: Pick<UsageSummaryGroup, 'costAmount' | 'unknownCostRuns' | 'runs'>): string {
  if (g.unknownCostRuns >= g.runs) return 'цена неизвестна'
  const known = g.costAmount > 0 ? formatCost(g.costAmount) : 'бесплатно'
  return g.unknownCostRuns > 0 ? `${known} + ${g.unknownCostRuns} без цены` : known
}

/** Стоимость одного прогона: pricing_known=0 или cost=null → «цена неизвестна» (не $0). */
export function runCostLabel(r: Pick<RunUsageRow, 'pricingKnown' | 'costAmount'>): string {
  if (r.pricingKnown !== 1 || r.costAmount == null) return 'цена неизвестна'
  return r.costAmount > 0 ? formatCost(r.costAmount) : 'бесплатно'
}

/** Доля кэша: null → «нет данных»; 0 → «нет кэша»; иначе проценты. */
export function cacheLabel(share: number | null): string {
  if (share == null) return 'нет данных'
  if (share === 0) return 'нет кэша'
  return `${Math.round(share * 100)}%`
}

/**
 * Человеческий ярлык cache-диагностики. В БД лежит машинный код — пользователю показываем
 * ПО-РУССКИ и без жаргона (Павел — маркетолог, «system-prompt-changed» ему ничего не говорит).
 * Формулировки описывают ФАКТ изменения, а не утверждают «поэтому кэш промахнулся».
 *
 * ВАЖНО про 'system-prompt-changed' (ревью P0): системное сообщение пересобирается на КАЖДУЮ
 * отправку и включает не только правила проекта (CLAUDE.md), но и авто-контекст (git status,
 * недавние правки, карта проекта) — он меняется почти всегда. Поэтому ярлык НЕ смеет говорить
 * «изменились правила проекта» (правила-то не менялись) — он честно называет весь системный
 * промпт целиком. Что авто-контекст этим сам сбивает кэш — отдельная находка (см. STATUS).
 */
const DIAGNOSTIC_LABEL: Record<string, string> = {
  'first-request': 'первый прогон в этом чате',
  'system-prompt-changed': 'изменился системный промпт (правила + авто-контекст)',
  'tools-drift': 'изменился набор инструментов',
  'model-changed': 'сменилась модель',
  'ttl-expired': 'кэш устарел',
  'provider-reported-miss': 'провайдер сообщил о промахе',
  unknown: 'причина неизвестна',
}

/** Неизвестный/новый код показываем как есть — лучше сырой код, чем выдуманный смысл. */
export function cacheDiagnosticLabel(code: string | null): string | null {
  if (!code) return null
  return DIAGNOSTIC_LABEL[code] ?? code
}
