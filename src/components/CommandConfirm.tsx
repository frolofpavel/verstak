import { useEffect, useState } from 'react'
import { useProject } from '../store/projectStore'
import { useActiveChatField } from '../hooks/useActiveChatBundle'

export function CommandConfirm() {
  const pendingCommand = useActiveChatField('pendingCommand') ?? null
  const setPendingCommand = useProject(s => s.setPendingCommand)
  const [remember, setRemember] = useState(false)
  // Чекбокс «больше не спрашивать» показываем ТОЛЬКО когда правило реально
  // сформируется (derivePrefixRule ≠ null). К модалке ходят шесть инструментов
  // (run_command / spawn_process / connector_query / execute_code / файлы / MCP /
  // браузер) — для всех, кроме безопасных команд, чекбокс раньше обещал запись в
  // ~/.verstak/permissions.json и молча не делал её. Скрыт по умолчанию: событие
  // без toolName (старый снапшот) правила не даст.
  const [canRemember, setCanRemember] = useState(false)
  const callId = pendingCommand?.callId ?? null
  const toolName = pendingCommand?.toolName ?? null
  const commandText = pendingCommand?.command ?? ''
  useEffect(() => {
    setCanRemember(false)
    setRemember(false)
    if (callId === null || toolName === null) return
    let alive = true
    window.api.settings.canRememberRule(toolName, commandText)
      .then(ok => { if (alive) setCanRemember(ok) })
      .catch(() => { /* остаёмся скрытыми — хуже показать и соврать */ })
    return () => { alive = false }
  }, [callId, toolName, commandText])
  if (!pendingCommand) return null
  const ref = pendingCommand

  async function accept() {
    // «Запомнить» — до резолва, чтобы правило легло в permissions.json ещё до
    // следующего вызова. Запись правил остаётся только у команд: чекбокс виден
    // лишь когда derivePrefixRule('run_command', …) формирует правило.
    if (remember && canRemember) {
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
    <div className="gg-modal-backdrop" onClick={() => void reject()}>
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
          {canRemember && (
            <label className="gg-remember-approval" title="Похожие команды с этим префиксом будут выполняться автоматически в следующих сессиях (правило в ~/.verstak/permissions.json)">
              <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />
              <span>Больше не спрашивать про такие команды</span>
            </label>
          )}
        </div>

        <div className="gg-modal-footer">
          <button className="gg-btn gg-btn-danger" onClick={() => void reject()}>Отклонить</button>
          <button className="gg-btn gg-btn-success" onClick={() => void accept()}>Выполнить</button>
        </div>
      </div>
    </div>
  )
}
