import { useEffect, useState } from 'react'
import type { RunUsageRow, UsageSummaryGroup } from '../../types/api'
import { costLabel, cacheLabel, runCostLabel, cacheDiagnosticLabel, formatCost } from '../../lib/usage-format'

// Срез 2.0.8-F: вкладка «Расход» — история usage прогонов (переживает рестарт), разрез
// provider/model/transport за 7/30 дней + стоимость.
//
// STANDALONE (каветат #5 карточки): компонент готов, но НЕ вшивается в Settings.tsx до
// merge живой ветки Ильи (его зона — конфликт). Подключение табов — срез после merge.
//
// ЧЕСТНОСТЬ ТРЁХ СОСТОЯНИЙ (каветат #2 — нельзя выдавать «неизвестно» за ноль):
//  · кэш «нет данных»  — знаменатель неизвестен (провайдер не сообщил input) → cacheHitShare=null;
//  · кэш «нет кэша»    — знаменатель ИЗВЕСТЕН и доля = 0 (кэш реально не сработал);
//  · «цена неизвестна» — pricing_known=0 (модель не в прайсе) → НЕ $0. Известный ноль
//    (CLI/локальные) показываем как «бесплатно» — это ДРУГОЕ состояние.

const DAY_MS = 86_400_000

const fmt = (n: number) => n.toLocaleString('ru-RU')

export function UsageTab() {
  const [days, setDays] = useState<7 | 30>(7)
  const [groups, setGroups] = useState<UsageSummaryGroup[]>([])
  const [runs, setRuns] = useState<RunUsageRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    // Границу периода считает UI (storage не выдумывает «сегодня») — абсолютная метка.
    const sinceMs = Date.now() - days * DAY_MS
    void Promise.all([
      window.api.usage.summary(sinceMs),
      window.api.usage.list({ sinceMs, limit: 20 }),
    ])
      .then(([s, l]) => { if (!cancelled) { setGroups(s); setRuns(l); setLoading(false) } })
      .catch(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [days])

  const totalRuns = groups.reduce((a, g) => a + g.runs, 0)
  const knownCost = groups.reduce((a, g) => a + g.costAmount, 0)
  const unknownRuns = groups.reduce((a, g) => a + g.unknownCostRuns, 0)

  return (
    <div className="gg-settings-extra gg-usage-tab">
      <h2 className="gg-settings-page-title">Расход</h2>
      <p className="gg-models-intro">
        Сколько прогонов, токенов и денег ушло по каждому провайдеру и модели. История пишется
        при завершении прогона и переживает перезапуск. Там, где провайдер не сообщил цифры или
        цена модели неизвестна, так и написано — вместо выдуманного нуля.
      </p>

      <div className="gg-usage-period" style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
        {([7, 30] as const).map(d => (
          <button
            key={d}
            type="button"
            className={`gg-usage-period-btn${days === d ? ' is-active' : ''}`}
            aria-pressed={days === d}
            onClick={() => setDays(d)}
          >
            {d} дней
          </button>
        ))}
      </div>

      {loading && <p className="gg-models-card-desc">Загрузка…</p>}
      {!loading && groups.length === 0 && (
        <p className="gg-models-card-desc">За выбранный период прогонов не было.</p>
      )}

      {!loading && groups.length > 0 && (
        <>
          <p className="gg-usage-total gg-models-card-desc">
            {/* formatCost, а не сырой toFixed(2): мелкая сумма схлопнулась бы в «$0.00» и
                читалась как «бесплатно» — ровно та ложь, от которой этот форматтер и заведён. */}
            Всего прогонов: <b>{fmt(totalRuns)}</b> · известная стоимость: <b>{formatCost(knownCost)}</b>
            {unknownRuns > 0 && <> · без цены: <b>{fmt(unknownRuns)}</b></>}
          </p>

          <div className="gg-usage-groups" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {groups.map(g => (
              <div
                key={`${g.providerId}|${g.model}|${g.transport ?? ''}`}
                className="gg-usage-group"
                style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}
              >
                <span className="gg-usage-model" style={{ fontWeight: 600 }}>{g.model}</span>
                <span className="gg-usage-provider gg-models-card-desc">{g.providerId}</span>
                {g.transport && <span className="gg-usage-transport gg-models-card-desc">{g.transport}</span>}
                <span className="gg-usage-runs gg-models-card-desc">{fmt(g.runs)} прогонов</span>
                {/* «Вход» здесь = СВЕЖИЙ вход. У Claude кэш идёт отдельными корзинами, поэтому
                    подписывать это просто «вход» нельзя — процент ниже считается от ВСЕГО
                    промпта, и без видимой базы цифры на экране не сходились бы (ре-ревью P0). */}
                <span className="gg-usage-tokens gg-models-card-desc" title="Свежий вход (не из кэша) / выход">
                  ↓{fmt(g.inputTokens)} ↑{fmt(g.outputTokens)}
                </span>
                {g.cacheReadTokens > 0 && (
                  <span className="gg-usage-cacheread gg-models-card-desc" title="Прочитано из кэша (дешевле свежего входа)">
                    ⚡{fmt(g.cacheReadTokens)}
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
