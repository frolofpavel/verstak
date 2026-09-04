import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { randomBytes } from 'crypto'
import { tmpdir } from 'os'
import { join } from 'path'

const createHeadlessHostMock = vi.hoisted(() => vi.fn())

vi.mock('electron', () => {
  throw new Error("Cannot find module 'electron' (headless Node)")
})

vi.mock('../../electron/headless/host', () => ({
  createHeadlessHost: createHeadlessHostMock,
  createHeadlessRunCapacity: (limit: number) => {
    let active = 0
    return {
      limit,
      tryAcquire: () => {
        if (active >= limit) return null
        active += 1
        let released = false
        return {
          release: () => {
            if (released) return
            released = true
            active -= 1
          },
        }
      },
      activeCount: () => active,
    }
  },
}))

const { createTenantRegistry } = await import('../../electron/headless/tenants')

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

interface FakeHostActivity {
  active: number
  starting: number
  inFlight: number
  scheduled: number
  closing: boolean
}

function fakeHost(
  id: string,
  initial: Partial<FakeHostActivity> = {},
  closeImpl: (opts?: { timeoutMs?: number }) => Promise<void> = async () => undefined,
) {
  const activity: FakeHostActivity = {
    active: 0,
    starting: 0,
    inFlight: 0,
    scheduled: 0,
    closing: false,
    ...initial,
  }
  return {
    id,
    activity,
    canEvictIdle: vi.fn(() => (
      !activity.closing
      && activity.active === 0
      && activity.starting === 0
      && activity.inFlight === 0
      && activity.scheduled === 0
    )),
    close: vi.fn(async (opts?: { timeoutMs?: number }) => {
      activity.closing = true
      await closeImpl(opts)
    }),
  }
}

describe('tenant registry single-flight', () => {
  let root: string
  let registry: ReturnType<typeof createTenantRegistry>
  let releases: Array<() => void>

  beforeEach(() => {
    createHeadlessHostMock.mockReset()
    root = mkdtempSync(join(tmpdir(), 'vsk-tenant-flight-'))
    registry = createTenantRegistry({ root, masterKey: randomBytes(32) })
    releases = []
  })

  afterEach(async () => {
    for (const release of releases.splice(0)) release()
    await registry.closeAll()
    rmSync(root, { recursive: true, force: true })
  })

  it('parallel first get for one tenant shares one initialization and one handle', async () => {
    const init = deferred<ReturnType<typeof fakeHost>>()
    const host = fakeHost('same')
    createHeadlessHostMock.mockReturnValue(init.promise)

    const first = registry.get('same-tenant')
    const second = registry.get('same-tenant')

    expect(createHeadlessHostMock).toHaveBeenCalledTimes(1)

    init.resolve(host)
    const [a, b] = await Promise.all([first, second])
    releases.push(a.release, b.release)
    expect(a).not.toBe(b)
    expect(a.host).toBe(host)
    expect(b.host).toBe(host)
  })

  it('initialization of one tenant does not block another tenant', async () => {
    const slowInit = deferred<ReturnType<typeof fakeHost>>()
    const slowHost = fakeHost('slow')
    const fastHost = fakeHost('fast')
    createHeadlessHostMock.mockReturnValueOnce(slowInit.promise).mockResolvedValueOnce(fastHost)

    const slow = registry.get('slow-tenant')
    const fast = registry.get('fast-tenant')

    const fastResult = await expect(
      Promise.race([
        fast,
        new Promise((_, reject) => setTimeout(() => reject(new Error('fast tenant was blocked')), 100)),
      ]),
    ).resolves.toMatchObject({ host: fastHost })
    void fastResult
    expect(createHeadlessHostMock).toHaveBeenCalledTimes(2)

    slowInit.resolve(slowHost)
    const [slowLease, fastLease] = await Promise.all([slow, fast])
    releases.push(slowLease.release, fastLease.release)
    expect(slowLease.host).toBe(slowHost)
  })

  it('failed initialization is removed so the next get can retry', async () => {
    await registry.closeAll()
    registry = createTenantRegistry({ root, masterKey: randomBytes(32), maxTenantHosts: 1 })
    const recoveredHost = fakeHost('recovered')
    createHeadlessHostMock.mockRejectedValueOnce(new Error('init failed')).mockResolvedValueOnce(recoveredHost)

    await expect(registry.get('retry-tenant')).rejects.toThrow('init failed')
    // При cap=1 неудачный pending init обязан освободить ровно тот же host slot.
    const recovered = await registry.get('another-tenant')
    releases.push(recovered.release)
    expect(recovered.host).toBe(recoveredHost)
    expect(createHeadlessHostMock).toHaveBeenCalledTimes(2)
  })

  it('hard-caps ready plus pending tenant hosts and shares one global run limiter', async () => {
    await registry.closeAll()
    registry = createTenantRegistry({
      root,
      masterKey: randomBytes(32),
      maxTenantHosts: 3,
      maxActiveRunsGlobal: 2,
    })
    createHeadlessHostMock.mockImplementation(async (_opts: unknown) => fakeHost('bounded'))

    const attempts = Array.from({ length: 10 }, (_, i) => registry.get(`tenant-${i}`))
    const settled = await Promise.allSettled(attempts)
    for (const result of settled) {
      if (result.status === 'fulfilled') releases.push(result.value.release)
    }
    expect(settled.filter(result => result.status === 'fulfilled')).toHaveLength(3)
    const rejected = settled.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    )
    expect(rejected).toHaveLength(7)
    expect(rejected.every(result => String(result.reason).includes('HEADLESS_TENANT_HOST_CAPACITY'))).toBe(true)
    expect(createHeadlessHostMock).toHaveBeenCalledTimes(3)

    // Полный cache не ломает уже открытого тенанта и не создаёт второй SQLite handle.
    const existing = await registry.get('tenant-0')
    releases.push(existing.release)
    expect(existing.host).toBe((settled[0] as PromiseFulfilledResult<{ host: unknown }>).value.host)
    expect(createHeadlessHostMock).toHaveBeenCalledTimes(3)

    const options = createHeadlessHostMock.mock.calls.map(call => call[0] as {
      globalRunCapacity: { limit: number }
    })
    expect(options.map(option => option.globalRunCapacity.limit)).toEqual([2, 2, 2])
    expect(new Set(options.map(option => option.globalRunCapacity)).size).toBe(1)
  })

  it('evicts the least-recent idle host, serves more than the cap sequentially, and reopens persisted tenant paths', async () => {
    await registry.closeAll()
    registry = createTenantRegistry({
      root,
      masterKey: randomBytes(32),
      maxTenantHosts: 2,
    })
    const created: Array<{
      host: ReturnType<typeof fakeHost>
      dataDir: string
      workspaceRoots: string[]
    }> = []
    createHeadlessHostMock.mockImplementation(async (options: {
      dataDir: string
      workspaceRoots: string[]
    }) => {
      const host = fakeHost(`host-${created.length + 1}`)
      created.push({ host, dataDir: options.dataDir, workspaceRoots: options.workspaceRoots })
      return host
    })

    const tenantA = await registry.get('tenant-a')
    const firstAHost = tenantA.host
    tenantA.release()
    const tenantB = await registry.get('tenant-b')
    const firstBHost = tenantB.host
    tenantB.release()

    const tenantC = await registry.get('tenant-c')
    tenantC.release()
    expect(firstAHost.close).toHaveBeenCalledTimes(1)
    expect(firstBHost.close).not.toHaveBeenCalled()
    expect(created).toHaveLength(3)

    const reopenedA = await registry.get('tenant-a')
    releases.push(reopenedA.release)
    expect(reopenedA.host).not.toBe(firstAHost)
    expect(firstBHost.close).toHaveBeenCalledTimes(1)
    expect(created).toHaveLength(4)
    // tenantId -> hashed stable path: eviction closes handles, not durable data.
    expect(created[3].dataDir).toBe(created[0].dataDir)
    expect(created[3].workspaceRoots).toEqual(created[0].workspaceRoots)
  })

  it('never evicts request-leased, active, starting, idempotency-in-flight, or scheduled hosts', async () => {
    await registry.closeAll()
    registry = createTenantRegistry({
      root,
      masterKey: randomBytes(32),
      maxTenantHosts: 5,
    })
    const made: ReturnType<typeof fakeHost>[] = []
    createHeadlessHostMock.mockImplementation(async () => {
      const host = fakeHost(`protected-${made.length + 1}`)
      made.push(host)
      return host
    })

    const leased = await registry.get('leased')
    releases.push(leased.release)
    const active = await registry.get('active')
    active.release()
    made[1].activity.active = 1
    const starting = await registry.get('starting')
    starting.release()
    made[2].activity.starting = 1
    const inFlight = await registry.get('in-flight')
    inFlight.release()
    made[3].activity.inFlight = 1
    const scheduled = await registry.get('scheduled')
    scheduled.release()
    made[4].activity.scheduled = 1

    await expect(registry.get('blocked-newcomer'))
      .rejects.toThrow('HEADLESS_TENANT_HOST_CAPACITY')
    expect(made.every(host => host.close.mock.calls.length === 0)).toBe(true)
    expect(createHeadlessHostMock).toHaveBeenCalledTimes(5)
  })

  it('reserves evicted slots synchronously so concurrent newcomers never exceed the cap', async () => {
    await registry.closeAll()
    registry = createTenantRegistry({
      root,
      masterKey: randomBytes(32),
      maxTenantHosts: 3,
    })
    const closeGates = [deferred<void>(), deferred<void>(), deferred<void>()]
    let liveHandles = 0
    let maxLiveHandles = 0
    let createdCount = 0
    const made: ReturnType<typeof fakeHost>[] = []
    createHeadlessHostMock.mockImplementation(async () => {
      const index = createdCount++
      liveHandles += 1
      maxLiveHandles = Math.max(maxLiveHandles, liveHandles)
      const closeImpl = async (): Promise<void> => {
        if (index < closeGates.length) await closeGates[index].promise
        liveHandles -= 1
      }
      const host = fakeHost(`concurrent-${index}`, {}, closeImpl)
      made.push(host)
      return host
    })

    for (const tenantId of ['old-a', 'old-b', 'old-c']) {
      const lease = await registry.get(tenantId)
      lease.release()
    }
    expect(liveHandles).toBe(3)

    const attempts = Array.from({ length: 10 }, (_, index) => registry.get(`new-${index}`))
    // All three victims are removed/reserved before any async close completes.
    expect(made.slice(0, 3).map(host => host.close.mock.calls.length)).toEqual([1, 1, 1])
    expect(createHeadlessHostMock).toHaveBeenCalledTimes(3)

    for (const gate of closeGates) gate.resolve()
    const settled = await Promise.allSettled(attempts)
    const fulfilled = settled.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof registry.get>>> =>
        result.status === 'fulfilled'
    )
    const rejected = settled.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    )
    for (const result of fulfilled) releases.push(result.value.release)
    expect(fulfilled).toHaveLength(3)
    expect(rejected).toHaveLength(7)
    expect(rejected.every(result => String(result.reason).includes('HEADLESS_TENANT_HOST_CAPACITY'))).toBe(true)
    expect(createHeadlessHostMock).toHaveBeenCalledTimes(6)
    expect(maxLiveHandles).toBeLessThanOrEqual(3)
  })

  it('closeAll racing an eviction waits for the victim and does not open the replacement', async () => {
    await registry.closeAll()
    registry = createTenantRegistry({
      root,
      masterKey: randomBytes(32),
      maxTenantHosts: 1,
    })
    const victimClose = deferred<void>()
    const victim = fakeHost('victim', {}, async () => victimClose.promise)
    createHeadlessHostMock.mockResolvedValueOnce(victim)

    const first = await registry.get('first')
    first.release()
    const replacement = registry.get('replacement')
    const replacementRejected = expect(replacement).rejects.toThrow('реестр тенантов закрыт')
    const closing = registry.closeAll({ timeoutMs: 654 })

    expect(victim.close).toHaveBeenCalledTimes(1)
    victimClose.resolve()
    await replacementRejected
    await closing
    expect(createHeadlessHostMock).toHaveBeenCalledTimes(1)
  })

  it('closeAll waits for pending initialization and closes the late host exactly once', async () => {
    const init = deferred<ReturnType<typeof fakeHost>>()
    const lateHost = fakeHost('late')
    createHeadlessHostMock.mockReturnValue(init.promise)

    const getResult = registry.get('late-tenant')
    const rejectedGet = expect(getResult).rejects.toThrow('реестр тенантов закрыт')
    const closing = registry.closeAll({ timeoutMs: 321 })

    init.resolve(lateHost)
    await rejectedGet
    await closing
    expect(lateHost.close).toHaveBeenCalledTimes(1)
    expect(lateHost.close).toHaveBeenCalledWith({ timeoutMs: 321 })
    await expect(registry.get('after-close')).rejects.toThrow('реестр тенантов закрыт')
    expect(createHeadlessHostMock).toHaveBeenCalledTimes(1)
  })

  it('does not evict a newly published host before the first request lease is acquired', async () => {
    const raceRegistry = createTenantRegistry({
      root,
      masterKey: randomBytes(32),
      maxTenantHosts: 1,
    })
    const firstHost = fakeHost('first-published')
    const secondHost = fakeHost('must-not-open')
    createHeadlessHostMock.mockResolvedValueOnce(firstHost).mockResolvedValueOnce(secondHost)

    const first = raceRegistry.get('first')
    const duplicate = raceRegistry.get('first')
    // createHeadlessHost resumes in the first microtask. The next one publishes the
    // entry/removes pendingHosts; this nested microtask lands before the creator's
    // tracked.then(acquire) callback and exercises that exact publication window.
    const newcomer = new Promise<Awaited<ReturnType<typeof raceRegistry.get>>>((resolve, reject) => {
      queueMicrotask(() => {
        queueMicrotask(() => { void raceRegistry.get('second').then(resolve, reject) })
      })
    })

    const [firstLease, duplicateLease] = await Promise.all([first, duplicate])
    await expect(newcomer).rejects.toThrow('HEADLESS_TENANT_HOST_CAPACITY')
    expect(firstLease.host).toBe(firstHost)
    expect(duplicateLease.host).toBe(firstHost)
    expect(firstHost.close).not.toHaveBeenCalled()
    expect(createHeadlessHostMock).toHaveBeenCalledTimes(1)

    firstLease.release()
    duplicateLease.release()
    await raceRegistry.closeAll()
  })

  it('waits for same-tenant retirement failure without evicting another healthy host', async () => {
    const raceRegistry = createTenantRegistry({
      root,
      masterKey: randomBytes(32),
      maxTenantHosts: 2,
    })
    const victimClose = deferred<void>()
    const victim = fakeHost('victim', {}, async () => victimClose.promise)
    const healthy = fakeHost('healthy')
    createHeadlessHostMock.mockResolvedValueOnce(victim).mockResolvedValueOnce(healthy)

    const victimLease = await raceRegistry.get('victim-tenant')
    victimLease.release()
    const healthyLease = await raceRegistry.get('healthy-tenant')
    healthyLease.release()

    const replacement = raceRegistry.get('new-tenant')
    const reopenedVictim = raceRegistry.get('victim-tenant')
    expect(victim.close).toHaveBeenCalledTimes(1)
    expect(healthy.close).not.toHaveBeenCalled()

    victimClose.reject(new Error('victim close failed'))
    await expect(replacement).rejects.toThrow('victim close failed')
    await expect(reopenedVictim).rejects.toThrow('victim close failed')
    expect(healthy.close).not.toHaveBeenCalled()
    expect(createHeadlessHostMock).toHaveBeenCalledTimes(2)
    await expect(raceRegistry.closeAll()).rejects.toThrow('victim close failed')
  })

  it('keeps a failed eviction accounted, blocks replacement handles, and surfaces close failure', async () => {
    const brokenRegistry = createTenantRegistry({
      root,
      masterKey: randomBytes(32),
      maxTenantHosts: 1,
    })
    const victim = fakeHost('close-failure', {}, async () => {
      throw new Error('close exploded')
    })
    createHeadlessHostMock.mockResolvedValueOnce(victim)

    const first = await brokenRegistry.get('victim')
    first.release()
    await expect(brokenRegistry.get('replacement')).rejects.toThrow('close exploded')

    // A failed close may have left the original SQLite/scheduler handle alive. The
    // registry must fail closed instead of forgetting it and opening a second handle.
    await expect(brokenRegistry.get('another'))
      .rejects.toThrow('HEADLESS_TENANT_HOST_CAPACITY')
    expect(createHeadlessHostMock).toHaveBeenCalledTimes(1)
    await expect(brokenRegistry.closeAll()).rejects.toThrow('close exploded')
  })

  it('counts a quarantined handle as one slot while keeping the remaining capacity usable', async () => {
    const boundedRegistry = createTenantRegistry({
      root,
      masterKey: randomBytes(32),
      maxTenantHosts: 2,
    })
    const quarantined = fakeHost('quarantined', {}, async () => {
      throw new Error('persistent close failure')
    })
    const healthy = fakeHost('healthy-old')
    const replacement = fakeHost('healthy-new')
    createHeadlessHostMock
      .mockResolvedValueOnce(quarantined)
      .mockResolvedValueOnce(healthy)
      .mockResolvedValueOnce(replacement)

    const oldA = await boundedRegistry.get('old-a')
    oldA.release()
    const oldB = await boundedRegistry.get('old-b')
    oldB.release()
    await expect(boundedRegistry.get('failed-newcomer'))
      .rejects.toThrow('persistent close failure')

    // old-a remains possibly alive in quarantine. Only old-b's one healthy slot may
    // now rotate; opening one replacement must not forget or overbook the orphan.
    const admitted = await boundedRegistry.get('admitted')
    expect(admitted.host).toBe(replacement)
    expect(healthy.close).toHaveBeenCalledTimes(1)
    await expect(boundedRegistry.get('over-cap'))
      .rejects.toThrow('HEADLESS_TENANT_HOST_CAPACITY')
    expect(createHeadlessHostMock).toHaveBeenCalledTimes(3)

    admitted.release()
    await expect(boundedRegistry.closeAll()).rejects.toThrow('persistent close failure')
  })
})
