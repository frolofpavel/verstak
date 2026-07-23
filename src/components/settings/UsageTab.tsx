import { useEffect, useState } from 'react'
import type { RunUsageRow, UsageSummaryGroup } from '../../types/api'
import {
  costLabel, cacheLabel, runCostLabel, cacheDiagnosticLabel, formatCost, usagePeriodTotals,
  type UsagePeriodTotals,
} from '../../lib/usage-format'

// 2.1.3-E: Cache Control Tower поверх persistence 2.0.8-F. Одновременно показывает
// 7/30 дней, маршрут аккаунта и раздельные cache-write/cache-read.
//
// ЧЕСТНОСТЬ ТРЁХ СОСТОЯНИЙ (каветат #2 — нельзя выдавать «неизвестно» за ноль):
//  · кэш «нет данных»  — знаменатель неизвестен (провайдер не сообщил input) → cacheHitShare=null;
//  · кэш «нет кэша»    — знаменатель ИЗВЕСТЕН и доля = 0 (кэш реально не сработал);
//  · «цена неизвестна» — pricing_known=0 (модель не в прайсе) → НЕ $0. Известный ноль
//    (CLI/локальные) показываем как «бесплатно» — это ДРУГОЕ состояние.

const DAY_MS = 86_400_000

const fmt = (n: number) => n.toLocaleString('ru-RU')

function PeriodCard({ days, totals, active, onSelect }: {
  days: 7 | 30
  totals: UsagePeriodTotals
  active: boolean
  onSelect: () => void
}) {
  return (
    <button type="button" className={`gg-usage-period-card${active ? ' is-active' : ''}`} onClick={onSelect}>
      <strong>{days} дней</strong>
      <span>{fmt(totals.runs)} прогонов · {formatCost(totals.knownCost)}</span>
      {totals.unknownCostRuns > 0 && <span>{fmt(totals.unknownCostRuns)} без известной цены</span>}
      <span>кэш: записано {fmt(totals.cacheWriteTokens)} · прочитано {fmt(totals.cacheReadTokens)}</span>
    </button>
  )
}

export function UsageTab() {
  const [days, setDays] = useState<7 | 30>(7)
  const [summary7, setSummary7] = useState<UsageSummaryGroup[]>([])
  const [summary30, setSummary30] = useState<UsageSummaryGroup[]>([])
  const [runs, setRuns] = useState<RunUsageRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    // Границу периода считает UI (storage не выдумывает «сегодня») — абсолютная метка.
    const now = Date.now()
    void Promise.all([
      window.api.usage.summary(now - 7 * DAY_MS),
      window.api.usage.summary(now - 30 * DAY_MS),
      window.api.usage.list({ sinceMs: now - days * DAY_MS, limit: 20 }),
    ])
      .then(([week, month, list]) => {
        if (!cancelled) {
          setSummary7(week)
          setSummary30(month)
          setRuns(list)
          setLoading(false)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError('Не удалось загрузить расход. Данные не изменены — попробуй открыть вкладку снова.')
          setLoading(false)
        }
      })
    return () => { cancelled = true }
  }, [days])

  const groups = days === 7 ? summary7 : summary30
  const weekTotals = usagePeriodTotals(summary7)
  const monthTotals = usagePeriodTotals(summary30)
  const selectedTotals = days === 7 ? weekTotals : monthTotals

  return (
    <div className="gg-settings-extra gg-usage-tab">
      <h2 className="gg-settings-page-title">Расход</h2>
      <p className="gg-models-intro">
        Сколько прогонов, токенов и денег ушло по каждому провайдеру и модели. История пишется
        при завершении прогона и переживает перезапуск. Там, где провайдер не сообщил цифры или
        цена модели неизвестна, так и написано — вместо выдуманного нуля.
      </p>

      <div className="gg-usage-period gg-usage-period-compare">
        <PeriodCard days={7} totals={weekTotals} active={days === 7} onSelect={() => setDays(7)} />
        <PeriodCard days={30} totals={monthTotals} active={days === 30} onSelect={() => setDays(30)} />
      </div>

      {loading && <p className="gg-models-card-desc">Загрузка…</p>}
      {error && <p className="gg-settings-error" role="alert">{error}</p>}
      {!loading && groups.length === 0 && (
        <p className="gg-models-card-desc">За выбранный период прогонов не было.</p>
      )}

      {!loading && groups.length > 0 && (
        <>
          <p className="gg-usage-total gg-models-card-desc">
            {/* formatCost, а не сырой toFixed(2): мелкая сумма схлопнулась бы в «$0.00» и
                читалась как «бесплатно» — ровно та ложь, от которой этот форматтер и заведён. */}
            Всего прогонов: <b>{fmt(selectedTotals.runs)}</b> · известная стоимость: <b>{formatCost(selectedTotals.knownCost)}</b>
            {selectedTotals.unknownCostRuns > 0 && <> · без цены: <b>{fmt(selectedTotals.unknownCostRuns)}</b></>}
          </p>

          <div className="gg-usage-groups" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {groups.map(g => (
              <div
                key={`${g.providerId}|${g.model}|${g.transport ?? ''}|${g.accountId ?? ''}`}
                className="gg-usage-group"
                style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}
              >
                <span className="gg-usage-model" style={{ fontWeight: 600 }}>{g.model}</span>
                <span className="gg-usage-provider gg-models-card-desc">{g.providerId}</span>
                {g.transport && <span className="gg-usage-transport gg-models-card-desc">{g.transport}</span>}
                {(g.accountLabel || g.accountId != null) && (
                  <span className="gg-usage-account gg-models-card-desc">
                    аккаунт: {g.accountLabel ?? `#${g.accountId}`}
                  </span>
                )}
                <span className="gg-usage-runs gg-models-card-desc">{fmt(g.runs)} прогонов</span>
                {/* «Вход» здесь = СВЕЖИЙ вход. У Claude кэш идёт отдельными корзинами, поэтому
                    подписывать это просто «вход» нельзя — процент ниже считается от ВСЕГО
                    промпта, и без видимой базы цифры на экране не сходились бы (ре-ревью P0). */}
                <span className="gg-usage-tokens gg-models-card-desc" title="Свежий вход (не из кэша) / выход">
                  ↓{fmt(g.inputTokens)} ↑{fmt(g.outputTokens)}
                </span>
                {g.cacheReadTokens > 0 && (
                  <span className="gg-usage-cacheread gg-models-card-desc" title="Прочитано из кэша (дешевле свежего входа)">
                    прочитано ⚡{fmt(g.cacheReadTokens)}
                  </span>
                )}
                {g.cacheWriteTokens > 0 && (
                  <span className="gg-usage-cachewrite gg-models-card-desc" title="Записано в prompt cache; первый прогрев тарифицируется отдельно">
                    записано ⇧{fmt(g.cacheWriteTokens)}
                  </span>
                )}
                <span className="gg-usage-cache gg-models-card-desc" title="Доля ВСЕГО промпта, прочитанная из кэша (свежий вход + запись в кэш + чтение из кэша)">
                  кэш: {cacheLabel(g.cacheHitShare)}
                </span>
                <span className="gg-usage-cost" style={{ fontWeight: 600 }}>{costLabel(g)}</span>
              </div>
            ))}
          </div>

          <h3 className="gg-usage-recent-title" style={{ marginTop: 14 }}>Последние прогоны</h3>
          <div className="gg-usage-runs-list" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {runs.map(r => (
              <div key={r.runId} className="gg-usage-run gg-models-card-desc" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <span>{new Date(r.createdAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                <span>{r.model}</span>
                {r.transport && <span>{r.transport}</span>}
                {(r.accountLabel || r.accountId != null) && <span>{r.accountLabel ?? `аккаунт #${r.accountId}`}</span>}
                {(r.cacheWriteTokens ?? 0) > 0 && <span>кэш ⇧{fmt(r.cacheWriteTokens ?? 0)}</span>}
                {(r.cacheReadTokens ?? 0) > 0 && <span>кэш ⚡{fmt(r.cacheReadTokens ?? 0)}</span>}
                <span>{runCostLabel(r)}</span>
                {r.cacheDiagnosticCode && (
                  // Тултип НЕ утверждает «поэтому кэш промахнулся»: для «первого прогона» и
                  // «причина неизвестна» ничего не менялось — обещание было бы ложным.
                  <span title="Состояние кэша: что известно про этот прогон в сравнении с прошлым прогоном этого чата">
                    {cacheDiagnosticLabel(r.cacheDiagnosticCode)}
                  </span>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
