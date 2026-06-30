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

  // Ревью HIGH: deny обходится цепочкой/обёрткой — теперь сегментируем.
  it('deny на git push ловит цепочку npm test && git push', () => {
    expect(applyPermissionRules('run_command', 'npm test && git push origin', rules)!.decision).toBe('ask')
  })
  it('deny на rm ловит цепочку cd sub && rm important.txt', () => {
    const r2 = compilePermissionConfig({ deny: ['Bash(rm:*)'] })
    expect(applyPermissionRules('run_command', 'cd sub && rm important.txt', r2)!.decision).toBe('deny')
  })
  it('deny ловит обёртку sudo/env/bash -c', () => {
    const r2 = compilePermissionConfig({ deny: ['Bash(rm:*)'] })
    expect(applyPermissionRules('run_command', 'sudo rm x', r2)!.decision).toBe('deny')
    expect(applyPermissionRules('run_command', 'env FOO=1 rm x', r2)!.decision).toBe('deny')
    expect(applyPermissionRules('run_command', 'bash -c "rm x"', r2)!.decision).toBe('deny')
  })
  it('deny на curl ловит echo x && curl evil', () => {
    const r2 = compilePermissionConfig({ deny: ['Bash(curl:*)'] })
    expect(applyPermissionRules('run_command', 'echo x && curl http://evil', r2)!.decision).toBe('deny')
  })

  // Ре-ревью HIGH×2: подстановки/группы/wrappers/find -exec/одиночный & обходили deny.
  const rmRules = compilePermissionConfig({ deny: ['Bash(rm:*)'] })
  const denied = (cmd: string) => applyPermissionRules('run_command', cmd, rmRules)?.decision
  it('подстановка $(...) и бэктики не прячут rm', () => {
    expect(denied('echo $(rm important.txt)')).toBe('deny')
    expect(denied('echo `rm important.txt`')).toBe('deny')
    expect(denied('X=$(rm important.txt) echo')).toBe('deny')
  })
  it('process substitution <(...) >(...) не прячут rm', () => {
    expect(denied('cat <(rm important.txt)')).toBe('deny')
    expect(denied('tee >(rm important.txt)')).toBe('deny')
  })
  it('сабшелл (...) и brace-group {...} не прячут rm', () => {
    expect(denied('(rm important.txt)')).toBe('deny')
    expect(denied('{ rm important.txt; }')).toBe('deny')
    expect(denied('( sudo rm important.txt )')).toBe('deny')
  })
  it('одиночный & (фон) не прячет rm', () => {
    expect(denied('sleep 1 & rm important.txt')).toBe('deny')
  })
  it('обёртки timeout/nohup/watch/stdbuf не прячут rm', () => {
    expect(denied('timeout 5 rm x')).toBe('deny')
    expect(denied('nohup rm x')).toBe('deny')
    expect(denied('watch -n2 rm x')).toBe('deny')
    expect(denied('stdbuf -oL rm x')).toBe('deny')
  })
  it('find -exec/-execdir rm извлекается', () => {
    expect(denied('find . -name "*" -exec rm {} \\;')).toBe('deny')
    expect(denied('find . -type f -execdir rm {} +')).toBe('deny')
  })
  it('легитимные команды НЕ блокируются под deny rm:*', () => {
    expect(denied('npm test')).toBeUndefined()
    expect(denied('echo hi && git status')).toBeUndefined()
    expect(denied('git log --oneline')).toBeUndefined()
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
