import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { buildContextPack } from '../../electron/ai/context-pack'
import { invalidateProjectMap, invalidateDependencyMap, warmProjectMaps } from '../../electron/ai/project-map'

/**
 * Проверяем обогащение context-pack фичей «Карта проекта»:
 *   - в блок инжектятся dependency_hubs (самые импортируемые файлы);
 *   - для хабов добавляются ключевые символы (hub_symbols).
 * Граф зависимостей строится из реальных файлов во временной папке.
 *
 * ФИКСТУРА ПРАВЛЕНА 11.08 (V2 ось A), утверждения НЕ тронуты — объявляю по §3.1.
 * Раньше эти кейсы полагались на то, что buildContextPack сам построит карту и
 * граф синхронно. С переводом контекста push→pull сборка контекста больше ничего
 * не ждёт: карта попадает в пакет, только если кэш прогрет. Поэтому фикстура
 * теперь греет карты явно (warmProjectMaps) — ровно то, что в проде делает
 * открытие проекта. Проверяемое свойство прежнее: прогретый граф даёт хабы и
 * символы, проект без связей их не даёт.
 */
describe('context-pack dependency enrichment', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gg-cpdep-')) })
  afterEach(() => {
    invalidateProjectMap(dir)
    invalidateDependencyMap(dir)
    rmSync(dir, { recursive: true, force: true })
  })

  it('инжектит dependency_hubs и символы хаба в context_pack', async () => {
    mkdirSync(join(dir, 'src'), { recursive: true })
    // utils.ts — хаб: его импортируют три потребителя.
    writeFileSync(join(dir, 'src', 'utils.ts'), `
export function helper() { return 1 }
export class Engine {}
`)
    writeFileSync(join(dir, 'src', 'a.ts'), `import { helper } from './utils'\nexport const a = helper()`)
    writeFileSync(join(dir, 'src', 'b.ts'), `import { helper } from './utils'\nexport const b = helper()`)
    writeFileSync(join(dir, 'src', 'c.ts'), `import { Engine } from './utils'\nexport const c = new Engine()`)

    await warmProjectMaps(dir)
    const pack = await buildContextPack({ projectPath: dir })

    // Хаб-секция присутствует и указывает на utils.ts с числом импортов.
    expect(pack).toContain('dependency_hubs')
    expect(pack).toContain('src/utils.ts')
    // Символы хаба прокинуты (functions/classes из project map).
    expect(pack).toContain('hub_symbols')
    expect(pack).toMatch(/helper|Engine/)
  })

  it('не падает на проекте без межфайловых связей', async () => {
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'lonely.ts'), 'export const x = 1')
    await warmProjectMaps(dir)
    const pack = await buildContextPack({ projectPath: dir })
    // Карта есть, но dependency_hubs отсутствуют (нет importedBy) — секция не добавляется.
    expect(pack).toContain('project_map')
    expect(pack).not.toContain('dependency_hubs')
  })

  it('warmProjectMaps идемпотентен: повторный вызов не падает и кэш тёплый', async () => {
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'm.ts'), `import { helper } from './u'\nexport const m = helper()`)
    writeFileSync(join(dir, 'src', 'u.ts'), 'export function helper() { return 2 }')
    // Параллельные warm'ы делят один промис, оба резолвятся без ошибок.
    await Promise.all([warmProjectMaps(dir), warmProjectMaps(dir)])
    await warmProjectMaps(dir)
    const pack = await buildContextPack({ projectPath: dir })
    expect(pack).toContain('src/u.ts')
  })
})
