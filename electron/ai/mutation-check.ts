/**
 * C2 (P6, пакет 2.5.0): проверка, что тест не декоративный — мутация фикса.
 *
 * Зелёный тест доказательством не является: он зелен и тогда, когда ничего не
 * стережёт (§3.1). Правило «мутация фикса», которое до сих пор выполнял человек
 * руками, здесь исполняет рантайм: фикс временно «откатывается» и тест обязан
 * покраснеть. Не покраснел → тест декоративный.
 *
 * ТРИ ОГРАНИЧЕНИЯ, ОНИ ГЛАВНЕЕ ФИЧИ (постановка 10.08):
 *
 * 1. ИЗОЛЯЦИЯ. Откат НИКОГДА не трогает рабочее дерево — он происходит в
 *    отдельном git worktree на HEAD (инциденты 04.08: чужая сессия в общем
 *    дереве). Тест переносится в копию из рабочего дерева, фикс — нет: копия
 *    и есть «мир без фикса». Отсюда граница: ФИКС ОБЯЗАН БЫТЬ НЕЗАКОММИЧЕННЫМ
 *    (сравниваем с HEAD; закоммиченный фикс в копии уже есть, и проверка
 *    честно сообщает об этом невозможностью красного).
 *
 * 2. ГРАНИЦА ПРИМЕНИМОСТИ. Узкий прогон ОДНОГО файла мерит НЕ ТО, что полный
 *    набор: ни контеншн, ни соседние файлы, ни полноту сбора (§3.1, эталон).
 *    Вердикт «real» значит ровно «этот тест краснеет без этого фикса» — и
 *    ничего больше. scope: 'narrow' в результате — не украшение, а честная
 *    метка границы.
 *
 * 3. ЦЕНА. Второй прогон тестов стоит времени: budget (timeoutMs) обязателен,
 *    его исчерпание — 'error' без вердикта (таймаут не «декоративный»!), а
 *    выключатель mutation_check_enabled отключает механизм целиком.
 */
import { spawn, execFileSync } from 'child_process'
import { mkdtempSync, rmSync, mkdirSync, existsSync, copyFileSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname, isAbsolute } from 'path'

export const MUTATION_CHECK_DEFAULT_TIMEOUT_MS = 120_000
export const MUTATION_CHECK_MAX_TIMEOUT_MS = 300_000

export interface MutationCheckRunner {
  (opts: { cwd: string; testFile: string; timeoutMs: number }): Promise<{
    exitCode: number | null
    timedOut: boolean
    output: string
  }>
}

export interface MutationCheckOptions {
  projectRoot: string
  /** Repo-relative путь теста. Берётся из РАБОЧЕГО дерева и переносится в копию. */
  testFile: string
  /** Бюджет одного прогона; исчерпан → 'error', не вердикт. */
  timeoutMs?: number
  /** Выключатель (mutation_check_enabled). false → 'skipped' без каких-либо действий. */
  enabled?: boolean
  /** Шов исполнителя тестов — по умолчанию vitest run <file> в копии. */
  runner?: MutationCheckRunner
}

export type MutationCheckResult =
  | { verdict: 'real'; reason: string; scope: 'narrow' }
  | { verdict: 'decorative'; reason: string; scope: 'narrow' }
  | { verdict: 'skipped'; reason: string }
  | { verdict: 'error'; reason: string }

/** Дефолтный исполнитель: vitest run одного файла в указанном каталоге. */
export const vitestRunner: MutationCheckRunner = ({ cwd, testFile, timeoutMs }) =>
  new Promise(resolvePromise => {
    // shell на Windows: npx — .cmd, без shell spawn его не находит.
    const child = spawn('npx vitest run ' + JSON.stringify(testFile), {
      cwd, shell: true, windowsHide: true, env: { ...process.env, CI: '1' }
    })
    let output = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill() } catch { /* уже мёртв */ }
    }, timeoutMs)
    child.stdout?.on('data', (d: Buffer) => { output += d.toString() })
    child.stderr?.on('data', (d: Buffer) => { output += d.toString() })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({ exitCode: code, timedOut, output: output.slice(-4000) })
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolvePromise({ exitCode: null, timedOut, output: String(err) })
    })
  })

/**
 * Прогнать мутацию фикса: тест из рабочего дерева против кода HEAD в изолированном
 * worktree. Красный → тест настоящий; зелёный → декоративный.
 */
export async function runMutationCheck(opts: MutationCheckOptions): Promise<MutationCheckResult> {
  if (opts.enabled === false) {
    return { verdict: 'skipped', reason: 'Проверка декоративности выключена (mutation_check_enabled=false).' }
  }
  const timeoutMs = Math.min(opts.timeoutMs ?? MUTATION_CHECK_DEFAULT_TIMEOUT_MS, MUTATION_CHECK_MAX_TIMEOUT_MS)
  if (isAbsolute(opts.testFile) || opts.testFile.includes('..')) {
    return { verdict: 'error', reason: 'testFile должен быть относительным путём внутри проекта.' }
  }
  const srcTest = join(opts.projectRoot, opts.testFile)
  if (!existsSync(srcTest)) {
    return { verdict: 'error', reason: `Тест не найден в рабочем дереве: ${opts.testFile}` }
  }

  let tempRoot: string | null = null
  let worktreeAdded = false
  try {
    tempRoot = mkdtempSync(join(tmpdir(), 'verstak-mutation-'))
    const wt = join(tempRoot, 'wt')
    // Изоляция: копия НА HEAD — «мир без незакоммиченного фикса». Рабочее дерево
    // не трогается ни на байт.
    execFileSync('git', ['-C', opts.projectRoot, 'worktree', 'add', '--detach', wt, 'HEAD'], { stdio: 'pipe' })
    worktreeAdded = true
    // node_modules общий (junction): ставить зависимости в копию — минуты, ссылка — мгновенно.
    const nm = join(opts.projectRoot, 'node_modules')
    if (existsSync(nm) && !existsSync(join(wt, 'node_modules'))) {
      symlinkSync(nm, join(wt, 'node_modules'), 'junction')
    }
    // Тест — из РАБОЧЕГО дерева (он часть правки), фикс — нет.
    const dstTest = join(wt, opts.testFile)
    mkdirSync(dirname(dstTest), { recursive: true })
    copyFileSync(srcTest, dstTest)

    const runner = opts.runner ?? vitestRunner
    const run = await runner({ cwd: wt, testFile: opts.testFile, timeoutMs })
    if (run.timedOut) {
      return { verdict: 'error', reason: `Бюджет проверки (${timeoutMs} мс) исчерпан — вердикта нет: таймаут не отличает настоящий тест от декоративного.` }
    }
    if (run.exitCode === null) {
      return { verdict: 'error', reason: `Прогон теста не запустился: ${run.output.slice(0, 300)}` }
    }
    if (run.exitCode !== 0) {
      return {
        verdict: 'real',
        reason: 'Тест КРАСНЕЕТ на коде без фикса — он действительно стережёт правку. Граница: узкий прогон одного файла, полный набор этим не измерен.',
        scope: 'narrow'
      }
    }
    return {
      verdict: 'decorative',
      reason: 'Тест ЗЕЛЁНЫЙ на коде без фикса — он не ловит дефект, который заявлен починенным. Либо тест декоративный, либо фикс уже закоммичен (проверка сравнивает с HEAD).',
      scope: 'narrow'
    }
  } catch (err) {
    return { verdict: 'error', reason: err instanceof Error ? err.message : String(err) }
  } finally {
    if (worktreeAdded && tempRoot) {
      try { execFileSync('git', ['-C', opts.projectRoot, 'worktree', 'remove', '--force', join(tempRoot, 'wt')], { stdio: 'pipe' }) } catch { /* prune ниже */ }
      try { execFileSync('git', ['-C', opts.projectRoot, 'worktree', 'prune'], { stdio: 'pipe' }) } catch { /* best-effort */ }
    }
    if (tempRoot) { try { rmSync(tempRoot, { recursive: true, force: true }) } catch { /* temp */ } }
  }
}
