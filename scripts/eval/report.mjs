import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { assertNoSecretLikeText, redactSecrets } from './contracts.mjs'

export function buildRecommendations(rows) {
  const live = rows.filter(row => !['dry-run', 'not tested', 'available'].includes(row.result))
  const byModel = new Map()
  for (const row of live) {
    const current = byModel.get(row.model) ?? {
      model: row.model,
      pass: 0,
      warn: 0,
      fail: 0,
      strict: 0,
      recipes: new Map(),
    }
    if (row.result === 'pass') current.pass++
    else if (row.result === 'warn') current.warn++
    else current.fail++
    if (row.result === 'pass' && !row.unrelatedFilesTouched && !row.malformedToolCalls && row.traceSecretLeak === false)
      current.strict++
    current.recipes.set(row.recipe, row)
    byModel.set(row.model, current)
  }

  const ranked = [...byModel.values()].sort(
    (a, b) => b.strict - a.strict || b.pass - a.pass || a.fail - b.fail || preference(a.model) - preference(b.model),
  )
  const best =
    ranked.find(
      result =>
        result.recipes.get('bugfix')?.result === 'pass' &&
        result.recipes.get('test-fix')?.result === 'pass' &&
        result.recipes.get('typescript-error')?.result === 'pass' &&
        result.recipes.get('review-before-commit')?.result === 'pass',
    )?.model ??
    ranked[0]?.model ??
    'not enough data'
  const fallback =
    ranked.find(
      result =>
        result.model !== best &&
        result.recipes.get('bugfix')?.result === 'pass' &&
        result.recipes.get('test-fix')?.result === 'pass' &&
        result.recipes.get('typescript-error')?.result === 'pass',
    )?.model ??
    ranked.find(result => result.model !== best)?.model ??
    best
  const review =
    ranked.find(
      result =>
        result.recipes.get('review-before-commit')?.result === 'pass' &&
        result.recipes.get('bugfix')?.reviewGate === 'pass',
    )?.model ??
    ranked.find(result => result.recipes.get('review-before-commit')?.result === 'pass')?.model ??
    ranked.find(result => result.recipes.get('bugfix')?.reviewGate === 'pass')?.model ??
    best
  const planner =
    ranked.find(result =>
      ['small-edit', 'typescript-error'].every(recipe => result.recipes.get(recipe)?.result === 'pass'),
    )?.model ?? best
  const recipeMap = {}
  for (const recipe of ['bugfix', 'test-fix', 'typescript-error', 'review-before-commit']) {
    recipeMap[recipe] =
      ranked.find(result => result.recipes.get(recipe)?.result === 'pass')?.model ?? 'manual/stronger model'
  }

  return {
    defaultCodingModel: best,
    defaultFallbackModel: fallback,
    defaultReviewerModel: review,
    defaultPlannerModel: planner,
    recipeMap,
    presets: {
      'verstak/coder/fast': fallback,
      'verstak/coder/balanced': best,
    },
    notForAgentMode: ranked
      .filter(result => result.fail >= Math.max(2, result.pass + result.warn))
      .map(result => result.model),
    ranked,
  }
}

export function renderMarkdown(rows, recommendations, meta) {
  const lines = [
    '# Cheap Model Eval Matrix',
    '',
    'Scope: deterministic Model Gym fixtures through the Verstak runner; no secrets are written to reports.',
    '',
    '## Run Metadata',
    '',
    `- Runner version: ${meta.runnerVersion}`,
    `- Verstak commit: ${meta.verstakCommit}`,
    `- Run date: ${meta.runDate}`,
    `- Provider: ${meta.provider}`,
    `- Gateway base URL for probes: ${meta.baseUrl}`,
    `- Suite: ${meta.suite}`,
    `- Repeat: ${meta.repeat}`,
    `- Key present: ${meta.keyPresent ? 'yes' : 'no'}`,
    `- Dry run: ${meta.dryRun ? 'yes' : 'no'}`,
    `- Probe only: ${meta.probeOnly ? 'yes' : 'no'}`,
    `- Started: ${meta.startedAt}`,
    `- Finished: ${meta.finishedAt}`,
    '',
    '## Fixture Manifest',
    '',
    '| fixture | category | recipe | hash | expected | unrelated | verify | review |',
    '|---|---|---|---|---|---|---|---|',
  ]
  for (const fixture of meta.fixtureManifest) {
    lines.push(
      `| ${esc(fixture.id)} | ${esc(fixture.category)} | ${esc(fixture.recipe)} | ${fixture.fixtureHash.slice(0, 12)} | ${esc(fixture.expectedFiles.join(', ') || 'none')} | ${esc(fixture.unrelatedFiles.join(', ') || 'none')} | ${esc(fixture.verify.join('; '))} | ${fixture.requiresReview ? 'required' : 'no'} |`,
    )
  }

  lines.push(
    '',
    '## Recommendations',
    '',
    `1. Default coding model: ${recommendations.defaultCodingModel}`,
    `2. Default fallback model: ${recommendations.defaultFallbackModel}`,
    `3. Default reviewer model: ${recommendations.defaultReviewerModel}`,
    `4. Default planner model: ${recommendations.defaultPlannerModel}`,
    `5. bugfix -> ${recommendations.recipeMap['bugfix']}`,
    `6. test-fix -> ${recommendations.recipeMap['test-fix']}`,
    `7. typescript-error -> ${recommendations.recipeMap['typescript-error']}`,
    `8. review-before-commit -> ${recommendations.recipeMap['review-before-commit']}`,
    `9. verstak/coder/fast preset -> ${recommendations.presets['verstak/coder/fast']}`,
    `10. verstak/coder/balanced preset -> ${recommendations.presets['verstak/coder/balanced']}`,
    `11. Do not use in agent mode: ${recommendations.notForAgentMode.length ? recommendations.notForAgentMode.join(', ') : 'none from this run'}`,
    '',
    '## Matrix',
    '',
    '| model | fixture | repeat | result | tool discipline | diff discipline | verify | review gate | turns | tokens | cost | failure mode | recommendation |',
    '|---|---|---:|---:|---|---|---|---|---:|---|---|---|---|',
  )
  for (const row of rows) {
    const toolDiscipline = [
      `calls ${row.toolCallsCount}`,
      row.firstMutatingTool ? `first mutating ${row.firstMutatingTool}` : 'no mutation',
      row.malformedToolCalls ? 'malformed yes' : 'malformed no',
      row.baselineTaken ? 'baseline yes' : 'baseline no',
    ].join('; ')
    const diffDiscipline = [
      `${row.diffSize} lines`,
      row.changedFiles.length ? row.changedFiles.join(', ') : 'no changed files',
      row.unrelatedFilesTouched ? 'unrelated yes' : 'unrelated no',
    ].join('; ')
    const tokens = `${formatNullable(row.tokens.input)}/${formatNullable(row.tokens.output)}/${formatNullable(row.tokens.total)}`
    lines.push(
      `| ${esc(row.model)} | ${esc(row.recipe)} | ${row.repeat} | ${esc(row.result)} | ${esc(toolDiscipline)} | ${esc(diffDiscipline)} | ${row.verifyPass ? 'pass' : 'fail'} | ${esc(String(row.reviewGate))} | ${row.turnsUsed} | ${tokens} | ${formatNullable(row.estimatedCost)} | ${esc(row.failureMode || '')} | ${esc(row.recommendation)} |`,
    )
  }

  lines.push('', '## Blocking Runtime Bugs', '')
  const runtimeBugs = rows.filter(row => row.errorClass === 'runtime error' || row.traceSecretLeak)
  if (runtimeBugs.length) {
    for (const row of runtimeBugs) lines.push(`- ${row.model} / ${row.recipe}: ${row.failureMode || row.errorClass}`)
  } else {
    lines.push('- None found in this run.')
  }

  lines.push('', '## Raw Summary', '')
  for (const row of rows) {
    lines.push(
      `- ${row.model} / ${row.recipe} / repeat ${row.repeat}: result=${row.result}, exit=${row.exitCode}, selected=${row.selectedModel}, duration=${Math.round(row.durationMs / 1000)}s, secretLeak=${row.traceSecretLeak ? 'yes' : 'no'}`,
    )
  }
  lines.push('')
  return lines.join('\n')
}

export function writeReports({ markdownPath, jsonPath, payload, explicitSecrets = [] }) {
  mkdirSync(dirname(markdownPath), { recursive: true })
  mkdirSync(dirname(jsonPath), { recursive: true })
  const markdown = redactSecrets(renderMarkdown(payload.rows, payload.recommendations, payload.meta), explicitSecrets)
  const json = redactSecrets(JSON.stringify(payload, null, 2), explicitSecrets)
  assertNoSecretLikeText(markdown, 'Markdown report')
  assertNoSecretLikeText(json, 'JSON report')
  writeFileSync(markdownPath, markdown, 'utf8')
  writeFileSync(jsonPath, json, 'utf8')
}

function preference(model) {
  const order = [
    'qwen3-coder',
    'deepseek-chat',
    'kimi-k2.7-code',
    'verstak/coder',
    'verstak/coder/fast',
    'verstak/coder/balanced',
    'z-ai/glm-4.6',
    'deepseek-reasoner',
    'minimax-m1',
  ]
  const index = order.indexOf(model)
  return index === -1 ? 999 : index
}

function formatNullable(value) {
  return value === null || value === undefined ? 'unknown' : String(value)
}

function esc(value) {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ')
}
