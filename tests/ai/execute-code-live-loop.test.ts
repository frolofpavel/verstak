// execute_code (PTC): живая петля на НАСТОЯЩЕМ проекте + STRICT-проверка периметра.
//
// Позиция 3 плана 2026-07-27 требует доказательства, а не мнения: инструмент либо
// валидирован и включается, либо снимается. Существующие сетки (tests/ai/ptc.test.ts,
// tests/ai/execute-code-handler.test.ts) проверяют движок и хендлер на МОКАХ тулзов.
// Здесь закрыт оставшийся кусок, который на моках не проверить:
//
//   1) петля собирается целиком на РЕАЛЬНЫХ read-only тулзах (`createFileTools`) и
//      бежит по РЕАЛЬНОМУ дереву файлов — скрипт агента читает несколько файлов,
//      агрегирует и возвращает только итог;
//   2) измеряется то, ради чего PTC и строился: сколько контекста экономит
//      агрегация против «каждый результат тулзы отдельным сообщением»;
//   3) STRICT-периметр: внутри песочницы доступны РОВНО read-only тулзы, ни одной
//      пишущей или командной; права execute_code совпадают с run_command во ВСЕХ
//      режимах агента — молча шире они стать не могут.
//
// Чего здесь НЕТ и почему: живого прогона, где модель САМА решает вызвать
// execute_code. Для него нужен авторизованный провайдер, которого в окружении
// исполнителя нет (та же причина, что в разведке CLI-сессий 27.07).
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runPtcCode, PTC_READONLY_TOOLS } from '../../electron/ai/ptc'
import { createFileTools } from '../../electron/ai/tools'
import { decide } from '../../electron/ai/mode-policy'
import type { AgentMode } from '../../electron/ai/mode-policy'

/** Обёртка тулзов ровно та же, что строит executeCodeHandler. */
function ptcToolsOver(root: string) {
  const fileTools = createFileTools(root)
  const tools: Record<string, (args: Record<string, unknown>) => Promise<string>> = {}
  for (const name of PTC_READONLY_TOOLS) {
    tools[name] = async (args) => {
      const r = await fileTools.execute(name, args ?? {})
      return typeof r === 'string' ? r : JSON.stringify(r)
    }
  }
  return { tools, fileTools }
}

function seedProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'gg-ptc-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  for (let i = 1; i <= 6; i++) {
    const hasTodo = i % 2 === 0
    writeFileSync(
      join(root, 'src', `mod${i}.ts`),
      [
        `// модуль ${i}`,
        'export function work' + i + '() {',
        '  '.repeat(1) + 'return ' + i,
        '}',
        hasTodo ? `// TODO: доделать модуль ${i}` : '// всё сделано',
        'x'.repeat(400), // добиваем объём, чтобы экономия контекста была измерима
      ].join('\n'),
      'utf8',
    )
  }
  return root
}

describe('execute_code: живая петля на реальных файлах', () => {
  it('скрипт читает шесть реальных файлов и возвращает только агрегат', async () => {
    const root = seedProject()
    try {
      const { tools } = ptcToolsOver(root)
      const res = await runPtcCode({
        code: `
          const todos = []
          for (let i = 1; i <= 6; i++) {
            const text = await tools.read_file({ path: 'src/mod' + i + '.ts' })
            if (text.includes('TODO')) todos.push('mod' + i)
          }
          log('файлов прочитано: 6')
          log('с TODO: ' + todos.join(', '))
        `,
        tools,
        timeoutMs: 10_000,
      })

      expect(res.error).toBeUndefined()
      expect(res.toolCalls).toBe(6)
      expect(res.output).toContain('файлов прочитано: 6')
      expect(res.output).toContain('с TODO: mod2, mod4, mod6')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('в контекст возвращается итог, а не содержимое файлов — вот и экономия', async () => {
    const root = seedProject()
    try {
      const { tools, fileTools } = ptcToolsOver(root)

      // Сколько заняли бы шесть отдельных tool-результатов классическим путём.
      let classic = 0
      for (let i = 1; i <= 6; i++) {
        const r = await fileTools.execute('read_file', { path: `src/mod${i}.ts` })
        classic += (typeof r === 'string' ? r : JSON.stringify(r)).length
      }

      const res = await runPtcCode({
        code: `
          let withTodo = 0
          for (let i = 1; i <= 6; i++) {
            const text = await tools.read_file({ path: 'src/mod' + i + '.ts' })
            if (text.includes('TODO')) withTodo++
          }
          log('модулей с TODO: ' + withTodo + ' из 6')
        `,
        tools,
        timeoutMs: 10_000,
      })

      expect(res.error).toBeUndefined()
      expect(res.output).toContain('модулей с TODO: 3 из 6')
      // Итог должен быть КРАТНО меньше суммы сырых результатов — иначе смысла в PTC нет.
      expect(res.output.length).toBeLessThan(classic / 10)
      // И содержимого файлов в контексте быть не должно вовсе.
      expect(res.output).not.toContain('export function work1')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('несуществующий файл не роняет петлю — скрипт доходит до итога', async () => {
    const root = seedProject()
    try {
      const { tools } = ptcToolsOver(root)
      const res = await runPtcCode({
        code: `
          let ok = 0, bad = 0
          for (const p of ['src/mod1.ts', 'src/нет-такого.ts', 'src/mod3.ts']) {
            try {
              const t = await tools.read_file({ path: p })
              if (t && !t.toLowerCase().includes('error')) ok++; else bad++
            } catch { bad++ }
          }
          log('прочитано: ' + ok + ', не удалось: ' + bad)
        `,
        tools,
        timeoutMs: 10_000,
      })
      expect(res.error).toBeUndefined()
      expect(res.output).toMatch(/прочитано: \d+, не удалось: \d+/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// STRICT: периметр. Исполнение кода — внешний эффект, поэтому проверяем не «оно
// работает», а «оно не может больше, чем разрешено», и что это не изменится молча.
// ─────────────────────────────────────────────────────────────────────────────
describe('execute_code: периметр не расширяется молча', () => {
  it('в песочнице ровно read-only тулзы — список зафиксирован', () => {
    expect([...PTC_READONLY_TOOLS]).toEqual([
      'read_file',
      'list_directory',
      'search_project',
      'find_files',
      'get_project_map',
    ])
  })

  it('ни одной пишущей или командной тулзы в наборе нет', () => {
    const forbidden = ['write_file', 'apply_patch', 'run_command', 'connector_query', 'execute_code', 'web_fetch', 'delegate_task']
    for (const name of forbidden) {
      expect(PTC_READONLY_TOOLS as readonly string[]).not.toContain(name)
    }
  })

  it('пишущая тулза недоступна изнутри скрипта даже по имени', async () => {
    const root = seedProject()
    try {
      const { tools } = ptcToolsOver(root)
      const res = await runPtcCode({
        code: 'log(typeof tools.write_file + "/" + typeof tools.run_command)',
        tools,
      })
      expect(res.output).toContain('undefined/undefined')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('права execute_code совпадают с run_command во ВСЕХ режимах агента', () => {
    const modes: AgentMode[] = ['ask', 'accept-edits', 'plan', 'auto', 'bypass']
    for (const mode of modes) {
      const asCode = decide('execute_code', mode)
      const asCommand = decide('run_command', mode)
      expect(asCode, `режим ${mode}: execute_code разошёлся с run_command`).toEqual(asCommand)
    }
  })

  it('в plan-режиме исполнение кода заблокировано', () => {
    expect(decide('execute_code', 'plan')).toBe('block')
  })

  it('в ask-режиме исполнение кода требует подтверждения человека', () => {
    expect(decide('execute_code', 'ask')).toBe('confirm')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Гейт по умолчанию. Пока живого прогона с моделью нет, инструмент обязан
// оставаться выключенным — и это состояние закреплено, а не «так вышло».
// ─────────────────────────────────────────────────────────────────────────────
describe('execute_code: гейт по умолчанию', () => {
  it('без явного ptc_enabled=true тулза не предлагается модели', () => {
    const src = require('node:fs').readFileSync('electron/ai/runner-api.ts', 'utf8') as string
    expect(src).toContain("getSecretForDelegate?.('ptc_enabled') !== 'true'")
    expect(src).toContain("allToolDefs.filter(t => t.name !== 'execute_code')")
  })
})
