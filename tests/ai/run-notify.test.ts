import { describe, it, expect, vi, beforeEach } from 'vitest'

// Захват вызовов мокнутого telegram-коннектора (vi.hoisted для hoisted-фабрики).
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn(async (_args: Record<string, unknown>, _ctx: unknown) => ({ ok: true })) }))
vi.mock('../../electron/connectors/telegram', () => ({
  createTelegramConnector: () => ({ info: () => ({}), query: queryMock }),
}))

import { shouldNotifyStatus, formatRunNotification, notifyRunEvent } from '../../electron/ai/run-notify'

describe('run-notify: shouldNotifyStatus', () => {
  it('пушим done/failed/waiting_review, молчим на stopped/queued/running', () => {
    expect(shouldNotifyStatus('done')).toBe(true)
    expect(shouldNotifyStatus('failed')).toBe(true)
    expect(shouldNotifyStatus('waiting_review')).toBe(true)
    expect(shouldNotifyStatus('stopped')).toBe(false) // юзер сам остановил
    expect(shouldNotifyStatus('queued')).toBe(false)
    expect(shouldNotifyStatus('running')).toBe(false)
  })
})

describe('run-notify: formatRunNotification', () => {
  it('failed — ❌ + проект + ошибка', () => {
    const t = formatRunNotification({ status: 'failed', projectName: 'verstak', error: 'tsc упал' })
    expect(t).toContain('❌')
    expect(t).toContain('упал')
    expect(t).toContain('verstak')
    expect(t).toContain('tsc упал')
  })
  it('done — ✅ + сводка (инстр./файлы/стоимость)', () => {
    const t = formatRunNotification({ status: 'done', projectName: 'verstak', toolCount: 5, filesCount: 2, costCents: 34 })
    expect(t).toContain('✅')
    expect(t).toContain('завершён')
    expect(t).toContain('5 инстр.')
    expect(t).toContain('2 файлов')
    expect(t).toContain('$0.34')
  })
  it('waiting_review — 👀', () => {
    expect(formatRunNotification({ status: 'waiting_review', projectName: null })).toContain('👀')
  })
})

describe('run-notify: notifyRunEvent (гейтинг)', () => {
  beforeEach(() => queryMock.mockClear())
  const secrets = (m: Record<string, string>) => ({ getSecret: (k: string) => m[k] ?? null })

  it('настроено + main + done → шлёт send_message в notify-чат', async () => {
    await notifyRunEvent(
      { status: 'done', owner: 'main', projectName: 'verstak', toolCount: 3 },
      secrets({ telegram_notify_chat_id: '123', telegram_bot_token: 'tok' })
    )
    expect(queryMock).toHaveBeenCalledTimes(1)
    const [args] = queryMock.mock.calls[0]
    expect(args).toMatchObject({ op: 'send_message', chat_id: '123' })
    expect(String(args.text)).toContain('✅')
  })

  it('не настроен notify-чат → no-op', async () => {
    await notifyRunEvent({ status: 'done', owner: 'main', projectName: 'x' }, secrets({ telegram_bot_token: 'tok' }))
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('нет токена → no-op', async () => {
    await notifyRunEvent({ status: 'done', owner: 'main', projectName: 'x' }, secrets({ telegram_notify_chat_id: '123' }))
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('суб-агент (owner=delegate) → no-op (не спамим)', async () => {
    await notifyRunEvent({ status: 'done', owner: 'delegate', projectName: 'x' }, secrets({ telegram_notify_chat_id: '123', telegram_bot_token: 'tok' }))
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('stopped (юзер сам) → no-op', async () => {
    await notifyRunEvent({ status: 'stopped', owner: 'main', projectName: 'x' }, secrets({ telegram_notify_chat_id: '123', telegram_bot_token: 'tok' }))
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('не кидает при ошибке коннектора (наблюдаемость не роняет прогон)', async () => {
    queryMock.mockRejectedValueOnce(new Error('network'))
    await expect(notifyRunEvent(
      { status: 'failed', owner: 'main', projectName: 'x', error: 'boom' },
      secrets({ telegram_notify_chat_id: '123', telegram_bot_token: 'tok' })
    )).resolves.toBeUndefined()
  })
})
