import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * Страж «исходники — это текст». Повод (инцидент 2.0.8-F): в agent-run-usage.ts случайно
 * попали NUL-байты как разделители ключа группировки. Код РАБОТАЛ, тесты были зелёные, но:
 *  · git начинает считать файл БИНАРНЫМ → `git diff` отдаёт «Binary files differ» вместо кода
 *    (ревью на GitHub и адверсариальное ревью буквально СЛЕПНУТ на этом файле — так и вышло);
 *  · ripgrep/grep молча пропускают такой файл → поиск по коду врёт «не найдено».
 * Дефект невидим для type-check и обычных тестов — ловим отдельно.
 *
 * BASELINE исторически держал два файла, использовавших NUL ОСОЗНАННО — как разделитель
 * составного ключа поверх ПРОИЗВОЛЬНОГО содержимого (обычный символ вроде '|' реально
 * мог бы встретиться и склеить ключи): memory-hooks.ts (seed дедупа) и yandex-gpt.ts
 * (dedupKey tool-calls). ЗАКРЫТ (Фаза 3.1, FIX-PLAN-2026-07-24): NUL заменён на escaped
 * unit separator (`\u001F` в исходнике) — та же защита от коллизий, но файлы текстовые
 * для git/grep. BASELINE пуст и должен остаться пустым: новые добавлять НЕЛЬЗЯ — чинить.
 */

const ROOT = join(__dirname, '..', '..')

/** Известные нарушители. ПУСТО — все починены (Фаза 3.1, FIX-PLAN-2026-07-24). Новые сюда добавлять НЕЛЬЗЯ — чинить. */
const BASELINE = new Set<string>([])

// Скан ВСЕГО дерева (git ls-files + чтение каждого исходника) под нагрузкой шёл дольше
// глобального 20-секундного testTimeout → падал БЕЗЫМЯННЫМ таймаутом «Test timed out in
// 20000ms», неотличимым от регрессии кода (аудит 09.08, класс «тест зависит от живой
// машины»). Лечение по регламенту: таймаут теста заметно БОЛЬШЕ глобального (нормальный
// скан под нагрузкой доходит), а ВНУТРЕННИЙ бюджет — заметно МЕНЬШЕ таймаута теста: на
// патологически медленной машине падаем ОСМЫСЛЕННОЙ ошибкой (сколько прочитано, что это
// нагрузка, а не код) РАНЬШЕ, чем сработает безымянный таймаут прогона.
const SCAN_BUDGET_MS = 45_000
const SCAN_TEST_TIMEOUT_MS = 90_000

/** Только версионируемые исходники — генерённое/бинарное (иконки, out/) не наше дело. */
function trackedSources(): string[] {
  // Под pre-commit хуком git выставляет GIT_DIR/GIT_INDEX_FILE; в linked worktree путь
  // абсолютный → ls-files отвечал бы про чужой контекст. Конвенция: git-worktree.ts:27.
  const env = { ...process.env }
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR', 'GIT_PREFIX', 'GIT_NAMESPACE', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[k]
  const out = execFileSync('git', ['ls-files', '-z', '*.ts', '*.tsx', '*.mjs', '*.cjs', '*.json', '*.css', '*.md'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env,
  })
  return out.split('\0').filter(Boolean)
}

/**
 * Чистое ядро скана с ВНУТРЕННИМ бюджетом. files + reader + now инъектируются, чтобы
 * контрольный кейс мог детерминированно спровоцировать превышение (без реального
 * замедления диска). Превышение бюджета → ОСМЫСЛЕННАЯ ошибка, а не безымянный таймаут.
 */
export function scanForNul(
  files: string[],
  readBuf: (rel: string) => Buffer | null,
  opts: { budgetMs: number; now?: () => number },
): string[] {
  const now = opts.now ?? (() => Date.now())
  const started = now()
  const bad: string[] = []
  for (let i = 0; i < files.length; i++) {
    // Проверяем не на каждом файле (дёшево), но достаточно часто.
    if ((i & 63) === 0 && now() - started > opts.budgetMs) {
      throw new Error(
        `no-binary-sources: скан не уложился в бюджет ${opts.budgetMs}мс ` +
        `(прочитано ${i}/${files.length}) — машина под нагрузкой, это НЕ регрессия кода. ` +
        `Перезапусти на тихой машине / с меньшим параллелизмом.`,
      )
    }
    const buf = readBuf(files[i])
    if (buf && buf.indexOf(0) >= 0) bad.push(files[i].replace(/\\/g, '/'))
  }
  return bad
}

function nulOffenders(budgetMs = SCAN_BUDGET_MS): string[] {
  return scanForNul(
    trackedSources(),
    (rel) => { try { return readFileSync(join(ROOT, rel)) } catch { return null } }, // удалён/симлинк — не наше дело
    { budgetMs },
  )
}

describe('исходники не должны быть «бинарными» (инцидент 2.0.8-F)', () => {
  it('никакой НОВЫЙ исходник не содержит NUL-байтов (кроме задокументированного baseline)', () => {
    const fresh = nulOffenders().filter(f => !BASELINE.has(f))
    // NUL в исходнике = git считает файл бинарным = диф не читается, grep слепнет.
    expect(fresh).toEqual([])
  }, SCAN_TEST_TIMEOUT_MS)

  // КОНТРОЛЬ (штаб): при медленном скане падаем ОСМЫСЛЕННОЙ ошибкой, а не безымянным
  // таймаутом. Инъектируем now, перепрыгивающий бюджет — детерминированно, без реального
  // замедления. Зеркало к пину выше: доказывает, что бюджет РЕАЛЬНО срабатывает.
  it('превышение внутреннего бюджета → осмысленная ошибка (не безымянный таймаут)', () => {
    // Бюджет проверяется каждые 64 файла — берём список длиннее, чтобы дойти до проверки.
    const many = Array.from({ length: 70 }, (_, i) => `f${i}.ts`)
    let t = 1000
    const now = () => t
    expect(() => scanForNul(
      many,
      () => { t += 1_000; return Buffer.from('чистый текст') }, // каждый файл «съедает» 1с виртуально
      { budgetMs: 5_000, now },
    )).toThrow(/бюджет.*нагрузк|нагрузк.*бюджет|не уложился в бюджет/i)
  })

  it('КОНТРОЛЬ: в рамках бюджета скан отрабатывает и находит NUL', () => {
    const bad = scanForNul(
      ['clean.ts', 'dirty.ts'],
      (rel) => Buffer.from(rel === 'dirty.ts' ? 'a\0b' : 'чисто'),
      { budgetMs: 60_000, now: () => 0 }, // время не движется — бюджет не при чём
    )
    expect(bad).toEqual(['dirty.ts'])
  })

  it('baseline не «протух»: перечисленные файлы всё ещё существуют и всё ещё с NUL', () => {
    // Если файл починили/удалили — надо убрать его из BASELINE, иначе страж тихо ослабнет.
    //
    // РАБОТА УБРАНА, А НЕ БЮДЖЕТ ПОДНЯТ (29.07, блокировал релиз 2.2.21). Обход
    // ВСЕГО дерева (`git ls-files` + чтение каждого исходника) стоит секунды и
    // под полным параллельным прогоном упирался в 20-секундный таймаут. При этом
    // при ПУСТОМ baseline его результат на утверждение не влияет ВООБЩЕ:
    // `[...BASELINE].filter(...)` от пустого множества — всегда `[]`, чем бы ни
    // оказался `current`. То есть тест тратил секунды на данные, которые сам же
    // и не использовал. Считаем их только когда baseline непуст — тогда обход
    // возвращается вместе со смыслом, а пин не ослабевает ни на йоту.
    const current = BASELINE.size > 0 ? new Set(nulOffenders()) : new Set<string>()
    const stale = [...BASELINE].filter(f => !current.has(f))
    expect(stale).toEqual([])
  })
})
