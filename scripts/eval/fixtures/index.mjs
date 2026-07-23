import { validateFixture } from '../contracts.mjs'
import { CORE_FIXTURES } from './core.mjs'
import { EXPANDED_FIXTURES } from './expanded.mjs'

const SUITES = new Map([
  ['v0', CORE_FIXTURES],
  ['core', Object.freeze([...CORE_FIXTURES, ...EXPANDED_FIXTURES])],
])

export function selectFixtures(suiteName, requestedTasks) {
  const suite = SUITES.get(suiteName)
  if (!suite) throw new Error(`Unknown suite: ${suiteName}`)

  const fixtures = suite.map(validateFixture)
  assertUniqueIds(fixtures)
  if (!requestedTasks) return fixtures

  const selectedIds = new Set()
  for (const requested of requestedTasks) {
    const exact = fixtures.find(fixture => fixture.id === requested)
    if (exact) selectedIds.add(exact.id)
    else for (const fixture of fixtures) if (fixture.recipe === requested) selectedIds.add(fixture.id)
  }
  const selected = fixtures.filter(fixture => selectedIds.has(fixture.id))
  if (!selected.length) throw new Error(`No tasks selected from suite: ${suiteName}`)

  const knownIds = new Set(fixtures.map(fixture => fixture.id))
  const knownRecipes = new Set(fixtures.map(fixture => fixture.recipe))
  const unknown = requestedTasks.filter(task => !knownIds.has(task) && !knownRecipes.has(task))
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
