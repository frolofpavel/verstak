import { describe, it, expect } from 'vitest'
import { shouldShowLiveState } from '../../src/components/AgentProgressPanel'

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
