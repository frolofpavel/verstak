import { describe, it, expect } from 'vitest'
import { classifyMcpToolScope, mcpDecision } from '../../electron/ai/mcp-policy'

// mcp-policy — runtime-гейт вызовов внешних MCP-инструментов под agent-mode.
// Имена MCP-тулзов динамические, поэтому scope классифицируется эвристикой,
// а mcpDecision(scope, mode) маппит его в block/confirm/auto-accept так же,
// как mode-policy гейтит команды. Эти тесты фиксируют контракт: read проходит,
// write/command трогают внешние системы и гейтятся, plan блокирует.

describe('classifyMcpToolScope()', () => {
  it('command keyword → command scope', () => {
    expect(classifyMcpToolScope('run_shell', 'Execute a shell command')).toBe('command')
    expect(classifyMcpToolScope('exec_process')).toBe('command')
  })

  it('write keyword → write scope', () => {
    expect(classifyMcpToolScope('create_file', 'Create a new file')).toBe('write')
    expect(classifyMcpToolScope('delete_record')).toBe('write')
    expect(classifyMcpToolScope('post_message')).toBe('write')
  })

  it('network keyword → network scope', () => {
    expect(classifyMcpToolScope('fetch_url', 'Fetch a web page')).toBe('network')
    expect(classifyMcpToolScope('http_request')).toBe('network')
  })

  it('read keyword → read scope', () => {
    expect(classifyMcpToolScope('get_event', 'Get a calendar event')).toBe('read')
    expect(classifyMcpToolScope('list_items')).toBe('read')
    expect(classifyMcpToolScope('search_files')).toBe('read')
  })

  it('no keyword → unknown scope', () => {
    expect(classifyMcpToolScope('zorblax', 'does something opaque')).toBe('unknown')
  })

  it('most-dangerous match wins (command over read)', () => {
    // "get" (read) присутствует, но "exec" (command) опаснее и идёт первым правилом
    expect(classifyMcpToolScope('get_and_exec', 'get data then exec it')).toBe('command')
  })
})

describe('mcpDecision()', () => {
  it('read tool → auto-accept в ask', () => {
    expect(mcpDecision('read', 'ask')).toBe('auto-accept')
  })

  it('write tool → confirm в ask, block в plan', () => {
    expect(mcpDecision('write', 'ask')).toBe('confirm')
    expect(mcpDecision('write', 'plan')).toBe('block')
  })

  it('command tool → block в plan, confirm в ask', () => {
    expect(mcpDecision('command', 'plan')).toBe('block')
    expect(mcpDecision('command', 'ask')).toBe('confirm')
  })

  it('accept-edits подтверждает write/command (внешние side-effects, не локальные правки)', () => {
    expect(mcpDecision('write', 'accept-edits')).toBe('confirm')
    expect(mcpDecision('command', 'accept-edits')).toBe('confirm')
    // read всё равно проходит молча
    expect(mcpDecision('read', 'accept-edits')).toBe('auto-accept')
  })

  it('auto-режим → всё auto-accept', () => {
    for (const scope of ['read', 'write', 'command', 'network', 'unknown'] as const) {
      expect(mcpDecision(scope, 'auto')).toBe('auto-accept')
    }
  })

  it('bypass-режим → всё auto-accept', () => {
    for (const scope of ['read', 'write', 'command', 'network', 'unknown'] as const) {
      expect(mcpDecision(scope, 'bypass')).toBe('auto-accept')
    }
  })

  it('network/unknown гейтятся как команда (block в plan, confirm в ask)', () => {
    expect(mcpDecision('network', 'plan')).toBe('block')
    expect(mcpDecision('network', 'ask')).toBe('confirm')
    expect(mcpDecision('unknown', 'plan')).toBe('block')
    expect(mcpDecision('unknown', 'ask')).toBe('confirm')
  })
})
