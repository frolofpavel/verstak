import { describe, it, expect, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// Этап 1а, блок №4 — ЖИВОЙ прогон полного runApiConversation в headless-среде на
// реальном провайдере (DeepSeek, дешёвый v4-flash). Дополняет быстрый скриптованный
// tests/headless/full-loop-headless.test.ts: тот доказывает механику цикла, этот —
// что живой API-провайдер проходит тот же путь без Electron. agentRuns сознательно
// не передаётся (durable-пути закрывает быстрый тест) — live-smoke не зависит от sqlite.
// Запуск: VERSTAK_LIVE_HEADLESS=1 + DEEPSEEK_API_KEY в env.
vi.mock('electron', () => {
  throw new Error("Cannot find module 'electron' (headless Node)")
})

const LIVE = process.env.VERSTAK_LIVE_HEADLESS === '1' && !!process.env.DEEPSEEK_API_KEY

const { runApiConversation } = await import('../../electron/ai/runner-api')
const { createToolsForProject } = await import('../../electron/ai/tools')
const { createCostGuard } = await import('../../electron/ai/cost-guard')
const { createProvider } = await import('../../electron/ai/registry')

describe.skipIf(!LIVE)('headless live — runApiConversation на реальном DeepSeek', () => {
  it('модель живьём вызывает write_file, цикл завершается, файл на месте', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'vsk-headless-live-'))
    const ctrl = new AbortController()
    const events: Array<{ type?: string }> = []
    try {
      const provider = createProvider('deepseek', {
        apiKey: process.env.DEEPSEEK_API_KEY!,
        model: 'deepseek-v4-flash',
        signal: ctrl.signal,
        cwd: projectDir
      })
      await runApiConversation({
        sender: {
          send: (_ch: string, payload: { event: unknown }) => { events.push(payload.event as { type?: string }) },
          exec: async () => undefined
        },
        sendId: 201,
        provider,
        tools: createToolsForProject(projectDir, ctrl.signal, {}),
        projectPath: projectDir,
        initialMessages: [
          { role: 'system', content: 'Ты агент Verstak. Выполняй задачу инструментами. Пиши файлы только внутри проекта.' },
          { role: 'user', content: 'Создай файл report.md с содержимым "# Headless live" (инструмент write_file), затем ответь одним словом: Готово.' }
        ],
        signal: ctrl.signal,
        recordWrite: () => undefined,
        recordPlan: () => ({ id: 1 }),
        recordJournal: () => undefined,
        readJournal: () => [],
        saveMemory: () => ({ id: 'm' }),
        saveDecision: () => ({ id: 1 }),
        invalidateMemory: () => false,
        searchMemories: () => [],
        searchConversations: () => [],
        connectors: { list: () => [], query: async () => ({}) },
        agentMode: 'bypass',
        turnsBudget: 6,
        getSecretForDelegate: () => null,
        costGuard: createCostGuard(1),
        providerId: 'deepseek',
        model: 'deepseek-v4-flash'
        // Каст через unknown — как в быстром headless-тесте: минимальные стабы памяти.
      } as unknown as Parameters<typeof runApiConversation>[0])

      const report = join(projectDir, 'report.md')
      expect(existsSync(report)).toBe(true)
      expect(readFileSync(report, 'utf8').toLowerCase()).toContain('headless')
      const types = events.map(e => e.type)
      expect(types).toContain('done')
      expect(types).not.toContain('error')
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
    // Бюджет: заметно меньше таймаута теста (§3.1) — живой ход DeepSeek обычно < 60 с.
  }, 180_000)
})
