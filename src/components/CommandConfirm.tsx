import { useState } from 'react'
import { useProject } from '../store/projectStore'

export function CommandConfirm() {
  const { pendingCommand, setPendingCommand } = useProject()
  const [remember, setRemember] = useState(false)
  if (!pendingCommand) return null
  const ref = pendingCommand

  async function accept() {
    // «Запомнить» — до резолва, чтобы правило легло в permissions.json ещё до
    // следующего вызова. Тихо игнорируем null (файловые тулзы правило не дают).
    if (remember) {
      try { await window.api.settings.rememberApproval('run_command', ref.command) } catch { /* не блокируем выполнение */ }
    }
    await window.api.ai.resolveCommand(ref.callId, true, ref.sendId)
    setRemember(false)
    setPendingCommand(null)
  }
  async function reject() {
    await window.api.ai.resolveCommand(ref.callId, false, ref.sendId)
    setRemember(false)
    setPendingCommand(null)
  }

  return (
    <div className="gg-modal-backdrop" onClick={reject}>
      <div className="gg-modal" onClick={e => e.stopPropagation()}>
        <div className="gg-modal-header">
          <div>
            <div className="gg-modal-title">AI хочет выполнить команду</div>
            <div className="gg-text-tertiary" style={{ fontSize: 'var(--text-xs)', marginTop: 4 }}>
              Команда выполнится в корне проекта. Проверь — выглядит безопасно?
            </div>
          </div>
        </div>

        <div className="gg-modal-body" style={{ padding: '16px 22px' }}>
          <div className="gg-cmd-box">
            <span className="gg-cmd-prompt">$</span>
            <code className="gg-cmd-text">{pendingCommand.command}</code>
          </div>
          <label className="gg-remember-approval" title="Похожие команды с этим префиксом будут выполняться автоматически в следующих сессиях (правило в ~/.verstak/permissions.json)">
            <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />
            <span>Больше не спрашивать про такие команды</span>
          </label>
        </div>

        <div className="gg-modal-footer">
          <button className="gg-btn gg-btn-danger" onClick={reject}>Отклонить</button>
          <button className="gg-btn gg-btn-success" onClick={accept}>Выполнить</button>
        </div>
      </div>
    </div>
  )
}
