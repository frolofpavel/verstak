import { useProject } from '../store/projectStore'
import { selectInboxApprovals } from '../store/session-snapshot'

/**
 * T1.3 Inbox — approvals ФОНОВЫХ чатов в одном месте. Активный чат показывает
 * модалку CommandConfirm; здесь — команды, ждущие подтверждения в фоновых чатах,
 * чтобы агент в фоне не висел молча и невидимо. Резолв по callId+sendId работает
 * не заходя в чат (ai:resolve-command ищет по ключу, а не по активному чату).
 */
export function InboxApprovals() {
  const { activeChatId, pendingCommand, chatSnapshots, switchChatSession, clearChatPendingCommand } = useProject()
  const background = selectInboxApprovals({ activeChatId, pendingCommand, chatSnapshots })
    .filter(a => a.chatId !== activeChatId)
  if (background.length === 0) return null

  async function resolve(chatId: number, callId: string, accept: boolean, sendId?: number) {
    await window.api.ai.resolveCommand(callId, accept, sendId)
    clearChatPendingCommand(chatId)
  }

  return (
    <div className="gg-inbox">
      <div className="gg-inbox-title">📥 Ждут подтверждения в фоне · {background.length}</div>
      {background.map(a => (
        <div key={a.command.callId} className="gg-inbox-row">
          <code className="gg-inbox-cmd" title={a.command.command}>{a.command.command}</code>
          <div className="gg-inbox-actions">
            <button className="gg-btn gg-btn-ghost" onClick={() => void switchChatSession(a.chatId)}>Перейти</button>
            <button className="gg-btn gg-btn-danger" onClick={() => void resolve(a.chatId, a.command.callId, false, a.command.sendId)}>Отклонить</button>
            <button className="gg-btn gg-btn-success" onClick={() => void resolve(a.chatId, a.command.callId, true, a.command.sendId)}>Выполнить</button>
          </div>
        </div>
      ))}
    </div>
  )
}
