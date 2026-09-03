import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const createTenantRegistryMock = vi.hoisted(() => vi.fn())
const createHeadlessServerMock = vi.hoisted(() => vi.fn())

vi.mock('electron', () => {
  throw new Error("Cannot find module 'electron' (headless Node)")
})

vi.mock('../../electron/headless/tenants', () => ({
  createTenantRegistry: createTenantRegistryMock,
}))

vi.mock('../../electron/headless/server', () => ({
  createHeadlessServer: createHeadlessServerMock,
}))

vi.mock('../../electron/headless/secure-storage', () => ({
  createAesGcmSafeStorage: vi.fn(),
  masterKeyFromEnv: vi.fn(() => Buffer.alloc(32)),
}))

vi.mock('../../electron/runtime-log', () => ({
  configureRuntimeLogDir: vi.fn(),
  logRuntime: vi.fn(),
}))

process.env.VERSTAK_HEADLESS_NO_AUTOSTART = '1'
const { main } = await import('../../electron/headless/bin')

describe('headless bin schedule gate', () => {
  let root: string
  let oldDataRoot: string | undefined
  let oldPort: string | undefined
  let oldSchedules: string | undefined

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'vsk-bin-schedule-'))
    oldDataRoot = process.env.VERSTAK_DATA_ROOT
    oldPort = process.env.VERSTAK_AGENT_PORT
    oldSchedules = process.env.VERSTAK_ENABLE_SCHEDULES
    process.env.VERSTAK_DATA_ROOT = root
    process.env.VERSTAK_AGENT_PORT = '0'
    delete process.env.VERSTAK_SINGLE_TENANT
    createTenantRegistryMock.mockReset()
    createHeadlessServerMock.mockReset()
    createTenantRegistryMock.mockImplementation(() => ({ closeAll: vi.fn(async () => {}) }))
    createHeadlessServerMock.mockImplementation(() => ({
      listen: vi.fn(async () => 0),
      close: vi.fn(async () => {}),
      httpServer: { closeAllConnections: vi.fn() },
    }))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    if (oldDataRoot === undefined) delete process.env.VERSTAK_DATA_ROOT
    else process.env.VERSTAK_DATA_ROOT = oldDataRoot
    if (oldPort === undefined) delete process.env.VERSTAK_AGENT_PORT
    else process.env.VERSTAK_AGENT_PORT = oldPort
    if (oldSchedules === undefined) delete process.env.VERSTAK_ENABLE_SCHEDULES
    else process.env.VERSTAK_ENABLE_SCHEDULES = oldSchedules
    vi.restoreAllMocks()
    rmSync(root, { recursive: true, force: true })
  })

  it('default-off stops the scheduler loop while explicit opt-in restores it', async () => {
    delete process.env.VERSTAK_ENABLE_SCHEDULES
    const disabled = await main()
    await disabled.close()

    process.env.VERSTAK_ENABLE_SCHEDULES = '1'
    const enabled = await main()
    await enabled.close()

    const disabledDefaults = createTenantRegistryMock.mock.calls[0]?.[0]?.hostDefaults
    const enabledDefaults = createTenantRegistryMock.mock.calls[1]?.[0]?.hostDefaults
    expect(disabledDefaults).toMatchObject({
      enableScheduledTasks: false,
      schedulerPollMs: null,
    })
    expect(enabledDefaults.enableScheduledTasks).toBe(true)
    expect(enabledDefaults.schedulerPollMs).toBeUndefined()
  })
})
