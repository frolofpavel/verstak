import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { randomBytes } from 'crypto'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ChatEvent, ChatProvider } from '../../electron/ai/types'

// Закрытие хоста при живых прогонах. Находка пришла как «тест падает под параллелью»
// («database connection is not open»), но продуктовый хвост тяжелее теста: на деплое
// SIGTERM закрывал sqlite под работающими задачами людей — финализация не дописывала
// статус, и задача оставалась 'running' до следующего reconcileStale.
vi.mock('electron', () => {
  throw new Error("Cannot find module 'electron' (headless Node)")
})

const { createHeadlessHost } = await import('../../electron/headless/host')
const { createAesGcmSafeStorage } = await import('../../electron/headless/secure-storage')
const { openDb } = await import('../../electron/storage/db')

/**
 * Провайдер, замерший до открытия ворот: даёт прогону быть ЗАВЕДОМО живым в момент
 * close(). Сигнал отмены слушает — как настоящие API-провайдеры, отдающие signal в fetch;
 * провайдер, игнорирующий abort, мерил бы не остановку, а собственную глухоту.
 */
function gatedProvider(gate: Promise<void>, entered: () => void, signal?: AbortSignal): ChatProvider {
  return {
    id: 'gated', name: 'gated', models: ['gated'],
    async *send(): AsyncGenerator<ChatEvent> {
      entered()
      await Promise.race([
        gate,
        new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }))
      ])
      if (signal?.aborted) return
      yield { type: 'text', text: 'досчитал' }
      yield { type: 'done' }
    }
  }
}

describe('headless host — close() не рвёт БД под живыми прогонами', () => {
  let root: string

  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'vsk-close-')) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  async function boot(makeProvider: (signal: AbortSignal) => ChatProvider) {
    const dataDir = join(root, 'data')
    const workspaceRoot = join(root, 'ws')
    mkdirSync(workspaceRoot, { recursive: true })
    const host = await createHeadlessHost({
      dataDir,
      workspaceRoots: [workspaceRoot],
      safeStorage: createAesGcmSafeStorage(randomBytes(32)),
      env: {},
      providerFactory: (_id, _model, signal) => makeProvider(signal)
    })
    return { host, dbPath: join(dataDir, 'verstak.db') }
  }

  /** Статус прогона из ОТДЕЛЬНОГО соединения — то, что реально осело на диске. */
  function statusOnDisk(dbPath: string, runId: string): string | null {
    const db = openDb(dbPath)
    try {
      const row = db.prepare('SELECT status FROM agent_runs WHERE run_id = ?').get(runId) as { status: string } | undefined
      return row?.status ?? null
    } finally {
      db.close()
    }
  }

  it('close() ДОЖИДАЕТСЯ активного прогона: задача дописывает статус, а не остаётся «running» навсегда', async () => {
    let open: () => void = () => {}
    const gate = new Promise<void>(r => { open = r })
    let entered: () => void = () => {}
    const inProvider = new Promise<void>(r => { entered = r })
    const { host, dbPath } = await boot(signal => gatedProvider(gate, () => entered(), signal))

    const task = await host.startTask({ prompt: 'считай долго', agentMode: 'bypass', providerId: 'deepseek' })
    await inProvider // прогон ЗАВЕДОМО в работе — не гадаем по таймеру
    expect(statusOnDisk(dbPath, task.runId)).toBe('running')

    // Ворота откроются уже ПОСЛЕ вызова close(): без ожидания хост закроет БД раньше,
    // чем прогон допишет хвост, и статус останется 'running'.
    setTimeout(() => open(), 50)
    await host.close()

    expect(statusOnDisk(dbPath, task.runId)).toBe('done')
  }, 20_000)

  it('КОНТРОЛЬНЫЙ КЕЙС: без активных прогонов close() возвращается сразу, а не спит таймаут', async () => {
    const { host } = await boot(() => ({
      id: 'x', name: 'x', models: ['x'],
      // eslint-disable-next-line require-yield -- провайдер не зовётся в этом кейсе
      async *send(): AsyncGenerator<ChatEvent> { return }
    }))
    const started = Date.now()
    await host.close({ timeoutMs: 10_000 })
    // Заметно меньше и таймаута ожидания, и бюджета теста: close() не «всегда ждёт».
    expect(Date.now() - started).toBeLessThan(1_000)
  }, 20_000)

  it('КОНТРОЛЬНЫЙ КЕЙС: таймаут ОГРАНИЧИВАЕТ ожидание — прогон, который не кончается, не вешает close()', async () => {
    // Ворота не откроются никогда: без ограничения close() ждал бы вечно.
    const gate = new Promise<void>(() => {})
    let entered: () => void = () => {}
    const inProvider = new Promise<void>(r => { entered = r })
    const { host, dbPath } = await boot(signal => gatedProvider(gate, () => entered(), signal))

    const task = await host.startTask({ prompt: 'зависшая задача', agentMode: 'bypass', providerId: 'deepseek' })
    await inProvider

    const started = Date.now()
    await host.close({ timeoutMs: 200 })
    const elapsed = Date.now() - started
    expect(elapsed).toBeLessThan(8_000)

    // И статус честный: прогон прерван, а не «running» навечно. Тихая деградация
    // («висит вечно») хуже прерванной задачи с видимым исходом.
    expect(['stopped', 'interrupted', 'failed', 'done']).toContain(statusOnDisk(dbPath, task.runId))
  }, 20_000)
})
