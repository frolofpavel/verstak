// Декомпозиция Chat.tsx (2.1.11 срез C): рендер потока сообщений.
//
// Вынесено из Chat.tsx БЕЗ изменения разметки, классов и порядка узлов — весь
// `messages.map` целиком: разделители дат, пузыри пользователя и ассистента,
// строки tool-активности, карточки preflight и sub-agent, блок изменённых файлов,
// размышление модели, вложения, панель действий сообщения, live-индикатор набора,
// pill кросс-проверки и ветка пустого прерванного ответа.
//
// Вместе с блоком переехал `buildInterruptedAnswerProgress` — в Chat.tsx его
// использовал только этот узел.
//
// ЧТО ЗДЕСЬ ОХРАНЯЕТСЯ. После PerChatState 4.4 поток читает состояние живым из
// `chats` — единственного источника. Компонент презентационный и НИЧЕГО не
// выбирает сам: какие сообщения и какие карточки показывать, решает Chat.tsx по
// активному чату. Если сюда протечёт собственная выборка из стора, вернётся класс
// багов «событие фонового чата упало в активный». Сетка на это стоит в
// tests/components/chat-stream-characterization.test.ts.
//
// Пропсы намеренно названы теми же именами, что были у переменных замыкания в
// Chat.tsx: так тело JSX переезжает дословно, без единой правки разметки.

import { Fragment, type Dispatch, type SetStateAction } from 'react'
import { useProject } from '../../store/projectStore'
import type { PlanCreatedCard, PreflightCard, SubagentRunCard, ActivityEntry } from '../../store/session-snapshot'
import { Markdown } from '../Markdown'
import { AgentProgressPanel } from '../AgentProgressPanel'
import { MessageActions, AttachmentPreview } from './message-parts'
import { skillDisplayName } from './skill-prompts'
import { canEditMessage } from '../../lib/fork-edit'
import { parseSupplementMessage } from '../../lib/composer-streaming'
import { formatDuration } from '../../lib/format-duration'
import {
  formatChatDateDivider,
  formatMessageClock,
  formatMessageDateTitle,
  isSameLocalDay,
} from '../../lib/chat-timestamps'
import { type AgentProgressEntry } from '../../lib/agent-progress'
import type { ChatMessage, ResumableRun } from '../../types/api'
import type { Translations } from '../../i18n'

function buildInterruptedAnswerProgress(createdAt: number | undefined, providerLabel: string): AgentProgressEntry[] {
  const timestamp = createdAt ?? Date.now()
  return [
    {
      id: 'interrupted-answer',
      phase: 'final',
      title: 'Ответ прерван',
      detail: `${providerLabel} начал отвечать, но приложение было закрыто до сохранения видимого ответа. Запуск не удалось восстановить автоматически — если задача ещё актуальна, повтори запрос.`,
      status: 'error',
      timestamp
    }
  ]
}

export interface ChatStreamMessagesProps {
  messages: ChatMessage[]
  isStreaming: boolean
  /** Подпись провайдера в шапке ответа. */
  provider: { label: string }
  t: Translations
  activeChatId: number | null
  helpMode: boolean
  activity: ActivityEntry[]
  preflights: PreflightCard[]
  /** §7.2: карточки созданных планов — пользовательский вид вместо строки activity. */
  planCards: PlanCreatedCard[]
  onOpenPlan: () => void
  subagentRuns: SubagentRunCard[]
  agentProgress: AgentProgressEntry[]
  agentProgressDurationMs: number | null
  agentProgressFinishedAt: number | null
  handleAgentProgressToggle: () => void
  /** Незавершённые прогоны: при их наличии пустой прерванный ответ не рисуется —
   *  вместо него человек видит ResumeBanner. */
  resumableRuns: ResumableRun[]
  lastAssistantInfo: { index: number; message: ChatMessage; key: string } | null
  lastAssistantAnimationKey: string | null
  animatedAssistantText: { key: string; shown: string; target: string } | null
  streamStartedAt: number | null
  tickNow: number
  crossVerify: { result: string; provider: string; ok: boolean } | null
  cvExpanded: boolean
  setCvExpanded: Dispatch<SetStateAction<boolean>>
  openTaskFromPreflight: (pf: PreflightCard) => Promise<void>
  onOpenFilePreview: (path: string) => void
}

export function ChatStreamMessages(props: ChatStreamMessagesProps) {
  const {
    messages, isStreaming, provider, t, activeChatId, helpMode, activity, preflights, planCards, onOpenPlan,
    subagentRuns, agentProgress, agentProgressDurationMs, agentProgressFinishedAt,
    handleAgentProgressToggle, resumableRuns, lastAssistantInfo, lastAssistantAnimationKey,
    animatedAssistantText, streamStartedAt, tickNow, crossVerify, cvExpanded, setCvExpanded,
    openTaskFromPreflight, onOpenFilePreview,
  } = props
  return (
    <>
        {messages.map((m, i) => {
          const isLast = i === messages.length - 1
          const isStreamingAssistant = isLast && m.role === 'assistant' && isStreaming
          const hasAgentProgress = isLast && m.role === 'assistant' && agentProgress.length > 0
          const showInlineAgentProgress = hasAgentProgress && !isStreamingAssistant
          // Render activity rows just before the (last) assistant message
          const showActivity = isLast && m.role === 'assistant' && activity.length > 0
          const showPreflights = isLast && m.role === 'assistant' && preflights.length > 0
          const showPlanCards = isLast && m.role === 'assistant' && planCards.length > 0
          const showSubagents = isLast && m.role === 'assistant' && subagentRuns.length > 0
          const changedFiles = isLast && m.role === 'assistant' && !isStreaming
            ? activity.filter(a => a.kind === 'write' && a.status === 'ok').map(a => a.detail ?? '')
            : []
          const prevMsg = i > 0 ? messages[i - 1] : null
          const showDateDivider = m.createdAt != null
            && (prevMsg?.createdAt == null || !isSameLocalDay(prevMsg.createdAt, m.createdAt))
          const messageDateLabel = m.createdAt != null ? formatChatDateDivider(m.createdAt) : undefined
          const messageDay = m.createdAt != null ? new Date(m.createdAt).toLocaleDateString('en-CA') : undefined
          const supplement = m.role === 'user' && m.content ? parseSupplementMessage(m.content) : null
          const hideProgressMeta = m.role === 'assistant' && hasAgentProgress
          const hideStreamingProgressPlaceholder = isStreamingAssistant
            && hasAgentProgress
            && !m.content?.trim()
            && !m.thinking
            && !m.attachments?.length
            && changedFiles.length === 0
          const isAnimatedAssistant = m.role === 'assistant'
            && i === lastAssistantInfo?.index
            && animatedAssistantText?.key === lastAssistantAnimationKey
          const renderedContent = isAnimatedAssistant
            ? (animatedAssistantText?.shown ?? m.content)
            : m.content
          const isEmptyInterruptedAssistant = m.role === 'assistant'
            && !isStreamingAssistant
            && !renderedContent?.trim()
            && !m.thinking?.trim()
            && !m.attachments?.length
            && !showInlineAgentProgress
            && !showActivity
            && !showPreflights
            && !showSubagents
          if (isEmptyInterruptedAssistant) {
            if (resumableRuns.length > 0) return null
            return (
              <Fragment key={i}>
                {showDateDivider && (
                  <div className="gg-chat-date-divider" role="separator" aria-label={formatChatDateDivider(m.createdAt!)}>
                    <span className="gg-chat-date-divider-label">{formatChatDateDivider(m.createdAt!)}</span>
                  </div>
                )}
                <div
                  className="gg-msg gg-msg-assistant gg-msg-agent-progress-standalone"
                  data-message-day={messageDay}
                  data-message-date-label={messageDateLabel}
                >
                  <div className="gg-agent-progress-inline is-standalone">
                    <AgentProgressPanel
                      entries={buildInterruptedAnswerProgress(m.createdAt, provider.label)}
                      isStreaming={false}
                      finishedAt={m.createdAt ?? null}
                      onToggleOpen={handleAgentProgressToggle}
                    />
                  </div>
                </div>
              </Fragment>
            )
          }
          return (
            <Fragment key={i}>
            {showDateDivider && (
              <div className="gg-chat-date-divider" role="separator" aria-label={formatChatDateDivider(m.createdAt!)}>
                <span className="gg-chat-date-divider-label">{formatChatDateDivider(m.createdAt!)}</span>
              </div>
            )}
            <div
              className={`gg-msg ${m.role === 'user' ? 'gg-msg-user' : 'gg-msg-assistant'}${supplement ? ' is-supplement' : ''}`}
              data-message-day={messageDay}
              data-message-date-label={messageDateLabel}
            >
              {showInlineAgentProgress && (
                <div className="gg-agent-progress-inline">
                  <AgentProgressPanel
                    entries={agentProgress}
                    isStreaming={false}
                    durationMs={agentProgressDurationMs}
                    finishedAt={agentProgressFinishedAt}
                    onToggleOpen={handleAgentProgressToggle}
                  />
                </div>
              )}
              {showActivity && (
                <div className="gg-activity-list">
                  {activity.map(a => (
                    <div key={a.id} className={`gg-activity-row is-${a.status}`}>
                      <span className="gg-activity-icon" />
                      <span className="gg-activity-label">{a.label}</span>
                      {a.detail && <span className="gg-activity-detail">{a.detail.length > 80 ? a.detail.slice(0, 80) + '…' : a.detail}</span>}
                    </div>
                  ))}
                </div>
              )}
              {showPlanCards && planCards.map(card => (
                <div key={`plan-${card.planId}`} className="gg-plan-card">
                  <div className="gg-plan-card-head">
                    <span className="gg-plan-card-title">📋 {card.title}</span>
                    <span className="gg-plan-card-status">
                      {card.awaitingApproval ? 'ждёт вашего решения' : 'сохранён'}
                    </span>
                  </div>
                  <div className="gg-plan-card-meta">{card.stepCount} шаг(ов)</div>
                  <button className="gg-btn gg-btn-ghost gg-plan-card-open" type="button" onClick={onOpenPlan}>
                    Открыть план
                  </button>
                </div>
              ))}
              {showPreflights && preflights.map(pf => {
                const riskLabel = pf.risk === 'high' ? 'высокий риск' : pf.risk === 'medium' ? 'средний риск' : 'низкий риск'
                return (
                  <div key={pf.callId} className={`gg-preflight is-${pf.risk}`}>
                    <div className="gg-preflight-head">
                      <span className="gg-preflight-title">🛫 План перед действием</span>
                      <span className={`gg-preflight-pill is-${pf.risk}`}>{riskLabel}</span>
                    </div>
                    <div className="gg-preflight-summary">{pf.summary}</div>
                    {pf.riskReason && <div className="gg-preflight-reason">{pf.riskReason}</div>}
                    {pf.affectedZones.length > 0 && (
                      <div className="gg-preflight-section">
                        <div className="gg-preflight-label">Затронутые зоны</div>
                        <ul className="gg-preflight-ul">
                          {pf.affectedZones.map((z, zi) => <li key={zi}>{z}</li>)}
                        </ul>
                      </div>
                    )}
                    {pf.verifyAfter.length > 0 && (
                      <div className="gg-preflight-section">
                        <div className="gg-preflight-label">Проверить после</div>
                        <ul className="gg-preflight-ul">
                          {pf.verifyAfter.map((v, vi) => <li key={vi}>{v}</li>)}
                        </ul>
                      </div>
                    )}
                    {pf.outOfScope.length > 0 && (
                      <div className="gg-preflight-section">
                        <div className="gg-preflight-label">Вне scope / запреты</div>
                        <ul className="gg-preflight-ul">
                          {pf.outOfScope.map((o, oi) => <li key={oi}>{o}</li>)}
                        </ul>
                      </div>
                    )}
                    {/* Dev Task Flow (Фаза 2): мягкое предложение открыть задачу из
                        плана — НЕ авто-создание. Снимет checkpoint + зафиксирует
                        git-базу, появится вкладка «Задача» с откатом. */}
                    <div className="gg-preflight-section gg-preflight-devtask">
                      <button
                        type="button"
                        className="gg-preflight-opentask"
                        onClick={() => void openTaskFromPreflight(pf)}
                        title="Открыть задачу из этого плана — снимет чекпоинт и покажет вкладку «Задача» с откатом"
                      >
                        🗂️ Открыть задачу из этого плана
                      </button>
                    </div>
                  </div>
                )
              })}
              {showSubagents && subagentRuns.map(sa => {
                const statusLabel = sa.status === 'running' ? 'выполняется' : sa.status === 'done' ? 'готово' : 'ошибка'
                return (
                  <div key={sa.callId} className={`gg-subagent is-${sa.status}`}>
                    <div className="gg-subagent-head">
                      <span className="gg-subagent-title">🤖 Sub-agent: {sa.label}</span>
                      <span className={`gg-subagent-pill is-${sa.status}`}>{statusLabel}</span>
                    </div>
                    <div className="gg-subagent-meta">
                      {sa.skill && <span className="gg-subagent-tag">скилл: {sa.skill}</span>}
                      {sa.provider && <span className="gg-subagent-tag">провайдер: {sa.provider}</span>}
                      {sa.role && <span className="gg-subagent-tag">роль: {sa.role}</span>}
                      {typeof sa.toolCount === 'number' && sa.toolCount > 0 && (
                        <span className="gg-subagent-tag">🔧 {sa.toolCount} tool-вызовов</span>
                      )}
                    </div>
                    <div className="gg-subagent-task">{sa.task}</div>
                    {sa.result && (
                      <details className="gg-subagent-result">
                        <summary>{sa.status === 'error' ? 'Ошибка' : 'Результат'}</summary>
                        <div className="gg-subagent-result-body">{sa.result}</div>
                      </details>
                    )}
                  </div>
                )
              })}
              {(m.role === 'assistant' || m.role === 'user') && !hideProgressMeta && (
                <div className="gg-msg-meta">
                  {m.role === 'assistant' && (
                    <span className="gg-msg-author">{provider.label}</span>
                  )}
                  {m.createdAt != null && (
                    <time
                      className="gg-msg-time"
                      dateTime={new Date(m.createdAt).toISOString()}
                      title={formatMessageDateTitle(m.createdAt)}
                    >
                      {formatMessageClock(m.createdAt)}
                    </time>
                  )}
                  {isStreamingAssistant && streamStartedAt != null && !hasAgentProgress && (
                    <span className="gg-msg-duration is-live" title={t.chat.responseRunningTitle}>
                      {t.chat.responseRunning.replace('{duration}', formatDuration(tickNow - streamStartedAt))}
                    </span>
                  )}
                  {!isStreamingAssistant && m.responseDurationMs != null && (
                    <span className="gg-msg-duration" title={t.chat.responseDoneTitle}>
                      {t.chat.responseDone.replace('{duration}', formatDuration(m.responseDurationMs))}
                    </span>
                  )}
                </div>
              )}
              {!hideStreamingProgressPlaceholder && (
              <div className="gg-msg-bubble">
                {m.role === 'assistant' && m.thinking && (() => {
                  // Edge case: модель эмитнула ТОЛЬКО thinking без видимого
                  // ответа (короткий запрос → длинное рассуждение → done без
                  // финального текста). Чтобы пузырь не казался пустым —
                  // автоматически разворачиваем блок и показываем подпись.
                  const hasVisibleAnswer = !!(m.content && m.content.trim())
                  const isFinal = !isStreamingAssistant
                  const onlyThinking = !hasVisibleAnswer && isFinal
                  return (
                    <details className="gg-thinking" open={onlyThinking || undefined}>
                      <summary className="gg-thinking-summary">
                        <span>💭</span>
                        <span>{onlyThinking ? 'Только размышление, без видимого ответа' : 'Размышление модели'}</span>
                        <span className="gg-thinking-len">{m.thinking.length} симв.</span>
                      </summary>
                      <div className="gg-thinking-body">
                        <Markdown text={m.thinking} onOpenFile={onOpenFilePreview} />
                      </div>
                    </details>
                  )
                })()}
                {changedFiles.length > 0 && (
                  <div className="gg-changed-files">
                    <div className="gg-changed-files-title">✓ Изменены файлы ({changedFiles.length})</div>
                    {changedFiles.map((f, ci) => (
                      <div key={ci} className="gg-changed-files-row">{f}</div>
                    ))}
                  </div>
                )}
                {m.attachments?.length ? (
                  <div className="gg-msg-attachments">
                    {m.attachments.map((a, ai) => (
                      <AttachmentPreview key={ai} attachment={a} compact />
                    ))}
                  </div>
                ) : null}
                {renderedContent
                  ? (m.role === 'assistant'
                      ? <Markdown text={renderedContent} onOpenFile={onOpenFilePreview} />
                      : supplement
                        ? (
                          <>
                            <div className="gg-msg-supplement-tag">{supplement.tag}</div>
                            <span style={{ whiteSpace: 'pre-wrap' }}>{supplement.body}</span>
                          </>
                        )
                        : <span style={{ whiteSpace: 'pre-wrap' }}>{renderedContent}</span>)
                  : isStreamingAssistant
                    ? <div className="gg-typing"><span /><span /><span /></div>
                    : null
                }
              </div>
              )}
              {m.role === 'user' && m.source === 'reminder' && (
                <div className="gg-msg-source-note">Отправлено автоматически из раздела Напоминания</div>
              )}
              {m.role === 'user' && !!m.appliedSkills?.length && (
                <div className="gg-msg-skill-note" title="Эти скиллы были применены только к этому сообщению">
                  <span className="gg-msg-skill-note-label">
                    {m.appliedSkills.length === 1 ? 'Применён скилл' : 'Применены скиллы'}
                  </span>
                  <span className="gg-msg-skill-note-list">
                    {m.appliedSkills.map(skill => (
                      <span key={skill.id} className="gg-msg-skill-note-pill">
                        {skill.icon && <span aria-hidden>{skill.icon}</span>}
                        <span>{skillDisplayName(skill)}</span>
                      </span>
                    ))}
                  </span>
                </div>
              )}
              {m.content && !isStreamingAssistant && (
                <MessageActions
                  text={m.content}
                  // «Править» ведёт в ветку через editViaFork: оригинал не трогается.
                  // Видимость — единый гейт canEditMessage (в т.ч. НЕ в справке, ре-ревью D #2).
                  onEdit={canEditMessage(m, { activeChatId, helpMode })
                    ? () => { void useProject.getState().editViaFork(activeChatId!, m.dbId!) }
                    : undefined}
                />
              )}
              {/* Cross-verify pill: показываем под последним assistant-сообщением */}
              {isLast && m.role === 'assistant' && !isStreaming && crossVerify && (
                <div
                  className={`gg-cross-verify ${crossVerify.ok ? 'is-ok' : 'is-warn'}`}
                  onClick={() => setCvExpanded(v => !v)}
                  title={cvExpanded ? 'Свернуть' : 'Развернуть результат ревью'}
                >
                  <span className="gg-cv-badge">
                    {crossVerify.ok ? '✅' : '⚠️'} Проверено {crossVerify.provider}
                    <span className="gg-cv-chevron">{cvExpanded ? '▴' : '▾'}</span>
                  </span>
                  {cvExpanded && (
                    <div className="gg-cv-detail">{crossVerify.result}</div>
                  )}
                </div>
              )}
            </div>
            </Fragment>
          )
        })}
    </>
  )
}
