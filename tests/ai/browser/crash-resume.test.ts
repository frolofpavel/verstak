// crash-resume.test.ts — расширение crash-resume guard под browser mutations (B0 п.6).
//
// Главные свойства:
//   • browser_navigate / browser_click / browser_type_text → isMutatingTool=true
//   • browser_screenshot / browser_read_page / browser_observe → isMutatingTool=false
//   • lastToolName=browser_click → isAutoResumable=false
//   • в plan-режиме / с auto/bypass agent_mode — тоже false

import { describe, it, expect } from 'vitest'
import { isMutatingTool, isAutoResumable } from '../../../electron/storage/agent-runs'

describe('isMutatingTool — browser actions расширение (EXT-B0 п.6)', () => {
  it('browser_navigate → мутация (R1 navigation)', () => {
    expect(isMutatingTool('browser_navigate')).toBe(true)
  })
  it('browser_click → мутация (R3 unknown click)', () => {
    expect(isMutatingTool('browser_click')).toBe(true)
  })
  it('browser_type_text → мутация (R2/R3)', () => {
    expect(isMutatingTool('browser_type_text')).toBe(true)
  })
  it('browser_select_option → мутация', () => {
    expect(isMutatingTool('browser_select_option')).toBe(true)
  })
  it('browser_toggle → мутация', () => {
    expect(isMutatingTool('browser_toggle')).toBe(true)
  })
  it('browser_press_key → мутация', () => {
    expect(isMutatingTool('browser_press_key')).toBe(true)
  })
  it('browser_back/forward/reload/scroll/focus → мутации', () => {
    expect(isMutatingTool('browser_back')).toBe(true)
    expect(isMutatingTool('browser_forward')).toBe(true)
    expect(isMutatingTool('browser_reload')).toBe(true)
    expect(isMutatingTool('browser_scroll')).toBe(true)
    expect(isMutatingTool('browser_focus')).toBe(true)
  })
  it('browser_clear_field → мутация', () => {
    expect(isMutatingTool('browser_clear_field')).toBe(true)
  })
})

describe('isMutatingTool — browser R0 НЕ мутации', () => {
  it('browser_screenshot → не мутация (R0)', () => {
    expect(isMutatingTool('browser_screenshot')).toBe(false)
  })
  it('browser_read_page → не мутация (R0)', () => {
    expect(isMutatingTool('browser_read_page')).toBe(false)
  })
  it('browser_observe → не мутация (R0)', () => {
    expect(isMutatingTool('browser_observe')).toBe(false)
  })
  it('browser_wait_for → не мутация (R0)', () => {
    expect(isMutatingTool('browser_wait_for')).toBe(false)
  })
})

describe('isMutatingTool — unknown browser_* tool fail-closed', () => {
  it('browser_unknown_action → мутация (fail-closed, как classifyRisk)', () => {
    expect(isMutatingTool('browser_download_file')).toBe(true)
    expect(isMutatingTool('browser_upload_file')).toBe(true)
    expect(isMutatingTool('browser_new_unknown_thing')).toBe(true)
  })
})

describe('isMutatingTool — non-browser tools не задеты', () => {
  it('write_file/apply_patch/run_command → всё ещё мутации', () => {
    expect(isMutatingTool('write_file')).toBe(true)
    expect(isMutatingTool('apply_patch')).toBe(true)
    expect(isMutatingTool('run_command')).toBe(true)
  })
  it('read_file/list_directory → НЕ мутации', () => {
    expect(isMutatingTool('read_file')).toBe(false)
    expect(isMutatingTool('list_directory')).toBe(false)
    expect(isMutatingTool('search_project')).toBe(false)
  })
  it('connector_query → мутация (connector-*)', () => {
    expect(isMutatingTool('connector_query')).toBe(true)
  })
})

describe('isAutoResumable — browser mutations блокируют resume (B0 п.6)', () => {
  it('lastToolName=browser_click → НЕ autoResumable', () => {
    const r = isAutoResumable({
      lastToolName: 'browser_click',
      agentMode: 'ask',
      providerId: 'kimi',
    })
    expect(r).toBe(false)
  })
  it('lastToolName=browser_navigate → НЕ autoResumable', () => {
    const r = isAutoResumable({
      lastToolName: 'browser_navigate',
      agentMode: 'ask',
      providerId: 'kimi',
    })
    expect(r).toBe(false)
  })
  it('lastToolName=browser_type_text → НЕ autoResumable', () => {
    const r = isAutoResumable({
      lastToolName: 'browser_type_text',
      agentMode: 'accept-edits',
      providerId: 'kimi',
    })
    expect(r).toBe(false)
  })
  it('lastToolName=browser_screenshot → autoResumable=true (R0)', () => {
    const r = isAutoResumable({
      lastToolName: 'browser_screenshot',
      agentMode: 'ask',
      providerId: 'kimi',
    })
    expect(r).toBe(true)
  })
  it('lastToolName=browser_read_page → autoResumable=true (R0)', () => {
    const r = isAutoResumable({
      lastToolName: 'browser_read_page',
      agentMode: 'ask',
      providerId: 'kimi',
    })
    expect(r).toBe(true)
  })
  it('lastToolName=browser_observe → autoResumable=true (R0)', () => {
    const r = isAutoResumable({
      lastToolName: 'browser_observe',
      agentMode: 'ask',
      providerId: 'kimi',
    })
    expect(r).toBe(true)
  })
})

describe('isAutoResumable — старые правила не сломаны', () => {
  it('lastToolName=write_file → НЕ autoResumable', () => {
    expect(isAutoResumable({ lastToolName: 'write_file', agentMode: 'ask', providerId: 'kimi' })).toBe(false)
  })
  it('lastToolName=read_file → autoResumable (safe)', () => {
    expect(isAutoResumable({ lastToolName: 'read_file', agentMode: 'ask', providerId: 'kimi' })).toBe(true)
  })
  it('agentMode=auto → НЕ autoResumable (независимо от tool)', () => {
    expect(isAutoResumable({ lastToolName: 'read_file', agentMode: 'auto', providerId: 'kimi' })).toBe(false)
  })
  it('CLI provider → НЕ autoResumable', () => {
    expect(isAutoResumable({ lastToolName: 'read_file', agentMode: 'ask', providerId: 'claude-cli' })).toBe(false)
  })
})

describe('RED: реальный regression — последний browser action = нет silent-resume', () => {
  it('если run упал на browser_click — auto-resume должен быть запрещён', () => {
    // Сценарий: прогон был прерван на browser_click. Без расширения classifier'а
    // isMutatingTool вернул бы false (browser_click не в MUTATING_TOOLS) →
    // isAutoResumable=true → silent resume → потенциально повторный submit.
    // После EXT-B0: browser_click — мутация → resume требует ручного подтверждения.
    const r = isAutoResumable({
      lastToolName: 'browser_click',
      agentMode: 'accept-edits',
      providerId: 'kimi',
    })
    expect(r).toBe(false)
  })
})
