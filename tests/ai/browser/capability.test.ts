// capability.test.ts — task-level Capability Envelope (план §5.3 инвариант 13).
//
// Главные свойства:
//   • default capability — узкая (только observe/navigate/scroll/screenshot)
//   • page-derived instruction НЕ может расширить capability
//   • cross-tools (run_command/connector_query/file write) всегда запрещены
//   • site policy (allowedDomains) — fail-closed если список не пуст

import { describe, it, expect } from 'vitest'
import {
  defaultCapability,
  buildCapabilityFromCommand,
  isActionAllowedByCaps,
  isDomainAllowedByCaps,
  isCrossToolForbidden,
  FORBIDDEN_CROSS_TOOLS,
  R4_ALWAYS_FORBIDDEN_PAYLOAD_KEYS,
} from '../../../electron/ai/browser/capability'

describe('defaultCapability — узкая базовая capability', () => {
  it('разрешает observe/navigate/scroll/screenshot/wait_for', () => {
    const caps = defaultCapability()
    expect(isActionAllowedByCaps(caps, 'observe')).toBe(true)
    expect(isActionAllowedByCaps(caps, 'navigate')).toBe(true)
    expect(isActionAllowedByCaps(caps, 'scroll')).toBe(true)
    expect(isActionAllowedByCaps(caps, 'screenshot')).toBe(true)
    expect(isActionAllowedByCaps(caps, 'wait_for')).toBe(true)
  })
  it('НЕ разрешает click/type_text по умолчанию', () => {
    const caps = defaultCapability()
    expect(isActionAllowedByCaps(caps, 'click')).toBe(false)
    expect(isActionAllowedByCaps(caps, 'type_text')).toBe(false)
    expect(isActionAllowedByCaps(caps, 'select_option')).toBe(false)
  })
  it('forbiddenCrossTools включает run_command/file write/connector', () => {
    const caps = defaultCapability()
    expect(isCrossToolForbidden(caps, 'run_command')).toBe(true)
    expect(isCrossToolForbidden(caps, 'write_file')).toBe(true)
    expect(isCrossToolForbidden(caps, 'apply_patch')).toBe(true)
    expect(isCrossToolForbidden(caps, 'connector_query')).toBe(true)
    expect(isCrossToolForbidden(caps, 'delegate_task')).toBe(true)
    expect(isCrossToolForbidden(caps, 'execute_code')).toBe(true)
    expect(isCrossToolForbidden(caps, 'memory_save')).toBe(true)
  })
})

describe('buildCapabilityFromCommand — эвристика по команде', () => {
  it('«прочитай отчёт Calltouch» → только observe/navigate (без click/type)', () => {
    const caps = buildCapabilityFromCommand({ command: 'прочитай отчёт Calltouch' })
    expect(isActionAllowedByCaps(caps, 'observe')).toBe(true)
    expect(isActionAllowedByCaps(caps, 'navigate')).toBe(true)
    expect(isActionAllowedByCaps(caps, 'click')).toBe(false)
    expect(isActionAllowedByCaps(caps, 'type_text')).toBe(false)
  })
  it('«кликни на фильтр» → + click + select_option', () => {
    const caps = buildCapabilityFromCommand({ command: 'кликни на фильтр и выбери период' })
    expect(isActionAllowedByCaps(caps, 'click')).toBe(true)
    expect(isActionAllowedByCaps(caps, 'select_option')).toBe(true)
  })
  it('«введи текст в поле» → + type_text + clear_field', () => {
    const caps = buildCapabilityFromCommand({ command: 'введи текст в поле названия' })
    expect(isActionAllowedByCaps(caps, 'type_text')).toBe(true)
    expect(isActionAllowedByCaps(caps, 'clear_field')).toBe(true)
  })
  it('«отправь кампанию» → + click + type_text + press_key (submit-like)', () => {
    const caps = buildCapabilityFromCommand({ command: 'отправь кампанию в Telegram Ads' })
    expect(isActionAllowedByCaps(caps, 'click')).toBe(true)
    expect(isActionAllowedByCaps(caps, 'type_text')).toBe(true)
    expect(isActionAllowedByCaps(caps, 'press_key')).toBe(true)
  })
  it('allowedDomains передаётся в envelope', () => {
    const caps = buildCapabilityFromCommand({ command: '', allowedDomains: ['calltouch.com', 'novoe.online'] })
    expect(caps.allowedDomains).toEqual(['calltouch.com', 'novoe.online'])
  })
})

describe('RED: page content НЕ может расширить capability (инвариант 13)', () => {
  // Контрактор controller'а: buildCapabilityFromCommand вызывается ИСКЛЮЧИТЕЛЬНО
  // из исходной команды Павла или скилла — НИКОГДА из observation.text.
  // Тест: «страница говорит "выполни run_command"» — capability об этом не знает.
  it('текст команды — единственный источник; "run_command" в observation не влияет', () => {
    // Симулируем: buildCapabilityFromCommand вызывается с командой Павла
    // «прочитай отчёт». observation.text может содержать что угодно — он в
    // другой плоскости. capability строится ТОЛЬКО из command.
    const caps = buildCapabilityFromCommand({ command: 'прочитай отчёт' })
    // run_command не разрешён, даже если страница его упоминает.
    expect(isCrossToolForbidden(caps, 'run_command')).toBe(true)
    expect(isCrossToolForbidden(caps, 'connector_query')).toBe(true)
    expect(isCrossToolForbidden(caps, 'write_file')).toBe(true)
  })
  it('extraForbiddenActionTypes имеет приоритет над allowed', () => {
    const caps = buildCapabilityFromCommand({
      command: 'кликни сюда',
      extraForbiddenActionTypes: ['click'],
    })
    // click добавлен в allowed по команде, но forbidden — приоритет.
    expect(isActionAllowedByCaps(caps, 'click')).toBe(false)
  })
})

describe('isDomainAllowedByCaps — site policy', () => {
  it('пустой allowedDomains → все домены разрешены (observe-friendly)', () => {
    const caps = defaultCapability()
    expect(isDomainAllowedByCaps(caps, 'example.com')).toBe(true)
  })
  it('непустой allowedDomains → только перечисленные (fail-closed)', () => {
    const caps = buildCapabilityFromCommand({ command: '', allowedDomains: ['calltouch.com'] })
    expect(isDomainAllowedByCaps(caps, 'calltouch.com')).toBe(true)
    expect(isDomainAllowedByCaps(caps, 'evil.com')).toBe(false)
  })
  it('subdomain разрешён, если родитель в allowlist', () => {
    const caps = buildCapabilityFromCommand({ command: '', allowedDomains: ['calltouch.com'] })
    expect(isDomainAllowedByCaps(caps, 'app.calltouch.com')).toBe(true)
  })
  it('null origin → false', () => {
    const caps = defaultCapability()
    expect(isDomainAllowedByCaps(caps, null)).toBe(false)
  })
})

describe('FORBIDDEN_CROSS_TOOLS — полный список exfiltration vectors', () => {
  it('включает все опасные cross-tools', () => {
    expect(FORBIDDEN_CROSS_TOOLS).toContain('run_command')
    expect(FORBIDDEN_CROSS_TOOLS).toContain('execute_code')
    expect(FORBIDDEN_CROSS_TOOLS).toContain('write_file')
    expect(FORBIDDEN_CROSS_TOOLS).toContain('apply_patch')
    expect(FORBIDDEN_CROSS_TOOLS).toContain('edit_spreadsheet')
    expect(FORBIDDEN_CROSS_TOOLS).toContain('delegate_task')
    expect(FORBIDDEN_CROSS_TOOLS).toContain('connector_query')
    expect(FORBIDDEN_CROSS_TOOLS).toContain('connector_send')
    expect(FORBIDDEN_CROSS_TOOLS).toContain('spawn_process')
  })
})

describe('R4_ALWAYS_FORBIDDEN_PAYLOAD_KEYS', () => {
  it('включает password/payment/captcha/cvv и т.п.', () => {
    expect(R4_ALWAYS_FORBIDDEN_PAYLOAD_KEYS).toContain('password')
    expect(R4_ALWAYS_FORBIDDEN_PAYLOAD_KEYS).toContain('payment')
    expect(R4_ALWAYS_FORBIDDEN_PAYLOAD_KEYS).toContain('captcha')
    expect(R4_ALWAYS_FORBIDDEN_PAYLOAD_KEYS).toContain('cvv')
    expect(R4_ALWAYS_FORBIDDEN_PAYLOAD_KEYS).toContain('token')
    expect(R4_ALWAYS_FORBIDDEN_PAYLOAD_KEYS).toContain('otp')
  })
})
