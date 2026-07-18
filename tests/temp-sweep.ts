import { readdirSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { rmDirRobust } from '../electron/ai/git-worktree'

/**
 * Глобальная чистка test-temp-каталогов из %TEMP%.
 *
 * ЗАЧЕМ (инцидент 18.07, память verstak-worktree-test-eperm-flake): каждый worktree/proc-тест
 * создаёт temp-дерево через mkdtempSync; провалившаяся очистка (EPERM под антивирусом на Windows)
 * оставляет каталог. За сессию накопилось **10 051** `verstak-*` каталог → антивирус сканирует их
 * → любая temp-операция дико медленная → эскалация EPERM (гейт флейкает под любой нагрузкой).
 * Свип в globalSetup (старт: старые leftover прошлых/убитых прогонов; teardown: свои) держит
 * %TEMP% чистым и разрывает петлю накопления.
 */
const TEST_TMP_PREFIXES = ['verstak-', 'gg-']

export interface SweepOptions {
  /** Корень поиска (по умолчанию os.tmpdir()). Параметризован ради собственного теста —
   *  чтобы свип бил по изолированной базе, а не по реальному %TEMP% с каталогами
   *  параллельных тестов. */
  base?: string
  /** Только каталоги СТАРШЕ этого возраста (мс). Для безопасного старт-свипа: не трогаем
   *  свежие каталоги активного параллельного прогона, убираем лишь протухшие leftover. */
  olderThanMs?: number
}

export function sweepTestTempDirs(opts: SweepOptions = {}): { removed: number } {
  const base = opts.base ?? tmpdir()
  const now = Date.now()
  let removed = 0
  let names: string[]
  try { names = readdirSync(base) } catch { return { removed } }
  for (const name of names) {
    if (!TEST_TMP_PREFIXES.some(p => name.startsWith(p))) continue
    const full = join(base, name)
    let st
    try { st = statSync(full) } catch { continue }
    if (!st.isDirectory()) continue
    if (opts.olderThanMs != null && now - st.mtimeMs < opts.olderThanMs) continue
    try { rmDirRobust(full); removed++ } catch { /* держится антивирусом — best-effort */ }
  }
  return { removed }
}
