import { describe, it, expect } from 'vitest'
import {
  compileHooksConfig, matchHook, interpretHookResult, runHooks, hooksEnabled,
  type CompiledHooks, type HookEntry
} from '../../electron/ai/hooks'

describe('hooks — конфиг', () => {
  it('парсит события и matcher; * → null (любой тул)', () => {
    const h = compileHooksConfig({
      PreToolUse: [{ matcher: 'run_command', command: 'node guard.js' }],
      PostToolUse: [{ matcher: '*', command: 'echo hi' }],
    }, 'user')
    expect(h.PreToolUse).toHaveLength(1)
    expect(h.PreToolUse[0].matcher).toBe('run_command')
    expect(h.PostToolUse[0].matcher).toBeNull()
  })

  it('игнорирует записи без command', () => {
    const h = compileHooksConfig({ PreToolUse: [{ matcher: 'x' }, { command: '  ' }] }, 'user')
    expect(h.PreToolUse).toHaveLength(0)
  })

  it('таймаут клампится до 30000', () => {
    const h = compileHooksConfig({ Stop: [{ command: 'x', timeout: 999999 }] }, 'user')
    expect(h.Stop[0].timeout).toBe(30000)
  })

  it('hooksEnabled: дефолт выключен (opt-in)', () => {
    expect(hooksEnabled(undefined)).toBe(false)
    expect(hooksEnabled(() => null)).toBe(false)
    expect(hooksEnabled((k) => k === 'hooks_enabled' ? 'true' : null)).toBe(true)
  })
})

describe('hooks — matchHook', () => {
  const mk = (matcher: string | null): HookEntry => ({ matcher, command: 'x', timeout: 1000, scope: 'user' })
  it('точное имя', () => {
    expect(matchHook(mk('write_file'), 'write_file')).toBe(true)
    expect(matchHook(mk('write_file'), 'read_file')).toBe(false)
  })
  it('null matcher → любой тул', () => {
    expect(matchHook(mk(null), 'anything')).toBe(true)
  })
  it('glob', () => {
    expect(matchHook(mk('browser_*'), 'browser_click')).toBe(true)
    expect(matchHook(mk('browser_*'), 'write_file')).toBe(false)
  })
})

describe('hooks — interpretHookResult (pure)', () => {
  it('PreToolUse exit 2 → блок с reason из stderr', () => {
    const o = interpretHookResult('PreToolUse', { exitCode: 2, stdout: '', stderr: 'нельзя трогать prod' })
    expect(o.block).toBe(true)
    expect(o.reason).toContain('prod')
  })

  it('PostToolUse exit 2 НЕ блокирует (блок только PreToolUse)', () => {
    const o = interpretHookResult('PostToolUse', { exitCode: 2, stdout: '', stderr: 'x' })
    expect(o.block).toBe(false)
  })

  it('stdout JSON {block:true} → блок (PreToolUse)', () => {
    const o = interpretHookResult('PreToolUse', { exitCode: 0, stdout: '{"block":true,"reason":"deny"}', stderr: '' })
    expect(o.block).toBe(true)
    expect(o.reason).toBe('deny')
  })

  it('stdout JSON additionalContext → инжектируемый контекст', () => {
    const o = interpretHookResult('SessionStart', { exitCode: 0, stdout: '{"additionalContext":"проект на этапе релиза"}', stderr: '' })
    expect(o.block).toBe(false)
    expect(o.additionalContext).toBe('проект на этапе релиза')
  })

  it('не-JSON stdout не ломает разбор', () => {
    const o = interpretHookResult('Stop', { exitCode: 0, stdout: 'просто текст', stderr: '' })
    expect(o.block).toBe(false)
    expect(o.additionalContext).toBeUndefined()
  })
})

describe('hooks — runHooks (интеграция через node)', () => {
  const NODE = process.execPath // абсолютный путь к node, доступен в тест-окружении

  it('PreToolUse: node exit 2 → блок', async () => {
    const hooks: CompiledHooks = compileHooksConfig({
      PreToolUse: [{ matcher: 'run_command', command: `"${NODE}" -e "process.exit(2)"`, timeout: 8000 }],
    }, 'user')
    const out = await runHooks('PreToolUse', hooks, { event: 'PreToolUse', cwd: null, tool_name: 'run_command' })
    expect(out.block).toBe(true)
  })

  it('PreToolUse matcher не совпал → хук не запускается, нет блока', async () => {
    const hooks: CompiledHooks = compileHooksConfig({
      PreToolUse: [{ matcher: 'write_file', command: `"${NODE}" -e "process.exit(2)"`, timeout: 8000 }],
    }, 'user')
    const out = await runHooks('PreToolUse', hooks, { event: 'PreToolUse', cwd: null, tool_name: 'run_command' })
    expect(out.block).toBe(false)
  })

  it('SessionStart: stdout additionalContext инжектится', async () => {
    const hooks: CompiledHooks = compileHooksConfig({
      SessionStart: [{ command: `"${NODE}" -e "process.stdout.write(JSON.stringify({additionalContext:'ctx-from-hook'}))"`, timeout: 8000 }],
    }, 'user')
    const out = await runHooks('SessionStart', hooks, { event: 'SessionStart', cwd: null })
    expect(out.additionalContext).toContain('ctx-from-hook')
  })

  it('нет хуков события → no-op', async () => {
    const hooks: CompiledHooks = compileHooksConfig({}, 'user')
    const out = await runHooks('PreToolUse', hooks, { event: 'PreToolUse', cwd: null, tool_name: 'run_command' })
    expect(out.block).toBe(false)
    expect(out.additionalContext).toBeUndefined()
  })
}, 20000)
