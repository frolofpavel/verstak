import { describe, expect, it, vi } from 'vitest'
import { testConnectorUi } from '../../electron/ai/connector-test'

const getSecret = (key: string) => key === 'bitrix24_webhook_url' ? 'https://test.bitrix24.ru/rest/1/abc/' : null

describe('Bitrix24 connector health check', () => {
  it('marks connector as connected when at least one feature is available', async () => {
    const registry = {
      query: vi.fn(async (_id: string, args: { method?: string }) => {
        if (args.method === 'profile') return { result: { ID: 1 } }
        if (args.method === 'crm.deal.fields') return { error: 'request-failed', message: 'insufficient_scope: CRM' }
        if (args.method === 'tasks.task.list') return { result: { tasks: [{ id: 1, title: 'Ping' }] } }
        return { error: 'unknown_method' }
      })
    }

    const result = await testConnectorUi('bitrix', registry as any, getSecret)

    expect(result.ok).toBe(true)
    expect(result.message).toContain('Доступно: задачи')
    expect(result.capabilities).toEqual([
      expect.objectContaining({ id: 'profile', ok: true }),
      expect.objectContaining({ id: 'crm', ok: false }),
      expect.objectContaining({ id: 'tasks', ok: true })
    ])
  })

  it('does not mark connector as connected when only webhook profile works', async () => {
    const registry = {
      query: vi.fn(async (_id: string, args: { method?: string }) => {
        if (args.method === 'profile') return { result: { ID: 1 } }
        return { error: 'request-failed', message: 'insufficient_scope' }
      })
    }

    const result = await testConnectorUi('bitrix', registry as any, getSecret)

    expect(result.ok).toBe(false)
    expect(result.message).toContain('Webhook живой')
    expect(result.capabilities?.find(item => item.id === 'profile')?.ok).toBe(true)
    expect(result.capabilities?.find(item => item.id === 'crm')?.ok).toBe(false)
    expect(result.capabilities?.find(item => item.id === 'tasks')?.ok).toBe(false)
  })
})
