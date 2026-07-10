import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ChatProvider, ChatEvent } from '../../electron/ai/types'

/**
 * Тест-харнес CLI-пути (runPlainConversation) — 1.9.6 #5. Весь релиз 1.9.5
 * (CLI-глубокая-интеграция) шёл через этот путь БЕЗ единого теста: Control
 * Envelope, проекция tool-событий, redactForDisplay, done/abort правились
 * вслепую. Харнес гоняет реальный loop с мок-провайдером.
 *
 * ipcMain мокаем — ai.ts тянет его на загрузке модуля.
 */
vi.mock('electron', () => ({ ipcMain: { handle: () => {} }, app: { getPath: () => tmpdir() } }))

const { runPlainConversation } = await import('../../electron/ipc/ai')

const CLEAN_ENV = (() => {
  const e: NodeJS.ProcessEnv = { ...process.env }
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR', 'GIT_PREFIX', 'GIT_NAMESPACE', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete e[k]
  return e
})()
const gitRun = (dir: string, args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore', env: CLEAN_ENV })

function provider(events: ChatEvent[]): ChatProvider {
  return {
    id: 'claude-cli', name: 'claude-cli', models: ['claude-cli'],
    async *send(): AsyncGenerator<ChatEvent> { for (const e of events) yield e },
  }
}
function makeSender() { return { send: vi.fn(), exec: vi.fn(async () => undefined) } }
type Sender = ReturnType<typeof makeSender>
// Отправляются и ChatEvent, и UI-события (tool-activity/agent-progress) — берём
// широкий тип, а не ChatEvent (у последнего нет 'tool-activity').
type SentEvent = { type: string; text?: string; title?: string; detail?: string }
function sentEvents(sender: Sender): SentEvent[] {
  return sender.send.mock.calls.map(c => (c[1] as { event: SentEvent }).event)
}

// Позиционный вызов runPlainConversation (sender, sendId, provider, projectPath,
// messages, signal, recordJournal, costGuard?, providerId?, model?, fallbackOpts?, agentRuns?, runId?).
function run(dir: string, p: ChatProvider, sender: Sender, opts: { signal?: AbortSignal; agentRuns?: unknown; runId?: string; fallbackOpts?: unknown } = {}) {
  return runPlainConversation(
    sender as never, 1, p, dir, [{ role: 'user', content: 'сделай' }],
    opts.signal ?? new AbortController().signal, vi.fn(),
    undefined, 'claude-cli', 'auto', opts.fallbackOpts as never, opts.agentRuns as never, opts.runId
  )
}

describe('runPlainConversation — CLI-путь (1.9.6 #5)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plain-loop-')) })
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* win lock */ } })

  it('нормальный текстовый стрим → текст доходит + терминальный done', async () => {
    const sender = makeSender()
    await run(dir, provider([{ type: 'text', text: 'Готово.' }, { type: 'done' }]), sender)
    const evs = sentEvents(sender)
    expect(evs.some(e => e.type === 'text' && (e as { text: string }).text.includes('Готово'))).toBe(true)
    expect(evs.some(e => e.type === 'done')).toBe(true)
  })

  it('Control Envelope: перед CLI-прогоном эмитится контрольная точка', async () => {
    const sender = makeSender()
    await run(dir, provider([{ type: 'text', text: 'ok' }, { type: 'done' }]), sender)
    const evs = sentEvents(sender)
    const envelope = evs.find(e => e.type === 'agent-progress' && (e as { title?: string }).title?.includes('Контрольная точка'))
    expect(envelope).toBeTruthy()
  })

  it('SECURITY: projected tool args редактируются (секрет не течёт в Timeline)', async () => {
    const sender = makeSender()
    const secret = 'sk-ant-abcdefghijklmnopqrstuvwxyz0123456789'
    await run(dir, provider([
      { type: 'tool-call', call: { id: 't1', name: 'run_command', args: { command: `curl -H "Authorization: Bearer ${secret}" https://api` } } },
      { type: 'text', text: 'ok' }, { type: 'done' },
    ]), sender)
    const evs = sentEvents(sender)
    const activity = evs.find(e => e.type === 'tool-activity') as { detail?: string } | undefined
    expect(activity).toBeTruthy()
    expect(activity!.detail).not.toContain(secret)
    expect(activity!.detail).toContain('REDACTED')
  })

  it('Control Envelope в git-репо: checkpoint-событие с полным sha в ref', async () => {
    gitRun(dir, ['init']); gitRun(dir, ['config', 'user.email', 't@t.t']); gitRun(dir, ['config', 'user.name', 'T']); gitRun(dir, ['config', 'commit.gpgsign', 'false'])
    writeFileSync(join(dir, 'a.txt'), 'x'); gitRun(dir, ['add', '-A']); gitRun(dir, ['commit', '-m', 'i'])
    const appendEvent = vi.fn()
    const sender = makeSender()
    await run(dir, provider([{ type: 'text', text: 'ok' }, { type: 'done' }]), sender, { agentRuns: { appendEvent }, runId: 'r1' })
    const cp = appendEvent.mock.calls.find(c => c[1] === 'checkpoint')
    expect(cp).toBeTruthy()
    expect(cp![2].ref).toMatch(/[0-9a-f]{40}/) // полный gitHead в ref для отката
  })

  it('SECURITY/RESILIENCE: подписочный лимит → account-switch → re-run на свежем аккаунте (1.9.7 #6)', async () => {
    // Раньше CLI-путь на yielded-error просто сдавался (done+return) — авто-свитч
    // 1.9.4 был мёртв для CLI-подписок (свой главный кейс). Теперь склейка
    // detect→switch→getNextProvider→re-run прогоняется на CLI-пути.
    const limited: ChatProvider = {
      id: 'claude-cli', name: 'claude-cli', models: ['claude-cli'],
      async *send() { yield { type: 'error', message: 'Claude usage limit reached. Try again in 2 hours.' } },
    }
    const freshAccount = provider([{ type: 'text', text: 'Готово на свежем аккаунте.' }, { type: 'done' }])
    const switchAccountOnLimit = vi.fn((_providerId: string, _resetEta: number | null) => ({ switched: true }))
    const fallbackOpts = {
      getNextProvider: (_id: string) => freshAccount,
      getProviderModel: (_id: string) => 'auto',
      configuredProviders: new Set(['claude-cli']),
      triedProviders: new Set(['claude-cli']),
      switchAccountOnLimit,
    }
    const sender = makeSender()
    await run(dir, limited, sender, { fallbackOpts })
    // Свитч вызван с providerId + распарсенным ETA сброса (не null).
    expect(switchAccountOnLimit).toHaveBeenCalledTimes(1)
    expect(switchAccountOnLimit.mock.calls[0][0]).toBe('claude-cli')
    expect(switchAccountOnLimit.mock.calls[0][1]).toBeGreaterThan(0) // resetEta распарсен
    const evs = sentEvents(sender)
    expect(evs.some(e => e.type === 'info' && (e as { text?: string }).text?.includes('другой аккаунт'))).toBe(true)
    // Свежий аккаунт реально отработал (его текст дошёл).
    expect(evs.some(e => e.type === 'text' && (e as { text?: string }).text?.includes('свежем аккаунте'))).toBe(true)
  })

  it('лимит БЕЗ переключаемого аккаунта (пул исчерпан) → честно сдаётся, без зацикливания', async () => {
    const limited: ChatProvider = {
      id: 'claude-cli', name: 'claude-cli', models: ['claude-cli'],
      async *send() { yield { type: 'error', message: 'usage limit reached' } },
    }
    const switchAccountOnLimit = vi.fn((_providerId: string, _resetEta: number | null) => ({ switched: false })) // пул исчерпан
    const fallbackOpts = {
      getNextProvider: () => null, getProviderModel: () => 'auto',
      configuredProviders: new Set(['claude-cli']), triedProviders: new Set(['claude-cli']), switchAccountOnLimit,
    }
    const sender = makeSender()
    await run(dir, limited, sender, { fallbackOpts })
    expect(switchAccountOnLimit).toHaveBeenCalledTimes(1)
    // Не зациклился — терминальный done есть.
    expect(sentEvents(sender).some(e => e.type === 'done')).toBe(true)
  })

  it('прерванный сигнал → терминальный done, провайдер не зовётся', async () => {
    const ac = new AbortController(); ac.abort()
    const sendSpy = vi.fn()
    const p: ChatProvider = { id: 'claude-cli', name: 'claude-cli', models: ['claude-cli'], async *send() { sendSpy(); } }
    const sender = makeSender()
    await run(dir, p, sender, { signal: ac.signal })
    expect(sentEvents(sender).some(e => e.type === 'done')).toBe(true)
    expect(sendSpy).not.toHaveBeenCalled()
  })
})
