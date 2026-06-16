import { useEffect, useState, useCallback } from 'react'
import { useProject } from '../store/projectStore'
import type { DevTaskState, GitDiffStatEntry, DevTaskCheck, DevTaskPackage } from '../types/api'
import { CommitPlanEditor } from './CommitPlanEditor'

/**
 * Вкладка «Задача» (Dev Task Flow, Фазы 2-4) — состояние активной dev_task +
 * откат + сборка пакета + commit/PR.
 *
 * Шапка: заголовок + state-бейдж + ветка (work_branch || 'in-place') + risk.
 * Секции:
 *   - «Изменения» — изменённые файлы (window.api.git.diff), клик → reveal.
 *   - «Проверки» — чипы pass/fail из dev_task_checks + кнопка «Прогнать проверки»
 *     (devtask:buildPackage с runChecks).
 *   - «Пакет» — CommitPlanEditor (группы коммитов + редактируемое сообщение) +
 *     PR summary + кнопки «Commit» (devtask:commit) и «Создать PR».
 *   - откат к чекпоинту.
 *
 * git-write идёт ТОЛЬКО по явным кнопкам (Commit / Создать ветку / Создать PR).
 */

const STATE_LABEL: Record<DevTaskState, string> = {
  draft: 'черновик',
  branching: 'ветвление',
  in_progress: 'в работе',
  review_ready: 'к ревью',
  paused: 'пауза',
  packaged: 'упакована',
  committed: 'закоммичена',
  cancelled: 'отменена'
}

function statusGlyph(status: string): string {
  // git status из numstat у нас 'modified' | 'binary'; для наглядности
  // показываем буквенный маркер.
  if (status === 'binary') return 'B'
  if (status === 'added') return 'A'
  if (status === 'deleted') return 'D'
  return 'M'
}

export function DevTaskPanel() {
  const path = useProject(s => s.path)
  const devTask = useProject(s => s.devTask)
  const activeDevTaskId = useProject(s => s.activeDevTaskId)
  const refreshDevTask = useProject(s => s.refreshDevTask)
  const closeDevTask = useProject(s => s.closeDevTask)
  const [diff, setDiff] = useState<GitDiffStatEntry[]>([])
  const [checks, setChecks] = useState<DevTaskCheck[]>([])
  const [loading, setLoading] = useState(false)
  const [building, setBuilding] = useState(false)
  const [committing, setCommitting] = useState(false)
  const [creatingPr, setCreatingPr] = useState(false)
  const [pkg, setPkg] = useState<DevTaskPackage | null>(null)
  const [commitMessage, setCommitMessage] = useState('')
  const [notice, setNotice] = useState<string | null>(null)

  const loadDiff = useCallback(async () => {
    setLoading(true)
    try {
      const d = await window.api.git.diff()
      setDiff(d.stat)
    } catch { /* не git-репозиторий / IPC недоступен — пустой список */ }
    setLoading(false)
  }, [])

  // refresh = снимок задачи (state + проверки) + git diff изменений.
  const refresh = useCallback(async () => {
    await refreshDevTask()
    const id = useProject.getState().activeDevTaskId
    if (id != null) {
      try {
        const detail = await window.api.devtask.get(id)
        setChecks(detail.checks)
        // Если пакет уже заморожен в задаче — гидрируем редактор из него.
        if (detail.task?.packageJson) {
          try {
            const frozen = JSON.parse(detail.task.packageJson) as DevTaskPackage
            setPkg(frozen)
            setCommitMessage(prev => prev || frozen.commitMessage)
          } catch { /* битый пакет — игнорируем */ }
        }
      } catch { /* IPC недоступен — оставляем текущее */ }
    }
    await loadDiff()
  }, [refreshDevTask, loadDiff])

  // Поллинг раз в 3с пока вкладка открыта — diff/state живые во время прогона.
  useEffect(() => {
    void refresh()
    const t = setInterval(() => void refresh(), 3000)
    return () => clearInterval(t)
  }, [refresh])

  const handleRevert = useCallback(async () => {
    if (activeDevTaskId == null) return
    const ok = window.confirm(
      'Откатить ВСЕ файловые правки этой задачи к чекпоинту?\n\n' +
      'Файлы вернутся к состоянию на момент открытия задачи. Действие не отменить.'
    )
    if (!ok) return
    try {
      const success = await window.api.devtask.revert(activeDevTaskId)
      if (success && path) {
        // Дерево могло измениться — перечитываем, как делает CheckpointButton.
        const tree = await window.api.files.tree(path)
        useProject.setState({ tree })
      }
    } catch { /* откат не прошёл — состояние не меняем */ }
    await refresh()
  }, [activeDevTaskId, path, refresh])

  // Прогнать проверки → собрать пакет (devtask:buildPackage с runChecks).
  const handleBuildPackage = useCallback(async () => {
    if (activeDevTaskId == null) return
    setBuilding(true)
    setNotice(null)
    try {
      const built = await window.api.devtask.buildPackage(activeDevTaskId, { runChecks: true })
      if (built) {
        setPkg(built)
        setCommitMessage(built.commitMessage)
      }
    } catch {
      setNotice('Не удалось собрать пакет.')
    }
    setBuilding(false)
    await refresh()
  }, [activeDevTaskId, refresh])

  // Создать рабочую ветку verstak/... для задачи (git:branchCreate под капотом
  // делает devtask:open useBranch, но задача уже открыта — используем git:branchCreate
  // напрямую и привязываем не нужно, work_branch проставит следующий refresh не сам).
  const handleCreateBranch = useCallback(async () => {
    if (!devTask) return
    const slug = devTask.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '').slice(0, 32) || 'task'
    const name = `verstak/${slug}-${Date.now().toString(36)}`
    setNotice(null)
    try {
      const res = await window.api.git.branchCreate({ name })
      if (res.ok) {
        setNotice(`Ветка создана: ${res.branch}`)
        // Write-back ветки в задачу (аудит P0 #7): без этого work_branch оставался
        // null навсегда → кнопка «Создать PR» (гейт на workBranch) не появлялась.
        try { await window.api.devtask.setBranch(devTask.id, res.branch ?? name) } catch { /* refresh ниже подхватит */ }
      } else setNotice(`Не удалось создать ветку: ${res.error ?? 'ошибка'}`)
    } catch {
      setNotice('Не удалось создать ветку.')
    }
    await refresh()
  }, [devTask, refresh])

  // Закоммитить правки задачи (devtask:commit) с текущим сообщением редактора.
  const handleCommit = useCallback(async () => {
    if (activeDevTaskId == null) return
    const msg = commitMessage.trim()
    if (!msg) { setNotice('Заполни сообщение коммита.'); return }
    // Предупреждение при упавших проверках (аудит P1 #9): коммит поверх красных
    // проверок противоречит позиционированию «высокий контроль» — требуем явного
    // подтверждения, а не молча коммитим.
    const failed = checks.filter(c => c.status === 'fail').length
    if (failed > 0) {
      const ok = window.confirm(`Есть проваленные проверки (${failed} ✗). Точно закоммитить поверх них?`)
      if (!ok) return
    }
    setCommitting(true)
    setNotice(null)
    try {
      const res = await window.api.devtask.commit(activeDevTaskId, { message: msg })
      if (res.ok) setNotice(`Коммит создан: ${res.sha?.slice(0, 8)}`)
      else setNotice(`Коммит не прошёл: ${res.error ?? 'ошибка'}`)
    } catch {
      setNotice('Коммит не прошёл.')
    }
    setCommitting(false)
    await refresh()
  }, [activeDevTaskId, commitMessage, checks, refresh])

  // Создать PR через github-коннектор. repo/base спрашиваем простым prompt'ом
  // (V1 — без отдельной формы). Доступно только при наличии work_branch; токен
  // и пуш ветки на стороне пользователя (коннектор лишь открывает PR).
  const handleCreatePr = useCallback(async () => {
    if (activeDevTaskId == null) return
    const repo = window.prompt('Репозиторий (owner/repo):')?.trim()
    if (!repo) return
    const base = window.prompt('Базовая ветка (например main):', 'main')?.trim()
    if (!base) return
    setCreatingPr(true)
    setNotice(null)
    try {
      const res = await window.api.devtask.createPr(activeDevTaskId, { repo, base })
      if (res.ok) setNotice(`PR создан: ${res.url ?? `#${res.number}`}`)
      else setNotice(`PR не создан: ${res.error ?? 'ошибка'}`)
    } catch {
      setNotice('PR не создан.')
    }
    setCreatingPr(false)
  }, [activeDevTaskId])

  if (!path) {
    return (
      <div className="gg-panel">
        <div className="gg-panel-empty" style={{ marginTop: 80 }}>Открой проект чтобы видеть задачу</div>
      </div>
    )
  }

  if (!devTask) {
    return (
      <div className="gg-panel">
        <div className="gg-panel-header">
          <h2 className="gg-panel-title">Задача</h2>
        </div>
        <div className="gg-devtask-empty">
          <div className="gg-devtask-empty-icon">🗂️</div>
          <div className="gg-devtask-empty-title">Нет активной задачи</div>
          <div className="gg-devtask-empty-hint">
            Задача открывается из плана агента (preflight) — кнопкой «Открыть задачу».
            Тогда здесь появятся изменения и кнопка отката.
          </div>
        </div>
      </div>
    )
  }

  const branch = devTask.workBranch || (devTask.baseBranch ? `${devTask.baseBranch} · in-place` : 'in-place')
  const passCount = checks.filter(c => c.status === 'pass').length
  const failCount = checks.filter(c => c.status === 'fail').length

  return (
    <div className="gg-panel">
      <div className="gg-panel-header">
        <h2 className="gg-panel-title">Задача</h2>
        <div className="gg-panel-meta">
          <button className="gg-btn gg-btn-ghost" onClick={() => void refresh()} title="Обновить">↻ Обновить</button>
        </div>
      </div>

      <div className="gg-devtask-head">
        <div className="gg-devtask-title" title={devTask.title}>{devTask.title}</div>
        <div className="gg-devtask-tags">
          <span className={`gg-devtask-state is-${devTask.state}`}>{STATE_LABEL[devTask.state] ?? devTask.state}</span>
          <span className="gg-devtask-branch" title="Рабочая ветка">⎇ {branch}</span>
          {devTask.risk && <span className={`gg-devtask-risk is-${devTask.risk}`}>риск: {devTask.risk}</span>}
        </div>
        {devTask.summary && <div className="gg-devtask-summary">{devTask.summary}</div>}
      </div>

      <div className="gg-panel-body">
        {notice && <div className="gg-devtask-notice">{notice}</div>}

        {/* === Изменения === */}
        <div className="gg-devtask-section">
          <div className="gg-devtask-section-title">Изменения ({diff.length})</div>
          {diff.length === 0 ? (
            <div className="gg-devtask-section-empty">
              {loading ? 'Загрузка…' : 'Нет изменений в рабочем дереве.'}
            </div>
          ) : (
            <div className="gg-devtask-files">
              {diff.map(f => (
                <button
                  key={f.path}
                  className="gg-devtask-file"
                  title={`Открыть в проводнике: ${f.path}`}
                  onClick={() => void window.api.files.revealInExplorer(f.path).catch(() => {})}
                >
                  <span className={`gg-devtask-file-status is-${f.status}`}>{statusGlyph(f.status)}</span>
                  <span className="gg-devtask-file-path">{f.path}</span>
                  <span className="gg-devtask-file-stat">
                    {f.added > 0 && <span className="gg-devtask-add">+{f.added}</span>}
                    {f.removed > 0 && <span className="gg-devtask-del">−{f.removed}</span>}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* === Проверки === */}
        <div className="gg-devtask-section">
          <div className="gg-devtask-section-title">
            Проверки {checks.length > 0 && <span className="gg-devtask-checks-counter">({passCount} ✓ / {failCount} ✗)</span>}
          </div>
          {checks.length === 0 ? (
            <div className="gg-devtask-section-empty">Проверки ещё не прогонялись.</div>
          ) : (
            <div className="gg-devtask-checks">
              {checks.map(c => (
                <span
                  key={c.id}
                  className={`gg-devtask-check is-${c.status}`}
                  title={c.outputTail ? c.outputTail.slice(-600) : c.command}
                >
                  {c.status === 'pass' ? '✓' : c.status === 'fail' ? '✗' : '•'} {c.label}
                  {c.exitCode != null && c.status === 'fail' && <span className="gg-devtask-check-code"> (exit {c.exitCode})</span>}
                </span>
              ))}
            </div>
          )}
          <button
            className="gg-btn gg-btn-secondary gg-devtask-run-checks"
            onClick={() => void handleBuildPackage()}
            disabled={building}
            title="Прогнать проверки (npm test / tsc / lint) и собрать пакет"
          >
            {building ? 'Прогоняю…' : '▶ Прогнать проверки'}
          </button>
        </div>

        {/* === Пакет === */}
        <div className="gg-devtask-section">
          <div className="gg-devtask-section-title">Пакет</div>
          <CommitPlanEditor
            groups={pkg?.commitGroups ?? []}
            message={commitMessage}
            onMessageChange={setCommitMessage}
          />
          {pkg?.prSummary && (
            <details className="gg-devtask-pr-summary">
              <summary>PR summary</summary>
              <pre>{pkg.prSummary}</pre>
            </details>
          )}
          <div className="gg-devtask-package-actions">
            <button
              className="gg-btn gg-btn-primary"
              onClick={() => void handleCommit()}
              disabled={committing || !commitMessage.trim()}
              title="git add + commit (без --no-verify / push)"
            >
              {committing ? 'Коммичу…' : '✓ Commit'}
            </button>
            {!devTask.workBranch && (
              <button
                className="gg-btn gg-btn-ghost"
                onClick={() => void handleCreateBranch()}
                title="Создать рабочую ветку verstak/..."
              >
                ⎇ Создать ветку
              </button>
            )}
            {devTask.workBranch && (
              <button
                className="gg-btn gg-btn-ghost"
                onClick={() => void handleCreatePr()}
                disabled={creatingPr}
                title="Создать PR через GitHub (нужен github_token + запушенная ветка)"
              >
                {creatingPr ? 'Создаю PR…' : '⇡ Создать PR'}
              </button>
            )}
          </div>
        </div>

        <div className="gg-devtask-actions">
          <button
            className="gg-btn gg-devtask-revert"
            onClick={() => void handleRevert()}
            disabled={devTask.checkpointId == null}
            title={devTask.checkpointId == null ? 'У задачи нет чекпоинта' : 'Откатить все правки к чекпоинту задачи'}
          >
            ↩ Откатить задачу
          </button>
          <button className="gg-btn gg-btn-ghost" onClick={() => closeDevTask()} title="Убрать задачу из активных (не удаляет)">
            Снять как активную
          </button>
        </div>
      </div>
    </div>
  )
}
