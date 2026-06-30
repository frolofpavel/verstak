import { describe, it, expect } from 'vitest'
import {
  parseRule, expandToolName, compileArgMatcher, compilePermissionConfig,
  applyPermissionRules, extractArgText, resolveDecision, type CompiledPermissionRules
} from '../../electron/ai/permission-rules'

describe('permission-rules — парсинг', () => {
  it('Bash(npm:*) → run_command с префикс-матчером', () => {
    const rules = parseRule('Bash(npm:*)')
    expect(rules).toHaveLength(1)
    expect(rules[0].tool).toBe('run_command')
    expect(rules[0].argMatcher!('npm install')).toBe(true)
    expect(rules[0].argMatcher!('git push')).toBe(false)
  })

  it('Write → разворачивается в write_file/apply_patch/propose_edits', () => {
    expect(expandToolName('Write').sort()).toEqual(['apply_patch', 'propose_edits', 'write_file'])
  })

  it('Tool без скобок → argMatcher null (матчит любой вызов)', () => {
    const r = parseRule('connector_query')[0]
    expect(r.tool).toBe('connector_query')
    expect(r.argMatcher).toBeNull()
  })

  it('Read(src/**) → glob по пути', () => {
    const m = compileArgMatcher('src/**')!
    expect(m('src/a/b.ts')).toBe(true)
    expect(m('lib/x.ts')).toBe(false)
  })

  it('glob *.env ловит .env и prod.env (защита секретов)', () => {
    const m = compileArgMatcher('*.env')!
    expect(m('.env')).toBe(true)      // * матчит и пустую часть до .env
    expect(m('prod.env')).toBe(true)
    expect(m('a/.env')).toBe(false)   // * не пересекает сегмент пути
  })

  it('пустой/звезда паттерн → null матчер (любой)', () => {
    expect(compileArgMatcher('*')).toBeNull()
    expect(compileArgMatcher('')).toBeNull()
    expect(compileArgMatcher(null)).toBeNull()
  })
})

describe('permission-rules — приоритет deny > ask > allow', () => {
  const rules: CompiledPermissionRules = compilePermissionConfig({
    allow: ['Bash(npm:*)'],
    deny: ['Bash(rm:*)'],
    ask: ['Bash(git push:*)'],
  })

  it('deny выигрывает', () => {
    expect(applyPermissionRules('run_command', 'rm -rf x', rules)!.decision).toBe('deny')
  })
  it('ask матчится', () => {
    expect(applyPermissionRules('run_command', 'git push origin', rules)!.decision).toBe('ask')
  })
  it('allow матчится', () => {
    expect(applyPermissionRules('run_command', 'npm test', rules)!.decision).toBe('allow')
  })
  it('нет совпадения → null', () => {
    expect(applyPermissionRules('run_command', 'ls', rules)).toBeNull()
  })
})

describe('permission-rules — extractArgText', () => {
  it('run_command → command', () => {
    expect(extractArgText('run_command', { command: 'npm test' })).toBe('npm test')
  })
  it('write_file → path', () => {
    expect(extractArgText('write_file', { path: 'src/a.ts', content: 'x' })).toBe('src/a.ts')
  })
})

describe('permission-rules — resolveDecision (режим + правила)', () => {
  const rules: CompiledPermissionRules = compilePermissionConfig({
    allow: ['Bash(npm:*)'],
    deny: ['Bash(rm:*)'],
    ask: ['Bash(git push:*)'],
  })

  it('deny-правило блокирует даже в bypass', () => {
    const r = resolveDecision('run_command', { command: 'rm -rf /' }, 'bypass', undefined, rules)
    expect(r.decision).toBe('block')
    expect(r.reason).toContain('deny')
  })

  it('allow повышает confirm→auto в ask-режиме', () => {
    const r = resolveDecision('run_command', { command: 'npm test' }, 'ask', undefined, rules)
    expect(r.decision).toBe('auto-accept')
  })

  it('ask понижает auto→confirm', () => {
    const r = resolveDecision('run_command', { command: 'git push origin main' }, 'auto', undefined, rules)
    expect(r.decision).toBe('confirm')
  })

  it('plan-режим: правила НЕ ослабляют block (allow на npm в plan → всё равно block)', () => {
    const r = resolveDecision('run_command', { command: 'npm test' }, 'plan', undefined, rules)
    expect(r.decision).toBe('block')
  })

  it('без правил → решение режима (обратная совместимость)', () => {
    expect(resolveDecision('run_command', { command: 'ls' }, 'ask', undefined, undefined).decision).toBe('confirm')
    expect(resolveDecision('write_file', { path: 'a.ts' }, 'accept-edits', undefined, undefined).decision).toBe('auto-accept')
    expect(resolveDecision('read_file', { path: 'a.ts' }, 'ask', undefined, undefined).decision).toBe('auto-accept')
  })
})
