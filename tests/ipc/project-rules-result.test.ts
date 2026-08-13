// C2 (13.08): итог draft_project_rules называет НАЙДЕННОЕ, а не только отсутствующее.
//
// Живой случай 12.08: DeepSeek написал в чат «не найдено: build, lint, typecheck»,
// хотя все четыре команды в проекте есть и попали в черновик. Разбор показал, что
// врал не файл: итог инструмента перечислял ТОЛЬКО отсутствующее, а когда не
// отсутствует ничего — молчал о командах вовсе. Модель черновика не видит (он
// уходит в файл, не в tool_result), и на месте пробела досочиняла — с обратным
// знаком. Бедный результат, а не враньё модели: единственное, что было сказано о
// командах, — форма «не найдено».
//
// Пины: найденное названо; отсутствующее по-прежнему названо; «всё нашлось» не
// оставляет пустого места, куда можно досочинить.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { draftProjectRulesHandler } from '../../electron/ipc/tool-handlers/project-rules'
import type { ToolContext } from '../../electron/ipc/tool-handlers/shared'
import type { ToolCall } from '../../electron/ai/types'

// bypass — чтобы сетка мерила ТЕКСТ ИТОГА, а не показ diff (это C1 и своя сетка).
function harness(dir: string): ToolContext {
  return {
    runId: 'run-c2',
    projectPath: dir,
    sendId: 't',
    agentMode: 'bypass',
    signal: new AbortController().signal,
    sender: { send: () => {} },
    pendingWrites: new Map(),
    scopedKey: (s: unknown, c: unknown) => `${s}:${c}`,
    recordWrite: () => {},
    recordRunEvent: () => {},
    tools: { execute: async () => 'ok' },
  } as unknown as ToolContext
}

const rulesCall = (): ToolCall => ({ id: '1', name: 'draft_project_rules', args: {} })
const writePkg = (dir: string, scripts: Record<string, string>) =>
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo', scripts }), 'utf8')

let dir = ''
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'verstak-c2-rules-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('C2: итог инструмента называет найденные команды', () => {
  it('ПИН: все четыре команды есть → итог их перечисляет', async () => {
    writePkg(dir, { test: 'vitest run', build: 'vite build', 'lint:full': 'eslint .', type: 'tsc --noEmit' })

    const res = await draftProjectRulesHandler.handle(rulesCall(), harness(dir))

    expect(res.error).toBeFalsy()
    expect(res.result, 'о командах в итоге не сказано ничего — модели нечем ответить, кроме догадки').toContain('npm run build')
    expect(res.result).toContain('npm run lint:full')
    expect(res.result).toContain('npm run type')
    expect(res.result).toContain('npm test')
  })

  it('ПИН: всё нашлось → сказано ЯВНО, что не найденного нет', async () => {
    writePkg(dir, { test: 'vitest run', build: 'vite build', 'lint:full': 'eslint .', type: 'tsc --noEmit' })

    const res = await draftProjectRulesHandler.handle(rulesCall(), harness(dir))

    expect(res.result, 'молчание об отсутствующем читается как «ничего не найдено»').toMatch(/не найденных команд нет/i)
  })

  it('ЗЕРКАЛО: часть команд отсутствует → и найденное, и отсутствующее названы', async () => {
    writePkg(dir, { build: 'vite build' })

    const res = await draftProjectRulesHandler.handle(rulesCall(), harness(dir))

    expect(res.result).toContain('npm run build')
    expect(res.result).toContain('Не найдено')
    expect(res.result).toMatch(/test|Тесты/)
  })

  it('КОНТРОЛЬ: команд нет вовсе → итог не выдумывает найденных', async () => {
    writePkg(dir, {})

    const res = await draftProjectRulesHandler.handle(rulesCall(), harness(dir))

    expect(res.result).not.toContain('npm run')
    expect(res.result).toContain('Не найдено')
  })
})
