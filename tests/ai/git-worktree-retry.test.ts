// Транзиент-устойчивость удаления worktree. Баг: removeWorktree делал ОДИН заход
// git worktree remove; под внешней git-нагрузкой (Codex/антивирус держат хендл файла) команда
// транзиентно падала → false, хотя повтор проходит. Это роняло гейт («removes clean pushed
// worktree» → expected false to be true) при зелёном коде. retryTransient — примитив повтора
// (как rmDirRobust для каталога). Pure-блок чистый: без git, без fs, детерминированный.
// Мок-блок (мок execFileSync; lifecycle с реальным git — в worktree-lifecycle.test.ts):
//  — защита от ЛОЖНОГО УСПЕХА: ошибка `git worktree list` ≠ «worktree уже нет»;
//  — WIRING: removeWorktree реально использует retry (не только pure retryTransient);
//  — containment cleanup'а: 'Temp-evil-…\verstak-wt-x' начинается со строки tmpdir(),
//    но НЕ является temp-каталогом — такой parent удалять нельзя.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, symlinkSync, rmdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { retryTransient, removeWorktree, rmDirRobust } from '../../electron/ai/git-worktree'

// Общее состояние для мока git-подкоманд (vi.hoisted — фабрика мока иначе не увидит переменную).
const gitMock = vi.hoisted(() => ({
  failRemove: false,             // remove падает ВСЕГДА
  failRemoveTimes: 0,            // …ИЛИ только первые N вызовов (для wiring-теста)
  removeCalls: 0,                // счётчик вызовов `git worktree remove`
  listResult: null as string | null, // null = `git worktree list` падает (транзиент)
}))

vi.mock('child_process', async (importOriginal) => {
  const mod = await importOriginal<typeof import('child_process')>()
  return {
    ...mod,
    execFileSync: vi.fn((_cmd: unknown, args: unknown) => {
      const a = Array.isArray(args) ? args.map(String) : []
      if (a.includes('remove')) {
        gitMock.removeCalls++
        if (gitMock.failRemove || gitMock.removeCalls <= gitMock.failRemoveTimes) {
          throw new Error('transient: git worktree remove non-zero')
        }
        return ''
      }
      if (a.includes('list')) {
        if (gitMock.listResult == null) throw new Error('transient: git worktree list non-zero')
        return gitMock.listResult
      }
      return '' // prune и прочие подкоманды — успех
    }),
  }
})

describe('retryTransient — bounded-retry транзиентной операции', () => {
  it('повторяет после транзиентного сбоя и возвращает успех', () => {
    let calls = 0
    const ok = retryTransient(() => { calls++; return calls >= 3 }, { attempts: 6, baseDelayMs: 1 })
    expect(ok).toBe(true)
    expect(calls).toBe(3) // упал 2 раза, на 3-й прошёл
  })

  it('happy-path: успех с первой попытки, без лишних заходов', () => {
    let calls = 0
    const ok = retryTransient(() => { calls++; return true }, { attempts: 6, baseDelayMs: 1 })
    expect(ok).toBe(true)
    expect(calls).toBe(1)
  })

  it('сдаётся после N попыток (не бесконечный цикл) и возвращается false', () => {
    let calls = 0
    const ok = retryTransient(() => { calls++; return false }, { attempts: 4, baseDelayMs: 1 })
    expect(ok).toBe(false)
    expect(calls).toBe(4)
  })

  it('isGone() = успех, даже если op всё время падает (идемпотентно: worktree уже снят)', () => {
    let calls = 0
    const ok = retryTransient(() => { calls++; return false }, { attempts: 5, baseDelayMs: 1, isGone: () => calls >= 2 })
    expect(ok).toBe(true)
    expect(calls).toBe(2) // op упал, но isGone поймал «уже нет» на 2-м заходе
  })

  it('исключение из op — не краш и не ложный успех: заход засчитан неудачным, bounded false', () => {
    let calls = 0
    const ok = retryTransient(() => { calls++; throw new Error('boom') }, { attempts: 3, baseDelayMs: 1 })
    expect(ok).toBe(false)
    expect(calls).toBe(3) // исключение не повесило процесс, лимит попыток соблюдён
  })

  it('исключение из isGone — «отсутствие не доказано», не превращается в успех', () => {
    let calls = 0
    const ok = retryTransient(() => { calls++; return false }, {
      attempts: 3,
      baseDelayMs: 1,
      isGone: () => { throw new Error('check failed') },
    })
    expect(ok).toBe(false)
    expect(calls).toBe(3)
  })

  it('attempts <= 0 не создаёт бесконечную работу', () => {
    let calls = 0
    expect(retryTransient(() => { calls++; return true }, { attempts: 0, baseDelayMs: 1 })).toBe(false)
    expect(retryTransient(() => { calls++; return true }, { attempts: -3, baseDelayMs: 1 })).toBe(false)
    expect(calls).toBe(0) // ни одного захода — работа не начата вообще
  })

  it('attempts: non-finite → 0 заходов; дробное → целое; > 10 → clamp 10 (нормализация параметров)', () => {
    let calls = 0
    // Infinity/NaN → 0: без нормализации Infinity с вечно падающим op — бесконечный цикл.
    expect(retryTransient(() => { calls++; return false }, { attempts: Infinity, baseDelayMs: 1 })).toBe(false)
    expect(retryTransient(() => { calls++; return false }, { attempts: NaN, baseDelayMs: 1 })).toBe(false)
    expect(calls).toBe(0)
    // Дробное число попыток усекается до целого.
    expect(retryTransient(() => { calls++; return false }, { attempts: 3.9, baseDelayMs: 1 })).toBe(false)
    expect(calls).toBe(3)
    // Конечное сверх меры — clamp до безопасных 10.
    calls = 0
    expect(retryTransient(() => { calls++; return false }, { attempts: 100, baseDelayMs: 1 })).toBe(false)
    expect(calls).toBe(10)
  })

  it('baseDelayMs: non-finite/отрицательное → без сна; конечная задержка ограничена 1000 мс', () => {
    let calls = 0
    // NaN/Infinity/отрицательная задержка → 0: attempts заходов идут подряд, процесс не виснет
    // (без нормализации Infinity-задержка повесила бы main process на Atomics.wait).
    expect(retryTransient(() => { calls++; return false }, { attempts: 3, baseDelayMs: NaN })).toBe(false)
    expect(retryTransient(() => { calls++; return false }, { attempts: 3, baseDelayMs: Infinity })).toBe(false)
    expect(retryTransient(() => { calls++; return false }, { attempts: 3, baseDelayMs: -500 })).toBe(false)
    expect(calls).toBe(9)
    // Cap 1000 мс: «месячная» задержка ограничена — 2 попытки = 1 сон ≤ 1000 мс, а не 60 секунд.
    const t0 = Date.now()
    expect(retryTransient(() => false, { attempts: 2, baseDelayMs: 60_000 })).toBe(false)
    expect(Date.now() - t0).toBeLessThan(10_000)
  })

  it('sleep-cap: каждый ФАКТИЧЕСКИЙ timeout в Atomics.wait конечный, >= 0 и <= 1000 мс', () => {
    // Блокер R2: cap должен применяться к САМОМУ sleep (base * (i+1)), а не только к base.
    // attempts=10 с base 60_000 без cap'а на sleep давал бы паузы 1..10+ секунд — суммарно
    // десятки секунд блокировки Electron main process. Atomics.wait замокан — реального сна нет.
    const waitSpy = vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out')
    try {
      let calls = 0
      const ok = retryTransient(() => { calls++; return false }, { attempts: 10, baseDelayMs: 60_000 })
      expect(ok).toBe(false)
      expect(calls).toBe(10)                 // все 10 попыток выполнены
      expect(waitSpy).toHaveBeenCalledTimes(9) // 10 попыток = 9 пауз между ними
      for (const call of waitSpy.mock.calls) {
        const timeout = call[3]
        expect(typeof timeout).toBe('number')
        expect(Number.isFinite(timeout)).toBe(true)
        expect(timeout).toBeGreaterThanOrEqual(0)
        expect(timeout).toBeLessThanOrEqual(1000)
      }
    } finally {
      waitSpy.mockRestore()
    }
  })
})

describe('removeWorktree — защита от ложного успеха и wiring retry (мок git)', () => {
  // Путь заведомо не существует на диске (existsSync = false) — изолируем именно git-ветку isGone.
  const FAKE_REPO = 'C:\\repo'
  const FAKE_WT = 'C:\\no\\such\\verstak-wt-fake000\\wt'

  beforeEach(() => {
    gitMock.failRemove = true   // по умолчанию git worktree remove всегда non-zero (транзиент)
    gitMock.failRemoveTimes = 0
    gitMock.removeCalls = 0
    gitMock.listResult = null   // по умолчанию и git worktree list тоже падает
  })

  it('git list УПАЛ + каталога нет ≠ «уже удалено»: remove не прошёл → false (не ложный успех)', () => {
    // [] из-за упавшего `git worktree list` нельзя считать доказанным отсутствием регистрации.
    expect(removeWorktree(FAKE_REPO, FAKE_WT)).toBe(false)
  })

  it('отсутствие регистрации ПОДТВЕРЖДЕНО успешным git list + каталога нет → идемпотентный true', () => {
    gitMock.listResult = 'worktree C:\\repo\nHEAD 0123456789abcdef0123456789abcdef01234567\nbranch refs/heads/main\n'
    expect(removeWorktree(FAKE_REPO, FAKE_WT)).toBe(true)
  })

  it('worktree ещё зарегистрирован (list успешен, путь в списке) + remove падает → false', () => {
    gitMock.listResult =
      'worktree C:\\repo\nHEAD 0123456789abcdef0123456789abcdef01234567\nbranch refs/heads/main\n\n' +
      `worktree ${FAKE_WT}\nHEAD 0123456789abcdef0123456789abcdef01234567\ndetached\n`
    expect(removeWorktree(FAKE_REPO, FAKE_WT)).toBe(false)
  })

  it('WIRING: removeWorktree повторяет транзиентный remove (2 отказа → 3-й успех → true, ровно 3 вызова)', () => {
    // Доказывает, что retry подключён именно в removeWorktree, а не только в pure retryTransient:
    // без retry-обёртки был бы ОДИН вызов remove и false. Пока remove падает, успешный git list
    // показывает worktree зарегистрированным — isGone НЕ завершает тест раньше времени.
    gitMock.failRemove = false
    gitMock.failRemoveTimes = 2
    gitMock.listResult = `worktree ${FAKE_WT}\nHEAD 0123456789abcdef0123456789abcdef01234567\ndetached\n`
    expect(removeWorktree(FAKE_REPO, FAKE_WT)).toBe(true)
    expect(gitMock.removeCalls).toBe(3)
  })

  it('cleanup НЕ удаляет verstak-wt-* внутри каталога-двойника Temp-evil-* (обход startsWith)', () => {
    // Двойник tmp: строка `${tmpdir()}-evil-…` НАЧИНАЕТСЯ с tmpdir(), но НЕ является temp-root'ом.
    // startsWith-«containment» такой parent бы снёс — настоящая проверка обязана отказать.
    const twinRoot = mkdtempSync(`${tmpdir()}-evil-`)
    const fakeParent = join(twinRoot, 'verstak-wt-fake')
    mkdirSync(fakeParent) // пустой — чтобы срабатывала именно containment-ветка гарда
    gitMock.failRemove = false // remove «успешен» (мок) → ok=true → гард решает судьбу parent
    try {
      expect(removeWorktree(FAKE_REPO, join(fakeParent, 'wt'))).toBe(true)
      expect(existsSync(fakeParent)).toBe(true) // НЕ снесён
    } finally {
      rmDirRobust(twinRoot) // двойника убираем сами
    }
  })

  it('непустой настоящий temp-parent после успешного remove НЕ удаляется (marker остаётся)', () => {
    const parent = mkdtempSync(join(tmpdir(), 'verstak-wt-'))
    writeFileSync(join(parent, 'marker.txt'), 'keep')
    gitMock.failRemove = false
    try {
      expect(removeWorktree(FAKE_REPO, join(parent, 'wt'))).toBe(true)
      expect(existsSync(join(parent, 'marker.txt'))).toBe(true)
    } finally {
      rmDirRobust(parent)
    }
  })

  it('пустой настоящий temp-parent после успешного remove удаляется (штатный cleanup не сломан)', () => {
    const parent = mkdtempSync(join(tmpdir(), 'verstak-wt-'))
    gitMock.failRemove = false
    expect(removeWorktree(FAKE_REPO, join(parent, 'wt'))).toBe(true)
    expect(existsSync(parent)).toBe(false)
  })

  it('junction-гард: verstak-wt-* = junction во внешний каталог → cleanup НЕ сносит ни ссылку, ни цель', (ctx) => {
    // Блокер R2: cleanup обязан проверять lstat (junction/symlink — НЕ настоящий каталог) и
    // удалять только атомарным rmdirSync. Рекурсивный rm по ссылке мог бы задеть чужое
    // содержимое; даже безопасный вариант «снести саму ссылку» недопустим — мы её не создавали.
    const outside = mkdtempSync(join(tmpdir(), 'wt-outside-')) // внешний ПУСТОЙ каталог (цель)
    const linkPath = join(tmpdir(), `verstak-wt-junction-${process.pid}`)
    let linkCreated = false
    try {
      try {
        symlinkSync(outside, linkPath, 'junction') // Windows: junction без прав администратора
        linkCreated = true
      } catch (e) {
        // Среда объективно не даёт создать link — ЯВНЫЙ skip с причиной, а не ложный PASS.
        ctx.skip(`junction недоступен в этой среде: ${e instanceof Error ? e.message : String(e)}`)
        return
      }
      gitMock.failRemove = false // remove «успешен» (мок) → ok=true → гард решает судьбу parent
      expect(removeWorktree(FAKE_REPO, join(linkPath, 'wt'))).toBe(true)
      expect(existsSync(linkPath)).toBe(true)  // ссылка НЕ удалена
      expect(existsSync(outside)).toBe(true)   // внешний каталог цел
    } finally {
      if (linkCreated) { try { rmdirSync(linkPath) } catch { /* best-effort */ } }
      try { rmDirRobust(outside) } catch { /* best-effort */ }
    }
  })
})
