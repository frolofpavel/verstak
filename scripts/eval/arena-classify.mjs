// Классификация одного Arena-прогона. Вынесена из arena.mjs в чистый модуль,
// чтобы краснеть в юнит-пинах: arena.mjs несёт top-level await (CLI-вход) и не
// импортируется vitest-трансформом.
//
// Два урока живого baseline 09.08 (оба стоили по 3 ложных провала):
// - review-фикстура с пустым expectedFiles всегда падала «expected file not
//   changed»: требование «файл изменён» неприменимо, когда правок не объявлено —
//   такие фикстуры проверяются verify-командами и review-гейтом;
// - «модель недоступна» матчилось на имени workspace-каталога и на содержимом
//   задач ПРО модели при живом успешном прогоне. Сигнал имеет смысл только у
//   УПАВШЕГО прогона: раннер с exit 0 очевидно нашёл свою модель.

const MODEL_UNAVAILABLE_RE =
  /model.{0,40}(not found|unknown|unavailable|unsupported|invalid)|unknown model|invalid model/i

export function detectModelUnavailable({ status, raw, dryRun }) {
  if (dryRun) return false
  if (status === 0) return false
  return MODEL_UNAVAILABLE_RE.test(String(raw ?? ''))
}

export function classifyArenaRun({
  dryRun,
  comparable,
  execution,
  verifyPass,
  expectedTouched,
  unrelatedTouched,
  traceSecretLeak,
  expectedFilesCount,
}) {
  if (dryRun) return { result: 'dry-run', failureMode: 'not executed' }
  if (!comparable) return { result: 'not comparable', failureMode: 'runner/model/permissions mismatch' }
  if (traceSecretLeak) return { result: 'fail', failureMode: 'secret leak in runner output' }
  if (execution.error || execution.status !== 0) return { result: 'fail', failureMode: 'runner failed' }
  if (!verifyPass) return { result: 'fail', failureMode: 'verify failed' }
  if (unrelatedTouched) return { result: 'fail', failureMode: 'unrelated file touched' }
  if (expectedFilesCount > 0 && expectedTouched.length === 0) {
    return { result: 'fail', failureMode: 'expected file not changed' }
  }
  return { result: 'pass', failureMode: '' }
}
