import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import { openDb } from '../../../electron/storage/db'
import { createBrowserTasks, type BrowserTasks } from '../../../electron/storage/browser-tasks'
import { createComputerController, type ComputerController } from '../../../electron/ai/computer/controller'
import { deferred, FakeComputerBackend } from '../../helpers/fake-computer-backend'

let dir: string
let db: Database
let storage: BrowserTasks
let backend: FakeComputerBackend
let controller: ComputerController

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'computer-routing-'))
  db = openDb(join(dir, 'test.db'))
  storage = createBrowserTasks(db)
  storage.create({ browserTaskId: 'bt-1', projectPath: '/p', runId: 'run-1' })
  storage.appendRun({ browserTaskId: 'bt-1', runId: 'run-1' })
  backend = new FakeComputerBackend()
  controller = createComputerController({ storage, backend })
  const [candidate] = await controller.listCandidates()
  await controller.bindCandidate(candidate!.candidateId)
  expect(controller.authorizeRun({ browserTaskId: 'bt-1', runId: 'run-1' }).ok).toBe(true)
})

afterEach(async () => {
  await controller.shutdown()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

async function enableUnverifiedGlobalInputForTest(): Promise<void> {
  await controller.shutdown()
  controller = createComputerController({
    storage,
    backend,
    testOnlyAllowUnverifiedGlobalInput: true,
  })
  const [candidate] = await controller.listCandidates()
  await controller.bindCandidate(candidate!.candidateId)
  expect(controller.authorizeRun({ browserTaskId: 'bt-1', runId: 'run-1' }).ok).toBe(true)
}

function fullTitleFingerprint(title: string): string {
  const normalized = title.normalize('NFKC').replace(/\s+/gu, ' ').trim()
  return createHash('sha256').update(`window-title|${normalized}`, 'utf8').digest('hex')
}

async function rebindWithFullTitle(fullTitle: string): Promise<string> {
  await controller.unbind()
  const displayTitle = fullTitle.normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, 300)
  const titleFingerprint = fullTitleFingerprint(fullTitle)
  Object.assign(backend.candidates[0]!, { title: displayTitle, titleFingerprint })
  Object.assign(backend.probe, { title: displayTitle, titleFingerprint })
  const [candidate] = await controller.listCandidates()
  expect(await controller.bindCandidate(candidate!.candidateId)).toMatchObject({ ok: true })
  expect(controller.authorizeRun({ browserTaskId: 'bt-1', runId: 'run-1' }).ok).toBe(true)
  return displayTitle
}

describe('ComputerController — fresh routing and UIA-first', () => {
  it.each(['API key ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef', 'Access token visible-value'])(
    'omits a candidate whose top-level title is a credential surface: %s',
    async title => {
      await controller.unbind()
      backend.candidates[0]!.title = title
      expect(await controller.listCandidates()).toEqual([])
    },
  )

  it.each([
    ['geometry', () => { backend.probe.geometry.width += 1 }],
    ['dpi', () => { backend.probe.dpi = 120 }],
    ['user-input', () => { backend.probe.userInputEpoch += 1 }],
  ])('blocks stale %s before prepare/commit', async (_name, mutate) => {
    const observation = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
    mutate()
    const result = await controller.dispatch({
      actionId: `stale-${_name}`, browserTaskId: 'bt-1', runId: 'run-1',
      action: 'click', observationId: observation.observationId,
      elementRef: observation.elements[0]!.elementRef,
    })
    expect(result.status).toBe('blocked')
    expect(result.reason).toBe(_name === 'user-input' ? 'hardware-input' : `stale-${_name}`)
    expect(backend.prepareCount).toBe(0)
    expect(backend.commitCount).toBe(0)
  })

  it('blocks a title change after observation before prepare', async () => {
    const observation = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
    backend.probe.title = 'Different document - Notepad'

    const result = await controller.dispatch({
      actionId: 'stale-title-before-prepare', browserTaskId: 'bt-1', runId: 'run-1',
      action: 'click', observationId: observation.observationId,
      elementRef: observation.elements[0]!.elementRef,
    })

    expect(result).toMatchObject({ status: 'blocked', reason: 'target-title-changed' })
    expect(backend.prepareCount).toBe(0)
    expect(backend.commitCount).toBe(0)
  })

  it('rechecks the title after effect-free prepare and blocks before commit', async () => {
    const observation = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
    backend.prepareBarrier = deferred()
    const pending = controller.dispatch({
      actionId: 'stale-title-during-prepare', browserTaskId: 'bt-1', runId: 'run-1',
      action: 'click', observationId: observation.observationId,
      elementRef: observation.elements[0]!.elementRef,
    })
    while (backend.prepareCount === 0) await Promise.resolve()
    backend.probe.title = 'Different document - Notepad'
    backend.prepareBarrier.resolve()

    await expect(pending).resolves.toMatchObject({ status: 'blocked', reason: 'target-title-changed' })
    expect(backend.commitCount).toBe(0)
  })

  it('keeps the unchanged selected title through observe, prepare and commit', async () => {
    const observation = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
    const result = await controller.dispatch({
      actionId: 'stable-title-positive', browserTaskId: 'bt-1', runId: 'run-1',
      action: 'click', observationId: observation.observationId,
      elementRef: observation.elements[0]!.elementRef,
    })

    expect(result.status).toBe('verified')
    expect(backend.lastPrepare?.expected.title).toBe('Temporary canary')
    expect(backend.commitCount).toBe(1)
  })

  it('carries the exact observed Toggle transition and refuses a stale opposite post-state', async () => {
    backend.observation.elements[0]!.role = 'CheckBox'
    backend.observation.elements[0]!.label = 'Grid lines'
    backend.observation.elements[0]!.state = 'off'
    backend.observation.elements[0]!.supportedActions = ['click']
    const observation = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
    const originalCommit = backend.commitAction.bind(backend)
    backend.commitAction = async (prepared, options) => {
      const committed = await originalCommit(prepared, options)
      // Simulates the unsafe old outcome: the control self-changed Off -> On
      // before commit, then an unconditional Toggle moved it back to Off.
      backend.observation.elements[0]!.state = 'off'
      return committed
    }

    const result = await controller.dispatch({
      actionId: 'stale-toggle-transition', browserTaskId: 'bt-1', runId: 'run-1',
      action: 'click', observationId: observation.observationId,
      elementRef: observation.elements[0]!.elementRef,
    })

    expect(backend.lastPrepare?.resolvedElement?.expectedTransition).toEqual({
      kind: 'toggle', before: 'off', after: 'on',
    })
    expect(result).toMatchObject({ status: 'uncertain', reason: 'readback-mismatch' })
  })

  it.each(['indeterminate', 'selected'])('blocks non-deterministic UIA state %s before prepare', async state => {
    backend.observation.elements[0]!.role = state === 'selected' ? 'RadioButton' : 'CheckBox'
    backend.observation.elements[0]!.label = 'Grid lines'
    backend.observation.elements[0]!.state = state
    backend.observation.elements[0]!.supportedActions = ['click']
    const observation = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })

    const result = await controller.dispatch({
      actionId: `unsupported-state-${state}`, browserTaskId: 'bt-1', runId: 'run-1',
      action: 'click', observationId: observation.observationId,
      elementRef: observation.elements[0]!.elementRef,
    })

    expect(result).toMatchObject({ status: 'blocked', reason: 'invalid-action' })
    expect(backend.prepareCount).toBe(0)
    expect(backend.commitCount).toBe(0)
  })

  it('blocks a same-display full-title change before prepare', async () => {
    const prefix = 'A'.repeat(300)
    const displayTitle = await rebindWithFullTitle(`${prefix} Budget.xlsx`)
    const observation = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
    Object.assign(backend.probe, {
      title: displayTitle,
      titleFingerprint: fullTitleFingerprint(`${prefix} Payroll.xlsx`),
    })

    const result = await controller.dispatch({
      actionId: 'full-title-before-prepare', browserTaskId: 'bt-1', runId: 'run-1',
      action: 'click', observationId: observation.observationId,
      elementRef: observation.elements[0]!.elementRef,
    })

    expect(result).toMatchObject({ status: 'blocked', reason: 'target-title-changed' })
    expect(backend.prepareCount).toBe(0)
    expect(backend.commitCount).toBe(0)
  })

  it('blocks a same-display full-title change during effect-free prepare', async () => {
    const prefix = 'A'.repeat(300)
    const displayTitle = await rebindWithFullTitle(`${prefix} Budget.xlsx`)
    const observation = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
    backend.prepareBarrier = deferred()
    const pending = controller.dispatch({
      actionId: 'full-title-during-prepare', browserTaskId: 'bt-1', runId: 'run-1',
      action: 'click', observationId: observation.observationId,
      elementRef: observation.elements[0]!.elementRef,
    })
    while (backend.prepareCount === 0) await Promise.resolve()
    Object.assign(backend.probe, {
      title: displayTitle,
      titleFingerprint: fullTitleFingerprint(`${prefix} Payroll.xlsx`),
    })
    backend.prepareBarrier.resolve()

    await expect(pending).resolves.toMatchObject({ status: 'blocked', reason: 'target-title-changed' })
    expect(backend.commitCount).toBe(0)
  })

  it('keeps a stable full title whose UI display is clipped', async () => {
    const fullTitle = `${'A'.repeat(300)} Budget.xlsx`
    const displayTitle = await rebindWithFullTitle(fullTitle)
    const observation = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
    const result = await controller.dispatch({
      actionId: 'full-title-stable', browserTaskId: 'bt-1', runId: 'run-1',
      action: 'click', observationId: observation.observationId,
      elementRef: observation.elements[0]!.elementRef,
    })

    expect(result.status).toBe('verified')
    expect(observation.title).toBe(displayTitle)
    expect(observation.title).toHaveLength(300)
    expect(backend.lastPrepare?.expected.titleFingerprint).toBe(fullTitleFingerprint(fullTitle))
    expect(backend.commitCount).toBe(1)
  })

  it('adopts an action-induced title change only after verified dispatch and effect', async () => {
    const observation = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
    const originalCommit = backend.commitAction.bind(backend)
    backend.commitAction = async (prepared, options) => {
      const committed = await originalCommit(prepared, options)
      backend.probe.title = '*Temporary canary'
      backend.probe.titleFingerprint = fullTitleFingerprint('*Temporary canary')
      return committed
    }

    const result = await controller.dispatch({
      actionId: 'verified-post-action-title', browserTaskId: 'bt-1', runId: 'run-1',
      action: 'click', observationId: observation.observationId,
      elementRef: observation.elements[0]!.elementRef,
    })

    expect(result).toMatchObject({ status: 'verified', observation: { title: '*Temporary canary' } })
    expect(controller.getBinding()?.title).toBe('*Temporary canary')
  })

  it.each([
    ['Button', 'Delete', 'enabled'],
    ['Button', 'Remove permanently', 'enabled'],
    ['Button', 'Share', 'enabled'],
    ['Button', 'Release', 'enabled'],
    ['Button', 'Transfer', 'enabled'],
    ['Button', 'Publish', 'enabled'],
    ['Button', 'Send', 'enabled'],
    ['Button', 'Submit', 'enabled'],
    ['Button', 'Pay now', 'enabled'],
    ['Button', 'Buy', 'enabled'],
    ['Button', 'Grant access', 'enabled'],
    ['Button', 'Allow permissions', 'enabled'],
    ['Toggle', 'Allow', 'off'],
    ['SelectionItem', 'Grant', 'not selected'],
    ['Toggle', 'Разрешить', 'off'],
    ['SelectionItem', 'Предоставить', 'not selected'],
    ['Button', 'Disable protection', 'enabled'],
    ['Button', 'Продолжить', 'Отключить защиту'],
    ['SelectionItem', 'Public network', 'not-selected'],
    ['SelectionItem', 'Публичная сеть', 'not-selected'],
    ['SelectionItem', 'Anyone with the link', 'not-selected'],
    ['SelectionItem', 'Все, у кого есть ссылка', 'not-selected'],
    ['Toggle', 'Administrator', 'off'],
    ['Toggle', 'Администратор', 'off'],
    ['Toggle', 'Auto-renew', 'off'],
    ['Toggle', 'Автопродление', 'off'],
  ])('blocks responsible semantic target before prepare: %s / %s / %s', async (role, label, state) => {
    backend.observation.elements[0]!.role = role
    backend.observation.elements[0]!.label = label
    backend.observation.elements[0]!.state = state
    const observation = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
    const result = await controller.dispatch({
      actionId: `responsible-${backend.observeCount}`, browserTaskId: 'bt-1', runId: 'run-1',
      action: 'click', observationId: observation.observationId,
      elementRef: observation.elements[0]!.elementRef,
    })

    expect(result).toMatchObject({
      status: 'blocked',
      reason: 'responsible-action-confirmation-required',
    })
    expect(backend.prepareCount).toBe(0)
    expect(backend.commitCount).toBe(0)
    expect(JSON.stringify(storage.getAction(result.actionId))).not.toContain(label)
  })

  it.each(['SystemSettings.exe', 'control.exe', 'mmc.exe', 'secpol.exe'])(
    'blocks a Windows security/settings host at the main candidate boundary: %s',
    async processName => {
      await controller.unbind()
      backend.candidates[0]!.processName = processName

      const candidates = await controller.listCandidates()
      expect(candidates[0]).toMatchObject({ processName, blockedReason: 'secure-surface' })
      await expect(controller.bindCandidate(candidates[0]!.candidateId))
        .resolves.toEqual({ ok: false, error: 'secure-surface' })
    },
  )

  it('omits Yandex/browser-class surfaces while retaining a benign non-browser control', async () => {
    await controller.unbind()
    const safe = backend.candidates[0]!
    backend.candidates = [
      {
        ...safe,
        processName: 'browser.exe',
        productName: 'Яндекс Браузер',
        topLevelClassName: 'Chrome_WidgetWin_1',
        title: 'Найти или ввести адрес',
      },
      {
        ...safe,
        identity: { ...safe.identity, pid: safe.identity.pid + 1, hwnd: '0x0000000000012346' },
        processName: 'renderer-host.exe',
        productName: 'Canary Renderer',
        topLevelClassName: 'MozillaWindowClass',
        title: 'Localized browser chrome',
      },
      {
        ...safe,
        identity: { ...safe.identity, pid: safe.identity.pid + 2, hwnd: '0x0000000000012347' },
        processName: 'renderer-host.exe',
        productName: 'Arc',
        topLevelClassName: 'CanaryRendererWindow',
        title: 'Localized browser chrome',
      },
      {
        ...safe,
        identity: { ...safe.identity, pid: safe.identity.pid + 3, hwnd: '0x0000000000012348' },
        processName: 'canary-notes.exe',
        productName: 'Canary Notes',
        topLevelClassName: 'CanaryNotesWindow',
        title: 'Harmless local canary',
      },
    ]

    const candidates = await controller.listCandidates()

    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({
      processName: 'canary-notes.exe',
      title: 'Harmless local canary',
    })
  })

  it('allows a harmless Toggle/SelectionItem and ignores model text as a responsibility signal', async () => {
    backend.observation.elements[0]!.role = 'Toggle SelectionItem'
    backend.observation.elements[0]!.label = 'Grid lines'
    backend.observation.elements[0]!.state = 'off'
    let observation = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
    await expect(controller.dispatch({
      actionId: 'harmless-grid-lines', browserTaskId: 'bt-1', runId: 'run-1',
      action: 'click', observationId: observation.observationId,
      elementRef: observation.elements[0]!.elementRef,
    })).resolves.toMatchObject({ status: 'verified' })

    observation = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
    await expect(controller.dispatch({
      actionId: 'model-args-not-semantic-authority', browserTaskId: 'bt-1', runId: 'run-1',
      action: 'type', observationId: observation.observationId,
      elementRef: observation.elements[0]!.elementRef,
      text: 'publish',
    })).resolves.toMatchObject({ status: 'verified' })
  })

  it('invalidates elementRef after a newer observation', async () => {
    const old = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
    await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
    const result = await controller.dispatch({
      actionId: 'old-observation', browserTaskId: 'bt-1', runId: 'run-1', action: 'click',
      observationId: old.observationId, elementRef: old.elements[0]!.elementRef,
    })
    expect(result.status).toBe('blocked')
    expect(result.reason).toBe('stale-observation')
    expect(backend.prepareCount).toBe(0)
  })

  it('rejects non-issued routing refs before writing an action ledger row', async () => {
    const privateRef = 'PRIVATE UI TEXT FROM SELECTED WINDOW'
    const result = await controller.dispatch({
      actionId: 'invalid-private-ref', browserTaskId: 'bt-1', runId: 'run-1', action: 'click',
      observationId: privateRef, elementRef: privateRef,
    })
    expect(result.status).toBe('blocked')
    expect(result.reason).toBe('stale-observation')
    expect(storage.getAction('invalid-private-ref')).toBeNull()
    expect(JSON.stringify(storage.listActions('bt-1'))).not.toContain(privateRef)
    expect(backend.prepareCount).toBe(0)
  })

  it('rejects a UUID-shaped but non-issued observation before writing an action ledger row', async () => {
    const observation = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
    const forgedObservation = 'wo-deadbeef-dead-4eef-8ead-deadbeefdead'
    const result = await controller.dispatch({
      actionId: 'forged-observation', browserTaskId: 'bt-1', runId: 'run-1', action: 'click',
      observationId: forgedObservation, elementRef: observation.elements[0]!.elementRef,
    })

    expect(result).toMatchObject({ status: 'blocked', reason: 'stale-observation' })
    expect(storage.getAction('forged-observation')).toBeNull()
    expect(JSON.stringify(storage.listActions('bt-1'))).not.toContain(forgedObservation)
    expect(backend.prepareCount).toBe(0)
    expect(backend.commitCount).toBe(0)
  })

  it('rejects a UUID-shaped but non-issued effect element before writing an action ledger row', async () => {
    const observation = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
    const forgedElement = 'we-deadbeef-dead-4eef-8ead-deadbeefdead'
    const result = await controller.dispatch({
      actionId: 'forged-effect-element', browserTaskId: 'bt-1', runId: 'run-1', action: 'click',
      observationId: observation.observationId, elementRef: forgedElement,
    })

    expect(result).toMatchObject({ status: 'blocked', reason: 'invalid-element-ref' })
    expect(storage.getAction('forged-effect-element')).toBeNull()
    expect(JSON.stringify(storage.listActions('bt-1'))).not.toContain(forgedElement)
    expect(backend.prepareCount).toBe(0)
    expect(backend.commitCount).toBe(0)
  })

  it('rejects a UUID-shaped but non-issued wait target before writing an action ledger row', async () => {
    await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
    const forgedElement = 'we-deadbeef-dead-4eef-8ead-deadbeefdead'
    const result = await controller.dispatch({
      actionId: 'forged-wait-element', browserTaskId: 'bt-1', runId: 'run-1', action: 'wait_for',
      waitFor: { elementRef: forgedElement, text: 'harmless marker' }, timeoutMs: 1,
    })

    expect(result).toMatchObject({ status: 'blocked', reason: 'invalid-element-ref' })
    expect(storage.getAction('forged-wait-element')).toBeNull()
    expect(JSON.stringify(storage.listActions('bt-1'))).not.toContain(forgedElement)
  })

  it('requires UIA when the observed element exposes the matching pattern', async () => {
    backend.forceMethod = 'coordinates'
    const observation = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
    const result = await controller.dispatch({
      actionId: 'uia-priority', browserTaskId: 'bt-1', runId: 'run-1', action: 'click',
      observationId: observation.observationId, elementRef: observation.elements[0]!.elementRef,
    })
    expect(result.status).toBe('blocked')
    expect(result.reason).toBe('uia-priority-violated')
    expect(backend.commitCount).toBe(0)
  })

  it('blocks unaccepted global SendInput in the production-default controller before commit', async () => {
    const observation = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
    const result = await controller.dispatch({
      actionId: 'production-global-input-blocked', browserTaskId: 'bt-1', runId: 'run-1', action: 'key',
      observationId: observation.observationId, elementRef: observation.elements[0]!.elementRef,
      key: 'Enter',
    })
    expect(result.status).toBe('blocked')
    expect(result.reason).toBe('global-input-not-accepted')
    expect(backend.prepareCount).toBe(0)
    expect(backend.commitCount).toBe(0)
    expect(storage.getAction('production-global-input-blocked')?.status).toBe('blocked')
  })

  it('allows coordinate fallback only with exact foreground and own-HWND hit-test', async () => {
    await enableUnverifiedGlobalInputForTest()
    backend.observation.elements[0]!.supportedActions = []
    backend.forceMethod = 'coordinates'
    backend.probe.hitTestOwnWindow = false
    let observation = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
    let result = await controller.dispatch({
      actionId: 'bad-hit-test', browserTaskId: 'bt-1', runId: 'run-1', action: 'click',
      observationId: observation.observationId, elementRef: observation.elements[0]!.elementRef,
    })
    expect(result.status).toBe('blocked')
    expect(result.reason).toBe('hit-test-mismatch')
    expect(backend.commitCount).toBe(0)

    backend.probe.hitTestOwnWindow = true
    observation = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
    result = await controller.dispatch({
      actionId: 'good-hit-test', browserTaskId: 'bt-1', runId: 'run-1', action: 'click',
      observationId: observation.observationId, elementRef: observation.elements[0]!.elementRef,
    })
    expect(result.status).toBe('verified')
    expect(backend.commitCount).toBe(1)
  })

  it('omits password elements and suppresses their screenshot surface', async () => {
    backend.observation.elements.push({
      backendRef: 'uia:password', role: 'textbox', label: 'Password',
      semanticFingerprint: 'b'.repeat(64),
      isPassword: true, supportedActions: ['type'],
    })
    backend.observation.screenshotDataUrl = 'data:image/png;base64,secret-pixels'
    const observation = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
    expect(observation.elements).toHaveLength(1)
    expect(observation.screenshotDataUrl).toBeNull()
    expect(observation.omissions).toContain('password-surface')
    expect(JSON.stringify(observation)).not.toContain('uia:password')
  })

  it.each(['API key', 'Access token', 'Client secret'])(
    'omits credential-labelled controls and suppresses screenshots: %s',
    async label => {
      backend.observation.elements[0]!.label = label
      backend.observation.text = `${label} ABCDEFGHIJKLMNOPQRST`
      backend.observation.screenshotDataUrl = 'data:image/png;base64,credential-pixels'
      const observation = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })

      expect(observation.elements).toEqual([])
      expect(observation.screenshotDataUrl).toBeNull()
      expect(observation.text).toBe('')
      expect(observation.omissions).toContain('credential-surface')
      expect(JSON.stringify(observation)).not.toContain(label)
    },
  )

  it('blocks recognizable secret text before prepare while ordinary text still works', async () => {
    await enableUnverifiedGlobalInputForTest()
    let observation = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
    const blocked = await controller.dispatch({
      actionId: 'secret-input-blocked', browserTaskId: 'bt-1', runId: 'run-1', action: 'type',
      observationId: observation.observationId, elementRef: observation.elements[0]!.elementRef,
      text: 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789',
    })
    expect(blocked.status).toBe('blocked')
    expect(blocked.reason).toBe('secret-input')
    expect(backend.prepareCount).toBe(0)

    observation = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
    const ordinary = await controller.dispatch({
      actionId: 'ordinary-input-allowed', browserTaskId: 'bt-1', runId: 'run-1', action: 'type',
      observationId: observation.observationId, elementRef: observation.elements[0]!.elementRef,
      text: 'hello',
    })
    expect(ordinary.status).toBe('verified')
  })

  it('keeps the observed ValuePattern state private and pins it into helper prepare', async () => {
    const privateValueState = { fingerprint: 'c'.repeat(64), scalarLength: 3 }
    Object.assign(backend.observation.elements[0]!, { valueState: privateValueState })
    const observation = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })

    const result = await controller.dispatch({
      actionId: 'value-state-pinned', browserTaskId: 'bt-1', runId: 'run-1', action: 'type',
      observationId: observation.observationId, elementRef: observation.elements[0]!.elementRef,
      text: 'hello',
    })

    expect(result.status).toBe('verified')
    expect(backend.lastPrepare?.resolvedElement?.expectedValueState).toEqual(privateValueState)
    expect(JSON.stringify(observation)).not.toContain(privateValueState.fingerprint)
    expect(JSON.stringify(result)).not.toContain(privateValueState.fingerprint)
    expect(JSON.stringify(storage.getAction('value-state-pinned'))).not.toContain(privateValueState.fingerprint)
  })

  it('rejects a helper-claimed type effect when fresh observation has the wrong final value token', async () => {
    const initial = { fingerprint: 'c'.repeat(64), scalarLength: 0 }
    Object.assign(backend.observation.elements[0]!, { valueState: initial })
    const observation = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
    const originalCommit = backend.commitAction.bind(backend)
    backend.commitAction = async (prepared, options) => {
      const committed = await originalCommit(prepared, options)
      backend.observation.elements[0]!.valueState = { ...initial }
      return committed
    }

    const result = await controller.dispatch({
      actionId: 'wrong-final-value-state', browserTaskId: 'bt-1', runId: 'run-1', action: 'type',
      observationId: observation.observationId, elementRef: observation.elements[0]!.elementRef,
      text: 'hello',
    })

    expect(result).toMatchObject({ status: 'uncertain', reason: 'readback-mismatch' })
  })

  it('blocks keys outside the explicit navigation allowlist', async () => {
    const observation = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
    const privateKey = 'PRIVATE_DESKTOP_MARKER'
    const result = await controller.dispatch({
      actionId: 'forbidden-key', browserTaskId: 'bt-1', runId: 'run-1', action: 'key',
      observationId: observation.observationId, elementRef: observation.elements[0]!.elementRef,
      key: privateKey as 'Enter',
    })
    expect(result.status).toBe('blocked')
    expect(result.reason).toBe('invalid-key')
    expect(storage.getAction('forbidden-key')).toBeNull()
    expect(JSON.stringify(storage.listActions('bt-1'))).not.toContain(privateKey)
    expect(backend.prepareCount).toBe(0)
  })

  it('requires an elementRef for key and routes an allowlisted key through SendInput', async () => {
    await enableUnverifiedGlobalInputForTest()
    const observation = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
    const missingElement = await controller.dispatch({
      actionId: 'key-without-element', browserTaskId: 'bt-1', runId: 'run-1', action: 'key',
      observationId: observation.observationId, key: 'Enter',
    })
    expect(missingElement.status).toBe('blocked')
    expect(missingElement.reason).toBe('invalid-element-ref')
    expect(backend.prepareCount).toBe(0)

    const result = await controller.dispatch({
      actionId: 'element-key', browserTaskId: 'bt-1', runId: 'run-1', action: 'key',
      observationId: observation.observationId, elementRef: observation.elements[0]!.elementRef,
      key: 'Enter',
    })
    expect(result.status).toBe('verified')
    expect(backend.lastPrepare?.resolvedElement?.backendRef).toMatch(/^uia:editor:observation-\d+$/)
    expect(backend.lastPrepare?.uiaRequired).toBe(false)
    expect(backend.lastPrepared?.method).toBe('send-input')
  })

  it('requires an elementRef for scroll and fresh own-HWND hit-test before fallback', async () => {
    await enableUnverifiedGlobalInputForTest()
    backend.observation.elements[0]!.supportedActions = []
    backend.forceMethod = 'send-input'
    backend.probe.hitTestOwnWindow = false
    const observation = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
    const missingElement = await controller.dispatch({
      actionId: 'scroll-without-element', browserTaskId: 'bt-1', runId: 'run-1', action: 'scroll',
      observationId: observation.observationId, deltaY: 1,
    })
    expect(missingElement.status).toBe('blocked')
    expect(missingElement.reason).toBe('invalid-element-ref')
    expect(backend.prepareCount).toBe(0)

    const result = await controller.dispatch({
      actionId: 'scroll-hit-test', browserTaskId: 'bt-1', runId: 'run-1', action: 'scroll',
      observationId: observation.observationId, elementRef: observation.elements[0]!.elementRef,
      deltaY: 1,
    })
    expect(result.status).toBe('blocked')
    expect(result.reason).toBe('hit-test-mismatch')
    expect(backend.commitCount).toBe(0)
  })

  it('blocks a zero-delta scroll before helper prepare', async () => {
    backend.observation.elements[0]!.supportedActions = ['scroll']
    const observation = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })

    const result = await controller.dispatch({
      actionId: 'zero-scroll', browserTaskId: 'bt-1', runId: 'run-1', action: 'scroll',
      observationId: observation.observationId, elementRef: observation.elements[0]!.elementRef,
      deltaX: 0, deltaY: 0,
    })

    expect(result).toMatchObject({ status: 'blocked', reason: 'invalid-action' })
    expect(backend.prepareCount).toBe(0)
    expect(backend.commitCount).toBe(0)
  })

  it('rejects a non-discrete scroll before prepare and verifies one UIA small step', async () => {
    backend.observation.elements[0]!.supportedActions = ['scroll']
    const observation = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
    const oversized = await controller.dispatch({
      actionId: 'oversized-scroll', browserTaskId: 'bt-1', runId: 'run-1', action: 'scroll',
      observationId: observation.observationId, elementRef: observation.elements[0]!.elementRef,
      deltaX: 0, deltaY: 2_000,
    })
    expect(oversized).toMatchObject({ status: 'blocked', reason: 'invalid-action' })
    expect(backend.prepareCount).toBe(0)
    expect(backend.commitCount).toBe(0)

    const oneStep = await controller.dispatch({
      actionId: 'one-step-scroll', browserTaskId: 'bt-1', runId: 'run-1', action: 'scroll',
      observationId: observation.observationId, elementRef: observation.elements[0]!.elementRef,
      deltaX: 0, deltaY: 1,
    })
    expect(oneStep).toMatchObject({ status: 'verified' })
    expect(backend.lastPrepare?.action).toEqual({ kind: 'scroll', deltaX: 0, deltaY: 1 })
  })

  it('keeps ScrollPattern state private and rejects an opposite post direction', async () => {
    const privateScrollState = { horizontalPercent: 40, verticalPercent: 50 }
    backend.observation.elements[0]!.supportedActions = ['scroll']
    Object.assign(backend.observation.elements[0]!, { scrollState: privateScrollState })
    const observation = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
    const originalCommit = backend.commitAction.bind(backend)
    backend.commitAction = async (prepared, options) => {
      const committed = await originalCommit(prepared, options)
      Object.assign(backend.observation.elements[0]!, {
        scrollState: { horizontalPercent: 40, verticalPercent: 45 },
      })
      return committed
    }

    const result = await controller.dispatch({
      actionId: 'opposite-scroll', browserTaskId: 'bt-1', runId: 'run-1', action: 'scroll',
      observationId: observation.observationId, elementRef: observation.elements[0]!.elementRef,
      deltaY: 1,
    })

    expect(backend.lastPrepare?.resolvedElement?.expectedScrollState).toEqual(privateScrollState)
    expect(result).toMatchObject({ status: 'uncertain', reason: 'readback-mismatch' })
    expect(JSON.stringify(observation)).not.toContain('horizontalPercent')
    expect(JSON.stringify(storage.getAction('opposite-scroll'))).not.toContain('verticalPercent')
  })

  it('rejects movement on an unrequested ScrollPattern axis', async () => {
    backend.observation.elements[0]!.supportedActions = ['scroll']
    Object.assign(backend.observation.elements[0]!, {
      scrollState: { horizontalPercent: 40, verticalPercent: 50 },
    })
    const observation = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
    const originalCommit = backend.commitAction.bind(backend)
    backend.commitAction = async (prepared, options) => {
      const committed = await originalCommit(prepared, options)
      backend.observation.elements[0]!.scrollState!.horizontalPercent = 41
      return committed
    }

    const result = await controller.dispatch({
      actionId: 'cross-axis-scroll', browserTaskId: 'bt-1', runId: 'run-1', action: 'scroll',
      observationId: observation.observationId, elementRef: observation.elements[0]!.elementRef,
      deltaX: 0, deltaY: 1,
    })

    expect(result).toMatchObject({ status: 'uncertain', reason: 'readback-mismatch' })
  })

  it('accepts own LASTINPUT advance only when helper readback pins the post epoch', async () => {
    await enableUnverifiedGlobalInputForTest()
    backend.observation.elements[0]!.supportedActions = []
    backend.forceMethod = 'coordinates'
    const observation = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
    const originalCommit = backend.commitAction.bind(backend)
    backend.commitAction = async (prepared, options) => {
      const value = await originalCommit(prepared, options)
      backend.probe.userInputEpoch += 1
      return {
        ...value,
        readback: { ...value.readback, postUserInputEpoch: backend.probe.userInputEpoch },
      } as typeof value
    }
    const result = await controller.dispatch({
      actionId: 'own-input-epoch', browserTaskId: 'bt-1', runId: 'run-1', action: 'click',
      observationId: observation.observationId, elementRef: observation.elements[0]!.elementRef,
    })
    expect(result.status).toBe('verified')
  })

  it('blocks an expired observation before backend or durable action access', async () => {
    await controller.shutdown()
    let clock = 10_000
    backend = new FakeComputerBackend()
    controller = createComputerController({
      storage,
      backend,
      now: () => clock,
      maxSnapshotAgeMs: 100,
    })
    const [candidate] = await controller.listCandidates()
    await controller.bindCandidate(candidate!.candidateId)
    expect(controller.authorizeRun({ browserTaskId: 'bt-1', runId: 'run-1' }).ok).toBe(true)
    const observation = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
    const probesBefore = backend.probeCount
    clock += 100

    const result = await controller.dispatch({
      actionId: 'expired-observation', browserTaskId: 'bt-1', runId: 'run-1', action: 'click',
      observationId: observation.observationId, elementRef: observation.elements[0]!.elementRef,
    })
    expect(result.status).toBe('blocked')
    expect(result.reason).toBe('stale-observation')
    expect(backend.probeCount).toBe(probesBefore)
    expect(backend.prepareCount).toBe(0)
    expect(storage.getAction('expired-observation')).toBeNull()
  })
})
