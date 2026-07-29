// Red-first тесты UI-сценария Exact Rewind (хвост карточки 2.0.11-F: фича спала за флагом
// без UI-пути). Сценарий: preflight (превью покрытия) → execute (с бэкапами) → unrevert
// при частичном сбое. disabled → зовущий падает в обычный undo-путь.
import { describe, expect, it } from 'vitest'
import { runExactRewindFlow, type ExactRewindFlowDeps } from '../../src/lib/exact-rewind-flow'
import type { ExactRewindExecuteSummaryDTO, ExactRewindPreflightDTO } from '../../src/types/api'

function deps(patch: Partial<ExactRewindFlowDeps> = {}): ExactRewindFlowDeps {
  return {
    preflight: async () => ({ disabled: true }),
    execute: async () => ({ disabled: true }),
    unrevert: async () => ({ ok: true }),
    confirm: () => true,
    ...patch,
  }
}

const fullPreflight: ExactRewindPreflightDTO = {
  coverage: { level: 'complete', tracedFiles: 2, hasUntracedWriters: false, staleFiles: 0 },
  files: [
    { filePath: 'a.ts', action: 'restore', stale: false },
    { filePath: 'b.ts', action: 'delete', stale: false },
  ],
}

// Контракт с 30.07 (SEC-SECRET-04): содержимого бэкапов в ответе нет, есть токен.
const okExecute: ExactRewindExecuteSummaryDTO = {
  ok: true,
  restored: ['a.ts', 'b.ts'],
  failed: [],
  backupToken: 'tok-1',
  coverage: { level: 'complete', tracedFiles: 2, hasUntracedWriters: false, staleFiles: 0 },
}

describe('runExactRewindFlow — UI-сценарий Exact Rewind', () => {
  it('preflight disabled → disabled, execute/confirm не вызываются (обычный undo-путь)', async () => {
    let executeCalled = 0
    let confirmCalled = 0
    const result = await runExactRewindFlow(5, deps({
      execute: async () => { executeCalled++; return okExecute },
      confirm: () => { confirmCalled++; return true },
    }))
    expect(result).toEqual({ kind: 'disabled' })
    expect(executeCalled).toBe(0)
    expect(confirmCalled).toBe(0)
  })

  it('откатывать нечего (0 файлов) → nothing, без confirm и execute', async () => {
    let confirmCalled = 0
    const result = await runExactRewindFlow(5, deps({
      preflight: async () => ({
        coverage: { level: 'none', tracedFiles: 0, hasUntracedWriters: false, staleFiles: 0 },
        files: [],
      }),
      confirm: () => { confirmCalled++; return true },
    }))
    expect(result).toEqual({ kind: 'nothing' })
    expect(confirmCalled).toBe(0)
  })

  it('полное покрытие + пользователь согласен → done с числом восстановленных', async () => {
    const result = await runExactRewindFlow(5, deps({
      preflight: async () => fullPreflight,
      execute: async () => okExecute,
    }))
    expect(result).toEqual({ kind: 'done', restored: 2, failed: 0 })
  })

  it('пользователь отказался на превью → cancelled, execute не вызывается', async () => {
    let executeCalled = 0
    const result = await runExactRewindFlow(5, deps({
      preflight: async () => fullPreflight,
      execute: async () => { executeCalled++; return okExecute },
      confirm: () => false,
    }))
    expect(result).toEqual({ kind: 'cancelled' })
    expect(executeCalled).toBe(0)
  })

  it('частичный сбой execute + пользователь выбрал отмену → unrevert с токеном из execute', async () => {
    let unrevertArg: string | null = null
    const result = await runExactRewindFlow(5, deps({
      preflight: async () => fullPreflight,
      execute: async () => ({
        ...okExecute,
        ok: false,
        restored: ['a.ts'],
        failed: [{ filePath: 'b.ts', reason: 'EBUSY' }],
      }),
      unrevert: async (backupToken) => { unrevertArg = backupToken; return { ok: true } },
      confirm: () => true, // «да, вернуть как было»
    }))
    expect(result).toEqual({ kind: 'reverted-back', restored: 1, failed: 1 })
    expect(unrevertArg).toBe('tok-1')
  })

  it('частичный сбой execute + пользователь оставил как есть → done-with-failures, unrevert НЕ зовём', async () => {
    let unrevertCalled = 0
    let confirmCount = 0
    const result = await runExactRewindFlow(5, deps({
      preflight: async () => fullPreflight,
      execute: async () => ({
        ...okExecute,
        ok: false,
        restored: ['a.ts'],
        failed: [{ filePath: 'b.ts', reason: 'EBUSY' }],
      }),
      unrevert: async () => { unrevertCalled++; return { ok: true } },
      confirm: () => { confirmCount++; return confirmCount === 1 }, // превью — да, unrevert — нет
    }))
    expect(result).toEqual({ kind: 'done-with-failures', restored: 1, failed: 1 })
    expect(unrevertCalled).toBe(0)
  })

  it('execute вернул error → error с сообщением', async () => {
    const result = await runExactRewindFlow(5, deps({
      preflight: async () => fullPreflight,
      execute: async () => ({ ok: false, error: 'нет проекта' }),
    }))
    expect(result).toEqual({ kind: 'error', message: 'нет проекта' })
  })

  it('превью честно предупреждает: partial (bypass-writers) и stale-файлы попадают в текст', async () => {
    const seen: string[] = []
    await runExactRewindFlow(5, deps({
      preflight: async () => ({
        coverage: { level: 'partial', tracedFiles: 1, hasUntracedWriters: true, staleFiles: 1 },
        files: [{ filePath: 'a.ts', action: 'restore', stale: true }],
      }),
      confirm: (message) => { seen.push(message); return false },
    }))
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatch(/мимо отслеживания|не видели часть правок/i)
    expect(seen[0]).toMatch(/перезаписан|изменён кем-то|перезатр/i)
  })

  it('флаг выключился между preflight и execute → disabled (гонка), unrevert не зовём', async () => {
    const result = await runExactRewindFlow(5, deps({
      preflight: async () => fullPreflight,
      execute: async () => ({ disabled: true }),
    }))
    expect(result).toEqual({ kind: 'disabled' })
  })
})
