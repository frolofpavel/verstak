// Декомпозиция Chat.tsx (2.1.11 срез B-остаток, часть 2): нижняя строка композера.
//
// Вынесено из Chat.tsx БЕЗ изменения разметки, классов и порядка узлов — блок
// `gg-composer-hint` вместе с вложенным `gg-composer-meta`:
//  · подсказки клавиатуры во время стрима;
//  · счётчик токенов черновика и ценник, расход за чат, Σ за всю сессию;
//  · кнопка отката последней правки, переключатель автопрокрутки, DevTaskBadge;
//  · поповер «Инструменты чата» (модель, режим, инструменты, тумблер рекомендаций
//    скиллов, вход в pipeline);
//  · турбо-кнопка, вход в pipeline, «Прогоны», инструменты, ModePicker,
//    IntensityToggle, ModelPicker, PromptRouteControl.
//
// Вместе с блоком переехали локальные `TokenPreviewMeter` и `formatTokens` —
// в Chat.tsx их использовал только этот узел.
//
// Пропсы намеренно названы теми же именами, что были у переменных замыкания в
// Chat.tsx: так тело JSX переезжает дословно, без единой правки разметки.
// Компонент презентационный: своего состояния нет, решения остаются в Chat.tsx.

import { useState, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { estimateCost, costSeverity, costBreakdown } from '../../lib/pricing'
import { ModelPicker } from '../ModelPicker'
import { ModePicker, type AgentMode } from '../ModePicker'
import { IntensityToggle } from '../IntensityToggle'
import { DevTaskBadge } from '../DevTaskBadge'
import { ComposerToolsMenu } from '../ComposerToolsMenu'
import { PromptRouteControl } from './PromptRouteControl'
import { isCliProvider } from '../../lib/model-catalog'
import { HELP_AGENT_MODE } from '../../lib/help-scope'
import type { useProvider } from '../../hooks/useProvider'
import type { SessionUsage } from '../../store/session-snapshot'
import type { Translations } from '../../i18n'
import type { PipelineMode, PipelineRun } from '../../types/api'

function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/** Иконка-индикатор черновика: заливка растёт с объёмом текста (визуальный cap 32k). */
function TokenPreviewMeter({ tokens, exact, title }: { tokens: number; exact: boolean; title: string }) {
  const fill = Math.min(1, tokens / 32_000)
  const innerH = Math.max(1.2, fill * 9)
  const innerY = 13.2 - innerH
  return (
    <span className="gg-usage-pill is-preview" title={title}>
      <svg className="gg-usage-meter-icon" width="14" height="14" viewBox="0 0 16 16" aria-hidden>
        <rect x="3" y="2" width="10" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="1.15" opacity="0.38" />
        <rect x="3.6" y={innerY} width="8.8" height={innerH} rx="1.1" fill="currentColor" opacity="0.9" />
      </svg>
      <span className="gg-usage-meter-label">{exact ? '' : '≈'}{formatTokens(tokens)}</span>
    </span>
  )
}

export interface SessionStats {
  runs: number
  costCents: number
  toolCount: number
  filesCount: number
  agentsCount: number
  durationMs: number
}

export interface ComposerMetaRowProps {
  input: string
  isStreaming: boolean
  isHelpChat: boolean
  activePath: string | null
  t: Translations
  provider: ReturnType<typeof useProvider>
  /** Оценка черновика: null — превью ещё нет, счётчик не рендерится. */
  previewTokens: { tokens: number; exact: boolean } | null
  sessionUsage: SessionUsage
  sessionStats: SessionStats | null
  undoCount: number
  chatIsolated: boolean
  revertLastWrite: () => Promise<void>
  autoScrollEnabled: boolean
  toggleAutoScroll: () => void
  composerSettingsRef: RefObject<HTMLDivElement | null>
  composerSettingsOpen: boolean
  setComposerSettingsOpen: Dispatch<SetStateAction<boolean>>
  onOpenSettings: () => void
  agentMode: AgentMode
  applyMode: (m: AgentMode) => Promise<void>
  setAgentMode: (m: AgentMode) => Promise<void>
  saveHandoffToDownloads: () => Promise<void>
  exportTranscript: () => Promise<void>
  handoffBusy: boolean
  skillSuggestionsEnabled: boolean
  setProjectSkillSuggestionsEnabled: (enabled: boolean) => void
  activePipeline: PipelineRun | null
  setPipelineWizardMode: (mode: PipelineMode) => void
  setPipelineWizardOpen: (open: boolean) => void
  setOutcomeRunsOpen: (open: boolean) => void
}

export function ComposerMetaRow(props: ComposerMetaRowProps) {
  const {
    input, isStreaming, isHelpChat, activePath, t, provider, previewTokens,
    sessionUsage, sessionStats, undoCount, chatIsolated, revertLastWrite,
    autoScrollEnabled, toggleAutoScroll, composerSettingsRef, composerSettingsOpen,
    setComposerSettingsOpen, onOpenSettings, agentMode, applyMode, setAgentMode,
    saveHandoffToDownloads, exportTranscript, handoffBusy,
    skillSuggestionsEnabled, setProjectSkillSuggestionsEnabled, activePipeline,
    setPipelineWizardMode, setPipelineWizardOpen, setOutcomeRunsOpen,
  } = props
  // V1 (волна 2.6.0): телеметрия прогона свёрнута под одну иконку.
  //
  // ПОЧЕМУ УЗЛЫ ОСТАЮТСЯ В DOM, А НЕ РАЗМОНТИРУЮТСЯ. Скрытие здесь — задача CSS
  // (класс `is-closed`), и это не обход, а условие безопасности правки: 46
  // характеризационных пинов чата ищут эти узлы селектором, и размонтирование
  // сделало бы «зелёный прогон» результатом исчезновения элемента, а не
  // сохранности поведения. Состояние раскрытия читается пином по классу и
  // aria-expanded — видимость держит стиль, наличие держит разметка.
  //
  // Ничего не удалено и не переименовано: те же самые узлы, те же значения, тот
  // же единственный источник данных — они лишь переехали внутрь раскрытия.
  const [telemetryOpen, setTelemetryOpen] = useState(false)
  return (
    <div className="gg-composer-hint">
      {isStreaming && input.trim() ? (
        <div className="gg-composer-insights">
          {isStreaming && input.trim() && (
            <div className="gg-composer-streaming-hint">
              <span>
                <kbd className="gg-kbd">Ctrl+Enter</kbd>
                {' - '}
                {t.chat.streamingAppendHint}
                {' / '}
                <kbd className="gg-kbd">Enter</kbd>
                {' - '}
                {t.chat.streamingQueueHint}
              </span>
            </div>
          )}
        </div>
      ) : null}
      {false && isStreaming && input.trim() && (
        <div className="gg-composer-streaming-hint">
          <span>
            <kbd className="gg-kbd">Ctrl+Enter</kbd>
            {' - '}
            {t.chat.streamingAppendHint}
            {' / '}
            <kbd className="gg-kbd">Enter</kbd>
            {' - '}
            {t.chat.streamingQueueHint}
          </span>
        </div>
      )}
      <div className="gg-composer-meta">
        <div className="gg-composer-meta-cluster">
          {previewTokens && previewTokens.tokens > 0 && (() => {
            const cost = estimateCost(provider.id, provider.model, previewTokens.tokens, 0, 0)
            const title = previewTokens.exact
              ? `Точная оценка от ${provider.label}: ${previewTokens.tokens} токенов на следующий запрос${cost.usd ? `, ~${cost.usd} (только input)` : ''}`
              : `Грубая оценка (4 символа = 1 токен): ${previewTokens.tokens} токенов`
            return (
              <>
                <TokenPreviewMeter tokens={previewTokens.tokens} exact={previewTokens.exact} title={title} />
                {cost.usd && previewTokens.exact && (
                  <span className="gg-usage-pill is-preview is-cost-hint" title={title}>
                    <span className="gg-usage-cost">~{cost.usd}</span>
                  </span>
                )}
              </>
            )
          })()}
          <button
            type="button"
            className={`gg-telemetry-btn ${telemetryOpen ? 'is-open' : ''}`}
            onClick={() => setTelemetryOpen(v => !v)}
            aria-expanded={telemetryOpen}
            aria-label="Показатели прогона"
            title="Показатели прогона: токены, стоимость, инструменты, автопрокрутка"
          >
            <span aria-hidden>📊</span>
          </button>
          <div className={`gg-telemetry-drawer ${telemetryOpen ? 'is-open' : 'is-closed'}`}>
          {(sessionUsage.inputTokens > 0 || sessionUsage.outputTokens > 0) && (() => {
            // 2.0.8-E хвост: передаём семантику провайдера — иначе у Claude (exclusive)
            // из input повторно вычитался кэш и ценник занижал реальную стоимость (дефект B).
            const cost = estimateCost(provider.id, provider.model, sessionUsage.inputTokens, sessionUsage.outputTokens, sessionUsage.cachedInputTokens, sessionUsage.inputAccounting, sessionUsage.cacheWriteTokens ?? 0)
            const severity = costSeverity(cost.cents)
            const breakdown = costBreakdown(provider.id, provider.model, sessionUsage.inputTokens, sessionUsage.outputTokens, sessionUsage.cachedInputTokens, sessionUsage.inputAccounting, sessionUsage.cacheWriteTokens ?? 0)
            return (
              <span className={`gg-usage-pill ${severity}`} title={breakdown}>
                <span>↑{formatTokens(sessionUsage.inputTokens)}</span>
                <span className="gg-usage-sep">·</span>
                <span>↓{formatTokens(sessionUsage.outputTokens)}</span>
                {sessionUsage.cachedInputTokens > 0 && (
                  <>
                    <span className="gg-usage-sep">·</span>
                    <span title="Cached input">⟲{formatTokens(sessionUsage.cachedInputTokens)}</span>
                  </>
                )}
                {(sessionUsage.cacheWriteTokens ?? 0) > 0 && (
                  <span title="Записано в prompt cache">⇧{formatTokens(sessionUsage.cacheWriteTokens ?? 0)}</span>
                )}
                {cost.usd && (
                  <>
                    <span className="gg-usage-sep">·</span>
                    <span className="gg-usage-cost">{cost.usd}</span>
                  </>
                )}
              </span>
            )
          })()}
          {sessionStats && sessionStats.runs > 0 && (
            <span
              className="gg-usage-pill"
              title={`Σ за всю сессию (${sessionStats.runs} прогон(ов)${sessionStats.durationMs > 1000 ? ` · ${Math.max(1, Math.round(sessionStats.durationMs / 60000))} мин` : ''}) — переживает рестарт`}
            >
              <span>Σ ${(sessionStats.costCents / 100).toFixed(2)}</span>
              {sessionStats.toolCount > 0 && (<><span className="gg-usage-sep">·</span><span>🔧{sessionStats.toolCount}</span></>)}
              {sessionStats.filesCount > 0 && (<><span className="gg-usage-sep">·</span><span>📄{sessionStats.filesCount}</span></>)}
            </span>
          )}
          <button
            type="button"
            className={`gg-auto-scroll-btn ${autoScrollEnabled ? 'is-on' : 'is-off'}`}
            onClick={toggleAutoScroll}
            title={autoScrollEnabled ? t.chat.autoScrollOn : t.chat.autoScrollOff}
            aria-pressed={autoScrollEnabled}
          >
            {autoScrollEnabled ? t.chat.autoScrollLabelOn : t.chat.autoScrollLabelOff}
          </button>
          </div>
          {/* Откат правки — ДЕЙСТВИЕ, а не телеметрия: остаётся на виду. Спрятать
              его за раскрытие значило бы отнять у человека кнопку отмены, а
              постановка V1 про показатели, а не про доступ к действиям. */}
          {undoCount > 0 && !chatIsolated && (
            <button
              type="button"
              className="gg-undo-btn"
              onClick={() => void revertLastWrite()}
              title="Откатить последнюю правку файла"
            >
              <span>↶</span>
              <span className="gg-undo-count">{undoCount}</span>
            </button>
          )}
          <DevTaskBadge />
        </div>
        <div className="gg-composer-meta-cluster gg-composer-meta-cluster--end">
          <div className="gg-chat-settings-wrap" ref={composerSettingsRef}>
            <button
              type="button"
              className={`gg-chat-settings-btn ${composerSettingsOpen ? 'is-active' : ''}`}
              onClick={() => setComposerSettingsOpen(v => !v)}
              title={t.sidebar.chatTools}
              aria-expanded={composerSettingsOpen}
            >
              <span>{t.sidebar.chatTools}</span>
            </button>
            {composerSettingsOpen && (
              <div className="gg-chat-settings-popover">
                <div className="gg-chat-settings-grid">
                  <div className="gg-chat-settings-item gg-chat-settings-item--model">
                    <span className="gg-chat-settings-label">Модель</span>
                    <div className="gg-chat-settings-model-control">
                      <ModelPicker onOpenSettings={onOpenSettings} />
                      <span className={`gg-chat-settings-model-kind ${isCliProvider(provider.id) ? 'is-cli' : 'is-api'}`}>
                        {isCliProvider(provider.id) ? 'CLI' : 'API'}
                      </span>
                    </div>
                  </div>
                  <div className="gg-chat-settings-item gg-chat-settings-item--mode">
                    <span className="gg-chat-settings-label">Режим</span>
                    <ModePicker
                      mode={isHelpChat ? HELP_AGENT_MODE : agentMode}
                      onChange={m => { void applyMode(m) }}
                      locked={isHelpChat}
                    />
                  </div>
                  {!isHelpChat && (
                    <div className="gg-chat-settings-item">
                      <span className="gg-chat-settings-label">Инструменты</span>
                      <ComposerToolsMenu
                        onSaveHandoff={saveHandoffToDownloads}
                        onExportTranscript={exportTranscript}
                        exportBusy={handoffBusy}
                      />
                    </div>
                  )}
                  {!isHelpChat && (
                    <div className="gg-chat-settings-item">
                      <span className="gg-chat-settings-label">Скиллы</span>
                      <button
                        type="button"
                        className="gg-chat-settings-toggle-control"
                        onClick={() => setProjectSkillSuggestionsEnabled(!skillSuggestionsEnabled)}
                        title="Показывать автоматические рекомендации скиллов в этом проекте"
                      >
                        <span className="gg-chat-settings-toggle-text">Рекомендации скиллов</span>
                        <span className={`gg-toggle ${skillSuggestionsEnabled ? 'is-on' : ''}`} aria-hidden>
                          <span className="gg-toggle-knob" />
                        </span>
                      </button>
                    </div>
                  )}
                  {!isHelpChat && !activePipeline && (
                    <div className="gg-chat-settings-item">
                      <span className="gg-chat-settings-label">{t.pipeline.entry}</span>
                      <button
                        type="button"
                        className="gg-btn gg-btn-ghost gg-btn-xs gg-pipeline-entry"
                        onClick={() => {
                          setComposerSettingsOpen(false)
                          setPipelineWizardMode('agency')
                          setPipelineWizardOpen(true)
                        }}
                        disabled={isCliProvider(provider.id)}
                        title={isCliProvider(provider.id) ? t.pipeline.cliGate : t.pipeline.title}
                      >
                        {t.pipeline.entry}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
          <button
            type="button"
            className={`gg-chat-turbo-btn ${agentMode === 'auto' || agentMode === 'bypass' ? 'is-turbo' : 'is-simple'}`}
            onClick={() => { void setAgentMode(agentMode === 'auto' || agentMode === 'bypass' ? 'ask' : 'auto') }}
            disabled={isHelpChat}
            title={
              isHelpChat
                ? 'В справке режим зафиксирован'
                : agentMode === 'auto' || agentMode === 'bypass'
                  ? 'Турбо-режим включён. Нажмите, чтобы вернуться в простой режим.'
                  : 'Включить турбо-режим: агент будет выполнять действия быстрее и принимать правки автоматически.'
            }
            aria-label={agentMode === 'auto' || agentMode === 'bypass' ? 'Выключить турбо-режим' : 'Включить турбо-режим'}
            aria-pressed={agentMode === 'auto' || agentMode === 'bypass'}
          >
            <span aria-hidden>🔥</span>
          </button>
          {!isHelpChat && !activePipeline && (
            <button
              type="button"
              className="gg-btn gg-btn-ghost gg-btn-xs gg-pipeline-entry"
              onClick={() => { setPipelineWizardMode('agency'); setPipelineWizardOpen(true) }}
              disabled={isCliProvider(provider.id)}
              title={isCliProvider(provider.id) ? t.pipeline.cliGate : t.pipeline.title}
            >
              {t.pipeline.entry}
            </button>
          )}
          {!isHelpChat && activePath && (
            <button
              type="button"
              className="gg-btn gg-btn-ghost gg-btn-xs gg-pipeline-entry"
              onClick={() => setOutcomeRunsOpen(true)}
              title="История задач «До результата»"
            >
              Прогоны
            </button>
          )}
          {!isHelpChat && (
            <ComposerToolsMenu
              onSaveHandoff={saveHandoffToDownloads}
              onExportTranscript={exportTranscript}
              exportBusy={handoffBusy}
            />
          )}
          <ModePicker
            mode={isHelpChat ? HELP_AGENT_MODE : agentMode}
            onChange={m => { void applyMode(m) }}
            locked={isHelpChat}
          />
          {!isHelpChat && <IntensityToggle />}
          <ModelPicker onOpenSettings={onOpenSettings} />
          {!isHelpChat && <PromptRouteControl />}
        </div>
      </div>
    </div>
  )
}
