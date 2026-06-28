import { describe, it, expect } from 'vitest'
import { isReadOnlyConnectorOp } from '../../electron/ai/connector-readonly'

describe('isReadOnlyConnectorOp', () => {
  it('целиком read-only коннекторы → true для любого op', () => {
    for (const kind of ['ozon', 'wildberries', 'yandex_metrika', 'amocrm', 'github', 'onec-odata', 'dadata']) {
      expect(isReadOnlyConnectorOp(kind, { entity: 'orders' })).toBe(true)
    }
  })

  it('gsheets: read_/get_/ping → read, append_/update_ → запрет (SSOT TASK_REGISTRY!)', () => {
    expect(isReadOnlyConnectorOp('gsheets', { op: 'read_sheet' })).toBe(true)
    expect(isReadOnlyConnectorOp('gsheets', { op: 'get_row' })).toBe(true)
    expect(isReadOnlyConnectorOp('gsheets', { op: 'ping' })).toBe(true)
    expect(isReadOnlyConnectorOp('gsheets', { op: 'append_row' })).toBe(false)
    expect(isReadOnlyConnectorOp('gsheets', { op: 'update_row' })).toBe(false)
  })

  it('http: GET/HEAD → read, POST/PUT/DELETE → запрет', () => {
    expect(isReadOnlyConnectorOp('http-rest', { method: 'GET' })).toBe(true)
    expect(isReadOnlyConnectorOp('http-rest', {})).toBe(true) // дефолт GET
    expect(isReadOnlyConnectorOp('http-rest', { method: 'POST' })).toBe(false)
    expect(isReadOnlyConnectorOp('http-rest', { method: 'delete' })).toBe(false)
  })

  it('telegram: get_* → read, send/delete → запрет', () => {
    expect(isReadOnlyConnectorOp('telegram', { op: 'get_updates' })).toBe(true)
    expect(isReadOnlyConnectorOp('telegram', { op: 'get_me' })).toBe(true)
    expect(isReadOnlyConnectorOp('telegram', { op: 'send_message' })).toBe(false)
    expect(isReadOnlyConnectorOp('telegram', { op: 'delete_message' })).toBe(false)
  })

  it('yandex_disk: list → read, upload/unpublish → запрет', () => {
    expect(isReadOnlyConnectorOp('yandex_disk', { op: 'list_files' })).toBe(true)
    expect(isReadOnlyConnectorOp('yandex_disk', { op: 'upload_file' })).toBe(false)
    expect(isReadOnlyConnectorOp('yandex_disk', { op: 'get_public_url' })).toBe(false) // шарит файл наружу
  })

  it('bitrix24: list_/get_ → read, call (произвольный метод) → запрет', () => {
    expect(isReadOnlyConnectorOp('bitrix24', { op: 'list_deals' })).toBe(true)
    expect(isReadOnlyConnectorOp('bitrix24', { op: 'get_deal' })).toBe(true)
    expect(isReadOnlyConnectorOp('bitrix24', { op: 'call' })).toBe(false)
  })

  it('FAIL-SAFE: ssh / email-отправители / неизвестный kind → запрет', () => {
    expect(isReadOnlyConnectorOp('ssh', { op: 'run_remote', command: 'df -h' })).toBe(false)
    expect(isReadOnlyConnectorOp('sendpulse', {})).toBe(false)
    expect(isReadOnlyConnectorOp('unisender', {})).toBe(false)
    expect(isReadOnlyConnectorOp('social-publish', { op: 'publish_text' })).toBe(false)
    expect(isReadOnlyConnectorOp('some-new-connector', {})).toBe(false)
  })
})
