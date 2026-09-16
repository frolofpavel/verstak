import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()

describe('Computer Use production bootstrap', () => {
  it('wires the packaged helper through the durable BrowserTasks ledger', () => {
    const source = readFileSync(join(ROOT, 'electron', 'main.ts'), 'utf8')
    const storage = source.indexOf('const browserTasks = createBrowserTasks(db)')
    const helper = source.indexOf('new ComputerHelperClient({')
    const backend = source.indexOf('createComputerHelperBackend(computerHelperClient)')
    const controller = source.indexOf('createComputerController({')
    const handler = source.indexOf('configureComputerHandler({ controller: computerController })')
    const ipc = source.indexOf('registerComputerUseIpc({')

    expect(storage).toBeGreaterThan(-1)
    expect(helper).toBeGreaterThan(storage)
    expect(backend).toBeGreaterThan(helper)
    expect(controller).toBeGreaterThan(backend)
    expect(handler).toBeGreaterThan(controller)
    expect(ipc).toBeGreaterThan(handler)
    expect(source.slice(controller, handler)).toContain('storage: browserTasks')
    expect(source.slice(controller, handler)).not.toContain('testOnlyAllowUnverifiedGlobalInput')
    expect(source).toContain('let browserActionsReconciled = false')
    expect(source).toContain('browserActionsReconciled = true')
    expect(source).toMatch(/computerUseSupported\s*&&\s*browserActionsReconciled\s*&&/u)
  })

  it('is Windows-only, resolves the packaged resource and shuts the helper down', () => {
    const source = readFileSync(join(ROOT, 'electron', 'main.ts'), 'utf8')
    expect(source).toContain("const computerUseSupported = process.platform === 'win32'")
    expect(source).toContain("join(process.resourcesPath, 'computer-use', 'helper.ps1')")
    expect(source).toContain("join(app.getAppPath(), 'resources', 'computer-use', 'helper.ps1')")
    expect(source).toContain('supported: computerUseSupported')
    expect(source).toContain('void computerController?.shutdown()')
  })

  it('waits for the exact Computer Stop ACK on task-manager and mobile Stop surfaces', () => {
    const source = readFileSync(join(ROOT, 'electron', 'main.ts'), 'utf8')
    const hasAckWiring = (value: string) => (
      /import\s*{[^}]*\babortSendAndWait\b[^}]*}\s*from\s*['"]\.\/ipc\/ai['"]/.test(value)
      && /stopRun:\s*async\s+runId\s*=>\s*abortSendAndWait\(Number\(runId\)\)/.test(value)
      && /registerAgentRunsIpc\([^\n]*\babortSendAndWait\b[^\n]*\)/.test(value)
    )
    expect(hasAckWiring(source)).toBe(true)

    const earlyAckMutation = source
      .replace('stopRun: async runId => abortSendAndWait(Number(runId))', 'stopRun: async runId => abortSend(Number(runId))')
      .replace(
        /registerAgentRunsIpc\(([^\n]*?),\s*abortSendAndWait,\s*agentRunsReconciledAt\)/,
        'registerAgentRunsIpc($1, abortSend, agentRunsReconciledAt)',
      )
    expect(earlyAckMutation).not.toBe(source)
    expect(hasAckWiring(earlyAckMutation)).toBe(false)
  })

  it('guards browser-sidepanel and headless Computer Use ingress before append/provider dispatch', () => {
    const mainSource = readFileSync(join(ROOT, 'electron', 'main.ts'), 'utf8')
    const sidepanelStart = mainSource.indexOf('onTaskSubmit: async (prompt) => {')
    const sidepanelGuard = mainSource.indexOf('isComputerUseComposerAttempt(prompt)', sidepanelStart)
    const sidepanelAppend = mainSource.indexOf("chats.appendToSession(chat.id, projectPath, 'user', prompt)", sidepanelStart)
    const sidepanelProvider = mainSource.indexOf('aiGateway.sendFromBrowser(', sidepanelStart)

    expect(sidepanelStart).toBeGreaterThan(-1)
    expect(sidepanelGuard).toBeGreaterThan(sidepanelStart)
    expect(sidepanelAppend).toBeGreaterThan(sidepanelGuard)
    expect(sidepanelProvider).toBeGreaterThan(sidepanelAppend)

    const headlessSource = readFileSync(join(ROOT, 'electron', 'headless', 'host.ts'), 'utf8')
    const taskStart = headlessSource.indexOf('async function startTaskOnce(')
    const taskGuard = headlessSource.indexOf('isComputerUseComposerAttempt(task.prompt)', taskStart)
    const taskProvider = headlessSource.indexOf('createProvider(', taskStart)
    const taskAppend = headlessSource.indexOf("chats.appendToSession(acceptedThread.id, workspace, 'user', task.prompt)", taskStart)

    expect(taskGuard).toBeGreaterThan(taskStart)
    expect(taskProvider).toBeGreaterThan(taskGuard)
    expect(taskAppend).toBeGreaterThan(taskGuard)
  })
})
