// Губернатор доверия обязан стоять на КАЖДОМ пути к инструменту.
//
// Опасность здесь особого рода: обработчик, забывший передать уровень, не падает
// и не краснеет — он просто работает по старым правилам, и получается путь без
// губернатора. Такую дыру нельзя поймать поведенческим тестом, не зная о ней
// заранее, поэтому пин обходит ИСХОДНИКИ — тем же приёмом, что пин единого
// источника секрето-путей (tests/security/secret-path-single-source.test.ts).
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

const ROOT = join(__dirname, '..', '..', 'electron')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (entry.endsWith('.ts')) out.push(full)
  }
  return out
}

/** Строки с ВЫЗОВОМ гейта — объявление функции и комментарии не в счёт. */
function gateCalls(): Array<{ file: string; line: number; text: string }> {
  const found: Array<{ file: string; line: number; text: string }> = []
  for (const file of sourceFiles(ROOT)) {
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((text, i) => {
      if (!text.includes('resolveDecision(')) return
      const trimmed = text.trim()
      if (trimmed.startsWith('*') || trimmed.startsWith('//')) return
      if (trimmed.startsWith('export function')) return
      found.push({ file: file.slice(ROOT.length + 1), line: i + 1, text: trimmed })
    })
  }
  return found
}

describe('доверие доходит до каждого гейта', () => {
  it('вызовы гейта вообще есть — иначе пин ничего не измеряет', () => {
    expect(gateCalls().length).toBeGreaterThan(5)
  })

  it('каждый вызов передаёт уровень доверия', () => {
    const missing = gateCalls().filter(c => !c.text.includes('capabilityTrust'))
    expect(
      missing.map(c => `${c.file}:${c.line}`),
      'Обработчик без уровня доверия работает по старым правилам и об этом не сообщает'
    ).toEqual([])
  })

  // Контроль: сетка обязана ОТЛИЧАТЬ вызов с уровнем от вызова без него — иначе
  // пин выше зелен и у проверки, которая ничего не ищет.
  it('контроль: сетка видит вызов без уровня', () => {
    const withTrust = "const r = resolveDecision(n, a, m, ap, ctx.permissionRules, ctx.capabilityTrust)"
    const without = "const r = resolveDecision(n, a, m, ap, ctx.permissionRules)"
    expect(withTrust.includes('capabilityTrust')).toBe(true)
    expect(without.includes('capabilityTrust')).toBe(false)
  })
})

describe('путь MCP не остаётся в обход губернатора', () => {
  // Найдено при врезке: MCP-инструменты НЕ проходят через resolveDecision — у них
  // своя цепочка (mcpDecision + permission-правила). Без отдельной строки они
  // остались бы единственным путём к инструменту мимо слоя доверия, и пин выше
  // этого бы не увидел: он ищет вызовы resolveDecision, которых там нет.
  const mcp = () => readFileSync(join(ROOT, 'ipc', 'tool-handlers', 'mcp.ts'), 'utf8')

  it('решение по MCP-инструменту проходит через ужесточение доверием', () => {
    expect(mcp()).toContain('tightenByTrust(decision, ctx.capabilityTrust)')
  })

  // Контроль: обработчик обязан ещё и СЧИТАТЬ своё решение — иначе строка выше
  // могла бы стоять в файле, где решения нет вовсе.
  it('контроль: у MCP есть собственное решение, которое и ужесточается', () => {
    expect(mcp()).toContain('mcpDecision(scope, ctx.agentMode)')
  })
})
