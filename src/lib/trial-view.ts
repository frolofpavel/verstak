/**
 * P1 шаг 3: чистая логика панели состязания («История работы»).
 *
 * Здесь три обязательства постановки, вынесенные из JSX под пины:
 *  · финиш попытки ставит ПАНЕЛЬ (attempt.status не должен вечно висеть running,
 *    когда прогон уже терминален — правду до шага 3 нёс только runStatus из JOIN);
 *  · модель разрешается ЯВНО до оценки и запуска — обе смотрят на одну и ту же;
 *  · неизвестная цена — слово «неизвестна», не ноль и не подставленный тариф.
 */
import type { TrialTokenAssumption } from '../../shared/contracts/trials'

export interface TrialFinishPatch {
  status: 'done' | 'failed'
  error?: string
}

/** Терминальные статусы agent_runs → патч финиша попытки. 'suspended' здесь
 *  сознательно НЕТ: приостановленный прогон продолжаем, а не хороним. */
const RUN_FINISH: Record<string, TrialFinishPatch> = {
  done: { status: 'done' },
  failed: { status: 'failed', error: 'прогон завершился ошибкой' },
  stopped: { status: 'failed', error: 'прогон остановлен' },
  timed_out: { status: 'failed', error: 'прогон превысил лимит времени' },
  interrupted: { status: 'failed', error: 'прогон прерван перезапуском' },
}

const RUN_TERMINAL = new Set(Object.keys(RUN_FINISH))

/** Финиш попытки, который обязана поставить панель. null — ставить нечего. */
export function attemptFinishPatch(
  row: { status: string; runStatus: string | null },
): TrialFinishPatch | null {
  if (row.status !== 'running') return null
  if (!row.runStatus) return null
  return RUN_FINISH[row.runStatus] ?? null
}

export interface TrialCompetitorPick {
  providerId: string
  model: string | null
}

export interface ResolvedTrialCompetitor {
  providerId: string
  model: string
}

/**
 * Разрешить модели участников ДО оценки и запуска: выбранная — как есть,
 * невыбранная — дефолт провайдера из каталога. Итог без null: оценка и прогон
 * обязаны смотреть на одну и ту же модель, «пусть прогон сам решит» запрещено.
 */
export function resolveTrialCompetitors(
  picks: TrialCompetitorPick[],
  providers: Array<{ id: string; defaultModel: string }>,
): { competitors: ResolvedTrialCompetitor[] } | { error: string } {
  const byId = new Map(providers.map(p => [p.id, p]))
  const competitors: ResolvedTrialCompetitor[] = []
  for (const pick of picks) {
    const model = pick.model ?? byId.get(pick.providerId)?.defaultModel ?? null
    if (!model) {
      return { error: `у исполнителя «${pick.providerId}» не выбрана модель — оценка и прогон обязаны смотреть на одну` }
    }
    competitors.push({ providerId: pick.providerId, model })
  }
  return { competitors }
}

const fmtCents = (cents: number): string => `$${(cents / 100).toFixed(2)}`

/** Деньги попытки — факт из agent_runs. Терминальный прогон без цены — честное
 *  слово «неизвестна»; живой/не стартовавший — «—» (цены ещё просто нет). */
export function moneyFactLabel(
  row: { costCents: number | null; runStatus: string | null; status: string },
): string {
  if (row.costCents != null) return fmtCents(row.costCents)
  const finished = (row.runStatus != null && RUN_TERMINAL.has(row.runStatus))
    || row.status === 'done' || row.status === 'failed'
    || row.status === 'accepted' || row.status === 'archived'
  return finished ? 'неизвестна' : '—'
}

/** Оценка ДО запуска: основание цифры объявлено явно. */
export function estimateLabel(
  est: { basis: 'price' | 'subscription' | 'zero-cost' | 'unknown'; estimateCents: number | null },
): string {
  switch (est.basis) {
    case 'subscription': return '$0 · подписка CLI'
    case 'zero-cost': return '$0 · свой endpoint'
    case 'price': return est.estimateCents != null ? `≈${fmtCents(est.estimateCents)}` : 'неизвестна'
    case 'unknown': return 'неизвестна'
  }
}

const fmtTokens = (n: number): string =>
  n >= 1000 && n % 1000 === 0 ? `${n / 1000} тыс.` : String(n)

/** Подпись допущения объёма — рядом с центами, из той же shared-константы. */
export function estimateAssumptionLabel(tokens: TrialTokenAssumption): string {
  return `допущение объёма: ${fmtTokens(tokens.inputTokens)} токенов входа · ${fmtTokens(tokens.outputTokens)} выхода — сравнение исполнителей, не обещание чека`
}

/** Колонка «что вышло»: слова попытки важнее выведенного ярлыка. */
export function attemptOutcomeLabel(
  row: { status: string; runStatus: string | null; outcome: string | null; error: string | null; filesCount: number | null },
): string {
  if (row.outcome) return row.outcome
  if (row.error) return row.error
  switch (row.status) {
    case 'pending': return 'ожидает запуска'
    case 'running': return row.runStatus != null && RUN_TERMINAL.has(row.runStatus) ? 'завершается…' : 'работает…'
    case 'failed': return 'упало'
    case 'done':
    case 'accepted':
    case 'archived':
      // Б3.1 (живая приёмка 11.08): остановленный ⏹ на середине прогон — не
      // «готово». Ярлык обязан различать «дошёл до конца» и «остановлен»:
      // по нему человек решает, чью работу принять.
      if (row.runStatus === 'stopped') {
        return row.filesCount != null && row.filesCount > 0 ? `остановлен · файлов: ${row.filesCount}` : 'остановлен'
      }
      return row.filesCount != null && row.filesCount > 0 ? `готово · файлов: ${row.filesCount}` : 'готово'
    default: return row.status
  }
}

/** Колонка «минут». */
export function fmtTrialMinutes(durationMs: number | null): string {
  if (durationMs == null) return '—'
  if (durationMs < 60_000) return '<1 мин'
  return `${Math.round(durationMs / 60_000)} мин`
}
