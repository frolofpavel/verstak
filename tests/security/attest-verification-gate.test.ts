// SEC-CMD-04 · attest_verification исполняет команды через ОБЩИЙ гейт, а не мимо него.
//
// ЧТО БЫЛО СЛОМАНО. Хендлер брал команды из аргументов МОДЕЛИ
// (`checks[].command`) и отдавал их прямо в `tools.runCommand` — сырой spawn.
// Между вводом модели и исполнением стоял ровно один фильтр: денилист. Вызова
// `resolveDecision` в файле не было ни одного, поэтому мимо проходили сразу:
// классификация ответственного действия, режим агента (включая `plan`, где
// команды запрещены всегда), тумблер autoApprove, permission-правила — В ТОМ
// ЧИСЛЕ `deny`, который объявлен АБСОЛЮТНЫМ («бьёт даже bypass»,
// permission-rules.ts:16), — bash_allowlist, smart-approve и модалка
// подтверждения. До десяти команд за вызов.
//
// КЛАСС ОШИБКИ ТОТ ЖЕ, ЧТО В ОБХОДЕ №4 (bash_allowlist). Код писался под
// предпосылку «в tools.runCommand попадают только команды, прошедшие гейт в
// command.ts» — на тот момент верную. Потом гейт стал местом, где живут режим,
// permissions и пауза, а этот путь про них так и не узнал: он их не спрашивает.
// Комментарий «перепрогон через тот же runCommand (denylist+scanner внутри)»
// описывал ровно ту устаревшую предпосылку.
//
// ПОЧЕМУ ГЕЙТ ЗОВЁТСЯ ПОКОМАНДНО ПОД ИМЕНЕМ `run_command`, А НЕ
// `attest_verification`. Вызов `resolveDecision('attest_verification', …)` был бы
// ПУСТЫШКОЙ: `decide()` (mode-policy.ts:50-58) считает командами только
// run_command/connector_query/execute_code, а `classifyResponsibleAction`
// (responsible-action.ts:100-114) разбирает аргументы для того же короткого
// списка. Такой гейт выглядел бы поставленным и не срабатывал никогда — худший
// исход, потому что он закрывает вопрос ложно. Поэтому каждая проверка идёт
// через НАСТОЯЩИЙ `runCommandHandler`: имя `run_command` наследует и
// классификатор, и denylist, и permissions, и режим, и allowlist, и модалку.
//
// ПОЧЕМУ НЕ СПИСОК РАЗРЕШЁННЫХ VERIFY-КОМАНД (вариант, который выглядит строже).
// Оба существующих списка покрывают только часть экосистем: `isAllowedVerifyCommand`
// (review-gate.ts:26) — JS-стек, `isVerifierCommand` (command-policy.ts:70) —
// плюс pytest/ruff/mypy. Ни один не знает `go build ./...`, `cargo test`,
// `dotnet test`, `mvn test` — при том, что описание run_command само предлагает
// модели `pytest` и `go build ./...` (tools.ts:133), а финализация прогона
// требует attest и пишет «итог не доказан» без него (runner-finalize.ts:125).
// Fail-closed список превратил бы DoD в вечный not_run для Go/Rust/.NET/Java.
// Трение в режиме `ask` снимается штатной пользовательской настройкой
// bash_allowlist, а не нашим исключением.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { attestVerificationHandler } from '../../electron/ipc/tool-handlers/verification'
import { compilePermissionConfig } from '../../electron/ai/permission-rules'
import { createFileTools } from '../../electron/ai/tools'
import { artifactsDir } from '../../electron/ai/artifacts'
import type { ToolContext } from '../../electron/ipc/tool-handlers/shared'
import type { AgentMode } from '../../electron/ai/mode-policy'
import type { ToolCall } from '../../electron/ai/types'
import type { VerificationArtifact } from '../../electron/ai/verification'

let dir: string

/**
 * Контекст с НАСТОЯЩИМИ FileTools: денилист, политика путей и исполнение —
 * живые. Мок только у sender. Сигнал оборван намеренно: если гейт решит
 * спросить человека, ожидание подтверждения завершается отказом, и мы видим
 * ФАКТ невыполнения, а не висящий хендлер.
 */
function ctxFor(agentMode: AgentMode, over: Partial<Record<string, unknown>> = {}): ToolContext {
  const aborted = new AbortController()
  aborted.abort()
  return {
    projectPath: dir,
    sendId: 1,
    runId: 'run-attest',
    agentMode,
    tools: createFileTools(dir),
    signal: aborted.signal,
    pendingCommands: new Map(),
    pendingWrites: new Map(),
    scopedKey: (s: number, c: string) => `${s}::${c}`,
    sender: { send: vi.fn() },
    pendingAttachments: [],
    runFilesTouched: () => [],
    recordJournal: () => {},
    recordRunEvent: () => {},
    verifications: { insert: () => 1 },
    ...over,
  } as unknown as ToolContext
}

function call(args: Record<string, unknown>): ToolCall {
  return { id: 'att-1', name: 'attest_verification', args }
}

function readArtifact(): VerificationArtifact {
  const jsonFile = readdirSync(artifactsDir(dir)).find(f => f.endsWith('.json'))
  if (!jsonFile) throw new Error('артефакт .json не записан')
  return JSON.parse(readFileSync(join(artifactsDir(dir), jsonFile), 'utf8'))
}

/**
 * Команда, создающая файл. Факт исполнения проверяем по ФАЙЛОВОЙ СИСТЕМЕ, а не
 * по статусу в артефакте: статус — слово хендлера, файл — факт.
 *
 * Скрипт лежит файлом, а команда — `node <файл>`: инлайновый `node -e "…"` на
 * cmd.exe разбирается кавычками и молча не делает ничего, из-за чего пины
 * «команда НЕ исполнилась» были бы зелёными всегда. Контрольные кейсы ниже это
 * и поймали на первом прогоне.
 */
const marker = () => join(dir, 'executed.txt')
/** @returns команда, создающая файл `name` в корне проекта. */
function touchCmd(script: string, name: string): string {
  writeFileSync(join(dir, script), `require('fs').writeFileSync('${name}', 'ran')\n`, 'utf8')
  return `node ${script}`
}
const TOUCH = () => touchCmd('touch.js', 'executed.txt')

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'vst-attest-gate-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('SEC-CMD-04 · attest_verification подчиняется общему гейту команд', () => {
  // ОБЯЗАТЕЛЬНЫЙ ПИН. Он и показывает, что «абсолютность» deny была ложной:
  // правило, которое по документации бьёт даже bypass, обходилось вызовом
  // другого инструмента.
  it('deny-правило permissions НЕ обходится через attest_verification', async () => {
    const rules = compilePermissionConfig({ deny: ['run_command(node:*)'] })

    await attestVerificationHandler.handle(
      call({ task_summary: 'проверка', checks: [{ command: TOUCH() }] }),
      ctxFor('auto', { permissionRules: rules }),
    )

    expect(existsSync(marker()), 'deny-правило обойдено через attest_verification').toBe(false)
    expect(readArtifact().checks[0].status, 'заблокированная команда не должна числиться пройденной').toBe('not_run')
  })

  it('режим plan: команды не исполняются вовсе — там запрещено всё', async () => {
    await attestVerificationHandler.handle(
      call({ task_summary: 'проверка', checks: [{ command: TOUCH() }] }),
      ctxFor('plan'),
    )

    expect(existsSync(marker()), 'в режиме plan команда исполнилась').toBe(false)
    expect(readArtifact().checks[0].status).toBe('not_run')
  })

  // Ответственное действие проверяем по СТАТУСУ «не прогоняли», а не по файлу:
  // побочный эффект у `git push` в пустом каталоге не воспроизвести, а цепочка
  // `A && B` дала бы ложно-зелёный пин — `git push` там падает сам и до B не
  // доходит. На коде ДО фикса эта же команда исполнялась и давала `failed`
  // (то есть прогон состоялся), после фикса — `not_run` (прогона не было).
  it('ответственное действие требует паузы даже под видом проверки', async () => {
    await attestVerificationHandler.handle(
      call({ task_summary: 'выкладка', checks: [{ command: 'git push origin main' }] }),
      ctxFor('auto'),
    )

    const check = readArtifact().checks[0]
    expect(check.status, 'ответственная команда прогнана без подтверждения').toBe('not_run')
    expect(check.exitCode, 'команда всё-таки исполнялась — есть код возврата').toBeUndefined()
  })

  it('bash_allowlist здесь тоже гасит только режимную рутину, не ответственное', async () => {
    await attestVerificationHandler.handle(
      call({ task_summary: 'выкладка', checks: [{ command: 'git push origin main' }] }),
      ctxFor('auto', { getSecretForDelegate: (k: string) => (k === 'bash_allowlist' ? 'git' : null) }),
    )

    expect(readArtifact().checks[0].status).toBe('not_run')
  })

  // КОНТРОЛЬ. Без него «починкой» было бы просто запретить attest выполнять
  // что-либо: пины выше стали бы зелёными, а инструмент — мёртвым, при том что
  // финализация прогона его ТРЕБУЕТ.
  it('контроль: обычная проверка в auto исполняется, статус по реальному exitCode', async () => {
    await attestVerificationHandler.handle(
      call({ task_summary: 'зелёная проверка', checks: [{ command: TOUCH() }] }),
      ctxFor('auto'),
    )

    expect(existsSync(marker()), 'обычная проверка перестала исполняться — DoD сломан').toBe(true)
    expect(readArtifact().checks[0]).toMatchObject({ status: 'passed', exitCode: 0, manual: false })
  })

  it('контроль: падающая проверка честно даёт failed, а не not_run', async () => {
    writeFileSync(join(dir, 'fail.js'), 'process.exit(3)\n', 'utf8')

    await attestVerificationHandler.handle(
      call({ task_summary: 'красная проверка', checks: [{ command: 'node fail.js' }] }),
      ctxFor('auto'),
    )

    expect(readArtifact().checks[0]).toMatchObject({ status: 'failed', exitCode: 3 })
  })

  // Проверка не-JS экосистемы: ровно тот случай, ради которого выбран общий
  // гейт, а не список разрешённых verify-команд.
  it('контроль: verify-команда чужой экосистемы проходит (список бы её отверг)', async () => {
    // Аналог `go build ./...` / `cargo test`: ни один verify-allowlist проекта
    // такой формы не знает, но DoD обязан оставаться достижимым.
    const cmd = touchCmd('build.js', 'gotest.txt')

    await attestVerificationHandler.handle(
      call({ task_summary: 'go-проект', checks: [{ command: cmd, summary: 'сборка' }] }),
      ctxFor('auto'),
    )

    expect(existsSync(join(dir, 'gotest.txt')), 'проверка не-JS проекта отвергнута — DoD стал недостижим').toBe(true)
  })

  it('денилист по-прежнему даёт not_run с причиной, а не молчаливый провал', async () => {
    writeFileSync(join(dir, 'victim.txt'), 'данные', 'utf8')

    await attestVerificationHandler.handle(
      call({ task_summary: 'опасная', checks: [{ command: 'rm -rf /', summary: 'почистить' }] }),
      ctxFor('auto'),
    )

    const check = readArtifact().checks[0]
    expect(check.status).toBe('not_run')
    expect(check.manual).toBe(true)
    expect(String(check.summary), 'причина отказа не доехала до человека').toMatch(/заблокирована|Заблокирована/)
  })
})
