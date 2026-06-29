import { useState } from 'react'
import { useProject } from '../store/projectStore'

/**
 * Session checkpoint UI — кнопка чекпоинта в композере.
 *
 * Откат гранулярный (ось 3 F, как cline): Файлы (per-file undo до чекпоинта),
 * Задачу (truncate диалога к чекпоинту, файлы не трогаем), Файлы+задачу.
 * checkpointMessageId — граница диалога, захваченная в момент чекпоинта.
 */
export function CheckpointButton() {
  const path = useProject(s => s.path)
  const checkpointId = useProject(s => s.checkpointId)
  const checkpointMessageId = useProject(s => s.checkpointMessageId)
  const activeChatId = useProject(s => s.activeChatId)
  const setCheckpoint = useProject(s => s.setCheckpoint)
  const pushActivity = useProject(s => s.pushActivity)
  const [menuOpen, setMenuOpen] = useState(false)

  if (!path) return null

  async function createCheckpoint() {
    if (!path) return
    const id = await window.api.undo.checkpoint(path)
    const msgId = activeChatId != null ? await window.api.chats.maxMessageId(activeChatId) : null
    setCheckpoint(id, msgId)
    pushActivity({
      id: `checkpoint-${Date.now()}`, kind: 'write', label: '📍 Чекпоинт',
      detail: id === 0 ? 'стек пуст — откатим всё, что начнётся с этого момента' : `на записи #${id}`,
      status: 'ok', timestamp: Date.now()
    })
  }

  // Откат файлов (per-file undo до чекпоинта). Возвращает успех.
  async function revertFiles(): Promise<boolean> {
    if (!path || checkpointId === null) return false
    const result = await window.api.undo.revertToCheckpoint(path, checkpointId)
    if (result.ok) {
      const tree = await window.api.files.tree(path)
      useProject.setState({ tree })
      pushActivity({
        id: `revert-files-${Date.now()}`, kind: 'write', label: `↶ Откатил файлы: ${result.count}`,
        detail: result.restored.slice(0, 4).join(', ') + (result.restored.length > 4 ? ` …+${result.restored.length - 4}` : ''),
        status: 'ok', timestamp: Date.now()
      })
      return true
    }
    pushActivity({
      id: `revert-files-fail-${Date.now()}`, kind: 'blocked', label: 'Откат файлов частично провалился',
      detail: `восстановлено ${result.count}, не удалось ${result.failed?.length ?? 0}`, status: 'error', timestamp: Date.now()
    })
    return false
  }

  // Откат задачи: truncate диалога к чекпоинту (файлы не трогаем).
  async function revertTask() {
    if (activeChatId == null || checkpointMessageId == null) return
    const deleted = await window.api.chats.truncateAfter(activeChatId, checkpointMessageId)
    const msgs = await window.api.chats.list(activeChatId)
    useProject.setState({ messages: msgs.map(m => ({ role: m.role, content: m.content, createdAt: m.createdAt })) })
    pushActivity({
      id: `revert-task-${Date.now()}`, kind: 'write', label: `↶ Откатил задачу: −${deleted} сообщений`,
      detail: 'диалог обрезан к чекпоинту (файлы не тронуты)', status: 'ok', timestamp: Date.now()
    })
  }

  const doFiles = async () => {
    setMenuOpen(false)
    if (!window.confirm('Откатить ВСЕ файловые правки после чекпоинта? Файлы вернутся к состоянию на момент чекпоинта.')) return
    if (await revertFiles()) setCheckpoint(null)
  }
  const doTask = async () => {
    setMenuOpen(false)
    if (!window.confirm('Откатить ДИАЛОГ к чекпоинту (файлы НЕ трогаем)? Сообщения после чекпоинта удалятся.')) return
    await revertTask(); setCheckpoint(null)
  }
  const doBoth = async () => {
    setMenuOpen(false)
    if (!window.confirm('Откатить и ФАЙЛЫ, и ДИАЛОГ к чекпоинту? Действие не отменить.')) return
    await revertFiles(); await revertTask(); setCheckpoint(null)
  }

  if (checkpointId === null) {
    return (
      <button type="button" className="gg-checkpoint-btn" onClick={() => void createCheckpoint()}
        title="Запомнить состояние файлов и диалога. Потом одной кнопкой откатить файлы, задачу или и то, и другое.">
        📍 Чекпоинт
      </button>
    )
  }

  return (
    <div className="gg-checkpoint-wrap">
      <button type="button" className="gg-checkpoint-btn is-armed" onClick={() => setMenuOpen(o => !o)}
        title="Откатить к чекпоинту: файлы, задачу (диалог) или и то, и другое">
        ↶ Откатить ▾
      </button>
      {menuOpen && (
        <div className="gg-checkpoint-menu">
          <button type="button" onClick={() => void doFiles()}>Файлы</button>
          <button type="button" onClick={() => void doTask()} disabled={checkpointMessageId == null}
            title={checkpointMessageId == null ? 'Граница диалога не захвачена (старый чекпоинт)' : undefined}>
            Задачу (диалог)
          </button>
          <button type="button" onClick={() => void doBoth()}>Файлы + задачу</button>
        </div>
      )}
    </div>
  )
}
