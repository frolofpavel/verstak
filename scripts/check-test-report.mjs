import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const reportPath = resolve(process.argv[2] || 'release/mac-test-report.json')
const report = JSON.parse(readFileSync(reportPath, 'utf8'))
const gateSource = readFileSync(resolve('scripts/release-gate.mjs'), 'utf8')
const expectedMatch = gateSource.match(/EXPECTED_TOTAL_TESTS\s*=\s*(\d+)/)
if (!expectedMatch) throw new Error('EXPECTED_TOTAL_TESTS не найден в scripts/release-gate.mjs')

const expected = Number(expectedMatch[1])
const total = Number(report.numTotalTests)
const failed = Number(report.numFailedTests)
if (failed !== 0 || total < expected) {
  const failedAssertions = (report.testResults || []).flatMap(suite =>
    (suite.assertionResults || [])
      .filter(assertion => assertion.status === 'failed')
      .map(assertion => `${suite.name}: ${assertion.fullName || assertion.title}`),
  )
  const failedSuites = (report.testResults || [])
    .filter(
      suite =>
        suite.status === 'failed' && !(suite.assertionResults || []).some(assertion => assertion.status === 'failed'),
    )
    .map(suite => `${suite.name}: ${suite.message || 'suite failed before assertions'}`)
  for (const failure of [...failedAssertions, ...failedSuites]) console.error(`[test-failure] ${failure}`)
  throw new Error(`Неполный test:fast: total=${total}, failed=${failed}, expected=${expected}`)
}
console.log(`[test-completeness] ${total}/${expected}, failures=0`)
