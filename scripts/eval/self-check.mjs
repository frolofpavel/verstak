// Метрика «проверил ли себя агент» (Agent Runtime V2 §5, метрика «была ли проверка»).
//
// Достаётся из трейса verstak-cli (--trace-json): после ПОСЛЕДНЕЙ принятой записи в
// файлы в trace.toolCalls обязаны быть проверочные действия. Проверка ДО последней
// записи не считается: она проверяла не тот код, который остался в workspace.
// Без этой метрики эффект главной правки V2-3 (completion gate) нечем показать,
// поэтому baseline Arena снимается уже с ней.
//
// Раннеры-конкуренты (codex/opencode) трейса не отдают — у них честный 'no-trace',
// а не выдуманное значение.

// Зеркало isMutatingToolName из scripts/verstak-cli.mjs (рантайм не трогаем).
const MUTATING_TOOLS = new Set(['write_file', 'apply_patch', 'edit_file', 'create_file', 'apply_diff'])

// Проверочные ИНСТРУМЕНТЫ: review_before_commit есть в CLI уже сейчас;
// check_diagnostics / attest_verification появятся с V2-ветками — детектор знает их
// заранее, чтобы замер «ПОСЛЕ» не требовал править измеритель.
const VERIFY_TOOLS = new Set(['check_diagnostics', 'attest_verification', 'review_before_commit'])

// run_command считается проверкой, если команда — тест/тайпчек/сборка/линт
// (фикстуры Arena зовут npm run test:fast / npm run type / node verify.mjs).
const VERIFY_COMMAND_RE = /\b(test\S*|type\S*|tsc|build|lint\S*|check\S*|verify\S*|vitest|jest|pytest)\b/i

/**
 * @param {{toolCalls?: Array<{name?: string, args?: Record<string, unknown>}>} | null | undefined} trace
 * @returns {{status: 'checked'|'unchecked'|'no-writes'|'no-trace', evidence: string[]}}
 */
export function analyzeSelfCheck(trace) {
  const calls = trace?.toolCalls
  if (!Array.isArray(calls)) return { status: 'no-trace', evidence: [] }

  let lastWriteIndex = -1
  for (let i = 0; i < calls.length; i++) {
    if (MUTATING_TOOLS.has(String(calls[i]?.name))) lastWriteIndex = i
  }
  if (lastWriteIndex === -1) return { status: 'no-writes', evidence: [] }

  const evidence = []
  for (const call of calls.slice(lastWriteIndex + 1)) {
    const name = String(call?.name ?? '')
    if (VERIFY_TOOLS.has(name)) evidence.push(name)
    else if (name === 'run_command') {
      const command = String(call?.args?.command ?? '')
      if (VERIFY_COMMAND_RE.test(command)) evidence.push(`run_command: ${command}`)
    }
  }
  return { status: evidence.length ? 'checked' : 'unchecked', evidence }
}

/** Короткое значение для колонки отчёта. 'NO' нарочно кричит: это и есть измеряемый дефект. */
export function describeSelfCheck(result) {
  switch (result?.status) {
    case 'checked': return 'yes'
    case 'unchecked': return 'NO'
    case 'no-writes': return 'no-writes'
    default: return 'unknown'
  }
}
