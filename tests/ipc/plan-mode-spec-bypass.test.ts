import { describe, it, expect, vi } from 'vitest'

/**
 * 2.1.0-A (characterization, ТОЛЬКО тесты — product-код Outcome Engine ночью не трогаем).
 *
 * ПРОВЕРКА ФАКТИЧЕСКОГО УТВЕРЖДЕНИЯ плана прорыва: «в plan-mode ветка ожидания одобрения
 * возвращается ДО planSpecFeedback → слабый план может попасть на одобрение без проверки».
 *
 * ВЕРДИКТ: утверждение ПОДТВЕРЖДЕНО по коду и закреплено тестами ниже.
 * verification.ts: ветка plan-mode (≈212) делает `return` на ≈226, а planSpecFeedback(steps)
 * стоит на ≈230 — то есть достижим ТОЛЬКО когда гейт одобрения НЕ сработал.
 *
 * ЧТО ИМЕННО ТЕРЯЕТСЯ (task-spec-check.ts): проверка «тонкого ТЗ» — нет путей к файлам, нет
 * критерия готовности, описание короче 40 символов. Модель не получает фидбэк и не уточняет
 * план ПЕРЕД тем, как показать его человеку на одобрение.
 *
 * ПОЧЕМУ ЭТО ВАЖНО: обход сидит ровно в том режиме, где человек УВЕРЕН, что согласует
 * продуманный план. В обычном режиме (гейт выключен) проверка работает — то есть защита
 * есть везде, КРОМЕ места, где она нужнее всего.
 *
 * Тесты ниже — характеризация: они фиксируют СЕГОДНЯШНЕЕ поведение (дефект), чтобы
 * (а) факт был доказан, а не пересказан; (б) фикс в 2.1.0 сразу их перевернул осознанно.
 */

vi.mock('electron', () => ({ ipcMain: { handle: () => {} } }))

const { createPlanHandler } = await import('../../electron/ipc/tool-handlers/verification')

/** Шаг с ЗАВЕДОМО тонким ТЗ: ни файлов, ни критерия готовности, коротко. */
const WEAK_STEP = { title: 'улучшить производительность', detail: 'сделать быстрее' }
/** Шаг по контракту: файлы + критерий + детальность. */
const GOOD_STEP = {
  title: 'ускорить загрузку чата',
  detail: 'В src/store/projectStore.ts заменить полную загрузку истории на оконную (50 сообщений). Критерий готовности: открытие чата с 5000 сообщений не блокирует UI, тест project-store-lifecycle зелёный.',
}

function makeCtx(over: Record<string, unknown> = {}) {
  return {
    projectPath: '/p',
    sendId: 1,
    agentMode: 'auto',
    sender: { send: vi.fn() },
    recordPlan: vi.fn(() => ({ id: 42 })),
    recordJournal: vi.fn(),
    scopedKey: (sendId: number, callId: string) => `${sendId}:${callId}`,
    getSecretForDelegate: () => undefined,
    ...over,
  } as never
}

const call = (steps: unknown[]) => ({ id: 'c1', name: 'create_plan', args: { title: 'План', steps } }) as never

describe('plan-mode обходит проверку качества плана (2.1.0-A, утверждение подтверждено)', () => {
  it('ОБЫЧНЫЙ режим: тонкое ТЗ → модель получает фидбэк (защита работает)', async () => {
    const res = await createPlanHandler.handle(call([WEAK_STEP]), makeCtx())
    expect(res.result).toContain('Тонкое ТЗ')
    expect(res.result).toContain('критерий готовности')
  })

  it('ОБЫЧНЫЙ режим: хорошее ТЗ → фидбэка нет (проверка не шумит зря)', async () => {
    const res = await createPlanHandler.handle(call([GOOD_STEP]), makeCtx())
    expect(res.result).not.toContain('Тонкое ТЗ')
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // ВОТ ОН, ОБХОД. Тот же тонкий план, но в plan-mode с включённым гейтом одобрения:
  // ветка гейта возвращается раньше, и фидбэк о тонком ТЗ до модели НЕ доходит.
  // ─────────────────────────────────────────────────────────────────────────────
  it('PLAN-MODE + гейт: тот же тонкий план проходит БЕЗ фидбэка (подтверждённый дефект)', async () => {
    const pendingPlans = new Map<string, { sendId: number; resolve: (d: unknown) => void }>()
    const ctx = makeCtx({
      agentMode: 'plan',
      pendingPlans,
      getSecretForDelegate: (k: string) => (k === 'plan_approval_gate' ? 'true' : undefined),
      setAgentMode: vi.fn(),
    })
    const p = createPlanHandler.handle(call([WEAK_STEP]), ctx)
    // Пользователь жмёт «Одобрить», не подозревая, что план не проверяли.
    await vi.waitFor(() => expect(pendingPlans.size).toBe(1))
    const [, entry] = [...pendingPlans.entries()][0]
    entry.resolve({ decision: 'approve' })
    const res = await p

    // ФИКСИРУЕМ ДЕФЕКТ: фидбэка о тонком ТЗ нет — проверка была обойдена.
    expect(res.result).not.toContain('Тонкое ТЗ')
    // Когда 2.1.0 закроет дыру, этот expect перевернётся на toContain — осознанно.
  })

  it('PLAN-MODE + гейт: человек видит только название и число шагов (нечем оценить качество)', async () => {
    const pendingPlans = new Map<string, { sendId: number; resolve: (d: unknown) => void }>()
    const sender = { send: vi.fn() }
    const ctx = makeCtx({
      agentMode: 'plan', pendingPlans, sender,
      getSecretForDelegate: (k: string) => (k === 'plan_approval_gate' ? 'true' : undefined),
      setAgentMode: vi.fn(),
    })
    const p = createPlanHandler.handle(call([WEAK_STEP]), ctx)
    await vi.waitFor(() => expect(pendingPlans.size).toBe(1))
    const approvalEvent = sender.send.mock.calls
      .map(c => (c[1] as { event: Record<string, unknown> }).event)
      .find(e => e.type === 'plan-approval')!

    // В событии одобрения — ни шагов, ни деталей, ни предупреждения о тонком ТЗ.
    expect(Object.keys(approvalEvent).sort()).toEqual(['callId', 'planId', 'stepCount', 'title', 'type'])
    expect(JSON.stringify(approvalEvent)).not.toContain('Тонкое')
    ;[...pendingPlans.values()][0].resolve({ decision: 'reject' })
    await p
  })

  it('PLAN-MODE БЕЗ гейта (выключен) → проверка снова работает — дыра именно в гейте', async () => {
    const res = await createPlanHandler.handle(call([WEAK_STEP]), makeCtx({ agentMode: 'plan' }))
    expect(res.result).toContain('Тонкое ТЗ')
  })
})
