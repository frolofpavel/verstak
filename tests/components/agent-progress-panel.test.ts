import { describe, it, expect } from 'vitest'
import { shouldShowLiveState, currentEntry } from '../../src/components/AgentProgressPanel'
import type { AgentProgressEntry } from '../../src/lib/agent-progress'

// Дефект 08.08 (найден Павлом): карточка «Ход работы» показывала ОДНОВРЕМЕННО «идёт»
// и «завершено HH:MM:SS» — человек читал это как «прогон завис» и перезапускал живую
// задачу. Механизм: прогон заканчивается (isStreaming=false) по пути согласования
// стрим-флага, который НЕ переписывает agentProgress (reconcileStreamFlag, phantom-flag
// в projectStore, вход/выход из чата), поэтому последняя запись остаётся в 'running'.
// isStreaming — авторитетный сигнал «прогон окончен»; живой бейдж после конца устарел.
describe('shouldShowLiveState — живой бейдж не переживает конец прогона', () => {
  // КОНТРОЛЬ 1 (штаб): прогон завершён + запись running → «идёт» НЕ показывается.
  it('завершён + running → скрыто (устаревшее живое состояние)', () => {
    expect(shouldShowLiveState('running', false)).toBe(false)
  })
  // КОНТРОЛЬ 2 (штаб, обязателен): прогон РЕАЛЬНО идёт + running → «идёт» ПОКАЗАНО.
  // Без него фикс выродился бы в «никогда не показывать идёт» — потеряли бы живую
  // индикацию, не заметив.
  it('идёт + running → показано (живая индикация сохраняется)', () => {
    expect(shouldShowLiveState('running', true)).toBe(true)
  })
  it('завершён + pending → скрыто (тоже устаревшее живое состояние)', () => {
    expect(shouldShowLiveState('pending', false)).toBe(false)
  })
  it('завершён + done → скрыто (дублирует «завершено» в таймере)', () => {
    expect(shouldShowLiveState('done', false)).toBe(false)
  })
  it('завершён + error → ПОКАЗАНО (терминальную проблему надо видеть)', () => {
    expect(shouldShowLiveState('error', false)).toBe(true)
  })
  it('завершён + blocked → ПОКАЗАНО (терминальная проблема)', () => {
    expect(shouldShowLiveState('blocked', false)).toBe(true)
  })
})

// Вторая половина дефекта 08.08: currentEntry давал «Сейчас» с заголовком в настоящем
// времени у уже завершённого прогона (устаревший running-шаг как «текущий»).
describe('currentEntry — текущий шаг у завершённого прогона', () => {
  const running: AgentProgressEntry = { id: 'final', phase: 'final', title: 'Пишу видимый ответ', status: 'running', timestamp: 10 }
  const done: AgentProgressEntry = { id: 'done', phase: 'final', title: 'Ответ готов', status: 'done', timestamp: 20 }

  it('прогон завершён → текущим становится ТЕРМИНАЛЬНЫЙ шаг, не устаревший running', () => {
    expect(currentEntry([running, done], false)?.id).toBe('done')
  })
  it('прогон идёт → текущим остаётся ЖИВОЙ running-шаг (живая индикация)', () => {
    expect(currentEntry([running, done], true)?.id).toBe('final')
  })
})
