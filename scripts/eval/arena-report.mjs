import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { assertNoSecretLikeText, redactSecrets } from './contracts.mjs'
import { describeSelfCheck } from './self-check.mjs'

export function buildArenaSummary(rows, repeat) {
  const groups = new Map()
  for (const row of rows) {
    const key = `${row.runnerId}:${row.model}`
    const group = groups.get(key) ?? {
      runnerId: row.runnerId,
      runnerLabel: row.runnerLabel,
      runnerVersion: row.runnerVersion,
      model: row.model,
      runs: 0,
      passes: 0,
      comparableRuns: 0,
      executedRuns: 0,
      durations: [],
      costs: [],
      interventions: 0,
      selfCheckedRuns: 0,
      selfCheckEligibleRuns: 0,
    }
    group.runs++
    if (row.comparable) {
      group.comparableRuns++
      if (row.result !== 'dry-run') group.executedRuns++
      if (row.result === 'pass') group.passes++
      if (Number.isFinite(row.durationMs)) group.durations.push(row.durationMs)
      if (Number.isFinite(row.estimatedCost)) group.costs.push(row.estimatedCost)
      group.interventions += row.interventions
      // Метрика «проверил ли себя» считается только там, где записи БЫЛИ:
      // no-writes/no-trace не разбавляют rate ни в плюс, ни в минус.
      if (row.selfCheck === 'checked' || row.selfCheck === 'unchecked') {
        group.selfCheckEligibleRuns++
        if (row.selfCheck === 'checked') group.selfCheckedRuns++
      }
    }
    groups.set(key, group)
  }

  return [...groups.values()].map(group => ({
    runnerId: group.runnerId,
    runnerLabel: group.runnerLabel,
    runnerVersion: group.runnerVersion,
    model: group.model,
    runs: group.runs,
    passRate: group.comparableRuns ? group.passes / group.comparableRuns : null,
    medianDurationMs: median(group.durations),
    medianEstimatedCost: median(group.costs),
    interventions: group.interventions,
    selfCheckedRuns: group.selfCheckedRuns,
    selfCheckEligibleRuns: group.selfCheckEligibleRuns,
    selfCheckRate: group.selfCheckEligibleRuns ? group.selfCheckedRuns / group.selfCheckEligibleRuns : null,
    comparable: group.comparableRuns === group.runs && group.runs > 0,
    productionRecommendationEligible:
      repeat >= 3
      && group.comparableRuns === group.runs
      && group.executedRuns === group.runs
      && group.runs > 0,
  }))
}

// D1 (10.08): рост цены при ТОМ ЖЕ успехе = регрессия. Порог явный, не магический:
// медианы цен дрожат между прогонами, 10% отсекают шум одиночного повтора.
export const COST_REGRESSION_THRESHOLD = 0.10

/**
 * Сравнить цену успеха с базовым замером по ключу (runnerId, fixtureId).
 * Метрика цены выбирается по доступности: стоимость → токены → вызовы; сравнение
 * идёт ТОЛЬКО в одной и той же метрике с обеих сторон. Успех обязан совпадать —
 * подорожавший, но более успешный прогон регрессией цены не считается (это
 * другой размен, его читают отдельной строкой отчёта).
 */
export function costRegressions(rows, baselineRows) {
  const metricOf = group => {
    if (group.costs.length) return { name: 'estimatedCost', value: median(group.costs) }
    if (group.tokens.length) return { name: 'tokensTotal', value: median(group.tokens) }
    if (group.calls.length) return { name: 'toolCalls', value: median(group.calls) }
    return null
  }
  const groupBy = list => {
    const map = new Map()
    for (const row of list ?? []) {
      if (!row.comparable) continue
      const key = `${row.runnerId}:${row.fixtureId}`
      const g = map.get(key) ?? { runnerId: row.runnerId, fixtureId: row.fixtureId, runs: 0, passes: 0, costs: [], tokens: [], calls: [] }
      g.runs++
      if (row.result === 'pass') g.passes++
      if (Number.isFinite(row.estimatedCost)) g.costs.push(row.estimatedCost)
      if (Number.isFinite(row.tokensTotal)) g.tokens.push(row.tokensTotal)
      if (Number.isFinite(row.agentToolCalls)) g.calls.push(row.agentToolCalls)
      map.set(key, g)
    }
    return map
  }
  const current = groupBy(rows)
  const baseline = groupBy(baselineRows)
  const regressions = []
  for (const [key, cur] of current) {
    const base = baseline.get(key)
    if (!base || !cur.runs || !base.runs) continue
    const curPass = cur.passes / cur.runs
    const basePass = base.passes / base.runs
    if (curPass !== basePass) continue // успех изменился — это не ось цены
    const curMetric = metricOf(cur)
    const baseMetric = metricOf(base)
    if (!curMetric || !baseMetric || curMetric.name !== baseMetric.name) continue
    if (baseMetric.value === 0) continue
    const growth = (curMetric.value - baseMetric.value) / baseMetric.value
    if (growth > COST_REGRESSION_THRESHOLD) {
      regressions.push({
        runnerId: cur.runnerId,
        fixtureId: cur.fixtureId,
        metric: curMetric.name,
        baseline: baseMetric.value,
        current: curMetric.value,
        growth,
        passRate: curPass,
      })
    }
  }
  return regressions
}

export function writeArenaReports({ markdownPath, jsonPath, payload }) {
  mkdirSync(dirname(markdownPath), { recursive: true })
  mkdirSync(dirname(jsonPath), { recursive: true })
  const markdown = redactSecrets(renderArenaMarkdown(payload))
  const json = redactSecrets(JSON.stringify(payload, null, 2))
  assertNoSecretLikeText(markdown, 'Arena Markdown report')
  assertNoSecretLikeText(json, 'Arena JSON report')
  writeFileSync(markdownPath, markdown, 'utf8')
  writeFileSync(jsonPath, json, 'utf8')
}

export function renderArenaMarkdown(payload) {
  const lines = [
    '# Verstak Model Gym Arena',
    '',
    '> Это измерительный отчёт, а не маркетинговое утверждение. Несопоставимые запуски не ранжируются.',
    '',
    `- Commit: ${payload.meta.verstakCommit}`,
    `- Run date: ${payload.meta.runDate}`,
    `- Suite: ${payload.meta.suite}`,
    `- Repeats: ${payload.meta.repeat}`,
    `- Command: \`${payload.meta.reproduceCommand}\``,
    '',
    '## Сводка',
    '',
    '| runner | version | model | runs | pass rate | self-check rate | median time | median cost | interventions | comparable | production eligible |',
    '|---|---|---|---:|---:|---:|---:|---:|---:|---|---|',
  ]
  for (const item of payload.summary) {
    lines.push(
      `| ${esc(item.runnerLabel)} | ${esc(item.runnerVersion)} | ${esc(item.model)} | ${item.runs} | ${item.passRate === null ? 'unknown' : `${(item.passRate * 100).toFixed(1)}%`} | ${item.selfCheckRate === null || item.selfCheckRate === undefined ? 'unknown' : `${(item.selfCheckRate * 100).toFixed(1)}% (${item.selfCheckedRuns}/${item.selfCheckEligibleRuns})`} | ${nullable(item.medianDurationMs)} | ${nullable(item.medianEstimatedCost)} | ${item.interventions} | ${item.comparable ? 'yes' : 'no'} | ${item.productionRecommendationEligible ? 'yes' : 'no'} |`,
    )
  }
  lines.push(
    '',
    '## Методика',
    '',
    '- Один commit, один fixture, одна модель и одинаковый лимит времени.',
    '- Каждый повтор получает новый временный Git-workspace.',
    '- Успех определяется verify-командами fixture, а не текстом ответа модели.',
    '- Секреты не записываются в отчёт; конкурентные runner-ы не получают gateway/API env Verstak.',
    '- Если модель, автоматизация или права не совпадают, строка получает comparable=no.',
    '- Рекомендация для production возможна только при трёх и более повторах.',
    '',
    '## Запуски',
    '',
    '| runner | model | fixture | repeat | result | verify | time ms | cost | tokens | interventions | turns | calls | errors | self-check | comparable | reason |',
    '|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---|---|---|---|',
  )
  for (const row of payload.rows) {
    lines.push(
      `| ${esc(row.runnerId)} | ${esc(row.model)} | ${esc(row.fixtureId)} | ${row.repeat} | ${esc(row.result)} | ${row.verifyPass ? 'pass' : 'fail'} | ${row.durationMs} | ${nullable(row.estimatedCost)} | ${nullable(row.tokensTotal)} | ${row.interventions} | ${nullable(row.agentTurns)} | ${nullable(row.agentToolCalls)} | ${row.agentErrors === null || row.agentErrors === undefined ? 'unknown' : row.agentErrors ? 'yes' : 'no'} | ${describeSelfCheck({ status: row.selfCheck })} | ${row.comparable ? 'yes' : 'no'} | ${esc(row.comparabilityReason || row.failureMode)} |`,
    )
  }
  // D1: ось цены против базового замера — рост при том же успехе называется регрессией.
  if (Array.isArray(payload.costRegressions)) {
    lines.push('', '## Регрессии цены (тот же успех, дороже)', '')
    if (payload.costRegressions.length === 0) {
      lines.push('Нет: ни одна пара (runner, fixture) не подорожала больше порога при том же успехе.')
    } else {
      lines.push(
        '| runner | fixture | metric | baseline | current | growth | pass rate |',
        '|---|---|---|---:|---:|---:|---:|',
      )
      for (const r of payload.costRegressions) {
        lines.push(`| ${esc(r.runnerId)} | ${esc(r.fixtureId)} | ${esc(r.metric)} | ${r.baseline} | ${r.current} | ${(r.growth * 100).toFixed(1)}% | ${(r.passRate * 100).toFixed(1)}% |`)
      }
    }
  }
  lines.push('')
  return lines.join('\n')
}

function median(values) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function nullable(value) {
  return value === null || value === undefined ? 'unknown' : String(value)
}

function esc(value) {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ')
}
