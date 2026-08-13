// C4 (13.08): keyword-эвристика scope ловила ПОДСТРОКИ.
//
// Живая приёмка P8 12.08: `get_history` у MOEX (read-only котировки) размечался как
// «запускает команды» — ключевое слово `sh` нашлось внутри `shares`. Ошибка в
// СТРОГУЮ сторону (лишнее подтверждение), не дыра, — поэтому чиним аккуратно и
// доказываем, что ни один настоящий command-инструмент не потерял разметку.
//
// Правило совпадения: ключевое слово равно ТОКЕНУ, либо (при длине ≥3) стоит в
// НАЧАЛЕ токена. Второе оставлено сознательно — без него `exec` перестал бы
// ловить `execute`, `command` — `commands`, `process` — `processes`, то есть
// «word-boundary» в лоб ослабил бы гейт. Токены режутся по не-буквам И по
// camelCase: `listShares` → [list, shares].
import { describe, it, expect } from 'vitest'
import { classifyTool } from '../../src/lib/mcp-risk'
import { classifyMcpToolScope } from '../../electron/ai/mcp-policy'
import { MCP_SCOPE_RULES } from '../../shared/contracts/mcp-scope'

/** Обе реализации обязаны отвечать одинаково — иначе ярлык врёт про боевой гейт. */
function bothScopes(name: string, description?: string): { renderer: string; main: string } {
  return { renderer: classifyTool({ name, description }).scope, main: classifyMcpToolScope(name, description) }
}

describe('C4: ключевое слово не ловится внутри чужого слова', () => {
  it('ПИН: «shares» не даёт command — живой случай MOEX get_history', () => {
    const s = bothScopes('get_history', 'История торгов: shares, bonds, currencies. Только чтение.')
    expect(s.renderer, '«sh» внутри «shares» снова тянет инструмент в command').toBe('read')
    expect(s.main, 'боевой гейт и ярлык разошлись').toBe('read')
  })

  it('КОНТРОЛЬ: настоящие shell/exec/sh по-прежнему дают command', () => {
    for (const [name, desc] of [
      ['run_shell', 'Execute a shell command'],
      ['exec_process', ''],
      ['sh', 'run a script'],
      ['tool_sh', ''],
      ['execShell', ''],
    ] as const) {
      const s = bothScopes(name, desc)
      expect(s.renderer, `${name}: потеряна разметка command`).toBe('command')
      expect(s.main, `${name}: гейт потерял command`).toBe('command')
    }
  })

  it('КОНТРОЛЬ: производные формы ключевых слов гейт не потерял', () => {
    for (const [name, desc] of [
      ['execute_it', 'executes arbitrary code'],
      ['list_commands', 'runs commands'],
      ['processes', 'spawns processes'],
      ['killer', 'kills a process'],
    ] as const) {
      expect(bothScopes(name, desc).main, `${name}: производная форма перестала ловиться`).toBe('command')
    }
  })

  it('ЗЕРКАЛО: подстрока в середине слова больше не срабатывает', () => {
    // «put» внутри «output», «api» внутри «capital», «run» внутри «prune» —
    // тот же класс ошибки, что и «sh» внутри «shares».
    // «show» — настоящее read-слово, оно и должно выиграть; важно, что «put»
    // внутри «output» больше не тянет инструмент в write.
    expect(bothScopes('show_output', 'shows computed output of a report').main).toBe('read')
    // Здесь настоящих ключевых слов нет вовсе → честное «unknown» (незнакомое
    // безопасным не считаем), но и ложного network из «api» внутри «capital» нет.
    expect(bothScopes('capital_report', 'capital structure of a company').main).toBe('unknown')
  })

  it('АНТИ-ДРЕЙФ: таблица ключевых слов одна на renderer и main', () => {
    // Раньше таблица была продублирована в src/lib/mcp-risk.ts и
    // electron/ai/mcp-policy.ts «синхронизируйте руками». Правка word-boundary в
    // одном из двух молча развела бы ярлык и боевой гейт.
    expect(MCP_SCOPE_RULES.length).toBeGreaterThan(0)
    for (const rule of MCP_SCOPE_RULES) {
      for (const kw of rule.keywords) {
        const s = bothScopes(kw, '')
        expect(s.renderer, `ключевое слово «${kw}» разошлось: renderer=${s.renderer}, main=${s.main}`).toBe(s.main)
      }
    }
  })
})
