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
 * BASELINE (деферрал, НЕ фикс — файлы вне allowlist среза 2.0.8-F, см. suppression ledger):
 * два файла используют NUL ОСОЗНАННО — как разделитель составного ключа поверх ПРОИЗВОЛЬНОГО
 * содержимого (там обычный символ вроде '|' реально мог бы встретиться и склеить ключи):
 *   · electron/ai/memory-hooks.ts — `${projectPath}\0${content}`
 *   · electron/ai/yandex-gpt.ts   — `${tc.name}\0${JSON.stringify(...)}`
 * Их правильный фикс — заменить NUL на  (unit separator): та же защита от коллизий,
 * но файл остаётся текстовым для git/grep. Сделать в отдельном срезе (аудит 2.0.10-G).
 * Здесь они внесены ПОИМЁННО, чтобы страж ловил ЛЮБОГО НОВОГО нарушителя, а не молчал.
 */

const ROOT = join(__dirname, '..', '..')

/** Известные нарушители на момент введения стража. Новые сюда добавлять НЕЛЬЗЯ — чинить. */
const BASELINE = new Set([
  'electron/ai/memory-hooks.ts',
  'electron/ai/yandex-gpt.ts',
])

/** Только версионируемые исходники — генерённое/бинарное (иконки, out/) не наше дело. */
function trackedSources(): string[] {
  const out = execFileSync('git', ['ls-files', '-z', '*.ts', '*.tsx', '*.mjs', '*.cjs', '*.json', '*.css', '*.md'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
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
    const current = new Set(nulOffenders())
    const stale = [...BASELINE].filter(f => !current.has(f))
    expect(stale).toEqual([])
  })
})
