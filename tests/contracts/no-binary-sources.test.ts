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

function nulOffenders(): string[] {
  const bad: string[] = []
  for (const rel of trackedSources()) {
    let buf: Buffer
    try { buf = readFileSync(join(ROOT, rel)) } catch { continue } // удалён/симлинк — не наше дело
    if (buf.indexOf(0) >= 0) bad.push(rel.replace(/\\/g, '/'))
  }
  return bad
}

describe('исходники не должны быть «бинарными» (инцидент 2.0.8-F)', () => {
  it('никакой НОВЫЙ исходник не содержит NUL-байтов (кроме задокументированного baseline)', () => {
    const fresh = nulOffenders().filter(f => !BASELINE.has(f))
    // NUL в исходнике = git считает файл бинарным = диф не читается, grep слепнет.
    expect(fresh).toEqual([])
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
