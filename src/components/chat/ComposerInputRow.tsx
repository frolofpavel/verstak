// Декомпозиция Chat.tsx (2.1.11 срез B-остаток): ядро композера — ряд ввода.
//
// Вынесено из Chat.tsx БЕЗ изменения разметки, классов и порядка узлов. Один
// связный узел «куда человек печатает и чем отправляет»:
//  · поповеры подстановки (@-упоминания файлов и слэш-команды);
//  · само поле ввода вместе с клавиатурным контрактом;
//  · ряд действий — вложение, голос, уровень усилий, отправка/пауза/стоп;
//  · скрытый файловый вход.
//
// Клавиатурный контракт перенесён дословно и закреплён пинами в
// tests/components/chat-composer-characterization.test.ts: слэш-команду Enter не
// отправляет (попап обрабатывает сам), Ctrl/Cmd+Enter на стриме дописывает контекст,
// Enter на стриме ставит в очередь, Esc на стриме останавливает.
//
// Компонент презентационный: своего состояния нет, решения остаются в Chat.tsx.

import type { ChangeEvent, ClipboardEvent, RefObject } from 'react'
import { MentionPopup } from '../MentionPopup'
import { SlashCommandPopup } from '../SlashCommandPopup'
import { VoiceInput } from '../VoiceInput'
import { EffortPicker } from '../EffortPicker'
import { buildSystemSlashCommands } from './system-slash-commands'
import { CHAT_FILE_ACCEPT } from '../../lib/chat-attachments'

export interface ComposerInputRowProps {
  input: string
  setInput: (next: string | ((prev: string) => string)) => void
  textareaRef: RefObject<HTMLTextAreaElement | null>
  fileInputRef: RefObject<HTMLInputElement | null>
  activePath: string | null
  /** Чат справки: без @-упоминаний и без системных слэш-команд. */
  isHelpChat: boolean
  /** Домашний экран — своя подсказка в поле. */
  isHome: boolean
  helpMode: boolean
  isStreaming: boolean
  canSend: boolean
  /** Подпись провайдера и поддержка тулзов — плейсхолдер и доступность паузы. */
  providerLabel: string
  providerSupportsTools: boolean
  placeholders: { streaming: string; home: string; idle: string }
  onPaste: (e: ClipboardEvent<HTMLTextAreaElement>) => void
  onFilesPicked: (e: ChangeEvent<HTMLInputElement>) => void
  send: () => void
  /** asSuspend=true — пауза с сохранением прогресса. */
  stop: (asSuspend?: boolean) => void
  queueFollowUp: (text: string) => void
  appendToCurrentContext: () => void
  injectTemplate: (template: string) => void
  newChatSession: () => void
  clearActiveSkill: () => void
}

export function ComposerInputRow(props: ComposerInputRowProps) {
  const {
    input, setInput, textareaRef, fileInputRef, activePath, isHelpChat, isHome,
    helpMode, isStreaming, canSend, providerLabel, providerSupportsTools, placeholders,
    onPaste, onFilesPicked, send, stop, queueFollowUp, appendToCurrentContext,
    injectTemplate, newChatSession, clearActiveSkill,
  } = props
  return (
    <div className="gg-composer-inner">
      {!isHelpChat && (
        <MentionPopup
          text={input}
          projectPath={activePath}
          onReplace={next => setInput(next)}
        />
      )}
      <SlashCommandPopup
        text={input}
        onClear={() => setInput('')}
        onInject={text => setInput(text)}
        projectPath={activePath}
        helpScope={isHelpChat}
        systemCommands={isHelpChat ? [] : buildSystemSlashCommands({
          newChatSession,
          clearActiveSkill,
          injectTemplate,
        })}
      />
      <textarea
        ref={textareaRef}
        className="gg-composer-textarea"
        value={input}
        rows={1}
        onChange={e => setInput(e.target.value)}
        onPaste={onPaste}
        onKeyDown={e => {
          // SlashCommandPopup глобально обрабатывает Enter/Esc когда
          // текст начинается с "/". Не отправляем сообщение в этом случае.
          const slashOpen = input.startsWith('/') && !input.includes('\n')
          if (slashOpen && (e.key === 'Enter' || e.key === 'Escape' || e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
            return  // popup сам всё обработает
          }
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && isStreaming && input.trim()) {
            e.preventDefault()
            void appendToCurrentContext()
            return
          }
          if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
            e.preventDefault()
            if (isStreaming && input.trim()) {
              queueFollowUp(input.trim())
              return
            }
            void send()
          }
          if (e.key === 'Escape' && isStreaming) {
            e.preventDefault()
            void stop()
          }
        }}
        placeholder={
          isStreaming
            ? `${providerLabel} ${placeholders.streaming}`
            : isHome
              ? placeholders.home
              : placeholders.idle
        }
      />
      <div className="gg-composer-actions">
        <button
          type="button"
          className="gg-attach-btn"
          onClick={() => fileInputRef.current?.click()}
          disabled={isStreaming}
          title="Прикрепить файл"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 11.5a8.38 8.38 0 0 1 -8.5 8.5 8.5 8.5 0 0 1 -8.5 -8.5 8.5 8.5 0 0 1 17 0z" style={{ display: 'none' }} />
            <path d="m21.44 11.05 -9.19 9.19a6 6 0 0 1 -8.49 -8.49l9.19 -9.19a4 4 0 0 1 5.66 5.66L9.41 17.41a2 2 0 0 1 -2.83 -2.83l8.49 -8.48" />
          </svg>
        </button>
        <VoiceInput
          disabled={isStreaming}
          onTranscript={chunk => setInput(prev => prev + chunk)}
        />
        <EffortPicker />
        {isStreaming ? (
          <>
          {/* ⏸ только для API-провайдеров с проектом: только этот путь пишет чекпойнт
              (runApiConversation). CLI/справка не чекпойнтят → ⏸ был бы молча=⏹. */}
          {providerSupportsTools && !helpMode && (
          <button
            className="gg-send-btn gg-pause-btn"
            onClick={() => void stop(true)}
            title="Приостановить — сохранить прогресс и продолжить позже (↻)"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="5" width="4" height="14" rx="1" />
              <rect x="14" y="5" width="4" height="14" rx="1" />
            </svg>
          </button>
          )}
          <button
            className="gg-send-btn gg-stop-btn"
            onClick={() => void stop()}
            title="Остановить (Esc)"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="6" width="12" height="12" rx="1.5" />
            </svg>
          </button>
          </>
        ) : (
          <button
            className="gg-send-btn"
            onClick={() => void send()}
            disabled={!canSend}
            title="Отправить (Enter)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12l14 -8l-4 16l-4 -6l-6 -2z" />
            </svg>
          </button>
        )}
      </div>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        accept={CHAT_FILE_ACCEPT}
        onChange={onFilesPicked}
      />
    </div>
  )
}
