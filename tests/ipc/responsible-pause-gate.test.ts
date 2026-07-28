// Позиция 2: ПАУЗА ПЕРЕД ОТВЕТСТВЕННЫМ ДЕЙСТВИЕМ — механизмом, а не текстом.
//
// Вчера её не было: продолжение после approve НАЗЫВАЛО ответственные шаги, но
// текст обходился четырьмя способами сразу — режимами auto/bypass, allow-правилом
// permissions, тумблером авто-подтверждения команд и обычной записью файла в
// accept-edits. В аудите это записано как «заявлено-но-не-построено».
//
// Здесь механизм на слое исполнения инструмента, и каждый пин доказывает, что
// ВЫЗОВ НЕ ПРОШЁЛ: проверяется решение общего гейта `resolveDecision`, через
// который обязаны идти file-ops, command, connectors и execute-code, и — в
// сквозном кейсе — факт на файловой системе.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveDecision, compilePermissionConfig } from '../../electron/ai/permission-rules'
import { classifyResponsibleAction } from '../../electron/ai/responsible-action'
import { runCommandHandler } from '../../electron/ipc/tool-handlers/command'
import { createFileTools } from '../../electron/ai/tools'
import type { AgentMode } from '../../electron/ai/mode-policy'

const RESPONSIBLE = [
  { tool: 'run_command', args: { command: 'git push origin main' }, kind: 'publish' },
  { tool: 'run_command', args: { command: 'npm publish' }, kind: 'publish' },
  { tool: 'run_command', args: { command: 'rm -f build/out.js' }, kind: 'delete' },
  { tool: 'run_command', args: { command: 'curl -X POST https://api.example.com/send' }, kind: 'send' },
  { tool: 'run_command', args: { command: 'scp report.pdf user@host:/tmp' }, kind: 'send' },
  { tool: 'run_command', args: { command: 'chmod 777 secrets' }, kind: 'permissions' },
  { tool: 'connector_query', args: { connector: 'telegram', entity: 'sendMessage' }, kind: 'send' },
  { tool: 'connector_query', args: { connector: 'social-publish' }, kind: 'publish' },
]

const ORDINARY = [
  { tool: 'run_command', args: { command: 'npm test' } },
  { tool: 'run_command', args: { command: 'git status' } },
  { tool: 'write_file', args: { path: 'src/index.html', content: '<h1/>' } },
  { tool: 'apply_patch', args: { path: 'src/a.ts' } },
  { tool: 'connector_query', args: { connector: 'yandex-metrika' } },
]

describe('ответственное действие спрашивает в ЛЮБОМ режиме, кроме bypass', () => {
  for (const mode of ['ask', 'accept-edits', 'auto'] as AgentMode[]) {
    it(`режим ${mode}: подтверждение обязательно`, () => {
      for (const c of RESPONSIBLE) {
        const { decision } = resolveDecision(c.tool, c.args, mode, undefined, undefined)
        expect(decision, `${mode} · ${c.tool} · ${JSON.stringify(c.args)}`).toBe('confirm')
      }
    })
  }

  it('bypass — единственное законное исключение, и оно осознанное', () => {
    for (const c of RESPONSIBLE) {
      const { decision } = resolveDecision(c.tool, c.args, 'bypass', undefined, undefined)
      expect(decision, `${c.tool}`).toBe('auto-accept')
    }
  })

  it('plan строже паузы: там по-прежнему block, а не вопрос', () => {
    for (const c of RESPONSIBLE) {
      expect(resolveDecision(c.tool, c.args, 'plan', undefined, undefined).decision).toBe('block')
    }
  })
})

describe('обходы, на которые указало ревью, закрыты', () => {
  it('тумблер авто-подтверждения команд НЕ пропускает ответственное действие', () => {
    const auto = { edits: true, commands: true }
    for (const c of RESPONSIBLE) {
      const { decision } = resolveDecision(c.tool, c.args, 'ask', auto, undefined)
      expect(decision, `autoApprove не должен пропускать ${JSON.stringify(c.args)}`).toBe('confirm')
    }
    // Контроль: обычную команду тот же тумблер по-прежнему пропускает.
    expect(resolveDecision('run_command', { command: 'npm test' }, 'ask', auto, undefined).decision).toBe('auto-accept')
  })

  it('allow-правило permissions НЕ пропускает ответственное действие', () => {
    const rules = compilePermissionConfig({ allow: ['run_command(*)', 'connector_query(*)'] })
    for (const c of RESPONSIBLE) {
      const { decision } = resolveDecision(c.tool, c.args, 'ask', undefined, rules)
      expect(decision, `allow-правило не должно пропускать ${JSON.stringify(c.args)}`).toBe('confirm')
    }
    // Контроль: обычную команду то же правило пропускает — иначе тест ничего не значит.
    expect(resolveDecision('run_command', { command: 'npm test' }, 'ask', undefined, rules).decision).toBe('auto-accept')
  })

  it('deny-правило по-прежнему сильнее всего: block, а не вопрос', () => {
    const rules = compilePermissionConfig({ deny: ['run_command(git push*)'] })
    const { decision } = resolveDecision('run_command', { command: 'git push origin main' }, 'auto', undefined, rules)
    expect(decision).toBe('block')
  })
})

describe('обычная работа НЕ становится вопросом — правило 1 цело', () => {
  it('в accept-edits правки файлов по-прежнему авто, команды-проверки тоже', () => {
    for (const c of ORDINARY) {
      const { decision } = resolveDecision(c.tool, c.args, 'auto', undefined, undefined)
      expect(decision, `${c.tool} ${JSON.stringify(c.args)}`).toBe('auto-accept')
    }
    expect(resolveDecision('write_file', { path: 'a.ts' }, 'accept-edits', undefined, undefined).decision).toBe('auto-accept')
  })

  it('классификатор не считает ответственным обычное', () => {
    for (const c of ORDINARY) {
      expect(classifyResponsibleAction(c.tool, c.args).responsible, `${c.tool}`).toBe(false)
    }
  })

  it('у ответственного действия есть человеческая причина для модалки', () => {
    for (const c of RESPONSIBLE) {
      const v = classifyResponsibleAction(c.tool, c.args)
      expect(v.responsible).toBe(true)
      expect(v.kind).toBe(c.kind)
      expect(v.why && v.why.length > 5, 'причина обязана быть читаемой').toBe(true)
    }
  })
})

// СКВОЗНОЙ КЕЙС: не решение гейта, а фактическое НЕвыполнение через настоящий
// обработчик команды. Сигнал оборван — ветка подтверждения завершается отказом.
describe('сквозной: ответственная команда не выполняется без подтверждения', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gg-responsible-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  function ctxOf(agentMode: AgentMode) {
    const aborted = new AbortController()
    aborted.abort()
    return {
      projectPath: dir, sendId: 1, runId: 'run-1', agentMode,
      tools: createFileTools(dir),
      signal: aborted.signal,
      pendingCommands: new Map(), pendingWrites: new Map(),
      scopedKey: (s: number, c: string) => `${s}::${c}`,
      sender: { send: vi.fn() },
      recordJournal: () => {},
      autoApprove: { edits: true, commands: true },
    } as never
  }

  it('в режиме auto с включённым авто-подтверждением файл всё равно НЕ удалён', async () => {
    const victim = join(dir, 'важный.txt')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(victim, 'данные', 'utf8')

    const res = await runCommandHandler.handle(
      { id: 'c1', name: 'run_command', args: { command: `rm -f "${victim}"` } } as never,
      ctxOf('auto'),
    ) as { error?: string }

    expect(res.error, 'команда выполнилась без подтверждения').toBeTruthy()
    expect(existsSync(victim), 'файл удалён ответственным действием без спроса').toBe(true)
  })

  // КОНТРОЛЬ: обычная команда в том же режиме и с тем же тумблером обязана пройти.
  it('контроль: обычная команда в auto проходит и выполняется', async () => {
    const res = await runCommandHandler.handle(
      { id: 'c2', name: 'run_command', args: { command: 'node -e "console.log(1)"' } } as never,
      ctxOf('auto'),
    ) as { error?: string; result?: string }

    expect(res.error, 'заготовка сломана: обычная команда тоже не идёт').toBeUndefined()
  })
})
