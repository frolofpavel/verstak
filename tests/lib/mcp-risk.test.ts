import { describe, it, expect } from 'vitest'
import { classifyTool, classifyServer } from '../../src/lib/mcp-risk'

describe('classifyTool', () => {
  it('command keywords → command/high', () => {
    expect(classifyTool({ name: 'run_command' })).toEqual({ scope: 'command', risk: 'high' })
    expect(classifyTool({ name: 'execute_shell' })).toEqual({ scope: 'command', risk: 'high' })
    expect(classifyTool({ name: 'spawn_process' })).toEqual({ scope: 'command', risk: 'high' })
  })

  it('network keywords → network/medium', () => {
    expect(classifyTool({ name: 'fetch_url' })).toEqual({ scope: 'network', risk: 'medium' })
    expect(classifyTool({ name: 'http_get', description: 'make an HTTP request' })).toEqual({ scope: 'network', risk: 'medium' })
  })

  it('write keywords → write/medium', () => {
    expect(classifyTool({ name: 'create_file' })).toEqual({ scope: 'write', risk: 'medium' })
    expect(classifyTool({ name: 'delete_record' })).toEqual({ scope: 'write', risk: 'medium' })
  })

  it('read keywords → read/low', () => {
    expect(classifyTool({ name: 'list_items' })).toEqual({ scope: 'read', risk: 'low' })
    expect(classifyTool({ name: 'search', description: 'find things' })).toEqual({ scope: 'read', risk: 'low' })
  })

  it('most-dangerous match wins (command over read)', () => {
    // "get" (read) и "run" (command) оба присутствуют — побеждает command.
    expect(classifyTool({ name: 'get_and_run', description: 'fetch then run' })).toEqual({ scope: 'command', risk: 'high' })
  })

  it('unrecognized → unknown/medium', () => {
    expect(classifyTool({ name: 'zzz_frobnicate' })).toEqual({ scope: 'unknown', risk: 'medium' })
  })
})

describe('classifyServer', () => {
  it('server with a command tool → high', () => {
    const r = classifyServer([
      { name: 'list_files' },
      { name: 'run_command' }
    ])
    expect(r.risk).toBe('high')
    expect(r.scopes.command).toBe(1)
    expect(r.scopes.read).toBe(1)
    expect(r.toolCount).toBe(2)
  })

  it('read-only server → low', () => {
    const r = classifyServer([
      { name: 'list_items' },
      { name: 'get_item' },
      { name: 'search_items' }
    ])
    expect(r.risk).toBe('low')
    expect(r.scopes.read).toBe(3)
    expect(r.toolCount).toBe(3)
  })

  it('write/network server → medium', () => {
    const r = classifyServer([
      { name: 'create_doc' },
      { name: 'fetch_url' }
    ])
    expect(r.risk).toBe('medium')
  })

  it('empty server → low', () => {
    const r = classifyServer([])
    expect(r.risk).toBe('low')
    expect(r.toolCount).toBe(0)
    expect(r.scopes.command).toBe(0)
  })
})
