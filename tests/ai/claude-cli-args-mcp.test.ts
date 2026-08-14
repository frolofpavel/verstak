import { describe, it, expect } from 'vitest'
import { buildClaudeCliArgs, claudePermissionMode } from '../../electron/ai/claude-cli'
import { buildClaudeMcpBridge } from '../../electron/ai/claude-cli-mcp'
import type { AgentMode } from '../../electron/ai/mode-policy'

const MODES: Array<AgentMode | undefined> = ['ask', 'accept-edits', 'auto', 'plan', 'bypass', undefined]

const MOEX = { id: 'srv-1', name: 'MOEX', command: 'npx', args: ['-y', 'moex-mcp'], env: {} }

describe('buildClaudeCliArgs — состав командной строки claude', () => {
  it('без MCP командная строка прежняя: --print/stream-json/--verbose + guard', () => {
    const args = buildClaudeCliArgs({ agentMode: 'ask' })
    expect(args.slice(0, 4)).toEqual(['--print', '--output-format', 'stream-json', '--verbose'])
    expect(args).toContain('--permission-mode')
    expect(args).toContain('--disallowedTools')
    expect(args).not.toContain('--mcp-config')
  })

  it('MCP-мост встаёт ДО guard: --disallowedTools остаётся последним блоком', () => {
    // --disallowedTools variadic: любой флаг после него был бы съеден списком
    // специфаеров. Инвариант тот же, что в claude-cli-permission.test.ts.
    const args = buildClaudeCliArgs({ agentMode: 'ask', mcpArgs: buildClaudeMcpBridge([MOEX])!.args })
    const mcpIdx = args.indexOf('--mcp-config')
    const dtIdx = args.indexOf('--disallowedTools')
    expect(mcpIdx).toBeGreaterThanOrEqual(0)
    expect(mcpIdx).toBeLessThan(dtIdx)
    const tail = args.slice(dtIdx + 1)
    expect(tail.every(a => /^(Read|Edit|Write)\(.+\)$/.test(a))).toBe(true)
  })

  it('--mcp-config variadic не поглощает соседний флаг: сразу за JSON идёт «--»-токен', () => {
    const args = buildClaudeCliArgs({ agentMode: 'ask', mcpArgs: buildClaudeMcpBridge([MOEX])!.args })
    const mcpIdx = args.indexOf('--mcp-config')
    expect(args[mcpIdx + 1].startsWith('{')).toBe(true)
    expect(args[mcpIdx + 2].startsWith('--')).toBe(true)
  })

  it('СООТВЕТСТВИЕ РЕЖИМА: включённый MCP не меняет --permission-mode ни в одном режиме', () => {
    // Условие 1 постановки: инструменты MCP на CLI-пути исполняет сам CLI, наш
    // resolveDecision к ним неприменим — поэтому единственное, что мы обязаны
    // удержать, это передача режима. Спрашивающий режим обязан остаться спрашивающим.
    for (const mode of MODES) {
      const withMcp = buildClaudeCliArgs({ agentMode: mode, mcpArgs: buildClaudeMcpBridge([MOEX])!.args })
      const withoutMcp = buildClaudeCliArgs({ agentMode: mode })
      expect(withMcp[withMcp.indexOf('--permission-mode') + 1], String(mode)).toBe(claudePermissionMode(mode))
      expect(withoutMcp[withoutMcp.indexOf('--permission-mode') + 1], String(mode)).toBe(claudePermissionMode(mode))
    }
  })

  it('MCP-инструменты НЕ свободнее прочих: ни одного разрешающего флага при включённом MCP', () => {
    for (const mode of MODES) {
      const args = buildClaudeCliArgs({ agentMode: mode, mcpArgs: buildClaudeMcpBridge([MOEX])!.args })
      for (const forbidden of ['--allowedTools', '--allowed-tools', '--dangerously-skip-permissions',
        '--allow-dangerously-skip-permissions', '--tools']) {
        expect(args, `${String(mode)} / ${forbidden}`).not.toContain(forbidden)
      }
      // guard секретов на месте при любом режиме и при включённом MCP
      expect(args, String(mode)).toContain('Read(**/.env)')
    }
  })

  it('небезопасное имя модели не уезжает в argv (существующий инвариант не сломан)', () => {
    expect(buildClaudeCliArgs({ model: '--dangerously-skip-permissions' })).not.toContain('--dangerously-skip-permissions')
    expect(buildClaudeCliArgs({ model: 'claude-opus-4-5' })).toContain('claude-opus-4-5')
    expect(buildClaudeCliArgs({ model: 'auto' })).not.toContain('--model')
  })
})
