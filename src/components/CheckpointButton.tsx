import { useProject } from '../store/projectStore'

/**
 * Session checkpoint UI — two-state button in the composer.
 *
 * Brainstorm 2026-05-21 (idea B): the existing per-file ↶ undo is great for
 * one mistake, but useless when the agent writes 8 files and you want to
 * roll the whole session back in one click. This wraps `undoStack` with a
 * "mark + revert-to-mark" pair without inventing new storage.
 *
 * Store contract: `checkpointId === null` ⇒ not set; any number (including 0)
 * ⇒ checkpoint marked. The IPC returns 0 when the undo stack was empty at
 * mark time, which is below any real autoincrement id — so `id > 0` reverts
 * everything written since.
 */
export function CheckpointButton() {
  const path = useProject(s => s.path)
  const checkpointId = useProject(s => s.checkpointId)
  const setCheckpoint = useProject(s => s.setCheckpoint)
  const pushActivity = useProject(s => s.pushActivity)

  if (!path) return null

  async function createCheckpoint() {
    if (!path) return
    const id = await window.api.undo.checkpoint(path)
    setCheckpoint(id)
    pushActivity({
      id: `checkpoint-${Date.now()}`,
      kind: 'write',
      label: '📍 Чекпоинт',
      detail: id === 0 ? 'стек пуст — откатим всё, что начнётся с этого момента' : `на записи #${id}`,
      status: 'ok',
      timestamp: Date.now()
    })
  }

  async function revertSession() {
    if (!path || checkpointId === null) return
    const ok = window.confirm(
      'Откатить ВСЕ файловые правки, сделанные после чекпоинта?\n\n' +
      'Это вернёт файлы к состоянию на момент чекпоинта. Действие не отменить.'
    )
    if (!ok) return
    const result = await window.api.undo.revertToCheckpoint(path, checkpointId)
    if (result.ok) {
      const tree = await window.api.files.tree(path)
      useProject.setState({ tree })
      setCheckpoint(null)
      pushActivity({
        id: `revert-session-${Date.now()}`,
        kind: 'write',
        label: `↶ Откатил сессию: ${result.count} файлов`,
        detail: result.restored.slice(0, 4).join(', ') + (result.restored.length > 4 ? ` …+${result.restored.length - 4}` : ''),
        status: 'ok',
        timestamp: Date.now()
      })
    } else {
      const failedCount = result.failed?.length ?? 0
      pushActivity({
        id: `revert-session-fail-${Date.now()}`,
        kind: 'blocked',
        label: 'Откат сессии частично провалился',
        detail: `восстановлено ${result.count}, не удалось ${failedCount}`,
        status: 'error',
        timestamp: Date.now()
      })
    }
  }

  if (checkpointId === null) {
    return (
      <button
        type="button"
        className="gg-checkpoint-btn"
        onClick={() => void createCheckpoint()}
        title="Запомнить текущее состояние файлов. Потом можно одной кнопкой откатить всё, что агент успеет наделать."
      >
        📍 Чекпоинт
      </button>
    )
  }

  return (
    <button
      type="button"
      className="gg-checkpoint-btn is-armed"
      onClick={() => void revertSession()}
      title={`Откатить все файловые правки после чекпоинта #${checkpointId === 0 ? 'start' : checkpointId}`}
    >
      ↶ Откатить сессию
    </button>
  )
}
