import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

/**
 * Интеграционные тесты оркестратора Dev Task Flow (Фаза 2): open → get переходы
 * и revert через тот же undo-стек. Мокаем electron.ipcMain.handle, ловим
 * хендлеры в Map, дёргаем напрямую против реального in-memory DB + UndoStack.
 *
 * Падают по ABI (NODE_MODULE_VERSION) вместе с остальными sqlite-тестами под
 * vitest/Node — это известный шум, не регрессия (см. CLAUDE.md п.3).
 *
 * projectRoot — НЕ git-репозиторий (temp dir), поэтому base_branch/base_sha = null
 * детерминированно (readGitBase ловит ошибку git).
 */

// Перехватываем регистрацию ipcMain.handle в Map<channel, handler>.
const handlers = new Map<string, (...args: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => { handlers.set(channel, fn) }
  }
}))

// Импортируем ПОСЛЕ vi.mock — иначе реальный electron подтянется.
const { openDb } = await import('../../electron/storage/db')
const { createDevTasks } = await import('../../electron/storage/dev-tasks')
const { createUndoStack } = await import('../../electron/storage/undo')
const { registerDevTaskIpc } = await import('../../electron/ipc/dev-task')
import type { DevTask } from '../../electron/storage/dev-tasks'

// Хелпер: вызвать хендлер канала с фейковым IpcMainInvokeEvent (первый арг).
function invoke<T>(channel: string, ...args: unknown[]): T {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`no handler for ${channel}`)
  return fn({} as unknown, ...args) as T
}

describe('dev-task ipc (Фаза 2)', () => {
  let dir: string
  let db: ReturnType<typeof openDb>
  let tasks: ReturnType<typeof createDevTasks>
  const auditEvents: Array<{ action: string; detail: string }> = []

  beforeEach(() => {
    handlers.clear()
    auditEvents.length = 0
    dir = mkdtempSync(join(tmpdir(), 'gg-devtask-ipc-'))
    db = openDb(join(dir, 'test.db'))
    tasks = createDevTasks(db)
    const undoStack = createUndoStack(db)
    // runCheck-заглушка — exit 0 (фаза 2 тесты не гоняют buildPackage с проверками).
    registerDevTaskIpc({
      tasks, getProjectRoot: () => dir, undoStack,
      runCheck: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      recordAudit: (action, detail) => auditEvents.push({ action, detail })
    })
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('open → get: создаёт draft с чекпоинтом, base=null (не git)', async () => {
    const task = await invoke<Promise<DevTask | null>>('devtask:open', { chatId: 3, title: 'Фича Y', risk: 'medium' })
    expect(task).not.toBeNull()
    expect(task!.state).toBe('draft')
    expect(task!.chatId).toBe(3)
    expect(task!.title).toBe('Фича Y')
    expect(task!.risk).toBe('medium')
    expect(task!.workBranch).toBeNull()       // Фаза 2: ветку не создаём
    expect(task!.baseBranch).toBeNull()       // temp dir не git → null
    expect(task!.baseSha).toBeNull()
    expect(task!.checkpointId).toBe(0)         // стек пуст на момент open → 0

    const detail = invoke<{ task: DevTask | null; checks: unknown[] }>('devtask:get', task!.id)
    expect(detail.task).not.toBeNull()
    expect(detail.task!.id).toBe(task!.id)
    expect(detail.checks).toEqual([])
  })

  it('open без title → null', async () => {
    const task = await invoke<Promise<DevTask | null>>('devtask:open', { title: '   ' })
    expect(task).toBeNull()
  })

  it('openFromPreflight: title = summary.slice(0,80), summary/risk перенесены', async () => {
    const longSummary = 'A'.repeat(120)
    const task = await invoke<Promise<DevTask | null>>('devtask:openFromPreflight', {
      chatId: 1,
      preflight: { summary: longSummary, risk: 'high', affectedZones: ['electron/'] }
    })
    expect(task).not.toBeNull()
    expect(task!.title.length).toBe(80)
    expect(task!.summary).toBe(longSummary)
    expect(task!.risk).toBe('high')
  })

  it('checkpointId фиксирует топ undo-стека на момент open', async () => {
    const undoStack = createUndoStack(db)
    undoStack.push(dir, 'a.txt', 'old', 'new')     // одна запись до open
    const top = undoStack.list(dir)[0].id
    const task = await invoke<Promise<DevTask | null>>('devtask:open', { title: 'T' })
    expect(task!.checkpointId).toBe(top)
  })

  it('revert: откатывает правки ПОСЛЕ чекпоинта через тот же undo-стек', async () => {
    const undoStack = createUndoStack(db)
    // open снимает checkpoint на пустом стеке → 0.
    const task = await invoke<Promise<DevTask | null>>('devtask:open', { title: 'Откат' })
    expect(task!.checkpointId).toBe(0)
    // Симулируем правку файла агентом: реальный файл + undo-запись.
    const file = join(dir, 'edited.txt')
    writeFileSync(file, 'НОВОЕ содержимое', 'utf8')
    undoStack.push(dir, 'edited.txt', null, 'НОВОЕ содержимое')  // before=null (файла не было) → revert удалит

    const ok = await invoke<Promise<boolean>>('devtask:revert', task!.id)
    expect(ok).toBe(true)
    // Файл должен быть удалён (before был пуст = файла не существовало).
    const { existsSync } = await import('fs')
    expect(existsSync(file)).toBe(false)
  })

  it('revert несуществующей задачи → false', async () => {
    const ok = await invoke<Promise<boolean>>('devtask:revert', 99999)
    expect(ok).toBe(false)
  })

  it('linkRun: идемпотентно связывает прогон с задачей', async () => {
    const task = await invoke<Promise<DevTask | null>>('devtask:open', { title: 'L' })
    invoke<void>('devtask:linkRun', task!.id, 'run-abc')
    invoke<void>('devtask:linkRun', task!.id, 'run-abc')  // повтор — без падения
    const rows = db.prepare('SELECT COUNT(*) as c FROM dev_task_runs WHERE dev_task_id = ?').get(task!.id) as { c: number }
    expect(rows.c).toBe(1)
  })

  it('list: новейшие первыми, фильтр по state', async () => {
    await invoke<Promise<DevTask | null>>('devtask:open', { title: 'Первая' })
    const second = await invoke<Promise<DevTask | null>>('devtask:open', { title: 'Вторая' })
    const all = invoke<DevTask[]>('devtask:list', dir)
    expect(all.length).toBe(2)
    expect(all[0].id).toBe(second!.id)  // DESC
    const drafts = invoke<DevTask[]>('devtask:list', dir, { state: 'draft' })
    expect(drafts.length).toBe(2)
    const committed = invoke<DevTask[]>('devtask:list', dir, { state: 'committed' })
    expect(committed.length).toBe(0)
  })

  // Ревью F2 (P0): backend DoD gate — commit поверх не-зелёных проверок.
  describe('devtask:commit DoD gate (F2)', () => {
    it('блокирует commit при failed check без overrideReason', async () => {
      const task = await invoke<Promise<DevTask | null>>('devtask:open', { title: 'gate' })
      tasks.addCheck(task!.id, { label: 'tsc', command: 'npm run type', status: 'fail', exitCode: 1 })
      const res = await invoke<Promise<{ ok: boolean; error?: string }>>('devtask:commit', task!.id, { message: 'wip' })
      expect(res.ok).toBe(false)
      expect(res.error).toMatch(/dod-gate/)
    })

    it('блокирует и при pending/running (проверки не завершены)', async () => {
      const task = await invoke<Promise<DevTask | null>>('devtask:open', { title: 'gate2' })
      tasks.addCheck(task!.id, { label: 'test', command: 'npm test', status: 'pending', exitCode: null })
      const res = await invoke<Promise<{ ok: boolean; error?: string }>>('devtask:commit', task!.id, { message: 'wip' })
      expect(res.ok).toBe(false)
      expect(res.error).toMatch(/dod-gate/)
    })

    it('с overrideReason gate пропускает (дальше падает уже на git, не на dod-gate)', async () => {
      const task = await invoke<Promise<DevTask | null>>('devtask:open', { title: 'gate3' })
      tasks.addCheck(task!.id, { label: 'tsc', command: 'npm run type', status: 'fail', exitCode: 1 })
      const res = await invoke<Promise<{ ok: boolean; error?: string }>>('devtask:commit', task!.id, { message: 'wip', overrideReason: 'срочный хотфикс' })
      // dir не git-репо → commit упадёт, но УЖЕ не на dod-gate (gate пройден).
      expect(res.error ?? '').not.toMatch(/dod-gate/)
    })

    it('зелёные проверки не блокируются gate', async () => {
      const task = await invoke<Promise<DevTask | null>>('devtask:open', { title: 'gate4' })
      tasks.addCheck(task!.id, { label: 'tsc', command: 'npm run type', status: 'pass', exitCode: 0 })
      const res = await invoke<Promise<{ ok: boolean; error?: string }>>('devtask:commit', task!.id, { message: 'wip' })
      expect(res.error ?? '').not.toMatch(/dod-gate/)
    })

    // Mandatory DoD mode (настройка dod_mode): off / block.
    function reRegister(dodMode: string) {
      handlers.clear()
      registerDevTaskIpc({
        tasks, getProjectRoot: () => dir, undoStack: createUndoStack(db),
        runCheck: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
        recordAudit: (action, detail) => auditEvents.push({ action, detail }),
        getSecret: (k) => (k === 'dod_mode' ? dodMode : null)
      })
    }

    it('dod_mode=off: красные проверки НЕ блокируют commit', async () => {
      const task = await invoke<Promise<DevTask | null>>('devtask:open', { title: 'off' })
      tasks.addCheck(task!.id, { label: 'tsc', command: 'x', status: 'fail', exitCode: 1 })
      reRegister('off')
      const res = await invoke<Promise<{ ok: boolean; error?: string }>>('devtask:commit', task!.id, { message: 'wip' })
      expect(res.error ?? '').not.toMatch(/dod-gate/)
    })

    it('dod_mode=block: overrideReason НЕ обходит — строгий блок', async () => {
      const task = await invoke<Promise<DevTask | null>>('devtask:open', { title: 'block' })
      tasks.addCheck(task!.id, { label: 'tsc', command: 'x', status: 'fail', exitCode: 1 })
      reRegister('block')
      const res = await invoke<Promise<{ ok: boolean; error?: string }>>('devtask:commit', task!.id, { message: 'wip', overrideReason: 'очень надо' })
      expect(res.ok).toBe(false)
      expect(res.error).toMatch(/Mandatory DoD = block/)
    })
  })

  // Ревью (тест-дыры): критичные пути Фазы 3-4 branch→package→PR без тестов.
  describe('branch / buildPackage / createPr (ревью — тест-дыры)', () => {
    it('setBranch: пишет workBranch + state→in_progress (раньше ветка=null навсегда)', async () => {
      const task = await invoke<Promise<DevTask | null>>('devtask:open', { title: 'ветка' })
      const after = invoke<DevTask | null>('devtask:setBranch', task!.id, 'verstak/feat-x')
      expect(after?.workBranch).toBe('verstak/feat-x')
      expect(after?.state).toBe('in_progress')
      // get подтверждает персист — кнопка «Создать PR» (гейт на workBranch) теперь достижима.
      const got = invoke<{ task: DevTask | null }>('devtask:get', task!.id)
      expect(got.task?.workBranch).toBe('verstak/feat-x')
    })

    it('buildPackage: гоняет проверки, замораживает пакет, state→packaged', async () => {
      const task = await invoke<Promise<DevTask | null>>('devtask:open', { title: 'пакет' })
      const pkg = await invoke<Promise<{ checks: unknown[]; changedFiles: unknown[] } | null>>('devtask:buildPackage', task!.id, { runChecks: true, checks: ['echo ok'] })
      expect(pkg).not.toBeNull()
      expect(Array.isArray(pkg!.checks)).toBe(true)
      const got = invoke<{ task: DevTask | null }>('devtask:get', task!.id)
      expect(got.task?.state).toBe('packaged')
    })

    it('createPr: без github-коннектора → connectors-unavailable (гейт)', async () => {
      const task = await invoke<Promise<DevTask | null>>('devtask:open', { title: 'pr' })
      const res = await invoke<Promise<{ ok: boolean; error?: string }>>('devtask:createPr', task!.id, { repo: 'o/r', base: 'main' })
      expect(res.ok).toBe(false)
      expect(res.error).toBe('connectors-unavailable')
    })

    it('createPr: с github-стабом, но без workBranch → no-work-branch', async () => {
      const task = await invoke<Promise<DevTask | null>>('devtask:open', { title: 'pr2' })
      // Перерегистрируем с github-стабами (гейт workBranch срабатывает ДО вызова коннектора).
      handlers.clear()
      registerDevTaskIpc({
        tasks, getProjectRoot: () => dir, undoStack: createUndoStack(db),
        runCheck: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
        connectorQuery: async () => ({ result: '{}' }),
        getSecret: (k) => (k === 'github_token' ? 'gho_test' : null)
      })
      const res = await invoke<Promise<{ ok: boolean; error?: string }>>('devtask:createPr', task!.id, { repo: 'o/r', base: 'main' })
      expect(res.error).toBe('no-work-branch')
    })

    it('createPr: workBranch есть, но repo/base пусты → repo-and-base-required', async () => {
      const task = await invoke<Promise<DevTask | null>>('devtask:open', { title: 'pr3' })
      invoke<DevTask | null>('devtask:setBranch', task!.id, 'verstak/x')
      handlers.clear()
      registerDevTaskIpc({
        tasks, getProjectRoot: () => dir, undoStack: createUndoStack(db),
        runCheck: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
        connectorQuery: async () => ({ result: '{}' }),
        getSecret: (k) => (k === 'github_token' ? 'gho_test' : null)
      })
      const res = await invoke<Promise<{ ok: boolean; error?: string }>>('devtask:createPr', task!.id, { repo: '', base: '' })
      expect(res.error).toBe('repo-and-base-required')
    })
  })
})
