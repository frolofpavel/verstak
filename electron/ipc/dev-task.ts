import { ipcMain } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import type { DevTasks, DevTask, DevTaskCheck } from '../storage/dev-tasks'
import type { UndoStack } from '../storage/undo'
import { revertToCheckpoint } from './undo'
import { gitBranchCreate, gitCommit, gitAdd, readDiffStat } from './git'
import { buildCommitPlan, type CommitGroup } from '../ai/commit-planner'
import { detectVerifyScriptsForHint } from '../ai/session-journal'

const execFileAsync = promisify(execFile)

/**
 * Dev Task Flow (Фаза 2) — оркестратор открытия задачи + наблюдение + откат.
 *
 * Тонкий слой поверх готовых dev_tasks (storage), undo/checkpoint (UndoStack) и
 * git READ. Один объект dev_task агрегирует чекпоинт, base_branch/base_sha,
 * привязанные прогоны. Агентный loop / system-layer НЕ трогаем — задача только
 * наблюдает существующие события.
 *
 * Фаза 2 ограничения (см. roadmap раздел 9):
 *   - ветку НЕ создаём (dirty-in-place, work_branch=null) — git-write это Фаза 3.
 *   - откат ТОЛЬКО через существующий undo:revertToCheckpoint (свой стек не заводим).
 *   - revert НЕ меняет state: откат файлов ≠ отмена задачи (задача остаётся
 *     активной, пользователь может продолжать работу или отменить вручную позже).
 *
 * Безопасность git: execFile('git', [...], {cwd}) без shell → нет command
 * injection (как в ipc/git.ts). Здесь только read-операции (branch / rev-parse).
 */

const GIT_TIMEOUT = 15_000

/** Результат прогона одной проверки (зеркало verify:exec). */
export interface CheckResult { exitCode: number; stdout: string; stderr: string }

export interface DevTaskDeps {
  tasks: DevTasks
  getProjectRoot: () => string | null
  undoStack: UndoStack
  /**
   * Прогон проверочной команды (та же семантика, что verify:exec — денилист +
   * secret-scanner внутри). Инжектится из main, чтобы не дублировать shell-логику.
   */
  runCheck: (command: string) => Promise<CheckResult>
  /** Доступ к коннекторам (для createPr → github create_pr). Опц. */
  connectorQuery?: (id: string, args: Record<string, unknown>) => Promise<unknown>
  /** Чтение секрета (например github_token). Опц. — нужен только для createPr. */
  getSecret?: (key: string) => string | null
  /** Ревью F2: запись в audit_log (commit-override поверх красных проверок). Опц. */
  recordAudit?: (action: string, detail: string) => void
}

/** Снимок git-базы на момент открытия задачи. */
interface GitBase {
  branch: string | null
  sha: string | null
}

/**
 * Текущая ветка + HEAD sha активного проекта. Read-only, argv-форма.
 * Не git-репозиторий / git не установлен → { null, null } (не падаем).
 */
async function readGitBase(cwd: string): Promise<GitBase> {
  // Под git-хуком (pre-commit) git сам выставляет GIT_DIR/GIT_INDEX_FILE; в linked
  // worktree путь абсолютный → git игнорирует cwd и отвечает про ЧУЖОЙ репозиторий
  // (не-git проект получил бы ветку приложения). Конвенция проекта — git-worktree.ts:27.
  const env = { ...process.env }
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR', 'GIT_PREFIX', 'GIT_NAMESPACE', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[k]
  const opts = { cwd, timeout: GIT_TIMEOUT, windowsHide: true, env }
  let branch: string | null = null
  let sha: string | null = null
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], opts)
    const b = String(stdout ?? '').trim()
    // 'HEAD' → detached, веткой не считаем.
    branch = b && b !== 'HEAD' ? b : null
  } catch { /* нет git / репозитория — branch остаётся null */ }
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], opts)
    const s = String(stdout ?? '').trim()
    sha = s || null
  } catch { /* нет коммитов / репозитория — sha остаётся null */ }
  return { branch, sha }
}

/** Состояния, при которых dev_task ещё «активна» (не финальная). */
export function isActiveDevTask(task: DevTask): boolean {
  return task.state !== 'committed' && task.state !== 'cancelled'
}

export interface DevTaskDetail {
  task: DevTask | null
  checks: DevTaskCheck[]
}

/** Замороженный пакет задачи (package_json) — снимок на момент packaged. */
export interface DevTaskPackage {
  changedFiles: { path: string; added: number; removed: number; status: string }[]
  checks: { label: string; command: string; status: string; exitCode: number | null }[]
  commitGroups: CommitGroup[]
  commitMessage: string
  prSummary: string
  risks: string[]
}

/**
 * slug из заголовка задачи для имени ветки: латиница/цифры/дефис, маленькими,
 * пробелы → дефис, кириллица/символы отбрасываются. Пусто → 'task'.
 */
function slugify(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-+|-+$)/g, '')
    .slice(0, 32)
  return s || 'task'
}

export function registerDevTaskIpc(deps: DevTaskDeps): void {
  const { tasks, getProjectRoot, undoStack, runCheck, connectorQuery, getSecret, recordAudit } = deps

  /**
   * Снять checkpoint текущего топа undo-стека — ТА ЖЕ семантика, что и
   * undo:checkpoint: id новейшей записи стека, либо 0 если стек пуст (0 ниже
   * любого реального autoincrement id, поэтому `id > 0` матчит все будущие
   * записи при откате). Переиспользуем UndoStack, не дублируем механизм.
   */
  function snapCheckpoint(projectPath: string): number {
    const list = undoStack.list(projectPath)
    return list.length > 0 ? list[0].id : 0
  }

  /**
   * Опц. создать рабочую ветку verstak/<slug>-<ts> на старте задачи (Фаза 3).
   * Возвращает имя ветки при успехе, иначе null (dirty-in-place fallback —
   * задача продолжает работать без ветки, не блокируем открытие).
   */
  async function maybeCreateBranch(projectPath: string, useBranch: boolean | undefined, title: string): Promise<string | null> {
    if (!useBranch) return null
    const name = `verstak/${slugify(title)}-${Date.now().toString(36)}`
    const res = await gitBranchCreate(projectPath, name)
    return res.ok ? (res.branch ?? name) : null
  }

  // devtask:open — открыть задачу: снять checkpoint, зафиксировать git-базу,
  // создать строку dev_tasks. useBranch=true → создаём ветку verstak/<slug>-<ts>
  // и переходим в 'in_progress'; иначе dirty-in-place (state='draft').
  ipcMain.handle('devtask:open', async (_e, opts: { chatId?: number | null; title: string; summary?: string | null; risk?: string | null; useBranch?: boolean }): Promise<DevTask | null> => {
    const projectPath = getProjectRoot()
    if (!projectPath) return null
    const title = String(opts?.title ?? '').trim()
    if (!title) return null
    const checkpointId = snapCheckpoint(projectPath)
    const base = await readGitBase(projectPath)
    const workBranch = await maybeCreateBranch(projectPath, opts.useBranch, title)
    const task = tasks.create({
      projectPath,
      chatId: opts.chatId ?? null,
      title,
      summary: opts.summary ?? null,
      risk: opts.risk ?? null,
      baseBranch: base.branch,
      baseSha: base.sha,
      workBranch, // Фаза 3: ветка по запросу, иначе dirty-in-place (null).
      checkpointId
    })
    // Если ветку создали — задача сразу 'in_progress' (ветвление состоялось).
    if (workBranch) tasks.setState(task.id, 'in_progress')
    return tasks.get(task.id)
  })

  // devtask:openFromPreflight — открыть задачу из объявленного preflight-плана.
  // Маппинг preflight → { title: summary.slice(0,80), summary, risk }.
  ipcMain.handle('devtask:openFromPreflight', async (_e, opts: {
    chatId?: number | null
    preflight: { summary: string; risk?: string; riskReason?: string; affectedZones?: string[] }
  }): Promise<DevTask | null> => {
    const projectPath = getProjectRoot()
    if (!projectPath) return null
    const summary = String(opts?.preflight?.summary ?? '').trim()
    if (!summary) return null
    const title = summary.slice(0, 80)
    const risk = opts.preflight.risk ?? null
    const checkpointId = snapCheckpoint(projectPath)
    const base = await readGitBase(projectPath)
    const task = tasks.create({
      projectPath,
      chatId: opts.chatId ?? null,
      title,
      summary,
      risk,
      baseBranch: base.branch,
      baseSha: base.sha,
      workBranch: null,
      checkpointId
    })
    return task
  })

  // devtask:get — задача + её проверки. id null/несуществующий → пустой агрегат.
  ipcMain.handle('devtask:get', (_e, id: number): DevTaskDetail => {
    const task = tasks.get(id)
    if (!task) return { task: null, checks: [] }
    return { task, checks: tasks.listChecks(id) }
  })

  // devtask:list — задачи проекта (новейшие первыми). Фильтр state опционален.
  ipcMain.handle('devtask:list', (_e, projectPath: string, opts?: { state?: DevTask['state'] }): DevTask[] => {
    if (!projectPath) return []
    return tasks.list(projectPath, opts)
  })

  // devtask:linkRun — связать прогон (run_id) с задачей. Идемпотентно (INSERT OR IGNORE).
  ipcMain.handle('devtask:linkRun', (_e, id: number, runId: string): void => {
    if (!id || !runId) return
    tasks.linkRun(id, runId)
  })

  // devtask:setBranch — записать рабочую ветку в задачу (аудит P0 #7). Кнопка
  // «Создать ветку» в панели создаёт git-ветку, но без этого write-back
  // work_branch оставался null навсегда → кнопка «Создать PR» (гейт на
  // workBranch) не появлялась и весь путь branch→PR был недостижим.
  ipcMain.handle('devtask:setBranch', (_e, id: number, branch: string): DevTask | null => {
    if (!id || !branch) return null
    tasks.update(id, { workBranch: branch })
    tasks.setState(id, 'in_progress')
    return tasks.get(id)
  })

  /**
   * devtask:revert — откатить файловые правки задачи к её чекпоинту.
   * Переиспользует СУЩЕСТВУЮЩИЙ механизм undo:revertToCheckpoint (тот же стек,
   * не дублируем откат). НЕ меняем state — откат файлов ≠ отмена задачи: задача
   * остаётся активной, можно продолжить работу. checkpoint_id===null → нечего
   * откатывать (задача без снятого чекпоинта).
   *
   * Возвращает true если откат прошёл успешно, иначе false.
   */
  ipcMain.handle('devtask:revert', async (_e, id: number): Promise<boolean> => {
    const projectPath = getProjectRoot()
    if (!projectPath) return false
    const task = tasks.get(id)
    if (!task || task.checkpointId == null) return false
    // Переиспользуем РОВНО ТОТ ЖЕ откат, что и undo:revertToCheckpoint /
    // кнопка «Откатить сессию» — тот же UndoStack, общая функция, не дублируем.
    const result = await revertToCheckpoint(undoStack, projectPath, task.checkpointId)
    return result.ok
  })

  /**
   * devtask:buildPackage — собрать пакет задачи (Фаза 4):
   *   1) прогнать проверки (runChecks): из detectVerifyScriptsForHint если не
   *      переданы явно, иначе opts.checks. Статус pass/fail ставит ХЕНДЛЕР по
   *      exitCode (не модель) — пишем в dev_task_checks (addCheck);
   *   2) git diff (base..HEAD если есть base_sha, иначе worktree) → changedFiles;
   *   3) commit-planner → группы + commitMessage + prSummary;
   *   4) заморозить package_json (tasks.setPackage → state='packaged').
   * Возвращает собранный Package.
   */
  ipcMain.handle('devtask:buildPackage', async (_e, id: number, opts?: { runChecks?: boolean; checks?: string[] }): Promise<DevTaskPackage | null> => {
    const projectPath = getProjectRoot()
    if (!projectPath) return null
    const task = tasks.get(id)
    if (!task) return null

    // --- 1) Проверки ---
    const checkResults: DevTaskPackage['checks'] = []
    if (opts?.runChecks) {
      let commands = (opts.checks ?? []).filter(c => typeof c === 'string' && c.trim())
      if (commands.length === 0) {
        // Автодетект из package.json/tsconfig (та же эвристика, что hint после write).
        commands = await detectVerifyScriptsForHint(projectPath)
      }
      for (const command of commands) {
        let res: CheckResult
        try {
          res = await runCheck(command)
        } catch (err) {
          res = { exitCode: 1, stdout: '', stderr: err instanceof Error ? err.message : String(err) }
        }
        const status = res.exitCode === 0 ? 'pass' : 'fail'
        // tail вывода — для UI; обрезаем до 2КБ чтобы не раздувать БД.
        const combined = `${res.stdout}\n${res.stderr}`.trim()
        const tail = combined.length > 2048 ? combined.slice(-2048) : combined
        tasks.addCheck(id, { label: command, command, status, exitCode: res.exitCode, outputTail: tail })
        checkResults.push({ label: command, command, status, exitCode: res.exitCode })
      }
    } else {
      // Без прогона — берём уже записанные проверки (если были).
      for (const c of tasks.listChecks(id)) {
        checkResults.push({ label: c.label, command: c.command, status: c.status, exitCode: c.exitCode })
      }
    }

    // --- 2) Изменённые файлы (git diff) ---
    // base_sha зафиксирован на open → сравниваем base..HEAD (правки в коммитах).
    // Если базы нет (не git) — diff рабочего дерева.
    const changedFiles = await readDiffStat(projectPath, task.baseSha ?? undefined)

    // --- 3) commit-planner ---
    const risks = task.risk ? [task.risk] : []
    const plan = buildCommitPlan({
      diffStat: changedFiles,
      summary: task.summary ?? task.title,
      affectedZones: undefined
    })

    // --- 4) Заморозить пакет ---
    const pkg: DevTaskPackage = {
      changedFiles,
      checks: checkResults,
      commitGroups: plan.groups,
      commitMessage: plan.commitMessage,
      prSummary: plan.prSummary,
      risks
    }
    tasks.setPackage(id, JSON.stringify(pkg)) // → state='packaged'
    return pkg
  })

  /**
   * devtask:commit — закоммитить правки задачи (Фаза 3). git add (changed paths
   * или все из diff) + git commit -m. Записываем sha, state→'committed'.
   * Денилист (push/force/--no-verify) гарантирован gitCommit → assertGitAllowed.
   */
  ipcMain.handle('devtask:commit', async (_e, id: number, opts: { message: string; paths?: string[]; overrideReason?: string }): Promise<{ ok: boolean; sha?: string; error?: string }> => {
    const projectPath = getProjectRoot()
    if (!projectPath) return { ok: false, error: 'no-project' }
    const task = tasks.get(id)
    if (!task) return { ok: false, error: 'no-task' }
    const message = String(opts?.message ?? '').trim()
    if (!message) return { ok: false, error: 'empty-message' }
    // Ревью F2 (P0): backend DoD gate. UI предупреждает перед коммитом поверх
    // красных проверок, но это клиентская валидация (обходится через devtools).
    // Жёсткая проверка статуса checks ЗДЕСЬ. Поведение управляется настройкой
    // Mandatory DoD (dod_mode): 'warn' (дефолт — блок, обход overrideReason →
    // audit), 'block' (строго — обход запрещён, доводи до зелёного), 'off' (без
    // гейта). Дефолт = текущее поведение, никого не ломает.
    const dodMode = (getSecret?.('dod_mode') ?? 'warn')
    const blocking = tasks.listChecks(id).filter(c => c.status === 'fail' || c.status === 'pending' || c.status === 'running')
    const overrideReason = String(opts?.overrideReason ?? '').trim()
    if (dodMode !== 'off' && blocking.length > 0) {
      const list = blocking.map(c => `${c.label}:${c.status}`).join(', ')
      if (dodMode === 'block') {
        return { ok: false, error: `dod-gate (Mandatory DoD = block): ${blocking.length} проверок не зелёные (${list}). Обход запрещён — доведи проверки до зелёного.` }
      }
      if (!overrideReason) {
        return { ok: false, error: `dod-gate: ${blocking.length} проверок не зелёные (${list}). Чтобы закоммитить поверх — передай overrideReason.` }
      }
    }
    // paths: явные или из текущего diff рабочего дерева (только новые правки).
    let paths = Array.isArray(opts?.paths) ? opts.paths.filter(p => typeof p === 'string' && p.trim()) : []
    if (paths.length === 0) {
      const stat = await readDiffStat(projectPath)
      paths = stat.map(s => s.path)
    }
    if (paths.length > 0) {
      const added = await gitAdd(projectPath, paths)
      if (!added.ok) return { ok: false, error: added.error }
    }
    const res = await gitCommit(projectPath, message)
    if (!res.ok) return res
    // Ревью F2: override поверх красных проверок — оставляем след в audit_log.
    if (blocking.length > 0 && overrideReason) {
      try {
        recordAudit?.('devtask-commit-override', `task=${id} sha=${res.sha ?? '?'} reason="${overrideReason}" checks=${blocking.map(c => `${c.label}:${c.status}`).join(',')}`)
      } catch { /* audit best-effort */ }
    }
    tasks.setState(id, 'committed')
    return res
  })

  /**
   * devtask:createPr — открыть PR через github-коннектор (Фаза 4, опц.).
   * Доступно если есть github_token + work_branch. head = work_branch, body =
   * prSummary из замороженного пакета. Авто-push НЕ делаем — пользователь сам
   * пушит ветку; коннектор лишь создаёт PR из уже запушенной ветки.
   */
  ipcMain.handle('devtask:createPr', async (_e, id: number, opts: { repo: string; base: string; draft?: boolean }): Promise<{ ok: boolean; url?: string; number?: number; error?: string }> => {
    if (!connectorQuery || !getSecret) return { ok: false, error: 'connectors-unavailable' }
    if (!getSecret('github_token')) return { ok: false, error: 'no-github-token' }
    const task = tasks.get(id)
    if (!task) return { ok: false, error: 'no-task' }
    if (!task.workBranch) return { ok: false, error: 'no-work-branch' }
    const repo = String(opts?.repo ?? '').trim()
    const base = String(opts?.base ?? '').trim()
    if (!repo || !base) return { ok: false, error: 'repo-and-base-required' }
    // Тело PR — prSummary из пакета, заголовок — из плана/заголовка задачи.
    let body = task.summary ?? task.title
    let title = task.title
    if (task.packageJson) {
      try {
        const pkg = JSON.parse(task.packageJson) as DevTaskPackage
        if (pkg.prSummary) body = pkg.prSummary
        if (pkg.commitMessage) title = pkg.commitMessage.split('\n')[0]
      } catch { /* битый пакет — оставляем дефолт */ }
    }
    try {
      const result = await connectorQuery('github', {
        op: 'create_pr', repo, head: task.workBranch, base, title, body, draft: opts?.draft === true
      }) as { created?: boolean; number?: number; url?: string; error?: string; message?: string }
      if (result?.error) return { ok: false, error: result.message ?? result.error }
      return { ok: true, url: result.url, number: result.number }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
