import { describe, it, expect, vi, beforeEach } from 'vitest'

// Захват вызовов мокнутого telegram-коннектора (vi.hoisted для hoisted-фабрики).
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn(async (_args: Record<string, unknown>, _ctx: unknown) => ({ ok: true })) }))
vi.mock('../../electron/connectors/telegram', () => ({
  createTelegramConnector: () => ({ info: () => ({}), query: queryMock }),
}))

import { shouldNotifyStatus, shouldSendAutoProofReport, formatRunNotification, notifyRunEvent } from '../../electron/ai/run-notify'

describe('run-notify: shouldNotifyStatus', () => {
  it('пушим done/failed/waiting_review, молчим на stopped/queued/running', () => {
    expect(shouldNotifyStatus('done')).toBe(true)
    expect(shouldNotifyStatus('failed')).toBe(true)
    expect(shouldNotifyStatus('timed_out')).toBe(true)
    expect(shouldNotifyStatus('waiting_review')).toBe(true)
    expect(shouldNotifyStatus('stopped')).toBe(false) // юзер сам остановил
    expect(shouldNotifyStatus('queued')).toBe(false)
    expect(shouldNotifyStatus('running')).toBe(false)
  })
})

describe('run-notify: auto proof report gating', () => {
  const secrets = (m: Record<string, string>) => ({ getSecret: (k: string) => m[k] ?? null })

  it('requires explicit opt-in, long main done run, project, and Telegram settings', () => {
    const ev = { runId: 'run-1', status: 'done' as const, owner: 'main', projectName: 'verstak', durationMs: 11 * 60_000 }
    expect(shouldSendAutoProofReport(ev, secrets({
      proof_auto_send_telegram: 'true',
      telegram_notify_chat_id: '123',
      telegram_bot_token: 'tok',
    }))).toBe(true)

    expect(shouldSendAutoProofReport(ev, secrets({ telegram_notify_chat_id: '123', telegram_bot_token: 'tok' }))).toBe(false)
    expect(shouldSendAutoProofReport({ ...ev, durationMs: 30_000 }, secrets({
      proof_auto_send_telegram: 'true',
      telegram_notify_chat_id: '123',
      telegram_bot_token: 'tok',
    }))).toBe(false)
    expect(shouldSendAutoProofReport({ ...ev, owner: 'delegate' }, secrets({
      proof_auto_send_telegram: 'true',
      telegram_notify_chat_id: '123',
      telegram_bot_token: 'tok',
    }))).toBe(false)
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
  it('timed_out — timeout message', () => {
    const t = formatRunNotification({ status: 'timed_out', projectName: 'verstak', error: 'Agent run timed out' })
    expect(t).toContain('таймауту')
    expect(t).toContain('verstak')
    expect(t).toContain('Agent run timed out')
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

  it('прогон без проекта (справка «?», projectName=null) → no-op (не спамим)', async () => {
    await notifyRunEvent({ status: 'done', owner: 'main', projectName: null }, secrets({ telegram_notify_chat_id: '123', telegram_bot_token: 'tok' }))
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
