import { describe, it, expect, beforeEach, vi } from 'vitest'
import { estimateCost } from '../../src/lib/pricing'

/**
 * 2.0.8-E хвост (проводка ценника чата). Дефект B жил в UI дольше всех: cost-guard и
 * persistence уже считали Claude честно, а пилюля расхода в чате — нет, потому что
 * семантика inputAccounting не доезжала от события до estimateCost.
 *
 * Цепочка: usage-событие (main) → Chat.tsx addUsage → store.sessionUsage.inputAccounting
 * → estimateCost(..., inputAccounting). Здесь фиксируем ЗВЕНО СТОРА и денежный итог.
 */
const baseWindow = {
  api: {
    chats: { append: vi.fn(async () => {}), list: vi.fn(async () => []), listWindow: vi.fn(async () => ({ messages: [], totalCount: 0, hasMoreBefore: false })) },
    chatSessions: { list: vi.fn(async () => []), listReviews: vi.fn(async () => []), setModel: vi.fn(async () => {}) },
    settings: { getKey: vi.fn(async () => null), setKey: vi.fn(async () => {}) },
    agentRuns: { list: vi.fn(async () => []) },
  },
}
vi.stubGlobal('window', baseWindow)

const { useProject } = await import('../../src/store/projectStore')

describe('проводка inputAccounting до ценника чата (2.0.8-E хвост)', () => {
  beforeEach(() => {
    useProject.setState({ sessionUsage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, inputAccounting: undefined } }, false)
  })

  it('addUsage сохраняет семантику провайдера в sessionUsage', () => {
    useProject.getState().addUsage({ inputTokens: 100, outputTokens: 10, cachedInputTokens: 900, inputAccounting: 'exclusive' })
    expect(useProject.getState().sessionUsage.inputAccounting).toBe('exclusive')
  })

  it('семантика ФАКТИЧЕСКОГО провайдера побеждает (последнее событие), как в runner-ах', () => {
    useProject.getState().addUsage({ inputTokens: 10, inputAccounting: 'inclusive' })
    useProject.getState().addUsage({ inputTokens: 10, inputAccounting: 'exclusive' })
    expect(useProject.getState().sessionUsage.inputAccounting).toBe('exclusive')
  })

  it('событие без семантики не стирает уже известную', () => {
    useProject.getState().addUsage({ inputTokens: 10, inputAccounting: 'exclusive' })
    useProject.getState().addUsage({ inputTokens: 10 })
    expect(useProject.getState().sessionUsage.inputAccounting).toBe('exclusive')
  })

  // ДЕНЬГИ: ровно тот сценарий, из-за которого ценник занижал Claude.
  it('дефект B в ценнике: Claude (exclusive) с большим кэшем считается по полному input', () => {
    useProject.getState().addUsage({ inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 1_000_000, inputAccounting: 'exclusive' })
    const u = useProject.getState().sessionUsage

    const honest = estimateCost('claude', 'claude-sonnet-4-6', u.inputTokens, u.outputTokens, u.cachedInputTokens, u.inputAccounting)
    // Если семантику НЕ передать — сработает дефолт 'inclusive': billable = max(0, 1M−1M) = 0,
    // и весь свежий input исчезнет из счёта (ровно то занижение, что чинил дефект B).
    const buggy = estimateCost('claude', 'claude-sonnet-4-6', u.inputTokens, u.outputTokens, u.cachedInputTokens)

    expect(honest.cents).toBeGreaterThan(buggy.cents)
    expect(honest.cents).toBeCloseTo(330, 0) // 1M×$3 + 1M×$0.3 = $3.30
    expect(buggy.cents).toBeCloseTo(30, 0)   // было бы $0.30 — занижение в 11 раз
  })

  it('inclusive-провайдер (OpenAI) считается как прежде — характеризация не поехала', () => {
    useProject.getState().addUsage({ inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 1_000_000, inputAccounting: 'inclusive' })
    const u = useProject.getState().sessionUsage
    const cost = estimateCost('openai', 'gpt-5', u.inputTokens, u.outputTokens, u.cachedInputTokens, u.inputAccounting)
    const legacy = estimateCost('openai', 'gpt-5', u.inputTokens, u.outputTokens, u.cachedInputTokens)
    expect(cost.cents).toBe(legacy.cents)
  })
})
