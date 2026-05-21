/**
 * Agent bench — десять «эталонных» проверок что наши агентские слои собраны
 * правильно. Не запускают реальную модель: проверяют ДЕТЕРМИНИРОВАННЫЕ
 * компоненты (context-pack, apply_patch, project-map, secret-scanner,
 * command-policy, tools.execute), которые легко сломать рефакторингом.
 *
 * Если все 10 проходят — значит «фундамент агента» не сломан с прошлой
 * недели. Качество ответов модели тестируется отдельно вручную.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { applySearchReplaceBlocks } from '../../electron/ai/tools'
import { buildContextPack } from '../../electron/ai/context-pack'
import { buildProjectMap, projectMapToText } from '../../electron/ai/project-map'
import { scanText, isForbiddenPath } from '../../electron/ai/secret-scanner'
import { classifyCommand } from '../../electron/ai/command-policy'
import { safeJoin, safeRealJoin } from '../../electron/ai/path-policy'

describe('agent-bench: 10 эталонных регрессий', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gg-bench-'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'fixture', scripts: { test: 'vitest', 'type-check': 'tsc --noEmit' }
    }))
    writeFileSync(join(dir, 'tsconfig.json'), '{}')
    writeFileSync(join(dir, 'src', 'foo.ts'), `export function hello() { return 'world' }
export const Widget = () => null
`)
    writeFileSync(join(dir, '.env'), 'SECRET_KEY=sk-proj-abcdefghijklmnopqrstuvwx\n')
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  // 1. apply_patch: single-block edit
  it('[1] apply_patch применяет один блок', () => {
    const before = `function f() {\n  return 1\n}\n`
    const diff = `<<<<<<< SEARCH\n  return 1\n=======\n  return 42\n>>>>>>> REPLACE`
    expect(applySearchReplaceBlocks(before, diff)).toContain('return 42')
  })

  // 2. apply_patch: ambiguous SEARCH rejected
  it('[2] apply_patch отказывает на неоднозначном SEARCH', () => {
    expect(() => applySearchReplaceBlocks('x\nx\n', '<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE'))
      .toThrow(/несколько раз/)
  })

  // 3. context-pack: package.json scripts surface as verify_scripts
  it('[3] context-pack видит verify_scripts из package.json', async () => {
    const pack = await buildContextPack({ projectPath: dir, recentWrites: [] })
    expect(pack).toContain('verify_scripts')
    expect(pack).toContain('npm test')
  })

  // 4. context-pack: recent_writes пробрасывается
  it('[4] context-pack включает recent_writes', async () => {
    const pack = await buildContextPack({
      projectPath: dir,
      recentWrites: [{ filePath: 'src/foo.ts', createdAt: Date.now() }]
    })
    expect(pack).toContain('recent_writes')
    expect(pack).toContain('src/foo.ts')
  })

  // 5. project-map: top-level symbols корректно
  it('[5] project-map извлекает экспорты', async () => {
    const map = await buildProjectMap(dir)
    const foo = map.files.find(f => f.path === 'src/foo.ts')
    expect(foo).toBeTruthy()
    const names = foo!.symbols.map(s => s.name).sort()
    expect(names).toEqual(['Widget', 'hello'])
  })

  // 6. project-map: compact text output не пустой
  it('[6] project-map в text формате содержит pаздел src/', async () => {
    const map = await buildProjectMap(dir)
    const text = projectMapToText(map)
    expect(text).toMatch(/src\//)
    expect(text).toContain('foo.ts')
  })

  // 7. secret-scanner: путь .env заблокирован
  it('[7] secret-scanner блокирует .env', () => {
    expect(isForbiddenPath('.env')).toBe(true)
    expect(isForbiddenPath('apps/.env.local')).toBe(true)
  })

  // 8. secret-scanner: OpenAI ключ редактируется
  it('[8] secret-scanner редактирует OpenAI sk-* ключ', () => {
    const { redacted, hits } = scanText('OPENAI_API_KEY=sk-proj-abc123def456ghi789jklmno')
    expect(redacted).toContain('[REDACTED:openai-key]')
    expect(hits).toContain('openai-key')
  })

  // 9. command-policy: rm -rf / заблокирован
  it('[9] command-policy блокирует rm -rf /', () => {
    expect(classifyCommand('rm -rf /').allowed).toBe(false)
    expect(classifyCommand('rm -r -f ~').allowed).toBe(false)
  })

  // 10. command-policy: PowerShell EncodedCommand bypass заблокирован
  it('[10] command-policy блокирует powershell -EncodedCommand', () => {
    expect(classifyCommand('powershell -EncodedCommand UABzAA==').allowed).toBe(false)
    expect(classifyCommand('powershell.exe -e abc').allowed).toBe(false)
  })

  // 11. context-pack: product_stack узнаёт electron + react + vite по package.json
  it('[11] context-pack определяет stack из package.json (electron+react)', async () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'geminigrok',
      dependencies: { electron: '^32', react: '^19', vite: '^7', 'better-sqlite3': '^11' }
    }))
    const pack = await buildContextPack({ projectPath: dir, recentWrites: [] })
    expect(pack).toContain('product_stack:')
    expect(pack).toMatch(/electron/)
    expect(pack).toMatch(/react/)
    expect(pack).toMatch(/geminigrok/)
  })

  // 13. path-policy: safeJoin блокирует ../ traversal
  it('[13] path-policy: safeJoin режет .. traversal', () => {
    expect(() => safeJoin(dir, '../../etc/passwd')).toThrow(/Запрещён выход/)
    expect(() => safeJoin(dir, '..')).toThrow(/Запрещён выход/)
  })

  // 14. path-policy: safeRealJoin совпадает с safeJoin для нормальных путей
  it('[14] path-policy: safeRealJoin пропускает нормальные пути внутри root', async () => {
    writeFileSync(join(dir, 'normal.ts'), 'export const x = 1')
    const abs = await safeRealJoin(dir, 'normal.ts')
    expect(abs.endsWith('normal.ts')).toBe(true)
  })

  // 12. context-pack: product_stack для Python проекта по requirements.txt
  it('[12] context-pack определяет stack из requirements.txt (fastapi)', async () => {
    // Fixture creates package.json in beforeEach — remove it so we hit the
    // Python fallback path of detectProductStack.
    rmSync(join(dir, 'package.json'))
    writeFileSync(join(dir, 'requirements.txt'), 'fastapi==0.110\nuvicorn==0.27\n')
    const pack = await buildContextPack({ projectPath: dir, recentWrites: [] })
    expect(pack).toContain('product_stack:')
    expect(pack).toMatch(/python/)
    expect(pack).toMatch(/fastapi/)
  })
})
