// C2 (P6, пакет 2.5.0): инструмент mutation_check — «тест не декоративный».
// Механика и три ограничения (изоляция worktree / граница узкого прогона /
// бюджет + выключатель) — в electron/ai/mutation-check.ts.
import type { ToolHandler } from './shared'
import { runMutationCheck, MUTATION_CHECK_DEFAULT_TIMEOUT_MS, MUTATION_CHECK_MAX_TIMEOUT_MS } from '../../ai/mutation-check'
import { runtimeFlagOn } from '../../../shared/contracts/runtime-flag-policy'

export const mutationCheckHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    // Выключатель обязателен (цена — второй прогон тестов): opt-out флаг,
    // включён, пока человек явно не выключил в «Поведении агента».
    const enabled = runtimeFlagOn('mutation_check_enabled', ctx.getSecretForDelegate?.('mutation_check_enabled'))
    const rawTimeout = Number(call.args.timeout_ms)
    const result = await runMutationCheck({
      projectRoot: ctx.projectPath,
      testFile: String(call.args.test_file ?? ''),
      timeoutMs: Number.isFinite(rawTimeout) && rawTimeout > 0
        ? Math.min(rawTimeout, MUTATION_CHECK_MAX_TIMEOUT_MS)
        : MUTATION_CHECK_DEFAULT_TIMEOUT_MS,
      enabled
    })
    // «Декоративный» — отклонённый вердикт: модель обязана увидеть это как отказ
    // доказательства, а не как строку в потоке. skipped/error — тоже НЕ успех:
    // вердикта нет, и выдавать его за «проверено» нельзя.
    if (result.verdict === 'real') {
      return { id: call.id, name: call.name, result: result.reason }
    }
    return { id: call.id, name: call.name, result: '', error: `[${result.verdict}] ${result.reason}` }
  }
}
