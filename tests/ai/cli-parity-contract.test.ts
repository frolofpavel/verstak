// Срез 2.0.7-H: transport parity. Контракт-страж честности: заявленная матрица
// capabilities (CLI/Tunnel = урезанный контроль) должна СОВПАДАТЬ с тем, что реально
// делает CLI-runner (runPlainConversation). DoD: UI/маркетинг не обещают больше, чем
// умеет движок. Если кто-то впишет в runner-plain реальный tool-dispatch/checkpoint/
// delegation, но оставит capability=false (или наоборот) — этот страж падает.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { capabilitiesFor, type ProviderTransport } from '../../shared/contracts/provider'
import { runtimeCapability, CLI_WITH_TIMELINE } from '../../src/lib/runtime-capability'

const ROOT = process.cwd()
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')

describe('capability matrix: CLI/Tunnel — урезанный контроль (2.0.7-C)', () => {
  for (const t of ['CLI', 'Tunnel'] as ProviderTransport[]) {
    it(`${t}: tools/verification/resumeSafe/mcp/delegation/perFileUndo = false`, () => {
      const c = capabilitiesFor(t, true) // даже с supportsTools — subprocess не наш loop
      expect(c.tools).toBe(false)
      expect(c.verification).toBe(false)
      expect(c.resumeSafe).toBe(false)
      expect(c.mcp).toBe(false)
      expect(c.delegation).toBe(false)
      expect(c.perFileUndo).toBe(false)
      expect(c.liveTimeline).toBe(false) // наш tick — не проекция CLI-таймлайна
    })
  }

  it('API + tools = полный контроль (контраст)', () => {
    const c = capabilitiesFor('API', true)
    expect(c.tools && c.verification && c.resumeSafe && c.mcp && c.delegation && c.perFileUndo).toBe(true)
  })
})

// Ядро паритета: CLI-runner физически НЕ делает того, что матрица объявляет false. Если
// бы делал — capability=false был бы ложью (UI/маркетинг обещали бы меньше, чем есть, или
// наоборот контроль деградировал бы молча). Проверяем по ИСХОДНИКУ runner-plain.
describe('runner-plain НЕ выполняет то, что заявлено недоступным для CLI', () => {
  const src = read('electron/ai/runner-plain.ts')

  const FORBIDDEN: Array<{ token: string; why: string }> = [
    { token: 'lookupHandler', why: 'tools=false: CLI не диспетчеризует наши инструменты' },
    { token: 'dispatchTool', why: 'tools=false' },
    { token: 'saveCheckpoint', why: 'resumeSafe=false: CLI-прогон не auto-resumable через checkpoint' },
    { token: 'attestVerification', why: 'verification=false' },
    { token: 'delegateTaskHandler', why: 'delegation=false' },
    { token: 'mcpToolHandler', why: 'mcp=false' },
    { token: 'recordWrite', why: 'perFileUndo=false: CLI пишет мимо нашего undo-стека' },
  ]

  for (const { token, why } of FORBIDDEN) {
    it(`не ссылается на ${token} (${why})`, () => {
      expect(src.includes(token), `runner-plain использует ${token} — матрица врёт (${why})`).toBe(false)
    })
  }

  it('tool-таймлайн — ПРОЕКЦИЯ структурного события провайдера, НЕ синтез из текста stdout', () => {
    // Карточка шаг 3: не синтезировать native tool events из свободного текста stdout.
    // Проекция должна идти от event.call (структурный tool-call из stream-json провайдера),
    // а не из парсинга произвольного текста.
    expect(src).toMatch(/tool-activity/)          // проекция есть
    expect(src).toMatch(/event\.call/)            // из структурного события
    // Нет самодельного парсинга «текст → tool-call» в runner (это делали бы regex по stdout).
    expect(src).not.toMatch(/stdout.*match\(.*tool/i)
  })
})

// Проекция таймлайна — только у подтверждённых на потоке CLI (claude/codex, 1.9.5).
describe('tool-таймлайн заявлен только для проверенных CLI', () => {
  it('CLI_WITH_TIMELINE = claude-cli + codex-cli (не разрастается молча)', () => {
    expect([...CLI_WITH_TIMELINE].sort()).toEqual(['claude-cli', 'codex-cli'])
  })

  it('наблюдаемый CLI показывает таймлайн, но НЕ исполнение/verify/undo/resume', () => {
    const obs = runtimeCapability('claude-cli', 'Tunnel')
    expect(obs.toolVisibility).toBe(true)   // видно, что делает агент
    expect(obs.toolExecution).toBe(false)   // но исполняет НЕ наш loop
    expect(obs.verify).toBe(false)
    expect(obs.undo).toBe(false)
    expect(obs.crashResume).toBe(false)
  })

  it('НЕнаблюдаемый CLI (grok/gemini) — даже таймлайна нет', () => {
    const lim = runtimeCapability('grok-cli', 'CLI')
    expect(lim.toolVisibility).toBe(false)
    expect(lim.tier).toBe('limited')
  })
})

// «Смена provider не оставляет capabilities прошлого transport» (карточка шаг 5):
// runtimeCapability — ЧИСТАЯ функция id+transport, без состояния → переключение всегда
// даёт свежую матрицу, стейл-capability невозможен.
describe('capability по switch — чистая функция, без стейл-состояния', () => {
  it('runtimeCapability детерминирован и меняется вместе с provider', () => {
    const api = runtimeCapability('claude', 'API')
    const cli = runtimeCapability('grok-cli', 'CLI')
    expect(api.tier).toBe('full')
    expect(cli.tier).toBe('limited')
    // Повторный вызов — тот же результат (нет накопленного состояния прошлого transport).
    expect(runtimeCapability('claude', 'API')).toEqual(api)
    expect(runtimeCapability('grok-cli', 'CLI')).toEqual(cli)
  })
})

// «Stop обязан завершать дерево subprocess» (карточка шаг 4): CLI-провайдеры должны
// убивать всё поддерево процесса (child-kill/treeKill), а не только родителя.
describe('stop убивает дерево subprocess (не только родителя)', () => {
  for (const f of ['grok-cli.ts', 'claude-cli.ts', 'codex-cli.ts']) {
    it(`${f} использует treeKill (child-kill)`, () => {
      const s = read(`electron/ai/${f}`)
      expect(s, `${f} должен убивать дерево процесса через treeKill`).toMatch(/treeKill|child-kill/)
    })
  }
})
