// C7 (13.08): обрыв сборки релиза убирает за собой.
//
// `scripts/release-build.mjs` вешал уборку на `process.on('exit')`. Этого мало:
// при SIGINT/SIGTERM без собственного обработчика Node завершает процесс штатной
// реакцией на сигнал, и обработчики `exit` НЕ выполняются. Ctrl+C посреди сборки
// оставлял каталог-призрак `%TEMP%\verstak-release-<sha>` (гигабайты) и запись в
// `git worktree list` — ловили дважды, один раз призрак уронил следующую сборку
// («missing but already registered worktree»).
//
// Пины на настоящем поведении: сигнал → уборка ровно один раз → выход с кодом
// 128+сигнал. Источник не грепаем: пин, читающий текст скрипта, зелен и тогда,
// когда обработчик зарегистрирован, но ничего не делает.
import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { installAbortCleanup } = require('../scripts/abort-cleanup.cjs') as {
  installAbortCleanup: (opts: {
    process: { on: (sig: string, h: () => void) => void }
    onAbort: () => void
    onExit: (code: number) => void
    signals?: string[]
  }) => string[]
}

/** Поддельный процесс: запоминает обработчики, чтобы их можно было позвать. */
function fakeProcess() {
  const handlers = new Map<string, Array<() => void>>()
  return {
    proc: { on: (sig: string, h: () => void) => { handlers.set(sig, [...(handlers.get(sig) ?? []), h]) } },
    fire: (sig: string) => { for (const h of handlers.get(sig) ?? []) h() },
    registered: () => [...handlers.keys()],
  }
}

describe('C7: обрыв сборки релиза', () => {
  it('ПИН: обработчики стоят и на SIGINT, и на SIGTERM', () => {
    const f = fakeProcess()

    installAbortCleanup({ process: f.proc, onAbort: () => {}, onExit: () => {} })

    expect(f.registered(), 'Ctrl+C по-прежнему уходит мимо уборки').toContain('SIGINT')
    expect(f.registered()).toContain('SIGTERM')
  })

  it('ПИН: SIGINT → уборка позвана, выход с кодом 130 (128+2)', () => {
    const f = fakeProcess()
    const onAbort = vi.fn()
    const onExit = vi.fn()

    installAbortCleanup({ process: f.proc, onAbort, onExit })
    f.fire('SIGINT')

    expect(onAbort, 'каталог-призрак остался на диске').toHaveBeenCalledTimes(1)
    expect(onExit).toHaveBeenCalledWith(130)
  })

  it('ПИН: SIGTERM → код 143 (128+15)', () => {
    const f = fakeProcess()
    const onExit = vi.fn()

    installAbortCleanup({ process: f.proc, onAbort: () => {}, onExit })
    f.fire('SIGTERM')

    expect(onExit).toHaveBeenCalledWith(143)
  })

  it('ПИН: второй сигнал не запускает уборку повторно', () => {
    // Нетерпеливый человек жмёт Ctrl+C дважды; вторая уборка пошла бы поверх
    // первой, ещё не закончившей удаление гигабайтного дерева.
    const f = fakeProcess()
    const onAbort = vi.fn()

    installAbortCleanup({ process: f.proc, onAbort, onExit: () => {} })
    f.fire('SIGINT')
    f.fire('SIGINT')
    f.fire('SIGTERM')

    expect(onAbort).toHaveBeenCalledTimes(1)
  })

  it('ПИН: упавшая уборка не отменяет выход — обрыв не должен виснуть', () => {
    const f = fakeProcess()
    const onExit = vi.fn()

    installAbortCleanup({
      process: f.proc,
      onAbort: () => { throw new Error('git worktree remove не смог') },
      onExit,
    })
    f.fire('SIGINT')

    expect(onExit).toHaveBeenCalledWith(130)
  })

  it('КОНТРОЛЬ: без сигнала уборка не зовётся (иначе пины выше ничего не мерят)', () => {
    const f = fakeProcess()
    const onAbort = vi.fn()

    installAbortCleanup({ process: f.proc, onAbort, onExit: () => {} })

    expect(onAbort).not.toHaveBeenCalled()
  })
})
