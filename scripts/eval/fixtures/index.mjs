import { validateFixture } from '../contracts.mjs'
import { CORE_FIXTURES } from './core.mjs'

const SUITES = new Map([['core', CORE_FIXTURES]])

export function selectFixtures(suiteName, requestedTasks) {
  const suite = SUITES.get(suiteName)
  if (!suite) throw new Error(`Unknown suite: ${suiteName}`)

  const fixtures = suite.map(validateFixture)
  assertUniqueIds(fixtures)
  if (!requestedTasks) return fixtures

  const selected = fixtures.filter(
    fixture => requestedTasks.includes(fixture.id) || requestedTasks.includes(fixture.recipe),
  )
  if (!selected.length) throw new Error(`No tasks selected from suite: ${suiteName}`)

  const matched = new Set(selected.flatMap(fixture => [fixture.id, fixture.recipe]))
  const unknown = requestedTasks.filter(task => !matched.has(task))
  if (unknown.length) throw new Error(`Unknown task(s) in suite ${suiteName}: ${unknown.join(', ')}`)
  return selected
}

export function listSuites() {
  return [...SUITES.keys()]
}

function assertUniqueIds(fixtures) {
  const seen = new Set()
  for (const fixture of fixtures) {
    if (seen.has(fixture.id)) throw new Error(`Duplicate fixture id: ${fixture.id}`)
    seen.add(fixture.id)
  }
}
