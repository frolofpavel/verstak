// P8 шаг 2 «видно, что сервер дал»: паспорт обязан говорить, какие инструменты
// требуют подтверждения. Ярлык считает renderer (mcp-risk.ts), а решение в бою
// принимает main (mcp-policy.ts) — анти-дрейф-пин держит их согласованными:
// ярлык «сразу» без авто-решения гейта (или наоборот) — ложь пользователю.
import { describe, it, expect } from 'vitest'
import { confirmRequirement, type McpScope } from '../../src/lib/mcp-risk'
import { mcpDecision } from '../../electron/ai/mcp-policy'

const SCOPES: McpScope[] = ['read', 'write', 'command', 'network', 'unknown']

describe('mcp confirm visibility', () => {
  it('read выполняется сразу, всё остальное — с подтверждением', () => {
    expect(confirmRequirement('read')).toBe('auto')
    for (const s of SCOPES.filter(s => s !== 'read')) {
      expect(confirmRequirement(s), `scope ${s}`).toBe('confirm')
    }
  })

  it('анти-дрейф: ярлык renderer совпадает с решением гейта main в ask/accept-edits', () => {
    for (const s of SCOPES) {
      const label = confirmRequirement(s)
      const ask = mcpDecision(s, 'ask')
      const acceptEdits = mcpDecision(s, 'accept-edits')
      if (label === 'auto') {
        expect(ask, `scope ${s}: ярлык «сразу», а гейт в ask = ${ask}`).toBe('auto-accept')
        expect(acceptEdits, `scope ${s}: ярлык «сразу», а гейт в accept-edits = ${acceptEdits}`).toBe('auto-accept')
      } else {
        expect(ask, `scope ${s}: ярлык «с подтверждением», а гейт в ask = ${ask}`).toBe('confirm')
        expect(acceptEdits, `scope ${s}: ярлык «с подтверждением», а гейт в accept-edits = ${acceptEdits}`).toBe('confirm')
      }
    }
  })
})
