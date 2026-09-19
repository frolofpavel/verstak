import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { openDb } from '../../../electron/storage/db'
import { createBrowserTasks, type BrowserTasks } from '../../../electron/storage/browser-tasks'
import { createComputerController, type ComputerController } from '../../../electron/ai/computer/controller'
import { FakeComputerBackend } from '../../helpers/fake-computer-backend'

const CALC = 'Открой Калькулятор и посчитай 125 × 47'
const SETTLED_BY_REQUEST = 'computer_uncertain_settled_by_new_request'
const OWNER_ACKNOWLEDGED = 'computer_uncertain_owner_acknowledged'

let dir: string
let db: Database
let storage: BrowserTasks
let backend: FakeComputerBackend
let controller: ComputerController

function calculatorBackend(): FakeComputerBackend {
  const fake = new FakeComputerBackend()
  fake.candidates[0]!.processName = 'CalculatorApp.exe'
  return fake
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'computer-stale-uncertainty-'))
  db = openDb(join(dir, 'test.db'))
  storage = createBrowserTasks(db)
  storage.create({ browserTaskId: 'bt-auto', projectPath: '/p', runId: 'run-1' })
  storage.appendRun({ browserTaskId: 'bt-auto', runId: 'run-1' })
  backend = calculatorBackend()
})

afterEach(async () => {
  await controller?.shutdown()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

/** Прогон, оставляющий ровно то, что живьём поймали 19.09: клик прошёл в окно,
 *  но исход не доказан — действие оседает в журнале как `uncertain`. */
async function leaveUncertainEffect(): Promise<{ observationId: string; elementRef: string }> {
  await expect(controller.prepareAutomaticRun({
    browserTaskId: 'bt-auto', runId: 'run-1', originalUserText: CALC,
  })).resolves.toMatchObject({ ok: true })
  const observation = await controller.observe({ browserTaskId: 'bt-auto', runId: 'run-1' })
  backend.throwAfterTransfer = new Error('transport lost')
  const result = await controller.dispatch({
    actionId: 'calc-click-1', browserTaskId: 'bt-auto', runId: 'run-1', action: 'click',
    observationId: observation.observationId, elementRef: observation.elements[0]!.elementRef,
  })
  expect(result.status).toBe('uncertain')
  backend.throwAfterTransfer = null
  return {
    observationId: observation.observationId,
    elementRef: observation.elements[0]!.elementRef,
  }
}

describe('Computer Use — незакрытая отметка не запирает следующую команду человека', () => {
  // Живой тупик 19.09: после недоказанного клика ЛЮБАЯ следующая команда в чате
  // отбивалась кодом `uncertain-reconciliation-required`, и снять его можно было
  // только кнопкой в настройках — а она видна лишь пока жива привязка в памяти.
  // Человеку оставалось закрывать окно приложения руками. Новая команда человека
  // и есть его присутствие: система обязана разобраться сама.
  it('новая автоматическая команда снимает залежавшуюся отметку сама', async () => {
    controller = createComputerController({ storage, backend })
    await leaveUncertainEffect()

    storage.appendRun({ browserTaskId: 'bt-auto', runId: 'run-2' })
    await expect(controller.prepareAutomaticRun({
      browserTaskId: 'bt-auto', runId: 'run-2', originalUserText: CALC,
    })).resolves.toMatchObject({ ok: true })
    expect(controller.getBinding()).toMatchObject({ reconciliationRequired: false })
  })

  // Сценарий Павла целиком: приложение перезапущено, привязки в памяти нет,
  // кнопки подтверждения человек не видит в принципе — отметка живёт только в БД.
  it('после перезапуска приложения отметка из БД тоже не запирает новую команду', async () => {
    controller = createComputerController({ storage, backend })
    await leaveUncertainEffect()
    await controller.shutdown()

    backend = calculatorBackend()
    controller = createComputerController({ storage, backend })
    storage.appendRun({ browserTaskId: 'bt-auto', runId: 'run-restart' })
    await expect(controller.prepareAutomaticRun({
      browserTaskId: 'bt-auto', runId: 'run-restart', originalUserText: CALC,
    })).resolves.toMatchObject({ ok: true })
  })

  it('снятие оставляет след в журнале и не выдумывает исход действия', async () => {
    controller = createComputerController({ storage, backend })
    await leaveUncertainEffect()

    storage.appendRun({ browserTaskId: 'bt-auto', runId: 'run-2' })
    await controller.prepareAutomaticRun({
      browserTaskId: 'bt-auto', runId: 'run-2', originalUserText: CALC,
    })

    const reasons = storage.actionEvents('calc-click-1').map(event => event.reason)
    expect(reasons).toContain(SETTLED_BY_REQUEST)
    // Снято системой по новой команде — это НЕ то же самое, что человек нажал
    // «Я проверил результат». Аудит обязан различать два случая.
    expect(reasons).not.toContain(OWNER_ACKNOWLEDGED)
    expect(storage.getAction('calc-click-1')).toMatchObject({ status: 'uncertain' })
  })

  it('снятие не даёт права действовать вслепую: нужно свежее наблюдение', async () => {
    controller = createComputerController({ storage, backend })
    const stale = await leaveUncertainEffect()

    storage.appendRun({ browserTaskId: 'bt-auto', runId: 'run-2' })
    await controller.prepareAutomaticRun({
      browserTaskId: 'bt-auto', runId: 'run-2', originalUserText: CALC,
    })

    const commits = backend.commitCount
    const blind = await controller.dispatch({
      actionId: 'calc-click-blind', browserTaskId: 'bt-auto', runId: 'run-2', action: 'click',
      observationId: stale.observationId, elementRef: stale.elementRef,
    })
    expect(blind.status).toBe('blocked')
    expect(blind.reason).toBe('stale-observation')
    expect(backend.commitCount).toBe(commits)

    // А со свежим наблюдением работа продолжается — иначе снятие бессмысленно.
    const fresh = await controller.observe({ browserTaskId: 'bt-auto', runId: 'run-2' })
    const proceeded = await controller.dispatch({
      actionId: 'calc-click-2', browserTaskId: 'bt-auto', runId: 'run-2', action: 'click',
      observationId: fresh.observationId, elementRef: fresh.elements[0]!.elementRef,
    })
    expect(proceeded.status).toBe('verified')
  })

  // Контрольная пара: снимается только ЗАЛЕЖАВШАЯСЯ отметка. Действие, которое
  // числится выполняющимся прямо сейчас, снимать нечем — его исход ещё не решён.
  it('действие в полёте (executing) по-прежнему требует человека', async () => {
    controller = createComputerController({ storage, backend })
    await expect(controller.prepareAutomaticRun({
      browserTaskId: 'bt-auto', runId: 'run-1', originalUserText: CALC,
    })).resolves.toMatchObject({ ok: true })
    const fingerprint = controller.getBinding()!.targetFingerprint

    storage.proposeAction({
      actionId: 'calc-in-flight', browserTaskId: 'bt-auto', runId: 'run-1',
      actionType: 'computer:click', riskLevel: 'R1',
      scope: { targetFingerprint: fingerprint }, payload: {}, preconditions: {},
    })
    storage.startExecute('calc-in-flight', 'attempt-in-flight')

    storage.appendRun({ browserTaskId: 'bt-auto', runId: 'run-2' })
    await expect(controller.prepareAutomaticRun({
      browserTaskId: 'bt-auto', runId: 'run-2', originalUserText: CALC,
    })).resolves.toEqual({ ok: false, error: 'uncertain-reconciliation-required' })
  })

  // Контрольная пара: недоступный журнал — это граница, а не разрешение. Молча
  // продолжить на нечитаемом журнале значит потерять сам смысл отметки.
  it('нечитаемый журнал по-прежнему останавливает работу', async () => {
    controller = createComputerController({ storage, backend })
    await leaveUncertainEffect()

    vi.spyOn(storage, 'findUnacknowledgedComputerEffect').mockImplementation(() => {
      throw new Error('ledger unavailable')
    })
    storage.appendRun({ browserTaskId: 'bt-auto', runId: 'run-2' })
    await expect(controller.prepareAutomaticRun({
      browserTaskId: 'bt-auto', runId: 'run-2', originalUserText: CALC,
    })).resolves.toEqual({ ok: false, error: 'uncertain-reconciliation-required' })
  })
})
