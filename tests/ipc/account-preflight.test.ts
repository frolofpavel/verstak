import { describe, expect, it, vi } from 'vitest'
import { preflightSubscriptionAccount, type ResolveSubscriptionAccountFn } from '../../electron/ipc/ai-send/account-preflight'

describe('preflightSubscriptionAccount — Computer Use account lock', () => {
  it('передаёт resolver запрет auto-ротации без one-shot аккаунта', () => {
    const resolve = vi.fn<ResolveSubscriptionAccountFn>(() => ({
      blocked: true,
      reason: 'cooling',
      resetAt: null,
      label: 'Computer A',
    }))

    const result = preflightSubscriptionAccount({
      providerId: 'claude-cli',
      chatId: 42,
      oneShotAccountId: null,
      allowAutoRotation: false,
      resolve,
    })

    expect(resolve).toHaveBeenCalledOnce()
    expect(resolve).toHaveBeenCalledWith('claude-cli', 42, { allowAutoRotation: false })
    expect(result.ok).toBe(false)
  })

  it('обычный Auto сохраняет прежнюю форму вызова resolver без opts', () => {
    const resolve = vi.fn<ResolveSubscriptionAccountFn>(() => null)

    const result = preflightSubscriptionAccount({
      providerId: 'claude-cli',
      chatId: 42,
      oneShotAccountId: null,
      resolve,
    })

    expect(resolve).toHaveBeenCalledWith('claude-cli', 42, undefined)
    expect(result).toEqual({ ok: true, account: null, chatPinned: false, runAccountId: null })
  })

  it('совмещает one-shot accountId с запретом Computer Use auto-ротации', () => {
    const resolve = vi.fn<ResolveSubscriptionAccountFn>(() => ({
      accountId: 7,
      secret: null,
      configDir: 'C:\\fixture',
      baseUrl: null,
      pinned: true,
      label: 'Computer exact',
    }))

    const result = preflightSubscriptionAccount({
      providerId: 'codex-cli',
      chatId: 42,
      oneShotAccountId: 7,
      allowAutoRotation: false,
      resolve,
    })

    expect(resolve).toHaveBeenCalledWith('codex-cli', 42, { accountId: 7, allowAutoRotation: false })
    expect(result).toMatchObject({ ok: true, runAccountId: 7, chatPinned: true })
  })
})
