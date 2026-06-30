import { describe, it, expect } from 'vitest'
import { splitArgs, expandCommandBody } from '../../electron/ai/commands'

describe('commands — splitArgs', () => {
  it('пустая строка → []', () => {
    expect(splitArgs('')).toEqual([])
    expect(splitArgs('   ')).toEqual([])
  })
  it('whitespace-сплит', () => {
    expect(splitArgs('main feature/x')).toEqual(['main', 'feature/x'])
  })
})

describe('commands — expandCommandBody', () => {
  it('$ARGUMENTS → вся строка аргументов', async () => {
    const out = await expandCommandBody('Ревью ветки: $ARGUMENTS', 'main release')
    expect(out).toBe('Ревью ветки: main release')
  })

  it('$1/$2 → позиционные', async () => {
    const out = await expandCommandBody('от $1 до $2', 'main hotfix')
    expect(out).toBe('от main до hotfix')
  })

  it('отсутствующий позиционный → пусто', async () => {
    const out = await expandCommandBody('arg=$3', 'a b')
    expect(out).toBe('arg=')
  })

  it('!`cmd` → инъекция вывода через runCommand', async () => {
    const out = await expandCommandBody('Диф:\n!`git diff`', '', {
      runCommand: async (cmd) => cmd === 'git diff' ? '+ added line' : ''
    })
    expect(out).toBe('Диф:\n+ added line')
  })

  it('несколько !`cmd` блоков', async () => {
    const out = await expandCommandBody('A=!`echo a` B=!`echo b`', '', {
      runCommand: async (cmd) => cmd === 'echo a' ? 'AA' : 'BB'
    })
    expect(out).toBe('A=AA B=BB')
  })

  it('без runCommand !`cmd` остаётся как есть (не выполняем shell без раннера)', async () => {
    const out = await expandCommandBody('X=!`rm -rf /`', '')
    expect(out).toContain('!`rm -rf /`')
  })

  it('ошибка команды → маркер, не падаем', async () => {
    const out = await expandCommandBody('!`bad`', '', {
      runCommand: async () => { throw new Error('boom') }
    })
    expect(out).toContain('не выполнена')
    expect(out).toContain('boom')
  })

  it('$VARIABLE (заглавные) НЕ трогаются — их промптит UI', async () => {
    const out = await expandCommandBody('$FOCUS и $1', 'pos', {})
    expect(out).toBe('$FOCUS и pos')
  })

  // Ревью HIGH: аргумент с !`cmd` НЕ должен исполняться (резолв по исходному body).
  it('!`cmd` из аргумента ($ARGUMENTS) НЕ исполняется — остаётся литералом', async () => {
    const spy: string[] = []
    const out = await expandCommandBody('Запрос: $ARGUMENTS', '!`whoami`', {
      runCommand: async (cmd) => { spy.push(cmd); return 'ATTACKER' }
    })
    expect(spy).not.toContain('whoami')          // команда из аргумента НЕ выполнена
    expect(out).toContain('!`whoami`')           // осталась литералом
    expect(out).not.toContain('ATTACKER')
  })

  it('!`cmd` из ИСХОДНОГО body выполняется (легитимный путь сохранён)', async () => {
    const out = await expandCommandBody('Диф $1:\n!`git diff`', 'main', {
      runCommand: async (cmd) => cmd === 'git diff' ? 'DIFF' : ''
    })
    expect(out).toBe('Диф main:\nDIFF')
  })
})
