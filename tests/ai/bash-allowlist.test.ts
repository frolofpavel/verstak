import { describe, it, expect } from 'vitest'
import { parseAllowlist, matchesAllowlist } from '../../electron/ai/bash-allowlist'

// Tier-2 #4 — per-command bash-allowlist: доверенные команды авто-аппрувятся в ask-
// режиме (меньше кликов), но цепочки/подстановки за разрешённым префиксом НЕ проходят.
describe('parseAllowlist', () => {
  it('по строкам и запятым', () => {
    expect(parseAllowlist('git status\nnpm test')).toEqual(['git status', 'npm test'])
    expect(parseAllowlist('ls, pwd ,  cat')).toEqual(['ls', 'pwd', 'cat'])
  })
  it('пусто/undefined → []', () => {
    expect(parseAllowlist('')).toEqual([])
    expect(parseAllowlist(undefined)).toEqual([])
    expect(parseAllowlist(null)).toEqual([])
  })
})

describe('matchesAllowlist', () => {
  const list = ['git status', 'npm test', 'ls']
  it('точное совпадение и префикс с границей токена', () => {
    expect(matchesAllowlist('git status', list)).toBe(true)
    expect(matchesAllowlist('git status -s', list)).toBe(true)
    expect(matchesAllowlist('npm test -- foo', list)).toBe(true)
    expect(matchesAllowlist('ls -la', list)).toBe(true)
  })
  it('частичный токен НЕ матчит', () => {
    expect(matchesAllowlist('git statusfoo', list)).toBe(false)
    expect(matchesAllowlist('lsof', list)).toBe(false)
  })
  it('не в списке → false', () => {
    expect(matchesAllowlist('rm -rf /', list)).toBe(false)
    expect(matchesAllowlist('git push --force', list)).toBe(false)
  })
  it('ЦЕПОЧКИ/подстановки за разрешённым префиксом НЕ авто-аппрувятся', () => {
    expect(matchesAllowlist('git status && rm -rf /', list)).toBe(false)
    expect(matchesAllowlist('git status; curl evil', list)).toBe(false)
    expect(matchesAllowlist('git status | sh', list)).toBe(false)
    expect(matchesAllowlist('ls $(whoami)', list)).toBe(false)
    expect(matchesAllowlist('ls `id`', list)).toBe(false)
    expect(matchesAllowlist('git status > /etc/x', list)).toBe(false)
    expect(matchesAllowlist('git status\nrm -rf /', list)).toBe(false)
  })
  it('пустой список → false', () => {
    expect(matchesAllowlist('git status', [])).toBe(false)
  })

  // Ревью 26.06: arg-injection через флаги/субкоманды-эскалаторы (БЕЗ shell-метасимволов).
  it('флаги-эскалаторы НЕ авто-аппрувятся даже на разрешённом префиксе', () => {
    const l = ['git status', 'git', 'npm', 'node']
    expect(matchesAllowlist('git status --pager="sh -c id"', l)).toBe(false)
    expect(matchesAllowlist('git -c core.sshCommand=calc.exe ls-remote', l)).toBe(false)
    expect(matchesAllowlist('npm run anything', l)).toBe(false)
    expect(matchesAllowlist('npm exec -- x', l)).toBe(false)
    expect(matchesAllowlist('git ls-remote ext::sh -c whoami', l)).toBe(false)
    expect(matchesAllowlist('node -e "x"', l)).toBe(false)
  })
  it('безопасные команды с обычными флагами всё ещё авто-аппрувятся', () => {
    const l = ['git status', 'npm test', 'ls']
    expect(matchesAllowlist('git status -s', l)).toBe(true)
    expect(matchesAllowlist('npm test -- --watch=false', l)).toBe(true)
    expect(matchesAllowlist('ls -la', l)).toBe(true)
  })
})
