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
import { spawnProcessHandler } from '../../electron/ipc/tool-handlers/process'
import { createFileTools } from '../../electron/ai/tools'
import type { AgentMode } from '../../electron/ai/mode-policy'

const RESPONSIBLE = [
  { tool: 'run_command', args: { command: 'git push origin main' }, kind: 'publish' },
  { tool: 'run_command', args: { command: 'npm publish' }, kind: 'publish' },
  { tool: 'run_command', args: { command: 'rm -f build/out.js' }, kind: 'delete' },
  { tool: 'run_command', args: { command: 'curl -X POST https://api.example.com/send' }, kind: 'send' },
  { tool: 'run_command', args: { command: 'scp report.pdf user@host:/tmp' }, kind: 'send' },
  { tool: 'run_command', args: { command: 'chmod 777 secrets' }, kind: 'permissions' },
  // Форма аргументов — ПРОДОВАЯ (`id`): схема connector_query другого поля не
  // объявляет (tools.ts, required:['id']), и именно `id` исполняет хендлер.
  // Прежняя запись через `connector` держалась на defensive-алиасе в гейтах;
  // алиас снят 30.07 (SEC-CMD-05), потому что он и позволял судить один
  // коннектор, а исполнять другой. Утверждения кейсов не менялись.
  { tool: 'connector_query', args: { id: 'telegram', entity: 'sendMessage' }, kind: 'send' },
  { tool: 'connector_query', args: { id: 'social-publish' }, kind: 'publish' },
  // Я.Диск: до 30.07 правило было мёртвым — ключ в таблице стоял через дефис,
  // а реальный id коннектора с подчёркиванием.
  { tool: 'connector_query', args: { id: 'yandex_disk', op: 'get_public_url' }, kind: 'publish' },
]

const ORDINARY = [
  { tool: 'run_command', args: { command: 'npm test' } },
  { tool: 'run_command', args: { command: 'git status' } },
  { tool: 'write_file', args: { path: 'src/index.html', content: '<h1/>' } },
  { tool: 'apply_patch', args: { path: 'src/a.ts' } },
  { tool: 'connector_query', args: { id: 'yandex_metrika' } },
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

// ЧЕТВЁРТЫЙ ОБХОД (найден ревизией 30.07 при трёх закрытых выше): bash_allowlist.
// Хендлер вычислял allowlisted ПОСЛЕ resolveDecision и перебивал вердикт confirm,
// не различая его причин. Когда перебивание писали, `confirm` значил одно —
// «так велит режим»; потом у confirm появилась вторая причина — ответственное
// действие, — и перебивание проглотило заодно и её. Совпадение префиксное,
// поэтому allowlist со значением `git` (заведённый ради `git status`) молча
// пропускал `git push`. Проверяется НА НАСТОЯЩИХ ХЕНДЛЕРАХ, не на чистом
// resolveDecision: дыра именно в том, что вердикт верный, а хендлер его перебивает.
describe('обход №4: bash_allowlist НЕ снимает паузу ответственного действия', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gg-allowlist-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  function ctxOf(agentMode: AgentMode, bashAllowlist: string, extra: Record<string, unknown> = {}) {
    const aborted = new AbortController()
    aborted.abort()
    return {
      projectPath: dir, sendId: 2, runId: 'run-2', agentMode,
      tools: createFileTools(dir),
      signal: aborted.signal,
      pendingCommands: new Map(), pendingWrites: new Map(),
      scopedKey: (s: number, c: string) => `${s}::${c}`,
      sender: { send: vi.fn() },
      recordJournal: () => {},
      getSecretForDelegate: (key: string) => (key === 'bash_allowlist' ? bashAllowlist : null),
      ...extra,
    } as never
  }

  it('run_command: rm -f при bash_allowlist=rm в auto НЕ выполняется и файл жив', async () => {
    const victim = join(dir, 'важный.txt')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(victim, 'данные', 'utf8')

    const res = await runCommandHandler.handle(
      { id: 'a1', name: 'run_command', args: { command: `rm -f "${victim}"` } } as never,
      ctxOf('auto', 'rm'),
    ) as { error?: string }

    expect(res.error, 'allowlist перебил паузу — ответственная команда выполнилась').toBeTruthy()
    expect(existsSync(victim), 'файл удалён по allowlist без спроса').toBe(true)
  })

  it('run_command: git push origin main при bash_allowlist=git в auto НЕ выполняется', async () => {
    const res = await runCommandHandler.handle(
      { id: 'a2', name: 'run_command', args: { command: 'git push origin main' } } as never,
      ctxOf('auto', 'git'),
    ) as { error?: string }

    expect(res.error, 'git push прошёл молча по allowlist=git').toBeTruthy()
  })

  it('spawn_process: тот же обход закрыт и во втором месте — процесс не порождается', async () => {
    const spawn = vi.fn(() => ({ id: 'p1', pid: 1, status: 'running' }))
    const res = await spawnProcessHandler.handle(
      { id: 'a3', name: 'spawn_process', args: { command: 'git push origin main' } } as never,
      ctxOf('auto', 'git', { processRegistry: { spawn } }),
    ) as { error?: string }

    expect(res.error, 'spawn_process пропустил ответственную команду по allowlist').toBeTruthy()
    expect(spawn, 'процесс порождён без подтверждения').not.toHaveBeenCalled()
  })

  // КОНТРОЛЬ ПОЛЕЗНОГО СЦЕНАРИЯ. Без него «починкой» была бы и отмена самой
  // настройки — и её завели бы заново, обходом. Доверенная ОБЫЧНАЯ команда
  // по-прежнему авто-аппрувится в confirm-режиме без модалки.
  it('контроль: git status при bash_allowlist=git в ask по-прежнему НЕ спрашивает', async () => {
    const sender = vi.fn()
    const res = await runCommandHandler.handle(
      { id: 'a4', name: 'run_command', args: { command: 'git status' } } as never,
      ctxOf('ask', 'git', { sender: { send: sender } }),
    ) as { error?: string }

    expect(res.error, 'полезный сценарий allowlist отменён — git status снова спрашивает').toBeUndefined()
    const events = sender.mock.calls.map(c => (c[1] as { event: { type: string } }).event.type)
    expect(events, 'модалка всё же показана').not.toContain('pending-command')
  })

  // Причина подтверждения — явная, и allowlist гасит только «так велит режим».
  it('resolveDecision называет причину confirm: mode / responsible-action / ask-rule', () => {
    const ordinary = resolveDecision('run_command', { command: 'git status' }, 'ask', undefined, undefined)
    expect(ordinary.decision).toBe('confirm')
    expect(ordinary.confirmCause, 'у режимного confirm причина mode').toBe('mode')

    const responsible = resolveDecision('run_command', { command: 'git push origin main' }, 'auto', undefined, undefined)
    expect(responsible.decision).toBe('confirm')
    expect(responsible.confirmCause, 'у ответственного действия своя причина').toBe('responsible-action')

    const askRules = compilePermissionConfig({ ask: ['run_command(git fetch*)'] })
    const asked = resolveDecision('run_command', { command: 'git fetch origin' }, 'auto', undefined, askRules)
    expect(asked.decision).toBe('confirm')
    expect(asked.confirmCause, 'у явного ask-правила своя причина').toBe('ask-rule')
  })

  // Явное ask-правило пользователя — тот же класс: allowlist (механизм allow-класса)
  // не должен перебивать ask по объявленной семантике deny > ask > allow.
  it('ask-правило permissions не гасится allowlist\'ом', async () => {
    const rules = compilePermissionConfig({ ask: ['run_command(git fetch*)'] })
    const res = await runCommandHandler.handle(
      { id: 'a5', name: 'run_command', args: { command: 'git fetch origin' } } as never,
      ctxOf('auto', 'git', { permissionRules: rules }),
    ) as { error?: string }

    expect(res.error, 'ask-правило пользователя перебито настройкой удобства').toBeTruthy()
  })
})
